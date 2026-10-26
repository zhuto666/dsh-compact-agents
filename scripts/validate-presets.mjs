/**
 * 校验每一份挂载本插件的 preset：
 *   1. YAML 仍可解析（这些 preset 用了 cordis 的 `!!js` 表达式标签，标准 schema 不认识，需补注册）；
 *   2. `compact-agents` 行确实落在 `compaction` 隔离组内（放外面解析不到 `ctx.compaction`）；
 *   3. 该行引用的绝对路径存在，且指向本项目；
 *   4. 顺带报告 `compaction-basic` 的 `thresholdRatio` / `retainRatio`（自动压缩阈值）。
 *
 * 另外校验仓库自己的文档一致性：两份 README 顶部的版本徽章必须等于 `package.json` 的版本
 * （手写的徽章停在了 0.4.0，而市场收录抓的正是 README，别人看到的就是那个过时数字）。
 *
 * 运行：node scripts/validate-presets.mjs [--preset <agent.cordis.yml> ...]
 * @module scripts/validate-presets
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_HOME, PLUGIN_ENTRY, ROW_ID, discoverPresets, parseCommonArgs, resolveDshCheckout, resolveDshRuntime } from './lib/presets.mjs'
import { findBlock, listShippedPresets } from './lib/preset-overrides.mjs'

// 本项目刻意不装依赖（离线、零安装）：js-yaml 与 cordis 一样从 DSH 检出里借。
// 检出位置靠自描述探测（--dsh / $DSH_CHECKOUT / 既有联接 / profile），不写死盘符。
const dshFlag = process.argv.indexOf('--dsh')
const explicitDsh = dshFlag === -1 ? undefined : process.argv[dshFlag + 1]
//update-begin---author:admin ---date:2026-10-26  for：【bug】只有打包运行时（Electron 桌面版）的机器上没有可解析的检出，旧代码在这里直接抛错、什么都校验不了；改为"有检出就做 YAML 校验，没有就退化成文本检查"-----------
let DSH_CHECKOUT
try {
  DSH_CHECKOUT = resolveDshCheckout(explicitDsh)
} catch {
  DSH_CHECKOUT = undefined
}
const DSH_RUNTIME = (() => {
  try {
    return resolveDshRuntime(explicitDsh ?? DSH_CHECKOUT)
  } catch {
    return undefined
  }
})()
let yaml
if (DSH_CHECKOUT !== undefined) {
  const require = createRequire(`${DSH_CHECKOUT.replace(/\\/g, '/')}/package.json`)
  yaml = require('js-yaml')
} else {
  console.log('SKIP js-yaml：找不到源码检出，改做文本级检查（YAML 语法留给 dsh 自己启动时验证）')
}
/** preset 里用 `!!js process.platform === 'win32'` 这类表达式，标准 schema 不认。 */
const schema = yaml === undefined ? undefined : yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar' }),
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'sequence' }),
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'mapping' }),
])
//update-end---author:admin ---date:2026-10-26  for：【bug】-----------

const options = parseCommonArgs(process.argv.slice(2), 'validate-presets')
const presets = options.presets.length > 0 ? options.presets : discoverPresets()

let failed = 0
let checked = 0
/**
 * 一份文件里所有 preset 声明。
 *
 * 形态有两代：老的是独立 preset 文件（顶层就是 plugins 列表）；0.1.7 起是内联在 profile 补丁里的
 * `insert: [ - id: preset-<name> ]`，以及用户层对随包 preset 的整份覆盖（`- id: preset-ptc` +
 * 完整 `config.plugins`）。两代都要能认，否则 profile 补丁会被整体 SKIP —— 那正是 2026-09-24
 * 「压缩与自动续写不生效」一直没被守卫发现的原因（当时它打印 ALL OK (0 preset mounted)）。
 *
 * @param doc - 已解析的 YAML 文档。
 * @returns {label, plugins} 列表。
 */
