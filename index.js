/**
 * dsh-compact-agents — 给模型一个 `compact_agents` 工具：**无视自动阈值**强制压缩会话上下文。
 *
 * 覆盖范围：**进程内所有活着的会话** —— 主会话、普通子代理、AgentTeams 成员，一视同仁
 * （`ctx.agents.list()` = "All live agents, in registration order"，不是只挑团队成员）。
 * 没有子代理时，主会话自己也照样能被压。
 *
 * 为什么需要它：DSH 的手动压缩入口只有人机命令 `/compact`
 * （`@deepseek-ai/dsh-command-compact` 用 `ctx.commands.register` 注册，只服务交互式
 * UI 适配器）。headless 的子代理 / 团队成员没有命令面，队长也没有任何工具能替它们
 * 压缩，于是"会话越跑越贵"只能靠换人解决。本插件补上这个工具入口。
 *
 * 它直接调用 `ctx.compaction.compactNow(agent, signal)`：该入口按契约
 * "Explicitly compact useful history even below automatic pressure thresholds"，
 * 即无视阈值强制压缩；而 `compactIfNeeded(..., 'pressure', ...)` 会尊重阈值，不适用。
 *
 * 忙的目标不会被丢下：`compactNow` 走 `agent.runMaintenance`，agent 正在跑 turn 时抛
 * `ManualCompactionError('busy')`。默认策略是**挂起**——监听该 agent 的
 * `agent/status → idle`，等它这一轮结束立刻补压。这正是"主会话也能生效"的实现方式：
 * 调用者自己永远 busy（它正在执行这个工具），所以它的压缩必然发生在本轮结束之后。
 *
 * 压缩过程本身也不再静默：默认订阅 `session/event`，`compaction/start` 一落地就往会话尾
 * 追加一条插件来源的 `user/message`，客户端把它渲染成「上下文注入 · dsh-compact-agents」
 * 折叠行 —— 压缩中显示"正在压缩上下文…（当前 N tokens）"，结束后显示
 * "上下文压缩完成：约 A → B tokens，已遮蔽 N 个历史节点"。`compaction/start` 是在摘要模型
 * 调用**之前**追加的，所以这条提示正好盖住原本那段什么都看不见的等待。
 * 行配置 `notice: false` 可整体关闭它。
 *
 * 放置位置：本文件必须在能解析 `@deepseek-ai/*` 的地方（见 README 的 junction 说明），
 * preset 用绝对路径引用它。
 *
 * @module dsh-compact-agents
 */

import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { currentPresetThreshold, currentPresetValues, liveConfig, onPresetParamsChanged, registerSettings, resolveMaxAutoContinues, resolvePreemptiveRatio } from './settings.js'

export const name = 'dsh-compact-agents'
export const inject = ['tools', 'compaction', 'agents']

/** 允许的压缩范围。 */
const SCOPES = ['others', 'all', 'self', 'ids']

/** 目标正忙时的处置策略。 */
const WHEN_BUSY = ['queue', 'skip']

/** 已排队等待 idle 的 agent id，避免重复排。 */
const scheduled = new Set()

/** 提示的插件身份；客户端据此把消息渲染成「上下文注入」折叠行。 */
const NOTICE_PLUGIN = 'dsh-compact-agents'

/** 折叠行摘要的字数上限，与框架的 `CONTEXT_SUMMARY_MAX_CHARS` 对齐。 */
const SUMMARY_MAX_CHARS = 120

/** 进行中的压缩：compactionId -> { before }（压缩前测得的 token 数，测不到为 null）。 */
const inFlight = new Map()

/** 已收到摘要、还没收到结束标记的压缩：compactionId -> { nodes, tokens }。 */
const summaries = new Map()

/** 每个会话连续自动续写的次数；一轮正常结束即清零。 */
const autoContinues = new Map()

/** 自动续写时替用户发出的那句话。 */
const CONTINUE_TEXT = '继续'

/**
 * 本进程里活着的各代际挂载（一个 preset 世代一份）。
 *
 * 设置卡片改的是 preset 文件，而活着的会话跑的是**建立时**那一代 —— `compaction-basic` 在构造
 * 时 `resolveConfig()` 并 `deepFreeze`，此后阈值固定。于是"改了 preset 还得新开一条对话"。
 * 这里收集每一代的 ctx，就能在保存后把新值**热同步**进每一代运行中的实例（见
 * {@link syncPresetParams}）：`ctx.compaction.config` 是个普通的自有属性（对象本身被冻结，
 * 但引用可换），而压力判定每次调用都重新读 `this.config`
 * （`packages/compaction/compaction-basic/src/index.ts` 的 `compactIfNeeded`），所以换掉它就立刻生效。
 */
const liveMounts = new Set()

/**
 * provider/model → 上下文窗口大小。校验热同步要用它把"阈值比例"换算成 token 触发线，
 * 而压缩发生时那条路径是同步的（查不动模型信息），所以在补丁落下的那一刻就**预先查好**。
 */
const contextWindows = new Map()

/** 刚被热同步改过阈值的代际：`ctx -> { from, to }`，等下一次真实压缩来反证。 */
const pendingPatch = new WeakMap()

/**
 * 反证失败的代际：`ctx -> 引擎其实还在用的那个阈值`。
 *
 * 一旦发现引擎没吃新值（例如上游把 spec 改成构造期缓存），提示就按这个值报，不能让
 * "配置里写着 ×0.35"冒充"实际按 ×0.35 压"。
 */
const patchFailed = new WeakMap()

/**
 * 我们自己刚请求过压缩的会话：`会话 id -> 标记时刻`。
 *
 * `compact_agents` 工具随时可以压，那次压缩的 token 数不说明策略阈值，所以窗口内该会话的
 * `compaction/start` 一律不当作热同步的反证材料。
 */
const selfCompactions = new Map()

/**
 * 上一次"回合结束预压"压不动（返回 `noop`）时的占用：`会话 id -> tokens`。
 *
 * 为什么不退避就会白花钱：`noop` 的典型成因是"单个超大保留单元"（契约上表面压缩修不了），
 * 这种会话的占用会一直贴在触发线附近，于是**每一轮结束都会再试一次**、每次都白调一遍
 * 摘要模型。占用没实质增长就不再试，是这条路径唯一必要的记账。
 */
