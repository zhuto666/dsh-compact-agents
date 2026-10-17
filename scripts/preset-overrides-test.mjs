/**
 * preset 覆盖逻辑的守卫：发现随包 preset、生成覆盖块、幂等同步、保留用户阈值、自建 preset 补行。
 *
 * 这些逻辑决定"每份 Agent 预设里到底有没有 compact-agents 行"。2026-10-16 的事故是：
 * 0.2.1-alpha.3 新增 cordis 并把它设成新建会话默认预设，而安装脚本只覆盖了部分 preset，
 * 于是新开对话就"功能没了"，profile 里却看不出任何异常。这个脚本把几种必须成立的行为钉住：
 *   1. 检出里每份随包 preset 都能被发现；
 *   2. 缺的覆盖会被追加，而不是只处理第一个 compaction 组；
 *   3. 重复运行逐字节幂等（install 可以随时重跑）；
 *   4. 用户调过的阈值在刷新覆盖时被保留（否则每次升级都把人家的参数按默认值冲掉）；
 *   5. 自建 preset 只补缺失的行/阈值，不重建整份 config（重建会丢定制）。
 *
 * 全程沙箱：临时目录里的假检出 + 假 profile，不碰真实配置。
 *
 * 运行：node scripts/preset-overrides-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_RETAIN_RATIO,
  DEFAULT_THRESHOLD_RATIO,
  buildOverride,
  ensureDeclaredRows,
  extractThresholds,
  listShippedPresets,
  syncOverrides,
} from './lib/preset-overrides.mjs'

let failed = 0

/**
 * 断言一行。
 * @param name - 断言名称。
 * @param ok - 是否通过。
 * @param evidence - 证据文本。
 */