function collectPresets(doc) {
  const found = []
  const visit = (rows) => {
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      if (Array.isArray(row.plugins)) found.push({ label: String(row.id ?? row.config?.id ?? '?'), plugins: row.plugins })
      else if (Array.isArray(row.config?.plugins)) found.push({ label: String(row.id ?? row.config?.id ?? '?'), plugins: row.config.plugins })
      if (Array.isArray(row.insert)) visit(row.insert)
    }
  }
  // 老形态：顶层就是插件列表（preset 自己的 agent.cordis.yml）。
  const looksLikePluginList = Array.isArray(doc)
    && doc.some(row => row?.id === 'compaction' && Array.isArray(row?.config))
    && !doc.some(row => Array.isArray(row?.plugins) || Array.isArray(row?.config?.plugins))
  if (looksLikePluginList) found.push({ label: '(top-level)', plugins: doc })
  else visit(doc)
  return found
}

//update-begin---author:admin ---date:2026-10-26  for：【bug】没有源码检出时（桌面版）退化成文本检查：profile 补丁里每个 `- id: preset-*` 块内必须有 compact-agents 行、路径存在且指向本项目、阈值可读-----------
/**
 * 文本级检查（无 js-yaml 时用）：按缩进切出每个 preset 块，块内找 compaction 组。
 *
 * 与 YAML 那条路查的是同一组事实，只是不解析语法 —— 语法错误由 dsh 启动时自己报，
 * 而"行在不在、指向谁"是文本就能答的。
 * @param file - 待检查文件。
 * @param label - 报告用的短标签。
 */
function checkByText(file, label) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const rowIds = lines
    .map(line => /^\s*- id: (preset-\S+)\s*$/.exec(line)?.[1])
    .filter(Boolean)
  const blocks = rowIds.length === 0 ? [{ id: '(top-level)', start: 0, end: lines.length }] : rowIds.map(id => ({ id, ...findBlock(lines, id) }))
  for (const block of blocks) {
    if (block.start === undefined || block.start < 0) continue
    const slice = lines.slice(block.start, block.end)
    if (!slice.some(line => /^\s*- id: compaction\s*$/.test(line))) {
      console.log('SKIP ' + label + ' :: ' + block.id + ' (没有 compaction 组 —— 该 preset 不压缩，正常)')
      continue
    }
    const at = slice.findIndex(line => /^\s*- id: compact-agents\s*$/.test(line))
    if (at < 0) throw new Error(block.id + ': compaction 组内缺少 ' + ROW_ID + ' 行 —— 重跑 node scripts/install.mjs')
    const entryLine = slice[at + 1] ?? ''
    const entryName = /^\s*name:\s*'?([^'\n]+)'?\s*$/.exec(entryLine)?.[1]?.trim()
    if (entryName === undefined || entryName === '') throw new Error(block.id + ': ' + ROW_ID + ' 行没有可读的 name')
    const entryPath = /^file:\/\//i.test(entryName) ? fileURLToPath(entryName) : entryName
    if (!fs.existsSync(entryPath)) throw new Error(block.id + ': 引用的文件不存在: ' + entryName)
    if (entryPath.replace(/\\/g, '/') !== PLUGIN_ENTRY) throw new Error(block.id + ': 引用的不是本项目入口: ' + entryName)
    const thresholds = slice.join('\n')
    checked += 1
    console.log(label + ' :: ' + block.id)
    console.log('  thresholdRatio = ' + /thresholdRatio:\s*([0-9.]+)/.exec(thresholds)?.[1]
      + '  retainRatio = ' + /retainRatio:\s*([0-9.]+)/.exec(thresholds)?.[1])
    console.log('  ' + ROW_ID + ' -> ' + entryName + ' (存在)')
  }
}
//update-end---author:admin ---date:2026-10-26  for：【bug】-----------