const preemptiveNoop = new Map()

/** 下一次压缩是"回合结束预压"发起的：`会话 id -> 标记时刻`（提示据此说明来历）。 */
const preemptiveMarks = new Map()

/** 退避幅度：占用没涨过这个比例，就不再重复预压。 */
const PREEMPTIVE_RETRY_GROWTH = 0.05

/** 预压标记的有效期；压缩事件紧接着就得来，给足冗余即可。 */
const PREEMPTIVE_MARK_TTL_MS = 10 * 60 * 1000

/** 把接下来这段时间内该会话的压缩标记为"我们自己要求的"。 */
function markSelfCompaction(agent) {
  const id = agent?.session?.id ?? agent?.id
  if (id !== undefined && id !== null) selfCompactions.set(String(id), Date.now())
}

/**
 * 仅供测试：清掉热同步的进程级状态（窗口缓存、"我们自己压的"标记）。
 * `pendingPatch` / `patchFailed` 按 ctx 记在 WeakMap 里，各用例自己安排顺序。
 */
export function resetHotSyncStateForTest() {
  selfCompactions.clear()
  contextWindows.clear()
}

/** 仅供测试：清掉回合结束预压的记账（noop 退避、来历标记）。 */
export function resetPreemptiveStateForTest() {
  preemptiveNoop.clear()
  preemptiveMarks.clear()
}

/** 把接下来的这次压缩标记为"回合结束预压"发起的。 */
function markPreemptive(session) {
  const id = session?.id
  if (id !== undefined && id !== null) preemptiveMarks.set(String(id), Date.now())
}

/**
 * 取出并消费"这次压缩是预压"的标记；过期或没有标记时返回 false。
 * @param session - 事件所属会话。
 * @returns 是否为预压发起的压缩。
 */
function consumePreemptiveMark(session) {
  const id = session?.id
  if (id === undefined || id === null) return false
  const at = preemptiveMarks.get(String(id))
  if (at === undefined) return false
  preemptiveMarks.delete(String(id))
  return Date.now() - at < PREEMPTIVE_MARK_TTL_MS
}

/**
 * 查一个路由目标的上下文窗口并缓存（查不到缓存 null，不再反复打搅适配器）。
 * @param ctx - registrant context（借同 realm 的 `llm` 服务）。
 * @param target - 路由目标。
 */
function resolveWindow(ctx, target) {
  const key = `${target.provider}/${target.model}`
  if (contextWindows.has(key)) return
  contextWindows.set(key, null)
  try {
    // 必须走 `ctx.get()`：`llm` 不在本插件的 inject 列表里，`ctx.llm` 会直接抛
    // `cannot get property "llm" without inject`。这里是可选依赖，拿不到就少一道校验。
    const llm = ctx.get?.('llm')
    const pending = llm?.resolveModelInfo?.(target.provider, target.model, new AbortController().signal)
    void Promise.resolve(pending).then((info) => {
      const window = info?.context?.contextWindow
      if (typeof window === 'number' && window > 0) contextWindows.set(key, window)
    }).catch(() => {})
  } catch {
    // 拿不到窗口只是少一道校验，不影响热同步本身。
  }
}

/** 给这一代的所有活会话预先查好窗口：等到压缩发生时再查就太晚了（那是同步路径）。 */
function primeContextWindows(ctx) {
  try {
    for (const agent of ctx.agents?.list?.() ?? []) {
      const target = routedTargetOf(agent?.session)
      if (target !== null) resolveWindow(ctx, target)
    }
  } catch {
    // 拿不到 agent 列表也不影响主流程。
  }
}

/**
 * 用一次真实压缩反证热同步是否真的生效。
 *
 * 依据：达线判定是 `totalTokens >= 窗口 × thresholdRatio`。若把阈值从 A 抬到 B 之后，**策略自己
 * 决定**的压缩却发生在"明显低于 B 线、又已经达到 A 线"的 token 数上，那引擎用的就还是 A ——
 * 说明它不再每次调用现读 `this.config`（上游若改成构造期缓存 spec 就会这样）。此时记下 A，
 * 之后提示按 A 报，并保留"新开一条对话"这条正路；调低阈值的情形无法这样反证，就保持待验证、
 * 不轻易下结论。
 *
 * **只采信策略自己决定的压缩**：`turn === null` 是回合之间的手动事务（`/compact` 等，见
 * `compaction/start` 的 data 文档），带 `sourceCommandId` 的是命令驱动的压缩，我们自己刚请求过的
 * 那次也不算 —— 这三种在任意 token 数上都可能发生，拿它们取证会冤枉引擎。宁可少验一次，
 * 也不能误报"热同步没生效"。
 *
 * @param ctx - registrant context。
 * @param session - 事件所属会话。
 * @param before - 本次压缩开始时的 token 估算。
 * @param event - 已追加的 `compaction/start` 事件。
 * @returns 判定为"引擎仍用旧值"时返回那个旧值，否则 null。
 */
function verifyPatch(ctx, session, before, event) {
  const pending = pendingPatch.get(ctx)
  if (pending === undefined || typeof before !== 'number') return null
  const data = event?.data ?? {}
  if (data.turn === null || data.sourceCommandId !== undefined) return null
  const selfUntil = selfCompactions.get(String(session?.id))
  if (typeof selfUntil === 'number' && Date.now() - selfUntil < 60_000) return null
  const target = routedTargetOf(session)
  if (target === null) return null
  const window = contextWindows.get(`${target.provider}/${target.model}`)
  if (typeof window !== 'number' || window <= 0) {
    resolveWindow(ctx, target)
    return null
  }
  const newLine = window * pending.to
  const oldLine = window * pending.from
  if (pending.to > pending.from) {
    if (before >= newLine * 0.9) {
      pendingPatch.delete(ctx)
      return null
    }
    if (before >= oldLine) {
      pendingPatch.delete(ctx)
      patchFailed.set(ctx, pending.from)
      ctx.logger.warn(
        `compact-agents: 热同步没有生效 —— 压缩发生在 ${group(before)} tokens，`
        + `而 ×${pending.to} 的触发线约 ${group(Math.round(newLine))}，说明引擎仍按 ×${pending.from} 判线`,
      )
      return pending.from
    }
    return null
  }
  // 调低阈值：只有在"比旧线还早就压了"时才是证据，否则不下结论。
  if (before < oldLine) pendingPatch.delete(ctx)
  return null
}

