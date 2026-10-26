/**
 * 自愈（`lib/self-heal.js`）的独立测试：不起 DSH、不碰真实 profile。
 *
 * 锁住的四件事（都是 2026-10-26 那次"插件装了却不生效"的真因）：
 *   1. 打包安装（随包 preset 在 `app.asar` 里、没有源码检出）也能被覆盖到；
 *   2. 覆盖块整份写进 profile 补丁，`compact-agents` 落在 compaction 组内；
 *   3. 幂等 —— 第二次跑一个字节都不动；
 *   4. 用户调过的阈值与手工追加的行不被冲掉。
 *
 * 运行：node scripts/self-heal-test.mjs
 * @module scripts/self-heal-test
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dca-selfheal-'))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const entryUrl = pathToFileURL(path.join(repoRoot, 'index.js')).href

process.env.DSH_HOME = path.join(root, 'dsh-home')
process.env.DSH_COMPACT_AGENTS_NO_SELF_HEAL = '1'

const { runSelfHeal, resetSelfHealForTest, ENTRY_URL } = await import('../lib/self-heal.js')
const { setActiveProfileDir, discoverPresets } = await import('./lib/presets.mjs')

/** 一份最小但结构真实的随包 preset（`config:` 在 6 空格 —— 与 DSH 发行版一致）。 */
function shippedPreset(rowId, tools) {
  return [
    '# fixture',
    '- insert:',
    '    - id: ' + rowId,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: ' + rowId.replace(/^preset-/, ''),
    '        order: 1',
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
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
    ...tools.map(tool => '      - id: ' + tool),
    '',
  ].join('\n')
}

// ── 夹具：打包布局的运行时（随包 preset 在 node_modules 下，模拟 app.asar 内的那套） ──
const runtime = path.join(root, 'DeepSeek', 'resources', 'app.asar', 'dsh')
const presetsDir = path.join(runtime, 'node_modules/@deepseek-ai/dsh-web-app/presets')
fs.mkdirSync(presetsDir, { recursive: true })
fs.writeFileSync(path.join(presetsDir, 'standard.patch.yml'), shippedPreset('preset-standard', ['tool-bash']))
fs.writeFileSync(path.join(presetsDir, 'minimal.patch.yml'), shippedPreset('preset-minimal', []))

// ── 夹具：profile 补丁（用户已装插件，但一份 preset 覆盖都没有） ──
const profileDir = path.join(root, 'dsh-home', 'profiles', 'desktop')
fs.mkdirSync(profileDir, { recursive: true })
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p', private: true }, null, 2))
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const initialPatch = '# 用户自己的补丁\n- id: ui-chat\n  config:\n    transcriptView: detailed\n'
fs.writeFileSync(patchPath, initialPatch)

/** 一个只记录调用、不真的重组宿主的 hmr 桩。 */
const hmrCalls = []
const hmr = {
  runExclusive: (operation) => {
    hmrCalls.push('runExclusive')
    return operation()
  },
  reconcileProfile: () => {
    hmrCalls.push('reconcileProfile')
    return { warnings: [] }
  },
}

/** 只实现 get / logger 的 ctx 桩。 */
function makeCtx(options = {}) {
  const warned = []
  return {
    warned,
    ctx: {
      get: (name) => {
        if (name === 'profileContext') return options.profile === false ? undefined : { dir: profileDir, patchPath }
        if (name === 'hmr') return options.hmr === false ? undefined : hmr
        return undefined
      },
      logger: { warn: (message) => warned.push(message), info: () => {} },
    },
  }
}

let checks = 0
/** 断言 + 计数，最后统一报告条数。 */
function ok(label) {
  checks += 1
  console.log('ok ' + label)
}

