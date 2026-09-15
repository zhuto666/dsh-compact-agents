/**
 * 卸载：从 preset 里移除挂载行，并删掉本项目创建的 junction。
 *
 * 只删自己加的东西 —— preset 的其它内容、注释、`!!js` 表达式一律不动。
 *
 * 用法：
 *   node scripts/uninstall.mjs
 *   node scripts/uninstall.mjs --preset <agent.cordis.yml> [--preset ...]
 *   node scripts/uninstall.mjs --dry-run
 * @module scripts/uninstall
 */
import fs from 'node:fs'
import path from 'node:path'
import { DSH_HOME, PROJECT_ROOT, ROW_ID, discoverPresets, parseCommonArgs } from './lib/presets.mjs'

/**
 * 删掉一个 preset 里的挂载行（行本身 + 属于它的续行）。
 * @param file - preset 文件路径。
 * @param dryRun - 只报告时不动盘。
 * @returns 一行人类可读的结果。
 */
function unpatchPreset(file, dryRun) {
  const label = file.replace(`${DSH_HOME}${path.sep}`, '')
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const index = lines.findIndex(line => new RegExp(`^\\s*-\\s*id:\\s*${ROW_ID}\\s*$`).test(line))
  if (index === -1) return `ok       ${label} (no row)`
  const indent = lines[index].length - lines[index].trimStart().length
  let end = index + 1
  while (end < lines.length) {
    const line = lines[end]
    const lineIndent = line.length - line.trimStart().length
    if (line.trim() === '') break
    if (lineIndent <= indent) break
    end += 1
  }
  // 行前是空行、行后也是空行时，连尾部空行一起删，避免留下连续两个空行。
  if (lines[index - 1]?.trim() === '' && lines[end]?.trim() === '') end += 1
  if (dryRun) return `remove   ${label} (lines ${index + 1}-${end})`
  fs.writeFileSync(file, [...lines.slice(0, index), ...lines.slice(end)].join('\n'))
  return `removed  ${label}`
}

/**
 * 删除一个 junction。只删链接本身，绝不碰目标目录。
 * @param linkPath - 链接路径。
 * @param dryRun - 只报告时不动盘。
 * @returns 一行人类可读的结果。
 */
function removeJunction(linkPath, dryRun) {
  const label = path.relative(PROJECT_ROOT, linkPath).split(path.sep).join('/')
  if (!fs.existsSync(linkPath)) return `ok       ${label} (absent)`
  const stat = fs.lstatSync(linkPath)
  if (!stat.isSymbolicLink()) return `WARN     ${label} is a real directory, left untouched`
  if (dryRun) return `remove   ${label}`
  fs.unlinkSync(linkPath)
  return `removed  ${label}`
}

const options = parseCommonArgs(process.argv.slice(2), 'uninstall')
const presets = options.presets.length > 0 ? options.presets : discoverPresets()

console.log(`mode: ${options.dryRun ? 'dry-run' : 'apply'}`)
console.log('')
console.log(`presets (${presets.length}):`)
for (const file of presets) console.log('  ' + unpatchPreset(file, options.dryRun))
console.log('')
console.log('junctions:')
console.log('  ' + removeJunction(path.join(PROJECT_ROOT, 'node_modules/@deepseek-ai/dsh-tools'), options.dryRun))
console.log('  ' + removeJunction(path.join(PROJECT_ROOT, 'node_modules/@deepseek-ai/cordis'), options.dryRun))
console.log('')
console.log('done — 新开一条对话后 compact_agents 即不再出现；preset 的 .bak 备份未删除。')
