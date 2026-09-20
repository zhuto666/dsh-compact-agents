/**
 * 设置面的真机测试：**真的 cordis Context + 真的 schemastery**，只把 settings 服务做成桩。
 *
 * 覆盖三块：
 *   1. preset 文本手术（按行定位到某个 row 的 `config` 块、只改一行、保留注释）；
 *   2. preset 落盘（备份 + 原子替换 + 范围校验 + 幂等）；
 *   3. 命名空间注册（命名空间名、作文层 base、schema 真能解析、进程级只注册一次、
 *      变更后自身旋钮立即生效且 preset 参数会落盘）。
 *
 * 全程用 `setPresetFilesForTest` 把读写指向临时文件，**绝不动用户的真实 preset**。
 *
 * 运行：node scripts/settings-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  liveConfig,
  readKeyInRow,
  readPresetValues,
  registerSettings,
  resetSettingsStateForTest,
  resolveMaxAutoContinues,
  setKeyInRow,
  setPresetFilesForTest,
  writePresetValues,
  SETTINGS_FIELDS,
  SETTINGS_NAMESPACE,
} from '../settings.js'
import { PROJECT_ROOT } from './lib/presets.mjs'

let failed = 0

/**
 * 断言一行。
 * @param name - 断言名称。
 * @param ok - 是否通过。
 * @param evidence - 失败时打印的证据。
 */