// ── 1. 第一次自愈：四份里的两份都补上，且 compact-agents 落在 compaction 组内 ──
resetSelfHealForTest()
setActiveProfileDir(undefined)
const { ctx, warned } = makeCtx()
const first = await runSelfHeal(ctx, { profile: profileDir, runtime, entry: entryUrl })
assert.equal(first.status, 'repaired', '首次自愈应报告 repaired')
assert.equal(first.hot, true, '有 hmr 时必须热重组')
assert.deepEqual(first.presets.sort(), ['minimal', 'standard'])
assert.deepEqual(hmrCalls, ['runExclusive', 'reconcileProfile'])
const text = fs.readFileSync(patchPath, 'utf8')
assert.ok(text.startsWith(initialPatch), '用户原有内容必须原样保留在最前面')
assert.ok(text.includes('- id: preset-standard'), '缺少 preset-standard 覆盖块')
assert.ok(text.includes('- id: preset-minimal'), '缺少 preset-minimal 覆盖块')
assert.ok(text.includes("name: '" + entryUrl + "'"), 'preset 行的 name 必须是传进来的入口')
assert.ok(fs.existsSync(patchPath + '.bak-compact-agents'), '写盘前必须留备份')
assert.equal(fs.readFileSync(patchPath + '.bak-compact-agents', 'utf8'), initialPatch)
ok('首次自愈补上两份随包 preset，并热重组')

// compaction 组内、且在 compaction-basic 之后（组内顺序 = 服务提供者在前）。
const { findBlock } = await import('./lib/preset-overrides.mjs')
const lines = text.split(/\r?\n/)
for (const rowId of ['preset-standard', 'preset-minimal']) {
  const block = findBlock(lines, rowId)
  assert.ok(block !== null, '缺少 ' + rowId + ' 覆盖块')
  const slice = lines.slice(block.start, block.end)
  const rows = slice.map(line => line.trim()).filter(line => line.startsWith('- id: '))
  assert.ok(rows.includes('- id: compact-agents'), rowId + ': compact-agents 必须落在该 preset 块内')
  assert.ok(rows.indexOf('- id: compact-agents') > rows.indexOf('- id: compaction-basic'), rowId + ': 必须排在 compaction-basic 之后')
  const joined = slice.join('\n')
  assert.ok(joined.includes('thresholdRatio: 0.3'), rowId + ': 默认阈值应写进 compaction-basic')
  assert.ok(joined.includes('retainRatio: 0.02'), rowId + ': 默认保留比例应写进 compaction-basic')
}
ok('compact-agents 落在 compaction 组内、默认阈值已写入')

// 幂等：第二次跑，一个字节都不动。
const before = fs.readFileSync(patchPath, 'utf8')
hmrCalls.length = 0
const second = await runSelfHeal(ctx, { profile: profileDir, runtime, entry: entryUrl })
assert.equal(second.status, 'ok')
assert.equal(second.changed, false)
assert.equal(fs.readFileSync(patchPath, 'utf8'), before, '幂等：第二次不得改文件')
assert.deepEqual(hmrCalls, [], '已覆盖时不该白跑一次热重组')
ok('幂等：第二次不改文件、不重跑热重组')

// ── 2. 用户调过的阈值与手工追加的行必须保住 ──
fs.writeFileSync(patchPath, before
  .replace('thresholdRatio: 0.3', 'thresholdRatio: 0.45')
  .replace('      - id: persona\n', '      - id: persona\n      - id: my-own-tool\n'))
const tuned = fs.readFileSync(patchPath, 'utf8')
await runSelfHeal(ctx, { profile: profileDir, runtime, entry: entryUrl })
const afterTune = fs.readFileSync(patchPath, 'utf8')
assert.ok(/thresholdRatio: 0\.45/.test(afterTune), '用户调过的阈值被冲掉了')
assert.ok(afterTune.includes('- id: my-own-tool'), '用户手工追加的行被冲掉了')
// 合并会把手写行归一到一个固定位置，所以这里比"再跑一次不再变"（幂等），不比逐字节等于手改后的文本。
const settled = fs.readFileSync(patchPath, 'utf8')
await runSelfHeal(ctx, { profile: profileDir, runtime, entry: entryUrl })
assert.equal(fs.readFileSync(patchPath, 'utf8'), settled, '归一之后必须幂等')
ok('保留用户调过的阈值与手工追加的行')

