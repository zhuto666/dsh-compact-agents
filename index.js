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
import { currentPresetThreshold, liveConfig, registerSettings, resolveMaxAutoContinues } from './settings.js'

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
 * `deepFreeze`），之后改 preset 只对之后新建的会话生效（`agent-presets` 的 standing mount 按
 * 文件戳换代，已加入的会话保留自己那一代）。于是"我改成 0.5 了，怎么还在 200K 压"是几乎必然
 * 撞上的困惑 —— 提示里同时给出两个值，用户自己就能看出原因。
 *
 * 读不到就返回 null（整句不出现），不让"报诊断"变成新的失败点：
 * 服务不是那个实现、配置里按模型覆盖了阈值（`modelPolicies`，此时全局值并非实际生效值）都算读不到。
 *
 * @param ctx - registrant context carrying the compaction service.
 * @returns `{ mounted, current, stale }`；`mounted` 为 null 表示读不到。
 */
function thresholdState(ctx) {
  let mounted = null
  try {
    const config = ctx.compaction?.config
    if (config !== undefined && typeof config.thresholdRatio === 'number'
      && !(Array.isArray(config.modelPolicies) && config.modelPolicies.length > 0)) {
      mounted = config.thresholdRatio
    }
  } catch {
    mounted = null
  }
  if (mounted === null) return null
  const current = currentPresetThreshold()
  return { mounted, current, stale: current !== null && current !== mounted }
}

/** 折叠行上的触发线附注；读不到阈值时为空串。 */
function thresholdSuffix(state) {
  return state === null ? '' : ` · 触发线 ×${state.mounted}`
}

/** "preset 已改、本会话还是旧代际"那句提醒；不需要提醒时为空串。 */
function staleLine(state) {
  if (state === null || !state.stale) return ''
  return `⚠️ preset 文件里现在是 ×${state.current}，本会话仍按 ×${state.mounted}：`
    + '压缩参数在会话建立时读取，新开一条对话才会用上新值。\n'
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
    const threshold = thresholdState(ctx)
    appendNotice(
      ctx,
      session,
      (before === null ? '正在压缩上下文…' : `正在压缩上下文…（当前 ${group(before)} tokens）`)
      + thresholdSuffix(threshold),
      '⏳ 上下文已达压缩阈值，正在压缩上下文。\n'
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
    + staleLine(thresholdState(ctx))
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
        + '请手动发送"继续"，或调大输出预算（preset 的 `bootstrapMaxTokens`、或模型的 maxTokens）。\n'
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
      const notice = liveConfig.notice ?? mount.notice
      const maxAutoContinues = liveConfig.maxAutoContinues ?? mount.maxAutoContinues
      if (notice
        && (type === 'compaction/start' || type === 'compaction/summary' || type === 'compaction/end')) {
        noticeFor(ctx, session, event)
      }
      if (maxAutoContinues > 0 && type === 'turn/end') {
        continueFor(ctx, session, event, maxAutoContinues, notice)
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
 * @returns true when this call queued it, false when one was already queued.
 */
function scheduleWhenIdle(ctx, agent) {
  const id = String(agent.id)
  if (scheduled.has(id)) return false
  scheduled.add(id)
  let fired = false
  const stop = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (fired || status !== 'idle' || String(subject.id) !== id) return
    fired = true
    stop()
    scheduled.delete(id)
    void (async () => {
      try {
        const result = await ctx.compaction.compactNow(agent, new AbortController().signal)
        ctx.logger.info(result === null
          ? `compact-agents: deferred compaction of ${id} found nothing safely compactable`
          : `compact-agents: deferred compaction of ${id} shadowed `
            + `${result.shadowedSeqs.length} nodes (~${result.shadowedTokenCount} tokens)`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`compact-agents: deferred compaction of ${id} failed: ${message}`)
      }
    })()
  })
  return true
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
 *   `settings: false` turns the Settings namespace off. Both knobs are the composition
 *   layer, so the Settings UI overrides them and — unlike the row config — applies live.
 */
export function apply(ctx, config) {
  // 行配置进「本挂载的兜底层」；设置界面里改过的值(用户层)会在事件发生时盖过它。
  const mount = {
    notice: config?.notice !== false,
    maxAutoContinues: resolveMaxAutoContinues(config),
  }
  registerSessionWatch(ctx, mount)
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
