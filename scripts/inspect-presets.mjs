/**
 * 只读自检：确认在**真实的 preset 文件**上，"发现 → 读到生效值"这条路径跑得通。
 *
 * 与 settings-test.mjs 的区别：那个用临时夹具，本脚本读真实文件但**只读不写**，
 * 用来在重启 DSH 之前确认设置界面将要显示的初始值是什么。
 *
 * 运行：node scripts/inspect-presets.mjs
 */
import path from 'node:path'
import { DSH_HOME, discoverPresets } from './lib/presets.mjs'
import { SETTINGS_FIELDS, SETTINGS_NAMESPACE, readPresetValues, resolveMaxAutoContinues } from '../settings.js'

const files = discoverPresets()
console.log(`命名空间   : ${SETTINGS_NAMESPACE}`)
console.log(`preset 文件: ${files.length} 个`)
for (const file of files) {
  const label = file.startsWith(DSH_HOME) ? `<dsh home>${file.slice(DSH_HOME.length)}` : file
  console.log(`  - ${label}`)
}

const { values, problems } = readPresetValues()
console.log(`\n读到的生效值（将作为设置界面的初值）:`)
for (const [key, description] of Object.entries(SETTINGS_FIELDS)) {
  const value = values[key]
  console.log(`  ${key.padEnd(20)} = ${value === undefined ? '(preset 里没有，用 schema 默认值)' : value}`)
  console.log(`  ${' '.repeat(20)}   ${description}`)
}
if (problems.length > 0) {
  console.log(`\n读取异常 (${problems.length}):`)
  for (const problem of problems) console.log(`  - ${problem}`)
}

const presetKeys = Object.keys(values)
const missing = presetKeys.length === 0
console.log(`\n行配置兜底: notice=${true} maxAutoContinues=${resolveMaxAutoContinues({})}`)
console.log(missing
  ? 'WARN 一个 preset 值都没读到 —— 设置界面会显示 schema 默认值（检查安装是否完整）'
  : `OK   读到 ${presetKeys.length} 个 preset 值；本脚本只读，未修改任何文件`)
process.exit(missing ? 1 : 0)
