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
import { DSH_HOME, PLUGIN_ENTRY, ROW_ID, discoverPresets, parseCommonArgs, resolveDshCheckout } from './lib/presets.mjs'

// 本项目刻意不装依赖（离线、零安装）：js-yaml 与 cordis 一样从 DSH 检出里借。
// 检出位置靠自描述探测（--dsh / $DSH_CHECKOUT / 既有联接 / profile），不写死盘符。
const dshFlag = process.argv.indexOf('--dsh')
const DSH_CHECKOUT = resolveDshCheckout(dshFlag === -1 ? undefined : process.argv[dshFlag + 1])
const require = createRequire(`${DSH_CHECKOUT.replace(/\\/g, '/')}/package.json`)
const yaml = require('js-yaml')
// preset 里用 `!!js process.platform === 'win32'` 这类表达式，标准 schema 不认。
const schema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar' }),
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'sequence' }),
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'mapping' }),
])

const options = parseCommonArgs(process.argv.slice(2), 'validate-presets')
const presets = options.presets.length > 0 ? options.presets : discoverPresets()

let failed = 0
let checked = 0
for (const file of presets) {
  const label = file.replace(`${DSH_HOME}\\`, '').replace(`${DSH_HOME}/`, '')
  try {
    const doc = yaml.load(fs.readFileSync(file, 'utf8'), { schema })
    if (!Array.isArray(doc)) throw new Error('顶层不是列表')
    const group = doc.find(row => row?.id === 'compaction')
    if (group === undefined) {
      console.log(`SKIP ${label} (没有 compaction 组 —— 该 preset 不压缩，正常)`)
      continue
    }
    if (!Array.isArray(group.config)) throw new Error('compaction.config 不是列表')
    const mine = group.config.find(row => row?.id === ROW_ID)
    if (mine === undefined) throw new Error(`compaction 组内缺少 ${ROW_ID} 行`)
    if (!fs.existsSync(mine.name)) throw new Error(`引用的文件不存在: ${mine.name}`)
    if (mine.name.replace(/\\/g, '/') !== PLUGIN_ENTRY) {
      throw new Error(`引用的不是本项目入口: ${mine.name}`)
    }
    const basic = group.config.find(row => row?.id === 'compaction-basic')
    checked += 1
    console.log(label)
    console.log(`  rows           = ${group.config.map(row => row?.id).join(',')}`)
    console.log(`  thresholdRatio = ${basic?.config?.thresholdRatio}  retainRatio = ${basic?.config?.retainRatio}`)
    console.log(`  ${ROW_ID} -> ${mine.name} (存在)`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${label}: ${error.message}`)
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

console.log(failed === 0 ? `ALL OK (${checked} preset mounted)` : `${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
