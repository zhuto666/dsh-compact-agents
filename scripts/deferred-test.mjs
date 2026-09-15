/**
 * 行为测试：忙的目标走"排队"路径，并在它下一次 idle 时真的被压。
 *
 * 这条路径就是"主会话也生效"的实现方式 —— 调用者自己永远 busy（它正在执行本工具），
 * 所以 `scope: "self"` 必然落在排队分支，等本轮结束立刻补压。
 *
 * 运行：node scripts/deferred-test.mjs
 */
import { apply } from '../index.js'

/** 记录 compactNow 的调用次数与行为。 */
const calls = []

/** 假的压缩服务：第一次抛 busy，之后成功。 */
const compaction = {
  compactNow(agent, signal) {
    calls.push({ id: String(agent.id), aborted: signal.aborted })
    if (calls.length === 1) {
      const error = new Error('agent is active')
      error.code = 'busy'
      throw error
    }
    return Promise.resolve({
      shadowedSeqs: [1, 2, 3],
      shadowedRange: { start: 1, end: 3 },
      shadowedTokenCount: 12345,
    })
  },
}

const caller = { id: 'session-main' }
const listeners = []
const logs = []

const ctx = {
  tools: { register: definition => { ctx._tool = definition } },
  compaction,
  agents: {
    list: () => [caller],
    roots: () => [caller],
  },
  on: (event, handler) => {
    const entry = { event, handler, disposed: false }
    listeners.push(entry)
    return () => { entry.disposed = true }
  },
  logger: {
    info: message => logs.push(['info', message]),
    warn: message => logs.push(['warn', message]),
  },
}

apply(ctx)
const tool = ctx._tool
if (tool === undefined) throw new Error('工具未注册')

const result = await tool.execute(
  { scope: 'self' },
  { agent: caller, signal: new AbortController().signal },
)

if (result.queued !== 1) throw new Error(`期望 queued=1，实际 ${JSON.stringify(result)}`)
if (result.compacted !== 0) throw new Error('首次调用不应直接压实')
if (calls.length !== 1) throw new Error(`期望 compactNow 调用 1 次，实际 ${calls.length}`)
const status = listeners.find(entry => entry.event === 'agent/status')
if (status === undefined) throw new Error('未注册 agent/status 监听器')

// 与本 agent 无关的 idle 事件不应触发。
status.handler({ agent: { id: 'somebody-else' }, status: 'idle' })
if (calls.length !== 1) throw new Error('无关 agent 的 idle 误触发了压缩')

// 真正 idle 后应当补压。
status.handler({ agent: caller, status: 'idle' })
await new Promise(resolve => setTimeout(resolve, 20))

if (calls.length !== 2) throw new Error(`期望 idle 后补压 1 次，实际总调用 ${calls.length} 次`)
if (!status.disposed) throw new Error('一次性监听器未注销')
if (!logs.some(([level, text]) => level === 'info' && text.includes('shadowed 3 nodes'))) {
  throw new Error(`未记录补压结果，日志=${JSON.stringify(logs)}`)
}

console.log('首次调用(row) :', JSON.stringify(result.results[0]))
console.log('compactNow 调用:', calls.length)
console.log('一次性监听器  :', status.disposed ? '已注销' : '未注销')
console.log('日志          :', logs.map(([level, text]) => `${level}: ${text}`).join(' | '))
console.log('OK')
