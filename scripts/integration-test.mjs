/**
 * 真机加载测试：不是假 ctx，而是**真的 cordis Context + 真的 ToolRuntime**。
 *
 * 目的：证明 preset 里那一行(`<repo>/index.js` 绝对路径)真的能被加载、
 * `inject` 真的能解析、`ctx.tools.register(defineTool(...))` 真的能被注册表接受、
 * 并且注册后能用 `ctx.tools.get('compact_agents')` 查到、参数 schema 真的能解析。
 * 这些是单元测试（假 ctx）覆盖不到的部分。
 *
 * 为了不起整个 Harness，只把三个被依赖的服务做成最小桩：
 *   - systemPrompt：ToolRuntime 构造时要用（`ctx.systemPrompt.tools()`）；
 *   - compaction   ：本插件只调 `compactNow`；
 *   - agents       ：本插件只调 `list/roots/get`。
 * 工具注册表本身是真的，所以注册/校验/可见性都是真行为。
 *
 * 运行：node scripts/integration-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { setPresetFilesForTest } from '../settings.js'
import { resetHotSyncStateForTest } from '../index.js'
import * as plugin from '../index.js'

/** ToolRuntime 构造期需要的最小 systemPrompt 桩。 */
class StubSystemPrompt extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt')
    /** 记录 ToolRuntime 注册过的 hook，便于断言它确实跑起来了。 */
    this.calls = []
  }

  tools(hook) {
    this.calls.push(['tools', hook])
    return () => {}
  }

  section(section) {
    this.calls.push(['section', section])
    return () => {}
  }

  getSectionOrder() {
    return 0
  }
}

/** 只实现本插件真正调用的 `compactNow`；顺带把计量值改小，模拟"压完变小"。 */
class StubCompaction extends Service {
  constructor(ctx) {
    super(ctx, 'compaction')
    this.calls = 0
  }

  async compactNow() {
    this.calls += 1
    const meter = this.ctx.get('tokenMeter')
    if (meter !== undefined) meter.total = 500
    return {
      shadowedRange: { start: 1, end: 2 },
      shadowedSeqs: [1, 2],
      shadowedTokenCount: 4242,
    }
  }
}

/** 只实现本插件真正调用的 `measure`；总数可写，便于制造"压缩前后"。 */
class StubTokenMeter extends Service {
  constructor(ctx) {
    super(ctx, 'tokenMeter')
    this.total = 1000
  }

  measure() {
    return { totalTokens: this.total }
  }
}

/**
 * 只实现本插件真正调用的 `resolveModelInfo`：热同步的效果校验要拿它换算出 token 触发线。
 * 窗口做成可写的，测试里模拟"1M 窗口 × 0.2 = 200K 就该压"这种现场。
 */
class StubLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
    this.contextWindow = 1_000_000
    this.lookups = 0
  }

  async resolveModelInfo() {
    this.lookups += 1
    return { context: { contextWindow: this.contextWindow } }
  }
}

/** 一个记录了每次 `append` 的假会话，用来断言插件往表面写了什么。 */
function fakeSession(id) {
  const appended = []
  return {
    id,
    appended,
    append(type, data, opts) {
      appended.push({ type, data, opts })
    },
  }
}

/** 只实现本插件真正调用的注册表读接口；顺带记录自动续写发出的消息。 */
class StubAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    /** 一个假的“顶级会话”和一个假的“子代理”。 */
    this.rootAgent = {
      id: 'session-root',
      session: fakeSession('session-root'),
      followups: [],
      followup(message) {
        this.followups.push(message)
      },
    }
    this.childAgent = {
      id: 'session-child',
      session: fakeSession('session-child'),
      followups: [],
      followup(message) {
        this.followups.push(message)
      },
    }
  }

  list() {
    return [this.rootAgent, this.childAgent]
  }

  roots() {
    return [this.rootAgent]
  }

  get(id) {
    return this.list().find(agent => agent.id === id)
  }
}