/**
 * 一次会话的**路由目标**（provider/model）—— 用来判断 `modelPolicies` 里有没有精确覆盖。
 *
 * 与引擎 `resolveTargetPolicy` 同一套匹配：只有 provider 与 model 都相等的那条才算覆盖。
 *
 * @param session - 会话（可能没有 requestHeader，例如测试桩）。
 * @returns `{provider, model}`，取不到时为 null。
 */
function routedTargetOf(session) {
  try {
    const config = session?.requestHeader?.()?.config
    if (config === undefined || config === null || config.provider === '' || config.model === '') return null
    return { provider: config.provider, model: config.model }
  } catch {
    return null
  }
}

/**
 * 命中的按模型覆盖条目（没有则为 null）。
 * @param config - `compaction-basic` 的 ResolvedConfig。
 * @param target - 路由目标。
 * @returns 精确匹配的策略条目，或 null。
 */
function matchingPolicy(config, target) {
  if (target === null || !Array.isArray(config.modelPolicies)) return null
  return config.modelPolicies.find(
    policy => policy?.provider === target.provider && policy?.model === target.model,
  ) ?? null
}

/**
 * 把 preset 里的压缩参数热同步到这一代正在跑的 `compaction-basic` 上。
 *
 * 只碰两个旋钮：`thresholdRatio` 与 `retainRatio` —— 它们是 `ResolvedConfig` 的字段，压力判定
 * 与选段都按调用时的 `this.config` 现算。`bootstrapMaxTokens` 属于另一个 preset 插件
 * （`tool-bootstrap.mjs` 在 `apply()` 里把它捕获进闭包），改不动，只能等新会话。
 *
 * 有按模型覆盖时只改命中那条（引擎的 `resolveTargetPolicy` 就是这么选的）；没有命中就改全局。
 * 读不到、形状不对、写不进去或写回校验失败都**原样返回**，由压缩提示里的"旧代际"那行兜底说明。
 *
 * @param ctx - 某一代的 registrant context。
 * @param values - 目标值；缺省读 preset 文件（一秒缓存）。
 * @param target - 本次要同步的路由目标；缺省 null（改全局策略）。
 * @returns 结果标签，仅用于日志与测试。
 */
function syncPresetParams(ctx, values = currentPresetValues(), target = null) {
  let service
  try {
    service = ctx.compaction
  } catch {
    return 'no-service'
  }
  const config = service?.config
  if (config === null || typeof config !== 'object') return 'no-config'
  const override = matchingPolicy(config, target)
  const scoped = override ?? config
  const ratio = values.thresholdRatio
  const retain = values.retainRatio
  const wantRatio = typeof ratio === 'number' && ratio !== scoped.thresholdRatio ? ratio : undefined
  const wantRetain = typeof retain === 'number' && retain !== scoped.retainRatio ? retain : undefined
  if (wantRatio === undefined && wantRetain === undefined) return 'in-sync'
  const nextScoped = { ...scoped }
  // 与 settings 面同一套范围；另外守住 `retainRatio < thresholdRatio` 这条引擎自己的不变量。
  if (wantRatio !== undefined && wantRatio >= 0.05 && wantRatio <= 0.95) nextScoped.thresholdRatio = wantRatio
  if (wantRetain !== undefined && wantRetain >= 0.01 && wantRetain <= 0.5
    && wantRetain < nextScoped.thresholdRatio) {
    nextScoped.retainRatio = wantRetain
  }
  if (nextScoped.retainRatio >= nextScoped.thresholdRatio) return 'invariant'
  if (nextScoped.thresholdRatio === scoped.thresholdRatio
    && nextScoped.retainRatio === scoped.retainRatio) return 'invariant'
  const next = override === null
    ? nextScoped
    : { ...config, modelPolicies: config.modelPolicies.map(policy => (policy === override ? nextScoped : policy)) }
  try {
    service.config = next
  } catch {
    return 'readonly'
  }
  const applied = matchingPolicy(service.config ?? {}, target) ?? service.config ?? {}
  if (applied.thresholdRatio !== nextScoped.thresholdRatio
    || applied.retainRatio !== nextScoped.retainRatio) return 'rejected'
  const changes = []
  if (nextScoped.thresholdRatio !== scoped.thresholdRatio) {
    changes.push(`thresholdRatio ${scoped.thresholdRatio} → ${nextScoped.thresholdRatio}`)
  }
  if (nextScoped.retainRatio !== scoped.retainRatio) {
    changes.push(`retainRatio ${scoped.retainRatio} → ${nextScoped.retainRatio}`)
  }
  ctx.logger.info(`compact-agents: 已热同步 preset 参数到正在运行的会话（${changes.join('，')}）`)
  if (nextScoped.thresholdRatio !== scoped.thresholdRatio) {
    // 换了阈值就留一个待验证：下一次真实压缩的 token 数会告诉我们引擎到底吃没吃新值。
    pendingPatch.set(ctx, { from: scoped.thresholdRatio, to: nextScoped.thresholdRatio })
    patchFailed.delete(ctx)
    primeContextWindows(ctx)
  }
  return 'synced'
}

/**
 * 对所有活着的代际做一次热同步。设置界面保存后（`settings.js` 广播）与每次挂载时调用。
 * @param values - 目标值；缺省读 preset 文件。
 */
function syncAllPresetParams(values) {
  for (const record of liveMounts) {
    try {
      syncPresetParams(record.ctx, values)
    } catch {
      // 某一代已经拆掉了也不该影响别代。
    }
  }
}

// 只登记一次（模块级）：设置界面写盘成功 → 所有活着的代际立刻吃上新值。
onPresetParamsChanged(values => syncAllPresetParams(values))

/**
 * 千分位格式化 token 数。
 * @param value - token 数。
 * @returns 形如 `213,400` 的字符串。
 */