function check(name, ok, evidence = '') {
  if (ok) {
    console.log(`OK   ${name}${evidence === '' ? '' : ` — ${evidence}`}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name}${evidence === '' ? '' : ` — ${evidence}`}`)
}

/** 与真实 preset 同构的夹具：嵌套 config 块、**行内注释**、独立注释行、兄弟 row。 */
const FIXTURE = [
  '# 顶部注释',
  '- id: prompt',
  '  name: ./prompt.mjs',
  '- id: compaction',
  '  name: ./compaction.mjs',
  '  config:',
  '    # 阈值：越低越早压',
  '    - id: compaction-basic',
  '      name: ./basics.mjs',
  '      config:',
  '        thresholdRatio: 0.2   # 1M 窗口 x 0.2 = 200K 触发压缩',
  '        retainRatio: 0.05     # 压缩后保留最近 5% 窗口',
  '        maxTokens: 8192',
  '    - id: compact-agents',
  "      name: '/opt/elsewhere/index.js'",
  '- id: tool-bootstrap',
  '  name: ./tool-bootstrap.mjs',
  '  config:',
  '    anchorGate: true',
  '    bootstrapMaxTokens: 1024',
  '    compactionTools: [read, write]',
  '',
].join('\n')

const lines = () => FIXTURE.split('\n')

// 1. 读取：只在目标 row 的 config 块里找键，不串到兄弟 row。
check('reads a nested key from the target row', readKeyInRow(lines(), 'compaction-basic', 'thresholdRatio') === '0.2',
  String(readKeyInRow(lines(), 'compaction-basic', 'thresholdRatio')))
check('reads a top-level row key', readKeyInRow(lines(), 'tool-bootstrap', 'bootstrapMaxTokens') === '1024',
  String(readKeyInRow(lines(), 'tool-bootstrap', 'bootstrapMaxTokens')))
check('missing key reads as undefined', readKeyInRow(lines(), 'compaction-basic', 'nope') === undefined)
check('missing row reads as undefined', readKeyInRow(lines(), 'no-such-row', 'thresholdRatio') === undefined)
check('a sibling row\'s key does not leak across the boundary',
  readKeyInRow(lines(), 'compaction-basic', 'anchorGate') === undefined,
  String(readKeyInRow(lines(), 'compaction-basic', 'anchorGate')))

// 2. 写入：只改一行、缩进不变、注释与其它行原样保留。
const edited = lines()
check('rewrites an existing value', setKeyInRow(edited, 'compaction-basic', 'thresholdRatio', '0.35') === true)
// 注意用 join 后再 includes：`Array.prototype.includes` 是**严格相等**，
// 行里有行内注释时"整行等于纯值"就不成立了（第一版正是这样碰巧通过的）。
const editedText = edited.join('\n')
check('the rewritten line keeps its indentation',
  editedText.includes('        thresholdRatio: 0.35'), JSON.stringify(edited[10]))
check('a same-value write is a no-op', setKeyInRow(edited, 'compaction-basic', 'thresholdRatio', '0.35') === false)
check('sibling keys are untouched',
  editedText.includes('        retainRatio: 0.05') && editedText.includes('        maxTokens: 8192'))
check('comments survive the edit', editedText.includes('    # 阈值：越低越早压'))
check('only the target line changed',
  edited.length === FIXTURE.split('\n').length && edited.filter((line, i) => line !== lines()[i]).length === 1,
  `${edited.filter((line, i) => line !== lines()[i]).length} line(s)`)

const inserted = lines()
check('inserts a missing key into the config block',
  setKeyInRow(inserted, 'tool-bootstrap', 'brandNew', '7') === true && inserted.includes('    brandNew: 7'),
  JSON.stringify(inserted[Math.max(0, inserted.indexOf('    brandNew: 7'))]))
check('an unknown row is left alone', setKeyInRow(lines(), 'no-such-row', 'x', '1') === false)

// 行内注释：真实 preset 就是这么写的（`thresholdRatio: 0.2   # 1M 窗口 x 0.2 = 200K 触发压缩`）。
// 第一版没覆盖这个形态，结果既读不到值（注释被当成值 → NaN），写回时还会把注释抹掉。
const inline = lines()
setKeyInRow(inline, 'compaction-basic', 'thresholdRatio', '0.35')
check('a numeric inline comment is refreshed with the new value',
  inline[10] === '        thresholdRatio: 0.35   # 窗口占用达 35% 时触发压缩', JSON.stringify(inline[10]))
check('a value with an inline comment still reads as a plain scalar',
  readKeyInRow(lines(), 'compaction-basic', 'retainRatio') === '0.05',
  String(readKeyInRow(lines(), 'compaction-basic', 'retainRatio')))
check('the comment on a line we did not touch is untouched',
  inline.join('\n').includes('    # 阈值：越低越早压'))

// 注释里没有数字的，是用户自己的话，原样保留；本来没有注释的行也不替他加。
const prose = lines()
setKeyInRow(prose, 'compaction-basic', 'maxTokens', '4096')
check('a comment without digits is left exactly as written',
  prose[11] === '        retainRatio: 0.05     # 压缩后保留最近 5% 窗口'
  && prose.join('\n').includes('        maxTokens: 4096'), JSON.stringify(prose[11]))
const bare = lines()
setKeyInRow(bare, 'tool-bootstrap', 'bootstrapMaxTokens', '4096')
check('a line without a comment gains none',
  bare[19] === '    bootstrapMaxTokens: 4096', JSON.stringify(bare[19]))
const retain = lines()
setKeyInRow(retain, 'compaction-basic', 'retainRatio', '0.02')
check('the retention comment is refreshed too',
  retain[11] === '        retainRatio: 0.02     # 压缩后保留最近 2% 窗口的原文', JSON.stringify(retain[11]))
check('only the target line changed',
  retain.filter((line, i) => line !== lines()[i]).length === 1,
  `${retain.filter((line, i) => line !== lines()[i]).length} line(s)`)
check('a # inside a quoted scalar is not treated as a comment',
  readKeyInRow(['- id: x', '  config:', "    url: 'a # b'", '    n: 1   # 注释'], 'x', 'url') === "'a # b'",
  String(readKeyInRow(['- id: x', '  config:', "    url: 'a # b'", '    n: 1   # 注释'], 'x', 'url')))

// 3. 落盘：备份 + 原子替换 + 范围校验 + 幂等。
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-agents-settings-'))
const target = path.join(sandbox, 'agent.cordis.yml')
fs.writeFileSync(target, FIXTURE)

const read = readPresetValues([target])
check('reads every preset value from a file',
  read.values.thresholdRatio === 0.2 && read.values.retainRatio === 0.05 && read.values.bootstrapMaxTokens === 1024,
  JSON.stringify(read.values))
check('a readable file reports no problems', read.problems.length === 0, JSON.stringify(read.problems))

const written = writePresetValues({ thresholdRatio: 0.35 }, [target])
check('writes the preset value', written[0].status === 'written' && written[0].detail === 'thresholdRatio',
  JSON.stringify(written[0]))
const after = fs.readFileSync(target, 'utf8')
check('the file carries the new value', after.includes('thresholdRatio: 0.35'))
check('the pre-write content is backed up',
  fs.existsSync(`${target}.bak-compact-agents`)
  && fs.readFileSync(`${target}.bak-compact-agents`, 'utf8').includes('thresholdRatio: 0.2'))
check('no temporary file is left behind', !fs.existsSync(`${target}.compact-agents.tmp`))
check('the untouched parts are byte-identical',
  after.replace('thresholdRatio: 0.35   # 窗口占用达 35% 时触发压缩',
    'thresholdRatio: 0.2   # 1M 窗口 x 0.2 = 200K 触发压缩') === FIXTURE, 'normalised compare')
check('a second identical write is a no-op',
  writePresetValues({ thresholdRatio: 0.35 }, [target])[0].status === 'unchanged')
check('an out-of-range value is rejected, not written',
  writePresetValues({ thresholdRatio: 99 }, [target])[0].status === 'rejected'
  && fs.readFileSync(target, 'utf8').includes('thresholdRatio: 0.35'))
check('a key whose row is absent is skipped', writePresetValues({ bootstrapMaxTokens: 4096 }, [path.join(sandbox, 'none.yml')])[0].status === 'unreadable')

// 4. 命名空间注册：真 schemastery + 真 Context，只桩 settings 服务。
/** 记录注册调用并按 schemastery 真解析一遍的 settings 桩。 */
class StubSettings extends Service {
  constructor(ctx) {
    super(ctx, 'settings')
    /** 每次 register 的入参。 */
    this.calls = []
    /** 已登记的观察者。 */
    this.watchers = new Set()
    /** 最近一次解析结果。 */
    this.resolved = undefined
  }

  register(ns, schema, options) {
    this.calls.push({ ns, schema, options })
    this.resolved = schema({ ...(options?.base ?? {}) })
    return {
      get: () => this.resolved,
      watch: (callback) => {
        this.watchers.add(callback)
        return () => this.watchers.delete(callback)
      },
      update: async () => {},
      replace: async () => {},
    }
  }
}

resetSettingsStateForTest()
setPresetFilesForTest([target])
const ctx = new Context()
ctx.plugin(StubSettings)
await new Promise(resolve => setTimeout(resolve, 50))
const settings = ctx.get('settings')
await registerSettings(ctx, { maxAutoContinues: 5 })

check('registers exactly one namespace', settings.calls.length === 1, `${settings.calls.length} call(s)`)
check('the namespace is the one the browser card binds',
  settings.calls[0]?.ns === SETTINGS_NAMESPACE, String(settings.calls[0]?.ns))
check('the namespace declares its effect timing', settings.calls[0]?.options?.applies === 'restart',
  String(settings.calls[0]?.options?.applies))
check('the composition layer carries the row config',
  settings.resolved?.maxAutoContinues === 5, JSON.stringify(settings.resolved))
check('the composition layer carries the preset values',
  settings.resolved?.thresholdRatio === 0.35 && settings.resolved?.bootstrapMaxTokens === 1024,
  JSON.stringify(settings.resolved))
check('a row config that the user never overrode stays a per-mount fallback',
  liveConfig.maxAutoContinues === null && liveConfig.notice === null,
  JSON.stringify(liveConfig))
check('a watcher is attached', settings.watchers.size === 1, `${settings.watchers.size} watcher(s)`)

await registerSettings(ctx, {})
check('a second mount reuses the scope instead of registering twice',
  settings.calls.length === 1, `${settings.calls.length} call(s)`)
check('a second mount does not turn its own row config into a global override',
  liveConfig.maxAutoContinues === null, String(liveConfig.maxAutoContinues))

// 用户在设置里改动：自身旋钮立即生效，preset 参数落盘。
for (const watcher of settings.watchers) {
  await watcher(
    { notice: false, maxAutoContinues: 1, thresholdRatio: 0.45, retainRatio: 0.05, bootstrapMaxTokens: 16384 },
    settings.resolved,
  )
}
check('a settings change applies to the live knobs immediately',
  liveConfig.notice === false && liveConfig.maxAutoContinues === 1, JSON.stringify(liveConfig))
check('a changed preset value reaches the file',
  fs.readFileSync(target, 'utf8').includes('thresholdRatio: 0.45'),
  fs.readFileSync(target, 'utf8').split('\n').find(line => line.includes('thresholdRatio')) ?? '')
check('an unchanged preset value is not rewritten',
  fs.readFileSync(target, 'utf8').includes('retainRatio: 0.05'))

check('resolveMaxAutoContinues handles false/undefined/valid',
  resolveMaxAutoContinues({ maxAutoContinues: false }) === 0
  && resolveMaxAutoContinues({}) === 2
  && resolveMaxAutoContinues({ maxAutoContinues: 7 }) === 7,
  `${resolveMaxAutoContinues({ maxAutoContinues: false })}/${resolveMaxAutoContinues({})}/${resolveMaxAutoContinues({ maxAutoContinues: 7 })}`)

// 5. 两端接口一致性：宿主 schema ↔ 卡片字段 ↔ 命名空间字符串。
// 这个接口是刻意在两端各写一份的（宿主声明 schema，卡片渲染表单），所以必须有守卫钉住，
// 否则哪天只改一边，界面会安静地少一个字段或者写出宿主不认识的键。
const hostFields = Object.keys(SETTINGS_FIELDS)
const clientSource = fs.readFileSync(path.join(PROJECT_ROOT, 'lib/client.js'), 'utf8')
const cardFields = new Set([...clientSource.matchAll(/field:\s*'([A-Za-z0-9_]+)'/g)].map(match => match[1]))
check('every documented field really exists in the registered schema',
  settings.resolved !== undefined && hostFields.every(field => field in settings.resolved),
  `${hostFields.join(',')} vs ${Object.keys(settings.resolved ?? {}).join(',')}`)
check('the card edits exactly the fields the host schema declares',
  cardFields.size === hostFields.length && hostFields.every(field => cardFields.has(field)),
  `host=${hostFields.join(',')} card=${[...cardFields].join(',')}`)
check('both halves key on the same namespace string',
  clientSource.includes(`'${SETTINGS_NAMESPACE}'`), SETTINGS_NAMESPACE)

resetSettingsStateForTest()
setPresetFilesForTest(null)
fs.rmSync(sandbox, { recursive: true, force: true })

console.log(failed === 0 ? '\nALL OK' : `\n${failed} failure(s)`)
process.exit(failed === 0 ? 0 : 1)