let failed = 0
/** @param {string} label @param {boolean} ok @param {string} extra */
function check(label, ok, extra = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra === '' ? '' : ` — ${extra}`}`)
  if (!ok) failed += 1
}

const ctx = new Context()
ctx.plugin(StubSystemPrompt)
ctx.plugin(ToolRuntime)
ctx.plugin(StubCompaction)
ctx.plugin(StubTokenMeter)
ctx.plugin(StubLlm)
ctx.plugin(StubAgents)
ctx.plugin(plugin)

// cordis 的插件加载是异步推进的；让 inject 有机会解析完。
await new Promise(resolve => setTimeout(resolve, 200))

// 1. 插件真的被加载了。
check('plugin applied (inject resolved)', ctx.tools !== undefined)

// 2. 工具真的进了真注册表，并且带 schema。
const def = ctx.tools.get('compact_agents')
check('ctx.tools.get("compact_agents") resolves', def !== undefined)
if (def === undefined) {
  console.log(`\n${failed} failure(s)`)
  process.exit(1)
}

check('definition has parameters', def.parameters !== undefined)
check('definition has output', def.output !== undefined)
check('timeoutMs preserved', def.timeoutMs === 30 * 60 * 1000, String(def.timeoutMs))
check('isConcurrencySafe is a predicate returning false',
  typeof def.isConcurrencySafe === 'function' && def.isConcurrencySafe({}) === false,
  String(def.isConcurrencySafe))

// 真实调度判定：注册表真的把这次调用算成 exclusive（串行），而不是并行组。
const mode = ctx.tools.executionMode({ name: 'compact_agents', arguments: { scope: 'others' } })
check('scheduler mode is exclusive', mode.kind === 'exclusive', JSON.stringify(mode))

// 3. ToolRuntime 构造期确实问过 systemPrompt（说明真服务起来了，不是空壳）。
const prompt = ctx.get('systemPrompt')
check('ToolRuntime wired into systemPrompt', prompt.calls.some(([kind]) => kind === 'tools'))

// 4. 端到端执行一次：真 execute + 真 output schema 校验。
const rootAgent = ctx.get('agents').rootAgent
ctx.get('tokenMeter').total = 213400
const output = await def.execute(
  { scope: 'others', whenBusy: 'skip' },
  { agent: rootAgent, signal: new AbortController().signal, deferContext() {} },
)
check('execute(scope=others) returns a value', output !== undefined)
check('child compacted, caller excluded', output.compacted === 1 && output.requested === 1,
  `compacted=${output.compacted} requested=${output.requested}`)
check('row reports real numbers from CompactionResult',
  output.results[0].shadowedNodes === 2 && output.results[0].shadowedTokens === 4242,
  JSON.stringify(output.results[0]))
check('row reports measured before/after tokens',
  output.results[0].beforeTokens === 213400 && output.results[0].afterTokens === 500,
  `before=${output.results[0].beforeTokens} after=${output.results[0].afterTokens}`)

// 5. 渲染块可生成（模型侧真正看到的东西）。
const blocks = def.output.render({}, output)
check('render produces one text block',
  blocks.length === 1 && blocks[0].type === 'text' && blocks[0].text.includes('compact_agents:'))

// 6. 非顶级会话不得扫别人。
let refused = false
try {
  await def.execute(
    { scope: 'others' },
    { agent: ctx.get('agents').childAgent, signal: new AbortController().signal, deferContext() {} },
  )
} catch {
  refused = true
}
check('sub-agent sweep refused', refused)

// 7. self 在忙时必须走排队路径，而不是报错。
const busyCompaction = ctx.get('compaction')
busyCompaction.compactNow = async () => {
  const error = new Error('session is busy')
  error.code = 'busy'
  throw error
}
const selfOut = await def.execute(
  { scope: 'self', whenBusy: 'queue' },
  { agent: rootAgent, signal: new AbortController().signal, deferContext() {} },
)
check('scope=self while busy queues instead of failing', selfOut.queued === 1,
  JSON.stringify(selfOut.results[0]))

// 8. 压缩提示：`compaction/start` 一落地就能在对话区看到，结束时给出前后对比。
// 这里直接 `ctx.emit`，等价于 SessionStore 提交后的观察者派发。
const surface = rootAgent.session
const meter = ctx.get('tokenMeter')
const noticeAt = () => surface.appended.at(-1)

meter.total = 213400
await ctx.emit('session/event', surface, {
  type: 'compaction/start', seq: 1, time: 0, data: { compactionId: 'c1', turn: 3 },
})
const started = noticeAt()
check('compaction/start appends a visible notice', surface.appended.length === 1,
  `${surface.appended.length} append(s)`)
check('notice is a plugin-sourced user message',
  started?.type === 'user/message' && started.data.role === 'user'
  && started.data.source?.kind === 'plugin' && started.data.source.plugin === 'dsh-compact-agents',
  JSON.stringify(started?.data?.source))
check('notice renders as a notice-form context row',
  started?.data?.source?.form === 'notice' && typeof started.data.source.summary === 'string',
  String(started?.data?.source?.form))
check('running notice carries the pre-compaction size',
  String(started?.data?.source?.summary).includes('正在压缩上下文')
  && String(started?.data?.source?.summary).includes('213,400'),
  String(started?.data?.source?.summary))
check('notice joins the surface tail', started?.opts?.surfaceOp === 'append',
  JSON.stringify(started?.opts))
check('notice carries a non-empty message id (session validation requires one)',
  typeof started?.data?.id === 'string' && started.data.id.length > 0, String(started?.data?.id))

meter.total = 49800
await ctx.emit('session/event', surface, {
  type: 'compaction/summary', seq: 2, time: 0,
  data: { compactionId: 'c1', shadowedSeqs: [11, 12], shadowedTokenCount: 163600 },
})
await ctx.emit('session/event', surface, {
  type: 'compaction/end', seq: 3, time: 0, data: { compactionId: 'c1', turn: 3 },
})
check('compaction/end reports before → after plus the shadowed count',
  String(noticeAt()?.data?.source?.summary).includes('213,400 → 49,800')
  && String(noticeAt()?.data?.source?.summary).includes('已遮蔽 2 个历史节点'),
  String(noticeAt()?.data?.source?.summary))

await ctx.emit('session/event', surface, {
  type: 'compaction/start', seq: 4, time: 0, data: { compactionId: 'c2', turn: 4 },
})
const beforeFailure = surface.appended.length
await ctx.emit('session/event', surface, {
  type: 'compaction/end', seq: 5, time: 0,
  data: { compactionId: 'c2', turn: 4, error: 'summarize failed' },
})
check('a failed compaction reports the failure instead of numbers',
  surface.appended.length === beforeFailure + 1
  && String(noticeAt()?.data?.source?.summary).includes('未完成'),
  String(noticeAt()?.data?.source?.summary))

const quietCount = surface.appended.length
await ctx.emit('session/event', surface, { type: 'assistant/message', seq: 6, time: 0, data: {} })
check('unrelated session events produce no notice', surface.appended.length === quietCount,
  `${surface.appended.length} vs ${quietCount}`)

// 9. 行配置 `notice: false` 关掉提示，但工具仍在。
const quietCtx = new Context()
quietCtx.plugin(StubSystemPrompt)
quietCtx.plugin(ToolRuntime)
quietCtx.plugin(StubCompaction)
quietCtx.plugin(StubTokenMeter)
quietCtx.plugin(StubAgents)
quietCtx.plugin(plugin, { notice: false })
await new Promise(resolve => setTimeout(resolve, 200))
const quietSurface = quietCtx.get('agents').rootAgent.session
await quietCtx.emit('session/event', quietSurface, {
  type: 'compaction/start', seq: 1, time: 0, data: { compactionId: 'c9', turn: 1 },
})
check('notice: false disables the notice', quietSurface.appended.length === 0,
  `${quietSurface.appended.length} append(s)`)
check('notice: false keeps the tool registered',
  quietCtx.tools.get('compact_agents') !== undefined)

// 10. 被输出上限截断的轮次：自动替用户发"继续"（有次数上限，正常结束即清零）。
const followups = rootAgent.followups
const maxTokensEnd = (turn, seq) => ({
  type: 'turn/end', seq, time: 0, data: { turn, reason: { kind: 'max-tokens' } },
})
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

await ctx.emit('session/event', surface, maxTokensEnd(1, 901))
await settle()
check('a max-tokens turn end auto-continues once', followups.length === 1,
  `${followups.length} followup(s)`)
check('the auto-continue message is a plain user "继续"',
  followups[0]?.content?.[0]?.text === '继续' && followups[0]?.source?.kind === 'user',
  JSON.stringify(followups[0]))
check('the auto-continue message is identified and frozen',
  Object.isFrozen(followups[0]) && typeof followups[0].id === 'string' && followups[0].id.length > 0
  && Object.isFrozen(followups[0].content),
  `frozen=${Object.isFrozen(followups[0])} id=${followups[0]?.id}`)
check('auto-continue is announced in the conversation',
  String(noticeAt()?.data?.source?.summary).includes('已自动续写（1/2）'),
  String(noticeAt()?.data?.source?.summary))

await ctx.emit('session/event', surface, maxTokensEnd(2, 902))
await settle()
check('a second consecutive truncation continues again', followups.length === 2,
  `${followups.length} followup(s)`)

await ctx.emit('session/event', surface, maxTokensEnd(3, 903))
await settle()
check('the auto-continue budget stops the loop', followups.length === 2,
  `${followups.length} followup(s)`)
check('the exhausted budget is reported',
  String(noticeAt()?.data?.source?.summary).includes('已停止自动续写'),
  String(noticeAt()?.data?.source?.summary))

await ctx.emit('session/event', surface, {
  type: 'turn/end', seq: 904, time: 0, data: { turn: 4, reason: { kind: 'completed' } },
})
await ctx.emit('session/event', surface, maxTokensEnd(5, 905))
await settle()
check('a completed turn resets the budget',
  followups.length === 3 && String(noticeAt()?.data?.source?.summary).includes('已自动续写（1/2）'),
  `${followups.length} followup(s) / ${String(noticeAt()?.data?.source?.summary)}`)

// 11. `maxAutoContinues: 0` 关掉自动续写（提示不受影响）。
const offCtx = new Context()
offCtx.plugin(StubSystemPrompt)
offCtx.plugin(ToolRuntime)
offCtx.plugin(StubCompaction)
offCtx.plugin(StubTokenMeter)
offCtx.plugin(StubAgents)
offCtx.plugin(plugin, { maxAutoContinues: 0 })
await new Promise(resolve => setTimeout(resolve, 200))
const offAgent = offCtx.get('agents').rootAgent
await offCtx.emit('session/event', offAgent.session, maxTokensEnd(1, 1))
await settle()
check('maxAutoContinues: 0 disables auto-continue', offAgent.followups.length === 0,
  `${offAgent.followups.length} followup(s)`)

// 12. preset 参数热同步：活着的会话不必等新会话。
// 本会话那一代建立时文件里还是 0.2，现在文件已经改成 0.5 —— 插件应当把 0.5 直接写进
// 运行中的 compaction-basic 配置（`config` 是自有可写属性，压力判定每次调用现读它）。
{
  const fixture = path.join(os.tmpdir(), `compact-agents-threshold-${process.pid}.yml`)
  fs.writeFileSync(fixture, [
    '- id: compaction',
    '  name: cordis:group',
    '  config:',
    '    - id: compaction-basic',
    '      config:',
    '        thresholdRatio: 0.5',
    '',
  ].join('\n'))
  setPresetFilesForTest([fixture])
  const compaction = ctx.get('compaction')
  compaction.config = { thresholdRatio: 0.2, retainRatio: 0.05, modelPolicies: [] }
  meter.total = 350000
  await ctx.emit('session/event', surface, {
    type: 'compaction/start', seq: 910, time: 0, data: { compactionId: 'c10', turn: 10 },
  })
  check('a running session picks up the preset threshold without a new conversation',
    compaction.config.thresholdRatio === 0.5, JSON.stringify(compaction.config))
  const summary = String(noticeAt()?.data?.source?.summary)
  check('the notice reports the hot-synced trigger line', summary.includes('触发线 ×0.5'), summary)
  check('a hot-synced session is no longer called stale',
    !String(noticeAt()?.data?.content?.[0]?.text).includes('preset 文件里现在是'), summary)

  // 有按模型覆盖时，同步的是**命中那条**（引擎的 resolveTargetPolicy 也这么选）。
  surface.requestHeader = () => ({ config: { provider: 'p', model: 'm' } })
  compaction.config = {
    thresholdRatio: 0.2,
    retainRatio: 0.05,
    modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.2 }],
  }
  await ctx.emit('session/event', surface, {
    type: 'compaction/start', seq: 911, time: 0, data: { compactionId: 'c11', turn: 11 },
  })
  check('a per-model override is the entry that gets hot-synced',
    compaction.config.modelPolicies[0].thresholdRatio === 0.5
    && compaction.config.thresholdRatio === 0.2,
    JSON.stringify(compaction.config))

  // 先把上一个补丁验证干净（620K 在新线之上），免得待验证状态串到后面的用例。
  meter.total = 620000
  await ctx.emit('session/event', surface, {
    type: 'compaction/start', seq: 9120, time: 0, data: { compactionId: 'c12a', turn: 12 },
  })

  // 同步不进去时（这里用只读属性模拟引擎形状变化）仍要说清两个值与出路。
  Object.defineProperty(compaction, 'config', {
    value: { thresholdRatio: 0.2, retainRatio: 0.05, modelPolicies: [] },
    writable: false,
    configurable: true,
  })
  await ctx.emit('session/event', surface, {
    type: 'compaction/start', seq: 912, time: 0, data: { compactionId: 'c12', turn: 12 },
  })
  const staleBody = String(noticeAt()?.data?.content?.[0]?.text)
  check('when the value cannot be hot-synced both values and the fix are stated',
    compaction.config.thresholdRatio === 0.2
    && staleBody.includes('×0.5') && staleBody.includes('×0.2') && staleBody.includes('新开一条对话'),
    staleBody)

  // 效果校验：值写进去了，引擎到底吃没吃？拿**策略自己决定**的那次压缩反证。
  {
    resetHotSyncStateForTest()
    const llm = ctx.get('llm')
    const restore = () => Object.defineProperty(compaction, 'config', {
      value: { thresholdRatio: 0.2, retainRatio: 0.05, modelPolicies: [] },
      writable: true,
      configurable: true,
    })

    // (a) 反证通过：0.2 → 0.5 之后，压缩发生在 620K（新线 500K 之上），不该有任何提醒。
    restore()
    await ctx.emit('session/event', surface, {
      type: 'compaction/start', seq: 913, time: 0, data: { compactionId: 'c13', turn: 13 },
    })
    check('raising the threshold records a patch that still needs proof',
      compaction.config.thresholdRatio === 0.5, JSON.stringify(compaction.config))
    await settle()
    check('the window lookup is primed at patch time, not at compaction time',
      llm.lookups > 0, `${llm.lookups} lookup(s)`)
    meter.total = 620000
    await ctx.emit('session/event', surface, {
      type: 'compaction/start', seq: 914, time: 0, data: { compactionId: 'c14', turn: 14 },
    })
    // 触发线在折叠行的摘要里，正文里只会有热同步没成功那类提醒。
    const healthy = String(noticeAt()?.data?.source?.summary)
    check('a compaction above the new line passes verification silently',
      healthy.includes('触发线 ×0.5')
      && !String(noticeAt()?.data?.content?.[0]?.text).includes('热同步没成功'), healthy)

    // (b) 回合之间的手动压缩（`turn: null`）在任意 token 数上都会发生，不能拿它冤枉引擎。
    restore()
    await ctx.emit('session/event', surface, {
      type: 'compaction/start', seq: 915, time: 0, data: { compactionId: 'c15', turn: 15 },
    })
    meter.total = 250000
    await ctx.emit('session/event', surface, {
      type: 'compaction/start', seq: 916, time: 0, data: { compactionId: 'c16', turn: null },
    })
    const manual = String(noticeAt()?.data?.source?.summary)
    check('a manual compaction is not taken as proof that hot-sync failed',
      manual.includes('触发线 ×0.5')
      && !String(noticeAt()?.data?.content?.[0]?.text).includes('热同步没成功'), manual)

    // (b2) 我们自己刚请求过压缩的会话也不算证据（工具随时可以压）；对**别的**会话的标记
    //      不该影响本会话取证，所以这条用子代理的会话验证，surface 那边留着给 (c)。
    const child = ctx.get('agents').childAgent
    child.session.requestHeader = () => ({ config: { provider: 'p', model: 'm' } })
    await def.execute(
      { scope: 'ids', ids: ['session-child'], whenBusy: 'skip' },
      { agent: rootAgent, signal: new AbortController().signal, deferContext() {} },
    )
    child.session.appended.length = 0
    await ctx.emit('session/event', child.session, {
      type: 'compaction/start', seq: 9170, time: 0, data: { compactionId: 'c17a', turn: 17 },
    })
    check('a compaction we asked for ourselves is not taken as proof either',
      String(child.session.appended.at(-1)?.data?.source?.summary).includes('触发线 ×0.5'),
      String(child.session.appended.at(-1)?.data?.source?.summary))
    delete child.session.requestHeader

    // (c) 引擎真的没吃（上游把 spec 缓存到构造期就会这样）：250K 就压了 —— 提示必须改口。
    await ctx.emit('session/event', surface, {
      type: 'compaction/start', seq: 917, time: 0, data: { compactionId: 'c17', turn: 17 },
    })
    const caught = String(noticeAt()?.data?.content?.[0]?.text)
    check('a policy-driven compaction below the new line exposes that the engine ignored the patch',
      caught.includes('×0.2') && caught.includes('×0.5') && caught.includes('热同步没成功'), caught)
    check('the trigger line falls back to the value the engine really uses',
      String(noticeAt()?.data?.source?.summary).includes('触发线 ×0.2'),
      String(noticeAt()?.data?.source?.summary))

    // (d) 反证失败之后不再自称生效：后续压缩的触发线继续按旧值报。
    meter.total = 620000
    await ctx.emit('session/event', surface, {
      type: 'compaction/start', seq: 918, time: 0, data: { compactionId: 'c18', turn: 18 },
    })
    check('after a failed verification the notice keeps reporting the real value',
      String(noticeAt()?.data?.source?.summary).includes('触发线 ×0.2'),
      String(noticeAt()?.data?.source?.summary))
  }

  setPresetFilesForTest(null)
  delete surface.requestHeader
  delete ctx.get('compaction').config
}

console.log(failed === 0 ? '\nALL OK' : `\n${failed} failure(s)`)
process.exit(failed === 0 ? 0 : 1)