function group(value) {
  return value.toLocaleString('en-US')
}

/**
 * 读一个会话当前的表面 token 估算。
 * @param ctx - registrant context carrying the token meter.
 * @param session - 要测量的会话。
 * @returns 估算总量；计量服务缺席或测量失败时为 null。
 */
function measureTokens(ctx, session) {
  try {
    const measurement = ctx.get('tokenMeter')?.measure?.(session)
    const total = measurement?.totalTokens
    return typeof total === 'number' && Number.isFinite(total) ? total : null
  } catch {
    return null
  }
}

/**
 * 往会话表面追加一条**对话区可见**的提示。
 *
 * 走的是框架自己注入"上下文注入"的那条通路：一条 `user/message` + `source.kind === 'plugin'`。
 * 客户端对这类消息渲染成折叠行「上下文注入 · dsh-compact-agents · <摘要>」，
 * 不会伪装成用户气泡；`form: 'notice'` + `summary` 让折叠态就带一行结论。
 *
 * 压缩契约明确允许在摘要期间注入：`compactNow` 的文档写着 "Context injected while the
 * summary runs may sit between the marker pair; only the selected span must remain stable"。
 * 追加在表面尾部，不触碰被替换的区间，因此不会触发稳定性校验失败。
 *
 * @param ctx - registrant context carrying the logger.
 * @param session - 目标会话。
 * @param summary - 折叠行上显示的一行摘要。
 * @param body - 展开后的正文。
 */