// ── 3. 用户自建的 preset：只补行，不重建 ──
fs.writeFileSync(patchPath, tuned + [
  '',
  '- id: preset-mine',
  "  name: '@deepseek-ai/dsh-agent-preset'",
  '  config:',
  '    id: mine',
  '    plugins:',
  '      - id: compaction',
  '        name: cordis:group',
  '        group: true',
  '        config:',
  '          - id: compaction-basic',
  "            name: '@deepseek-ai/dsh-compaction-basic'",
  '      - id: my-custom-plugin',
  "        name: 'file:///tmp/custom.js'",
  '',
].join('\n'))
await runSelfHeal(ctx, { profile: profileDir, runtime, entry: entryUrl })
const withCustom = fs.readFileSync(patchPath, 'utf8')
assert.ok(withCustom.includes('- id: my-custom-plugin'), '用户自建 preset 的定制行被重建冲掉了')
const mineBlock = withCustom.slice(withCustom.indexOf('- id: preset-mine'))
assert.ok(/- id: compact-agents/.test(mineBlock), '用户自建 preset 也应补上 compact-agents 行')
ok('用户自建 preset 只补行、不重建')

// ── 4. 没有 hmr：只落文件，明确报"下次启动生效" ──
resetSelfHealForTest()
fs.writeFileSync(patchPath, initialPatch)
const noHmr = makeCtx({ hmr: false })
const cold = await runSelfHeal(noHmr.ctx, { profile: profileDir, runtime, entry: entryUrl })
assert.equal(cold.status, 'repaired')
assert.equal(cold.hot, false, '没有 hmr 时必须如实报告不能热生效')
ok('没有 hmr 时只落文件并如实报告')

// ── 5. 拿不到 profile：跳过而不是报错 ──
resetSelfHealForTest()
fs.writeFileSync(patchPath, initialPatch)
const noProfile = makeCtx({ profile: false })
const skipped = await runSelfHeal(noProfile.ctx, { runtime, entry: entryUrl })
assert.equal(skipped.status, 'skipped')
assert.equal(fs.readFileSync(patchPath, 'utf8'), initialPatch, '跳过时不得改文件')
ok('拿不到 profile 时安全跳过')

// ── 6. 自愈之后 discoverPresets() 认的就是这个 profile（设置落盘不再写错 profile） ──
resetSelfHealForTest()
await runSelfHeal(ctx, { profile: profileDir, runtime, entry: entryUrl })
setActiveProfileDir(profileDir)
assert.deepEqual(discoverPresets(), [patchPath])
ok('设置落盘认当前 profile')

// ── 7. dry-run：算出差异但不写盘 ──
resetSelfHealForTest()
fs.writeFileSync(patchPath, initialPatch)
const dry = await runSelfHeal(ctx, { profile: profileDir, runtime, entry: entryUrl, dryRun: true })
assert.equal(dry.changed, true)
assert.equal(fs.readFileSync(patchPath, 'utf8'), initialPatch, 'dry-run 不得写盘')
ok('dry-run 不写盘')

// ── 8. 真·打包安装：能直接读 app.asar 里的随包 preset ──
const appAsar = process.env.DSH_APP_ASAR ?? 'E:/DeepSeek/resources/app.asar'
if (fs.existsSync(appAsar)) {
  const asarRuntime = appAsar.replace(/\\/g, '/') + '/dsh'
  const { listShippedPresets } = await import('./lib/preset-overrides.mjs')
  const shipped = listShippedPresets(asarRuntime)
  assert.ok(shipped.length > 0, 'asar 内应当读到随包 preset')
  assert.ok(shipped.every(item => item.text.includes('- id: compaction')), '读到的 preset 内容应完整')
  console.log('   （实测 asar：' + shipped.map(item => item.name).join(', ') + '）')
}
ok('打包安装（app.asar）里的随包 preset 可读')

assert.equal(ENTRY_URL, entryUrl, '默认入口应指向本包 index.js')

fs.rmSync(root, { recursive: true, force: true })
console.log(`\nALL OK (${checks} checks)`)