for (const file of presets) {
  const label = file.replace(DSH_HOME + '\\', '').replace(DSH_HOME + '/', '')
  if (yaml === undefined) {
    try {
      checkByText(file, label)
    } catch (error) {
      failed += 1
      console.log('FAIL ' + label + ': ' + error.message)
    }
    continue
  }
  try {
    const doc = yaml.load(fs.readFileSync(file, 'utf8'), { schema })
    if (!Array.isArray(doc)) throw new Error('顶层不是列表')
    const declarations = collectPresets(doc)
    if (declarations.length === 0) throw new Error('文件里找不到 preset 声明（没有 plugins 列表）')
    const shipped = file.includes(path.sep + 'node_modules' + path.sep)
    for (const preset of declarations) {
      const group = preset.plugins.find(row => row?.id === 'compaction')
      if (group === undefined) {
        console.log('SKIP ' + label + ' :: ' + preset.label + ' (没有 compaction 组 —— 该 preset 不压缩，正常)')
        continue
      }
      if (!Array.isArray(group.config)) throw new Error(preset.label + ': compaction.config 不是列表')
      const mine = group.config.find(row => row?.id === ROW_ID)
      if (mine === undefined) {
        // 随包发行的 preset（@linxin666/*/presets/）被它自己的插件升级重写时会丢掉我们这行；
        // DSH 内置 preset（ptc 等）必须靠 profile 补丁整份覆盖，随包文件不许直接改。
        throw new Error(shipped
          ? preset.label + ': ' + ROW_ID + ' 行被发行包重写掉了（这个 preset 随 @linxin666/* 包发行）—— 重跑 node scripts/install.mjs 补回'
          : preset.label + ': compaction 组内缺少 ' + ROW_ID + ' 行 —— 重跑 node scripts/install.mjs 补回')
      }
      // 行名两种写法都要认：0.1.7 迁移后本机用 `file://` URL（见 2026-09-23 的 file-url 修正），
      // 旧安装与脚本写的是普通绝对路径。
      const entryPath = /^file:\/\//i.test(mine.name) ? fileURLToPath(mine.name) : mine.name
      if (!fs.existsSync(entryPath)) throw new Error(preset.label + ': 引用的文件不存在: ' + mine.name)
      if (entryPath.replace(/\\/g, '/') !== PLUGIN_ENTRY) throw new Error(preset.label + ': 引用的不是本项目入口: ' + mine.name)
      const basic = group.config.find(row => row?.id === 'compaction-basic')
      checked += 1
      console.log(label + ' :: ' + preset.label)
      console.log('  rows           = ' + group.config.map(row => row?.id).join(','))
      console.log('  thresholdRatio = ' + basic?.config?.thresholdRatio + '  retainRatio = ' + basic?.config?.retainRatio)
      console.log('  ' + ROW_ID + ' -> ' + mine.name + ' (存在)')
    }
  } catch (error) {
    failed += 1
    console.log('FAIL ' + label + ': ' + error.message)
  }
}

// ── 随包 preset 的覆盖完整性 ───────────────────────────────────────────
// 0.2.1-alpha.3 新增了 cordis 并把它设成新建会话的默认预设。只覆盖部分 preset 时，
// 选到未覆盖那份的会话会**静默**失去整个插件（工具 / 压缩播报 / 自动续写 / 预压），
// 而且 profile 里看不出任何异常 —— 2026-10-16 用户报「功能失效」就是这个。
// 所以这里把"随包有、profile 没覆盖"变成显式 FAIL，而不是等下一份新 preset 再漏一次。
if (options.presets.length === 0) {
  const declared = new Set()
  for (const file of presets) {
    if (yaml === undefined) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/^\s*- id: (preset-\S+)\s*$/gm)) {
        declared.add(match[1])
        declared.add(match[1].replace(/^preset-/, ''))
      }
      continue
    }
    try {
      const doc = yaml.load(fs.readFileSync(file, 'utf8'), { schema })
      for (const preset of collectPresets(doc)) {
        declared.add(String(preset.label))
        declared.add(String(preset.label).replace(/^preset-/, ''))
      }
    } catch {
      // 上面的遍历已经就同一份文件报过 FAIL，这里不重复计数。
    }
  }
  //update-begin---author:admin ---date:2026-10-26  for：【bug】随包清单同样改从运行时读（打包安装里在 app.asar 内）-----------
  const shippedList = DSH_RUNTIME === undefined ? [] : listShippedPresets(DSH_RUNTIME)
  if (DSH_RUNTIME === undefined) console.log('SKIP 随包 preset 完整性：找不到 DSH 运行时（--dsh 指定）')
  //update-end---author:admin ---date:2026-10-26  for：【bug】-----------
  for (const preset of shippedList) {
    if (declared.has(preset.name) || declared.has(preset.rowId)) continue
    failed += 1
    console.log('FAIL preset-' + preset.name + ': 随包 preset 没有被 profile 覆盖 —— 选到该预设的会话没有 '
      + ROW_ID + ' 行；重跑 node scripts/install.mjs')
  }
}

