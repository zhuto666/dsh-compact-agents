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
 * 放置位置：本文件必须在能解析 `@deepseek-ai/*` 的地方（见 README 的 junction 说明），
 * preset 用绝对路径引用它。
 *
 * @module dsh-compact-agents
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-compact-agents'
export const inject = ['tools', 'compaction', 'agents']

/** 允许的压缩范围。 */
const SCOPES = ['others', 'all', 'self', 'ids']

/** 目标正忙时的处置策略。 */
const WHEN_BUSY = ['queue', 'skip']

/** 已排队等待 idle 的 agent id，避免重复排。 */
const scheduled = new Set()

const DESCRIPTION_HEAD =
  'Force-compact agent sessions now, ignoring the automatic pressure threshold. Every live '
  + 'session in the process is a candidate — the main session, ordinary sub-agents, and team '
  + 'members alike. Each target is compacted with the manual entry point, so a session is '
  + 'reduced even when it is nowhere near the automatic trigger line.'

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
  try {
    const result = await ctx.compaction.compactNow(agent, signal)
    if (result === null) {
      return {
        id,
        status: 'noop',
        shadowedNodes: 0,
        shadowedTokens: 0,
        detail: 'nothing safely compactable (empty session, or one oversized retained unit)',
      }
    }
    return {
      id,
      status: 'compacted',
      shadowedNodes: result.shadowedSeqs.length,
      shadowedTokens: result.shadowedTokenCount,
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
        detail: 'mid-turn; manual compaction needs an idle session (whenBusy: "skip")',
      }
    }
    return {
      id,
      status: 'error',
      shadowedNodes: 0,
      shadowedTokens: 0,
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
    const size = row.status === 'compacted' ? `, ~${row.shadowedTokens} tokens in ${row.shadowedNodes} nodes` : ''
    lines.push(`- ${row.id}: ${row.status}${size} — ${row.detail}`)
  }
  if (value.missingIds.length > 0) {
    lines.push(`- no live agent for: ${value.missingIds.join(', ')}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Register the `compact_agents` tool.
 * @param ctx - registrant context carrying the tool, compaction, and agent services.
 */
export function apply(ctx) {
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
