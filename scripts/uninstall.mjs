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
import { DSH_HOME, PLUGIN_ENTRY, PROJECT_ROOT, ROW_ID, discoverPresets, parseCommonArgs } from './lib/presets.mjs'

/**
 * 删掉一个 preset 里的挂载行（行本身 + 属于它的续行）。
 *
 * 只移除**指向本项目**的那一行：克隆了两份时，从 A 跑 uninstall 不该拆掉 B 的安装。
 * @param file - preset 文件路径。
 * @param dryRun - 只报告时不动盘。
 * @param force - 该行指向别处时也照样移除。
 * @returns 一行人类可读的结果。
 */
function unpatchPreset(file, dryRun, force) {
  const label = file.replace(`${DSH_HOME}${path.sep}`, '')
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const index = lines.findIndex(line => new RegExp(`^\\s*-\\s*id:\\s*${ROW_ID}\\s*$`).test(line))
  if (index === -1) return `ok       ${label} (no row)`
  const target = /^\s*name:\s*'?([^'\n]+)'?\s*$/.exec(lines[index + 1] ?? '')?.[1]?.trim()
  if (target !== undefined && target.replace(/\\/g, '/') !== PLUGIN_ENTRY && !force) {
    return `SKIP     ${label} (points at ${target}, not this project — --force to remove anyway)`
  }
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

/**
 * 从 profile 的 `dsh.profile.bundles` 里摘掉一个包名。
 *
 * 与 `install.mjs` 的登记对称：同样是行级文本手术，保留原排版，写前留 `.bak-compact-agents`。
 * 没找到就原样返回 —— 卸载要幂等，重复跑不该失败。
 *
 * @param manifestPath - profile 的 package.json 路径。
 * @param packageName - 要摘掉的包名。
 * @param dryRun - 只报告时不动盘。
 * @returns 一行人类可读的结果。
 */
function unregisterProfileBundle(manifestPath, packageName, dryRun) {
  const label = manifestPath.replace(`${DSH_HOME}${path.sep}`, '')
  let original
  try {
    original = fs.readFileSync(manifestPath, 'utf8')
  } catch (error) {
    return `WARN     ${label} 读取失败: ${error.message}`
  }
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const line = new RegExp(`\\n[ \\t]*"${escaped}",?`)
  if (!line.test(original)) return `ok       ${label} (bundle not listed)`
  if (dryRun) return `remove   ${label} -= ${packageName}`
  fs.writeFileSync(`${manifestPath}.bak-compact-agents`, original)
  fs.writeFileSync(manifestPath, original.replace(line, ''))
  return `removed  ${label} -= ${packageName}`
}

// `--force` / `--profile` 先自己摘掉，再把剩下的交给 parseCommonArgs。
// 这里有两个必须记住的坑，都是真实踩过的：
//   1. 下标必须和传进去的那个数组同一套编号（都是 slice(2) 之后的），不能混用 process.argv 的下标；
//   2. 没有 `--profile` 时 `indexOf` 返回 -1，`profileArg + 1` 正好是 **0**，会把第一个参数
//      （通常就是 `--dry-run`）当成 profile 的值滤掉 —— 于是"预演"变成真的卸载。
//      所以只有 `profileArg !== -1` 时才跳过它后面那个参数。
const argv = process.argv.slice(2)
const force = argv.includes('--force')
const profileArg = argv.indexOf('--profile')
const profile = profileArg === -1 ? (process.env.DSH_PROFILE ?? 'web') : argv[profileArg + 1]
const options = parseCommonArgs(argv.filter((token, index) => (
  token !== '--force'
  && token !== '--profile'
  && !(profileArg !== -1 && index === profileArg + 1)
)), 'uninstall')
const presets = options.presets.length > 0 ? options.presets : discoverPresets()

console.log(`mode: ${options.dryRun ? 'dry-run' : 'apply'}`)
console.log('')
console.log(`presets (${presets.length}):`)
for (const file of presets) console.log('  ' + unpatchPreset(file, options.dryRun, force))
console.log('')
console.log('junctions:')
console.log('  ' + removeJunction(path.join(PROJECT_ROOT, 'node_modules/@deepseek-ai/dsh-tools'), options.dryRun))
console.log('  ' + removeJunction(path.join(PROJECT_ROOT, 'node_modules/@deepseek-ai/cordis'), options.dryRun))
console.log('  ' + removeJunction(path.join(PROJECT_ROOT, 'node_modules/@deepseek-ai/schemastery'), options.dryRun))
console.log('')
console.log(`profile bundle (${profile}):`)
console.log('  ' + removeJunction(
  path.join(DSH_HOME, 'profiles', profile, 'node_modules', 'dsh-compact-agents'),
  options.dryRun,
))
console.log('  ' + unregisterProfileBundle(
  path.join(DSH_HOME, 'profiles', profile, 'package.json'),
  'dsh-compact-agents',
  options.dryRun,
))
console.log('')
console.log('done — 重启 dsh 后设置页那张卡片消失；新开一条对话后 compact_agents 即不再出现；')
console.log('       preset 与 profile package.json 的 .bak-compact-agents 备份未删除。')