// ── 仓库自己的文档一致性 ───────────────────────────────────────────────
// README 顶上的版本徽章是手写的，靠自觉必然忘：它曾停在 0.4.0 而 package.json 已经 0.7.x，
// 而市场收录抓的正是 README —— 别人在 dsh.market 上看到的版本号就是那个过时的数字。
// 所以让两者不一致时直接失败，而不是等谁哪天顺手看见。
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const pkgVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
for (const name of ['README.md', 'README.en.md']) {
  const text = fs.readFileSync(path.join(repoRoot, name), 'utf8')
  const badge = /shields\.io\/badge\/version-([0-9][0-9.]*)-/.exec(text)
  if (badge === null) {
    failed += 1
    console.log(`FAIL ${name}: 找不到版本徽章 (shields.io/badge/version-<版本>-…)`)
    continue
  }
  if (badge[1] !== pkgVersion) {
    failed += 1
    console.log(`FAIL ${name}: 版本徽章是 ${badge[1]}，package.json 是 ${pkgVersion} —— 两者必须一致`)
    continue
  }
  console.log(`${name}: 版本徽章 ${badge[1]} == package.json`)
}

// ── profile 侧的"半装"状态 ─────────────────────────────────────────────
// 新版插件页（侧栏「插件」）只列 `installed || optional || error` 的 bundle，而
// `installed` 的判据是**profile 的 `dependencies` 里有没有这个包名**
// （`packages/boot/plugin-manager/src/index.ts` 的 `listBundles()`）。
// 于是"只写进 `dsh.profile.bundles`、没写进 `dependencies`"是一种**静默失败**：
// 宿主照常加载、preset 跑得好好的，但插件页里根本看不到它 —— 2026-09-17 上游把插件配置
// 从设置页搬到插件页后，我们的插件就是这么消失的。这个状态不该靠人记得，让它自动失败。
//
// profile 不存在（别人机器上没装过 / CI）时只 SKIP：这里校验的是"装了就得装对"。
const profileArg = process.argv.indexOf('--profile')
const profileName = profileArg === -1 ? (process.env.DSH_PROFILE ?? 'web') : process.argv[profileArg + 1]
const profileManifest = path.join(DSH_HOME, 'profiles', profileName, 'package.json')
if (!fs.existsSync(profileManifest)) {
  console.log(`profile ${profileName}: 没有 profile package.json —— 跳过 profile 校验`)
} else {
  const manifest = JSON.parse(fs.readFileSync(profileManifest, 'utf8'))
  const bundleListed = (manifest.dsh?.profile?.bundles ?? []).includes('dsh-compact-agents')
  const dependencySpec = manifest.dependencies?.['dsh-compact-agents']
  const label = `profile ${profileName}`
  if (!bundleListed && dependencySpec === undefined) {
    console.log(`${label}: 未安装本插件 —— 跳过 profile 校验`)
  } else if (dependencySpec === undefined) {
    failed += 1
    console.log(`FAIL ${label}: 在 dsh.profile.bundles 里但不在 dependencies 里 —— 新版插件页会整条过滤掉它`)
    console.log('     修：node scripts/install.mjs（会补 dependencies）或 dsh plugin add <本项目目录> --profile ' + profileName)
  } else {
    console.log(`${label}: dependencies["dsh-compact-agents"] = ${dependencySpec}${bundleListed ? '（也在 dsh.profile.bundles 里）' : ' ⚠ 不在 dsh.profile.bundles 里，重启后卡片/表单不出现'}`)
    if (!bundleListed) failed += 1
  }
}

console.log(failed === 0 ? `ALL OK (${checked} preset mounted)` : `${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