function check(name, ok, evidence = '') {
  if (ok) {
    console.log('OK   ' + name + (evidence === '' ? '' : ' — ' + evidence))
    return
  }
  failed += 1
  console.log('FAIL ' + name + (evidence === '' ? '' : ' — ' + evidence))
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-agents-overrides-'))
const presetsDir = path.join(sandbox, 'checkout', 'packages', 'bundle', 'web-app', 'presets')
fs.mkdirSync(presetsDir, { recursive: true })

/**
 * 一份随包 preset 的夹具（与 0.2.1-alpha.3 的 insert 形态一致）。
 * @param name - preset 名。
 * @param extra - 额外追加的插件行（用来注入 createRequire(baseUrl) 那种表达式）。
 */
function shippedPreset(name, extra = []) {
  return [
    '# Agent preset ' + name + ': fixture',
    '- insert:',
    '    - id: preset-' + name,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: ' + name,
    '        order: 1',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '          - id: delegation',
    '            name: cordis:group',
    '            group: true',
    '            config:',
    '              - id: tool-subagent',
    "                name: '@deepseek-ai/dsh-tool-subagent'",
    ...extra,
    '          - id: compaction',
    '            name: cordis:group',
    '            group: true',
    '            isolate:',
    '              compaction: true',
    '            config:',
    '              - id: compaction-basic',
    "                name: '@deepseek-ai/dsh-compaction-basic'",
    '              - id: command-compact',
    "                name: '@deepseek-ai/dsh-command-compact'",
    '',
  ].join('\n')
}

fs.writeFileSync(path.join(presetsDir, 'standard.patch.yml'), shippedPreset('standard'))
fs.writeFileSync(path.join(presetsDir, 'ptc.patch.yml'), shippedPreset('ptc', [
  '          - id: skill-filesystem',
  "            name: '@deepseek-ai/dsh-skill-filesystem'",
  '            config:',
  '              customSkillDirs:',
  "                - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')",
]))

const entry = 'E:/fake/dsh-compact-agents/index.js'
const shipped = listShippedPresets(path.join(sandbox, 'checkout'))
check('finds every shipped preset', shipped.length === 2, shipped.map(item => item.name).join(','))
check('reads preset ids, not filenames', shipped.every(item => item.rowId === 'preset-' + item.name),
  shipped.map(item => item.rowId).join(','))

// ── 1) 从空 profile 追加两份覆盖 ───────────────────────────────────────────
let profile = '# profile fixture\n\n- id: ui-chat\n  config:\n    linkOpening: sidebar\n'
const first = syncOverrides(profile, shipped, {
  entry,
  thresholdRatio: DEFAULT_THRESHOLD_RATIO,
  retainRatio: DEFAULT_RETAIN_RATIO,
  date: '2026-10-17',
})
check('appends an override for every missing preset', first.report.every(item => item.action === 'added'),
  first.report.map(item => item.name + ':' + item.action).join(','))
check('each appended block carries the mount row', (first.text.match(/- id: compact-agents/g) ?? []).length === 2,
  String((first.text.match(/- id: compact-agents/g) ?? []).length))
check('each appended block carries the threshold', (first.text.match(/thresholdRatio:/g) ?? []).length === 2,
  String((first.text.match(/thresholdRatio:/g) ?? []).length))
check('appended blocks land at top level', first.text.includes('\n- id: preset-standard\n'), 'no indent')
check('profile keeps the unrelated rows', first.text.includes('- id: ui-chat'))

// ── 2) 幂等：再跑一次逐字节不变 ────────────────────────────────────────────
const again = syncOverrides(first.text, shipped, {
  entry,
  thresholdRatio: DEFAULT_THRESHOLD_RATIO,
  retainRatio: DEFAULT_RETAIN_RATIO,
  date: '2026-10-17',
})
check('repeated sync is byte-identical', again.text === first.text,
  again.report.map(item => item.name + ':' + item.action).join(','))
check('repeated sync reports ok', again.report.every(item => item.action === 'ok'))

// ── 3) 用户调过的阈值在刷新时被保留 ────────────────────────────────────────
const tuned = first.text.replace('thresholdRatio: 0.3', 'thresholdRatio: 0.55')
const refreshed = syncOverrides(tuned, shipped, {
  entry,
  thresholdRatio: DEFAULT_THRESHOLD_RATIO,
  retainRatio: DEFAULT_RETAIN_RATIO,
  date: '2026-10-17',
})
check('refresh keeps the user threshold', refreshed.text.includes('thresholdRatio: 0.55'), '0.55')
check('refresh keeps the tuned block untouched', refreshed.report.every(item => item.action === 'ok'),
  refreshed.report.map(item => item.action).join(','))
const kept = extractThresholds(refreshed.text.split('\n').slice(0, 60))
check('extractThresholds reads the tuned value', kept.thresholdRatio === 0.55, String(kept.thresholdRatio))

// ── 4) 自建 preset：只补行/阈值，不重建 config ─────────────────────────────
const declared = [
  '- id: preset-liangshen',
  "  name: '@deepseek-ai/dsh-agent-preset'",
  '  config:',
  '    id: liangshen',
  '    plugins:',
  '      - id: persona',
  "        name: '@deepseek-ai/dsh-persona'",
  '      - id: compaction',
  '        name: cordis:group',
  '        group: true',
  '        isolate:',
  '          compaction: true',
  '        config:',
  '          - id: compaction-basic',
  "            name: '@deepseek-ai/dsh-compaction-basic'",
  '          - id: command-compact',
  "            name: '@deepseek-ai/dsh-command-compact'",
  '',
].join('\n')
const rows = ensureDeclaredRows(declared, new Set(['standard', 'ptc']), {
  entry,
  thresholdRatio: DEFAULT_THRESHOLD_RATIO,
  retainRatio: DEFAULT_RETAIN_RATIO,
  dryRun: false,
})
check('self-built preset gets the mount row', rows.text.includes('- id: compact-agents'), 'added')
check('self-built preset keeps its own content', rows.text.includes('id: liangshen'), 'kept')
check('self-built preset gets the threshold', rows.text.includes('thresholdRatio: 0.3'), 'added')
const rowsAgain = ensureDeclaredRows(rows.text, new Set(['standard', 'ptc']), {
  entry,
  thresholdRatio: DEFAULT_THRESHOLD_RATIO,
  retainRatio: DEFAULT_RETAIN_RATIO,
  dryRun: false,
})
check('self-built sync is idempotent', rowsAgain.text === rows.text && rowsAgain.report.every(item => item.action === 'ok'))

// ── 5) baseUrl 表达式必须被改写（profile 里解析不到那个包） ────────────────
const ptc = shipped.find(item => item.name === 'ptc')
const block = buildOverride(ptc, {
  entry,
  thresholdRatio: DEFAULT_THRESHOLD_RATIO,
  retainRatio: DEFAULT_RETAIN_RATIO,
  date: '2026-10-17',
})
check('rewrites createRequire(baseUrl) to the launcher entry',
  block.join('\n').includes('createRequire(process.argv[1])'), 'rewritten')
check('never leaves baseUrl behind', !block.join('\n').includes('createRequire(baseUrl)'), 'clean')

// ── 6) dryRun 不动文本 ────────────────────────────────────────────────────
const dry = syncOverrides('# empty\n', shipped, {
  entry,
  thresholdRatio: DEFAULT_THRESHOLD_RATIO,
  retainRatio: DEFAULT_RETAIN_RATIO,
  dryRun: true,
})
check('dry run leaves the text alone', dry.text === '# empty\n', 'unchanged')
check('dry run still reports what it would do', dry.report.every(item => item.action === 'added'))

// ── 7) 刷新快照时保留手工追加的插件行 ────────────────────────────────────
// 本机就在 ptc 的 delegation 组里手工补过 tool-ralph / tool-subagent-*。
// 按随包重新生成若直接丢掉，等于"升级一次少一批工具"。
const withExtra = first.text.replace(
  '      - id: compaction',
  "      - id: tool-ralph\n        name: '@deepseek-ai/dsh-tool-ralph'\n      - id: compaction",
)
const merged = syncOverrides(withExtra, shipped, {
  entry,
  thresholdRatio: DEFAULT_THRESHOLD_RATIO,
  retainRatio: DEFAULT_RETAIN_RATIO,
  date: '2026-10-17',
})
check('refresh keeps hand-added plugin rows', merged.text.includes('- id: tool-ralph'), 'kept')
check('kept row keeps its package name', merged.text.includes("name: '@deepseek-ai/dsh-tool-ralph'"), 'kept')
check('refresh reports the preset as updated', merged.report.some(item => item.action === 'updated'),
  merged.report.map(item => item.action).join(','))

// 组内（delegation 的 config 列表）手工追加的行同样要保留 —— 本机那三行就在这里。
const withGroupExtra = first.text.replace(
  '          - id: tool-subagent',
  "          - id: tool-ralph\n            name: '@deepseek-ai/dsh-tool-ralph'\n          - id: tool-subagent",
)
const mergedGroup = syncOverrides(withGroupExtra, shipped, {
  entry,
  thresholdRatio: DEFAULT_THRESHOLD_RATIO,
  retainRatio: DEFAULT_RETAIN_RATIO,
  date: '2026-10-17',
})
check('refresh keeps rows added inside a group', mergedGroup.text.includes('- id: tool-ralph'), 'kept')
check('group row keeps its position under delegation',
  /- id: delegation[\s\S]{0,400}- id: tool-ralph/.test(mergedGroup.text), 'nested')
check('group merge stays idempotent after keeping the row',
  syncOverrides(mergedGroup.text, shipped, {
    entry,
    thresholdRatio: DEFAULT_THRESHOLD_RATIO,
    retainRatio: DEFAULT_RETAIN_RATIO,
    date: '2026-10-17',
  }).report.every(item => item.action === 'ok'))

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL OK' : '\n' + failed + ' failure(s)')
process.exit(failed === 0 ? 0 : 1)