function appendNotice(ctx, session, summary, body) {
  const bounded = summary.length <= SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`
  try {
    session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: body }],
      source: {
        kind: 'plugin',
        plugin: NOTICE_PLUGIN,
        form: 'notice',
        summary: bounded,
      },
    }, { surfaceOp: 'append' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`compact-agents: could not append a compaction notice: ${message}`)
  }
}

/**
 * 本会话这一代际实际生效的压缩触发阈值，以及 preset 文件里现在的值。
 *
 * 为什么要报它：压缩参数在**会话建立时**被读进 `compaction-basic`（构造时 `resolveConfig` +
 * `deepFreeze`），而"改 preset 要新开一条对话"这件事本身就该被说清楚。本插件会先把新值
 * **热同步**进去（见 {@link syncPresetParams}），所以正常情况下这里报的就是新值；只有当热同步
 * 进不去（配置不可写、形状变了）时才报旧值 —— 包括"写进去了但引擎没吃"这种被
 * {@link verifyPatch} 反证出来的情况。
 *
 * 读不到就返回 null（整句不出现），不让"报诊断"变成新的失败点。
 *
 * @param ctx - registrant context carrying the compaction service.
 * @param session - 事件所属会话，用来判断 `modelPolicies` 里哪条命中。
 * @returns `{ mounted, current, stale }`；`mounted` 为 null 表示读不到。
 */
function thresholdState(ctx, session) {
  let mounted = null
  const corrected = patchFailed.get(ctx)
  try {
    const config = ctx.compaction?.config
    if (config !== undefined && typeof config === 'object') {
      const override = matchingPolicy(config, routedTargetOf(session))
      const ratio = override?.thresholdRatio ?? config.thresholdRatio
      if (typeof ratio === 'number') mounted = ratio
    }
  } catch {
    mounted = null
  }
  // 反证失败时以引擎实际在用的那个值为准：宁可报得保守，也不能让"配置里写着新值"冒充生效。
  if (typeof corrected === 'number') mounted = corrected
  if (mounted === null) return null
  const current = currentPresetThreshold()
  return { mounted, current, stale: current !== null && current !== mounted }
}

/** 折叠行上的触发线附注；读不到阈值时为空串。 */
function thresholdSuffix(state) {
  return state === null ? '' : ` · 触发线 ×${state.mounted}`
}

/** "预设已改、热同步又进不去"那句提醒；不需要提醒时为空串。 */
function staleLine(state) {
  if (state === null || !state.stale) return ''
  return `⚠️ 预设文件里现在是 ×${state.current}，本会话这个实例仍按 ×${state.mounted}（热同步没成功）：`
    + '新开一条对话才会用上新值。\n'
}

/**
 * 本会话这一代际**实际生效**的压缩触发线（token 数）。
 *
 * 与 {@link thresholdState} 同源：命中 `modelPolicies` 的那条优先，被 {@link verifyPatch}
 * 反证出引擎没吃新值时以引擎实际在用的那个值为准 —— 预压要贴着引擎真正会判的那条线，
 * 否则"提前"就成了"守着一条没人用的线"。
 *
 * 窗口是异步查来的（{@link resolveWindow}），当次查不到就返回 null 并顺手补一次查询，
 * 下一次回合结束即可用上；查不到只是少一次优化，不影响达线兜底。
 *
 * @param ctx - registrant context carrying the compaction service.
 * @param session - 要判定的会话。
 * @returns 触发线（token 数）；读不到时为 null。
 */
function effectiveLine(ctx, session) {
  try {
    const target = routedTargetOf(session)
    if (target === null) return null
    const config = ctx.compaction?.config
    if (config === null || typeof config !== 'object') return null
    const override = matchingPolicy(config, target)
    const ratio = patchFailed.get(ctx) ?? override?.thresholdRatio ?? config.thresholdRatio
    if (typeof ratio !== 'number' || !(ratio > 0)) return null
    const key = `${target.provider}/${target.model}`
    const window = contextWindows.get(key)
    if (typeof window !== 'number' || !(window > 0)) {
      // 窗口是异步查来的（查不到也会缓存 null，重复调用是空操作）：这次用不上就补一次。
      resolveWindow(ctx, target)
      return null
    }
    return window * ratio
  } catch {
    return null
  }
}

/**
 * 把一次压缩事件翻译成对话里的提示。
 * @param ctx - registrant context carrying the token meter and logger.
 * @param session - 事件所属会话。
 * @param event - 已追加的 `compaction/start | summary | end` 事件。
 */
function noticeFor(ctx, session, event) {
  const id = String(event.data.compactionId)
  if (event.type === 'compaction/start') {
    const before = measureTokens(ctx, session)
    inFlight.set(id, { before })
    const threshold = thresholdState(ctx, session)
    // 消费标记：这次压缩是不是"回合结束预压"发起的（提示里要说明来历，别让人以为达线了）。
    const preemptive = consumePreemptiveMark(session)
    appendNotice(
      ctx,
      session,
      (before === null ? '正在压缩上下文…' : `正在压缩上下文…（当前 ${group(before)} tokens）`)
      + (preemptive ? ' · 回合结束预压' : '')
      + thresholdSuffix(threshold),
      (preemptive
        ? '⏳ 上一轮回答结束时上下文已接近触发线，正在提前压缩，好让下一轮直接开跑。\n'
        : '⏳ 上下文已达压缩阈值，正在压缩上下文。\n')
      + (before === null ? '' : `当前约 ${group(before)} tokens。\n`)
      + staleLine(threshold)
      + '这是一条状态提示，不需要回应。',
    )
    return
  }
  if (event.type === 'compaction/summary') {
    summaries.set(id, {
      nodes: Array.isArray(event.data.shadowedSeqs) ? event.data.shadowedSeqs.length : null,
      tokens: typeof event.data.shadowedTokenCount === 'number' ? event.data.shadowedTokenCount : null,
    })
    return
  }
  const before = inFlight.get(id)?.before ?? null
  inFlight.delete(id)
  const stat = summaries.get(id) ?? { nodes: null, tokens: null }
  summaries.delete(id)
  const failure = typeof event.data.error === 'string' && event.data.error !== '' ? event.data.error : null
  if (failure !== null) {
    appendNotice(
      ctx,
      session,
      '上下文压缩未完成',
      `⚠️ 上下文压缩未完成：${failure}\n这是一条状态提示，不需要回应。`,
    )
    return
  }
  const after = measureTokens(ctx, session)
  const detail = stat.nodes === null ? '' : `，已遮蔽 ${stat.nodes} 个历史节点`
  const size = before !== null && after !== null
    ? `约 ${group(before)} → ${group(after)} tokens`
    : stat.tokens === null ? '' : `已遮蔽约 ${group(stat.tokens)} tokens`
  appendNotice(
    ctx,
    session,
    size === '' ? `上下文压缩完成${detail}` : `上下文压缩完成：${size}${detail}`,
    '✅ 上下文压缩完成。\n'
    + (size === '' ? '' : `${size}${detail}。\n`)
    + staleLine(thresholdState(ctx, session))
    + '这是一条状态提示，不需要回应。',
  )
}

/**
 * 找到某个会话对应的活 agent。
 *
 * 自动续写必须走 `agent.followup`（内部 `send(message, 'next-turn', true)` + `wakeDriver`）
 * —— 这正是人在界面上发一句话时走的同一条路（`session-controller/src/commands.ts` 里
 * `agent.followup(message)`），而单纯往会话表面 `append` 一条 user/message **不会**唤醒
 * driver 开新一轮。
 *
 * @param ctx - registrant context carrying the agent registry.
 * @param session - 事件所属会话。
 * @returns 该会话的 agent；找不到时为 null。
 */
function agentForSession(ctx, session) {
  try {
    const list = ctx.get('agents')?.list?.() ?? []
    return list.find(agent => agent?.session === session)
      ?? list.find(agent => session?.id !== undefined && agent?.session?.id === session.id)
      ?? null
  } catch {
    return null
  }
}

/**
 * 构造一条"替用户发出的" `user/message`。
 *
 * 语义等价于框架的 `createUserMessage`（`llm/src/message.ts`：`deepFreeze(structuredClone(…))`
 * + 新 id）。这里手写而不是 import：`@deepseek-ai/dsh-llm` 在 harness 根 node_modules 里
 * 并不存在，裸导入会解析失败（插件只保证 `@deepseek-ai/dsh-tools` 可解析）。
 *
 * `source.kind` 保持 `'user'`：preset 的 `messageSources` 白名单只放行 user/goal，
 * 换成 plugin 来源可能被过滤出模型表面。
 *
 * @returns 冻结的 user 消息。
 */
function continueMessage() {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: CONTINUE_TEXT })]),
    source: Object.freeze({ kind: 'user' }),
  })
}

/**
 * 一轮因**输出 token 上限**结束时，替用户发一句"继续"，让对话自己走下去。
 *
 * 触发条件是 `turn/end` 且 `reason.kind === 'max-tokens'`（DeepSeek 适配器把
 * `finish_reason: 'length'` 映射成它，且该状态在整轮内"粘住"）。实机里最常见的成因：
 * 压缩后 preset 把下一个请求的输出预算压到很小的窗口，而 high 推理光思考就用满该预算，
 * 正文 0 字被判截断（见 docs/design.md §7）。
 *
 * 连续次数有上限，避免"截断→续写→又截断"无止境烧 token；任一轮正常结束即清零。
 *
 * @param ctx - registrant context carrying the agent registry, logger, and token meter.
 * @param session - 事件所属会话。
 * @param event - 已追加的 `turn/end` 事件。
 * @param max - 该会话允许的最大连续续写次数。
 * @param noticeEnabled - 是否播报（设置优先，其次本挂载行配置）。
 */
function continueFor(ctx, session, event, max, noticeEnabled) {
  if (event.data?.reason?.kind !== 'max-tokens') {
    // 正常结束的一轮：续写额度归还。
    autoContinues.delete(session)
    return
  }
  const agent = agentForSession(ctx, session)
  if (agent === null || typeof agent.followup !== 'function') return
  const used = (autoContinues.get(session) ?? 0) + 1
  autoContinues.set(session, used)
  if (used > max) {
    if (noticeEnabled) {
      appendNotice(
        ctx,
        session,
        `连续 ${max} 次被输出上限截断，已停止自动续写`,
        `⚠️ 连续 ${max} 轮都因输出 token 上限被截断，已停止自动续写，避免继续消耗。\n`
        + '请手动发送"继续"，或调大输出预算（预设里的 `bootstrapMaxTokens`，或模型的 maxTokens）。\n'
        + '这是一条状态提示，不需要回应。',
      )
    }
    return
  }
  // 先离开当前事件派发，再开新一轮，避免在会话观察者回调里重入 driver。
  setTimeout(() => {
    try {
      agent.followup(continueMessage())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`compact-agents: auto-continue failed: ${message}`)
    }
  }, 0)
  if (noticeEnabled) {
    appendNotice(
      ctx,
      session,
      `上一轮被输出上限截断，已自动续写（${used}/${max}）`,
      `⏩ 上一轮因输出 token 上限被截断，已自动替你发送"继续"（第 ${used}/${max} 次）。\n`
      + '这是一条状态提示，不需要回应。',
    )
  }
}

/**
 * 订阅会话追加事件：压缩生命周期在对话区可见，被输出上限截断的轮次自动续写。
 *
 * `session/event` 是提交后同步派发的观察者feed；`compaction/start` 在摘要模型调用之前
 * 追加，所以这里能在"等待模型"那段开始时就提示，而不是等压缩结束。
 *
 * 两个旋钮每次事件现算：设置界面改过就以设置为准（立即生效），没改过就用**本挂载**的
 * 行配置 —— 一个进程里可能同时挂着好几个 preset，行配置各不相同，不能互相串。
 *
 * @param ctx - registrant context carrying the session feed, agents, and logger.
 * @param mount - 本挂载的行配置（作文层兜底）。
 */
function registerSessionWatch(ctx, mount) {
  if (typeof ctx.on !== 'function') return
  ctx.on('session/event', (session, event) => {
    const type = event?.type
    try {
      // 顺序要紧：**先**反证上一次热同步，**再**把新值同步进去。
      // 反过来的话，本次压缩的 token 数（还是按旧阈值判出来的）会被当成新阈值的证据，
      // 结果自己冤枉自己。
      if (mount.livePresetParams !== false) {
        if (type === 'compaction/start') verifyPatch(ctx, session, measureTokens(ctx, session), event)
        syncPresetParams(ctx, currentPresetValues(), routedTargetOf(session))
      }
      const notice = liveConfig.notice ?? mount.notice
      const maxAutoContinues = liveConfig.maxAutoContinues ?? mount.maxAutoContinues
      const preemptiveRatio = liveConfig.preemptiveRatio ?? mount.preemptiveRatio
      if (notice
        && (type === 'compaction/start' || type === 'compaction/summary' || type === 'compaction/end')) {
        noticeFor(ctx, session, event)
      }
      if (type === 'turn/end') {
        // 顺序：先排预压（把摘要挪到本轮之后），再决定要不要自动续写。
        // 预压只是"排队"，真正的压缩等 agent 真的 idle 了才跑。
        if (preemptiveRatio > 0) schedulePreemptive(ctx, session, preemptiveRatio)
        if (maxAutoContinues > 0) continueFor(ctx, session, event, maxAutoContinues, notice)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`compact-agents: session watch failed: ${message}`)
    }
  })
}

const DESCRIPTION_HEAD =
  'Compress the conversation context NOW. Call this tool immediately whenever the user asks to '
  + 'compress / compact the context or complains that a session is too long — including terse or '
  + 'colloquial phrasings such as "压一遍", "压缩一下", "压一下上下文", "compact the context", '
  + '"free up context". This tool IS that action: do NOT ask a clarifying question first, and do '
  + 'NOT go looking for a plugin or a settings page. Choose the scope yourself — normally '
  + '"others" to sweep every other live session — and run it. It force-compacts sessions, '
  + 'ignoring the automatic pressure threshold, and every live session in the process is a '
  + 'candidate: the main session, ordinary sub-agents, and team members alike. Each target is '
  + 'compacted through the manual entry point, so a session is reduced even when it is nowhere '
  + 'near the automatic trigger line.'

const DESCRIPTION_TAIL =
  ' A target must be idle to compact immediately. A session that is mid-turn is either queued '
  + '(the default: it is compacted the moment that session next goes idle) or reported as '
  + '`busy`. The CALLING session is always mid-turn while it runs this tool, so it always takes '
  + 'the queued path and is compacted at the end of its own turn — that is how a main session '
  + 'without any sub-agents compacts itself. Only a top-level agent may sweep other agents; a '
  + 'sub-agent may only use `scope: "self"`.'

/**
 * Pick the agents this call should compact.
 * @param ctx - registrant context carrying the live agent registry.
 * @param caller - the agent on whose behalf the call runs, when the loop set one.
 * @param args - validated tool arguments.
 * @returns the target agents, in registry (registration) order.
 */
function selectTargets(ctx, caller, args) {
  const live = ctx.agents.list()
  if (args.scope === 'self') return caller === undefined ? [] : [caller]
  if (args.scope === 'ids') {
    const wanted = new Set(args.ids ?? [])
    return live.filter(agent => wanted.has(agent.id))
  }
  if (args.scope === 'all') return live
  return live.filter(agent => agent !== caller)
}

/**
 * Refuse a sweep from anything but a top-level agent, so a team member cannot
 * compact its peers or its captain.
 * @param ctx - registrant context carrying the live agent registry.
 * @param caller - the agent on whose behalf the call runs.
 * @param scope - the requested range.
 */
function assertMaySweep(ctx, caller, scope) {
  if (scope === 'self') return
  if (caller !== undefined && ctx.agents.roots().includes(caller)) return
  throw new Error(
    'compact_agents: only a top-level agent may compact other agents; '
    + 'use scope: "self" to compact your own session',
  )
}

/**
 * Compact one agent the moment it next goes idle.
 *
 * Registered on the plugin's own context, so the listener dies with the plugin.
 * @param ctx - registrant context carrying the agent registry and logger.
 * @param agent - the busy agent to compact later.
 * @param options - optional bookkeeping hooks.
 * @param options.reason - log label; `'deferred'` for a tool-driven queue (the default),
 *   `'preemptive'` for the end-of-turn pre-compaction.
 * @param options.after - called with the result and whether the call threw
 *   (`result === null` means nothing was safely compactable). The pre-compaction path
 *   uses it to back off after a `noop`; a call that *threw* says nothing about the
 *   context shape, so it must not be mistaken for one.
 * @returns true when this call queued it, false when one was already queued.
 */
function scheduleWhenIdle(ctx, agent, options = {}) {
  const id = String(agent.id)
  if (scheduled.has(id)) return false
  scheduled.add(id)
  const reason = typeof options.reason === 'string' ? options.reason : 'deferred'
  let fired = false
  const stop = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (fired || status !== 'idle' || String(subject.id) !== id) return
    fired = true
    stop()
    scheduled.delete(id)
    void (async () => {
      let result = null
      let failed = false
      try {
        // 这是我们自己要求的压缩：它的 token 数不代表策略阈值，别拿它反证热同步。
        markSelfCompaction(agent)
        result = await ctx.compaction.compactNow(agent, new AbortController().signal)
        ctx.logger.info(result === null
          ? `compact-agents: ${reason} compaction of ${id} found nothing safely compactable`
          : `compact-agents: ${reason} compaction of ${id} shadowed `
            + `${result.shadowedSeqs.length} nodes (~${result.shadowedTokenCount} tokens)`)
      } catch (error) {
        failed = true
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`compact-agents: ${reason} compaction of ${id} failed: ${message}`)
      } finally {
        if (typeof options.after === 'function') {
          try {
            options.after(result, failed)
          } catch {
            // 记账失败不该影响一次已经完成的压缩。
          }
        }
      }
    })()
  })
  return true
}

/**
 * 一轮结束时判定"快到触发线了"，是就把这次压缩提前做掉。
 *
 * 为什么需要它：`compaction-basic` 的达线判定挂在 `agent/pre-step`，也就是**每个模型请求
 * 之前**（`packages/compaction/compaction-basic/src/index.ts`），包含新一轮的第一个请求 ——
 * 而那时用户的新消息已经进会话了。于是最常见的那种情况（上一轮结束时差一点、新消息一进来
 * 就跨线）会让摘要模型跑在**第一个 token 之前**，表现成"开头卡顿、等半天才出字"。
 *
 * 这里把判定点前移一个回合：达线兜底仍归引擎，我们只负责把"即将达线"的那一次挪进"回答已
 * 交付、用户正在读"的空档里。代价与边界：
 *
 * - 只搬不消灭 —— 用户若立刻追问，等待照样发生（只是等的东西不同）；
 * - 会为"聊到线附近就收工"的会话多付一次摘要调用，所以判定带要贴着线（默认 0.9），
 *   而不是"每轮结束都压一遍"；
 * - 压不动（`noop`，例如单个超大保留单元）的会话要退避，否则每轮白试一次；
 * - 预压**不能**覆盖"跨线是用户新消息自己造成的"那一半（那时还不在带内）。
 *
 * 真正的压缩交给 {@link scheduleWhenIdle}：此刻 agent 还在收尾，等它真的 idle 了再动手，
 * 绝不与进行中的回合抢（`compactNow` 走 `agent.runMaintenance`，忙时会抛）。
 *
 * @param ctx - registrant context carrying the compaction service and logger.
 * @param session - 刚结束一轮的会话。
 * @param ratio - 预压比例（触发线的占比）；调用处已排除 0。
 */
function schedulePreemptive(ctx, session, ratio) {
  const agent = agentForSession(ctx, session)
  if (agent === null) return
  const line = effectiveLine(ctx, session)
  if (line === null) return
  const tokens = measureTokens(ctx, session)
  if (tokens === null || tokens < line * ratio) return
  const id = String(agent.id)
  const last = preemptiveNoop.get(id)
  if (typeof last === 'number' && tokens < last * (1 + PREEMPTIVE_RETRY_GROWTH)) return
  const queued = scheduleWhenIdle(ctx, agent, {
    reason: 'preemptive',
    after: (result, failed) => {
      // 只有"真的压不动"才退避；因为忙或报错而没跑成的，下一轮还要再试。
      if (failed) return
      if (result === null) preemptiveNoop.set(id, tokens)
      else preemptiveNoop.delete(id)
    },
  })
  if (!queued) return
  markPreemptive(session)
  ctx.logger.info(
    `compact-agents: ${id} 一轮结束时已贴近触发线（约 ${group(tokens)} / ${group(Math.round(line))} tokens，`
    + `带 ${ratio}），已排队提前压缩`,
  )
}

/**
 * Compact one agent, translating every outcome into a report row.
 * @param ctx - registrant context carrying the compaction seam.
 * @param agent - the agent to compact.
 * @param signal - cancellation signal of this tool call.
 * @param whenBusy - what to do when the agent is mid-turn.
 * @returns one structured result row.
 */
async function compactOne(ctx, agent, signal, whenBusy) {
  const id = String(agent.id)
  const before = measureTokens(ctx, agent.session)
  try {
    // 同上：工具触发的压缩随时可能发生，不当作阈值证据。
    markSelfCompaction(agent)
    const result = await ctx.compaction.compactNow(agent, signal)
    const after = measureTokens(ctx, agent.session)
    if (result === null) {
      return {
        id,
        status: 'noop',
        shadowedNodes: 0,
        shadowedTokens: 0,
        beforeTokens: before ?? -1,
        afterTokens: after ?? -1,
        detail: 'nothing safely compactable (empty session, or one oversized retained unit)',
      }
    }
    return {
      id,
      status: 'compacted',
      shadowedNodes: result.shadowedSeqs.length,
      shadowedTokens: result.shadowedTokenCount,
      beforeTokens: before ?? -1,
      afterTokens: after ?? -1,
      detail: `shadowed surface ${String(result.shadowedRange.start)}-${String(result.shadowedRange.end)}`,
    }
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : ''
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'busy' && whenBusy === 'queue') {
      const queued = scheduleWhenIdle(ctx, agent)
      return {
        id,
        status: 'queued',
        shadowedNodes: 0,
        shadowedTokens: 0,
        beforeTokens: before ?? -1,
        afterTokens: -1,
        detail: queued
          ? 'mid-turn; queued and will be compacted as soon as it goes idle'
          : 'mid-turn; already queued by an earlier call',
      }
    }
    if (code === 'busy') {
      return {
        id,
        status: 'busy',
        shadowedNodes: 0,
        shadowedTokens: 0,
        beforeTokens: before ?? -1,
        afterTokens: -1,
        detail: 'mid-turn; manual compaction needs an idle session (whenBusy: "skip")',
      }
    }
    return {
      id,
      status: 'error',
      shadowedNodes: 0,
      shadowedTokens: 0,
      beforeTokens: before ?? -1,
      afterTokens: -1,
      detail: `${code === '' ? 'error' : code}: ${message}`,
    }
  }
}

/**
 * Fold the per-agent rows into the tool's canonical output value.
 * @param requested - how many agents this call selected.
 * @param missingIds - requested ids that name no live agent.
 * @param rows - one row per selected agent.
 * @returns the canonical output value.
 */
function summarize(requested, missingIds, rows) {
  const count = status => rows.filter(row => row.status === status).length
  return {
    requested,
    compacted: count('compacted'),
    queued: count('queued'),
    skipped: count('noop') + count('busy'),
    failed: count('error'),
    missingIds,
    results: rows,
  }
}

/**
 * Render the canonical output value as the model-facing text block.
 * @param value - the canonical output value.
 * @returns the result content blocks.
 */
function render(value) {
  const lines = [
    `compact_agents: ${value.compacted} compacted, ${value.queued} queued, `
    + `${value.skipped} skipped, ${value.failed} failed (of ${value.requested} selected).`,
  ]
  for (const row of value.results) {
    const measured = row.beforeTokens >= 0 && row.afterTokens >= 0
      ? `~${group(row.beforeTokens)} → ~${group(row.afterTokens)} tokens`
      : `~${group(row.shadowedTokens)} tokens shadowed`
    const size = row.status === 'compacted' || row.status === 'noop'
      ? `, ${measured}`
      : ''
    lines.push(`- ${row.id}: ${row.status}${size} — ${row.detail}`)
  }
  if (value.missingIds.length > 0) {
    lines.push(`- no live agent for: ${value.missingIds.join(', ')}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Register the `compact_agents` tool, the in-conversation compaction notices,
 * the auto-continue safety net, and the Settings surface.
 * @param ctx - registrant context carrying the tool, compaction, session feed, settings, and agent services.
 * @param config - optional row config; `notice: false` turns the notices off,
 *   `maxAutoContinues` (default 2, `0`/`false` off) bounds the automatic "继续" turns,
 *   `preemptiveRatio` (default 0.9, `0`/`false` off) pre-compacts at the end of a turn
 *   once occupancy reaches that share of the trigger line,
 *   `settings: false` turns the Settings namespace off. All three knobs are the composition
 *   layer, so the Settings UI overrides them and — unlike the row config — applies live.
 */
export function apply(ctx, config) {
  // 行配置进「本挂载的兜底层」；设置界面里改过的值(用户层)会在事件发生时盖过它。
  const mount = {
    notice: config?.notice !== false,
    maxAutoContinues: resolveMaxAutoContinues(config),
    preemptiveRatio: resolvePreemptiveRatio(config),
    // `livePresetParams: false` 关掉"把 preset 参数热同步给运行中的会话"。
    livePresetParams: config?.livePresetParams !== false,
  }
  // 记下这一代：设置界面保存后要能把新值同步进**每一代**正在跑的 `compaction-basic`。
  const record = { ctx }
  liveMounts.add(record)
  if (typeof ctx.on === 'function') ctx.on('dispose', () => liveMounts.delete(record))
  registerSessionWatch(ctx, mount)
  if (mount.livePresetParams) syncPresetParams(ctx)
  void registerSettings(ctx, config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`compact-agents: settings registration failed: ${message}`)
  })
  ctx.tools.register(defineTool({
    name: 'compact_agents',
    description: DESCRIPTION_HEAD + DESCRIPTION_TAIL,
    parameters: {
      scope: {
        type: 'string',
        required: true,
        enum: [...SCOPES],
        description: 'Which live sessions to compact. "others" = every live agent except you '
          + '(the default for a sweep); "all" = every live agent including you; "self" = only '
          + 'your own session (works with no sub-agents at all); "ids" = exactly the agents '
          + 'named in `ids`.',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Agent/session ids to compact. Required when scope is "ids".',
      },
      whenBusy: {
        type: 'string',
        enum: [...WHEN_BUSY],
        description: '"queue" (default): a session that is mid-turn is compacted as soon as it '
          + 'goes idle. "skip": report it as `busy` and leave it untouched.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requested: { type: 'integer', required: true },
          compacted: { type: 'integer', required: true },
          queued: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          missingIds: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                status: {
                  type: 'string',
                  required: true,
                  enum: ['compacted', 'queued', 'noop', 'busy', 'error'],
                },
                shadowedNodes: { type: 'integer', required: true },
                shadowedTokens: { type: 'integer', required: true },
                // -1 表示计量服务测不到（例如没有 tokenMeter）。
                beforeTokens: { type: 'integer', required: true },
                afterTokens: { type: 'integer', required: true },
                detail: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => render(value),
    },
    // A sweep of several sessions is several serial summarization calls; the
    // default call timeout is far too short for that. Deferred work is not
    // covered by this timeout — it runs after the turn, off the tool call.
    timeoutMs: 30 * 60 * 1000,
    // 这里必须是**谓词**而不是布尔值：`defineTool` 只在选项为真值时才保留该字段
    // （`@deepseek-ai/dsh-tools` 的 schema.ts：`if (userIsConcurrencySafe)`），
    // 所以字面量 `false` 会被静默丢掉。返回 false 让它落进 fail-closed 的
    // `exclusive` 调度模式 —— 一次扫描不该和另一个可能压同一会话的调用并行。
    isConcurrencySafe: () => false,
    async execute(args, run) {
      const scope = args.scope ?? 'others'
      const whenBusy = args.whenBusy ?? 'queue'
      assertMaySweep(ctx, run.agent, scope)
      const targets = selectTargets(ctx, run.agent, args)
      const liveIds = new Set(ctx.agents.list().map(agent => String(agent.id)))
      const missingIds = scope === 'ids'
        ? (args.ids ?? []).filter(id => !liveIds.has(String(id)))
        : []
      const results = []
      for (const target of targets) {
        results.push(await compactOne(ctx, target, run.signal, whenBusy))
      }
      return summarize(targets.length, missingIds, results)
    },
  }))
}
