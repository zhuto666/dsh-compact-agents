/**
 * 真机加载测试：不是假 ctx，而是**真的 cordis Context + 真的 ToolRuntime**。
 *
 * 目的：证明 preset 里那一行 `E:/dsh-compact-agents/index.js` 真的能被加载、
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
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
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

/** 只实现本插件真正调用的 `compactNow`。 */
class StubCompaction extends Service {
  constructor(ctx) {
    super(ctx, 'compaction')
    this.calls = 0
  }

  async compactNow() {
    this.calls += 1
    return {
      shadowedRange: { start: 1, end: 2 },
      shadowedSeqs: [1, 2],
      shadowedTokenCount: 4242,
    }
  }
}

/** 只实现本插件真正调用的注册表读接口。 */
class StubAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    /** 一个假的“顶级会话”和一个假的“子代理”。 */
    this.rootAgent = { id: 'session-root', session: {} }
    this.childAgent = { id: 'session-child', session: {} }
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

console.log(failed === 0 ? '\nALL OK' : `\n${failed} failure(s)`)
process.exit(failed === 0 ? 0 : 1)
