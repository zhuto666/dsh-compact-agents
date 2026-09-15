/**
 * 一键安装 / 修复：建好两个 junction，并往 preset 的 `compaction` 隔离组里追加挂载行。
 *
 * 幂等：已存在的东西原样跳过；重复运行安全。
 *
 * 用法：
 *   node scripts/install.mjs                              # 自动探测 DSH 检出与 preset
 *   node scripts/install.mjs --dsh /path/to/deepseek-harness
 *   node scripts/install.mjs --preset <agent.cordis.yml> [--preset ...]
 *   node scripts/install.mjs --dry-run                    # 只报告将要做什么
 *
 * 为什么需要这些步骤：见 README 的「安装」与「架构」两节。
 * @module scripts/install
 */
import fs from 'node:fs'
import path from 'node:path'
import { DSH_HOME, PLUGIN_ENTRY, PROJECT_ROOT, ROW_ID, GROUP_ID, discoverPresets, resolveDshCheckout } from './lib/presets.mjs'

/** 解析命令行参数（比另两个脚本多一个 `--dsh`）。 */
function parseArgs(argv) {
  const options = { dsh: process.env.DSH_CHECKOUT, presets: [], dryRun: false, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--dry-run') options.dryRun = true
    else if (token === '--force') options.force = true
    else if (token === '--dsh') options.dsh = argv[++i]
    else if (token === '--preset') options.presets.push(argv[++i])
    else throw new Error(`install: unknown argument ${token}`)
  }
  return options
}

/**
 * 建一个目录联接（Windows 上用 `junction`，不需要管理员权限）。
 * @param linkPath - 要创建的链接路径。
 * @param targetPath - 目标目录。
 * @param dryRun - 只报告时不动盘。
 * @returns 一行人类可读的结果。
 */
function ensureJunction(linkPath, targetPath, dryRun) {
  const label = path.relative(PROJECT_ROOT, linkPath).split(path.sep).join('/')
  if (fs.existsSync(linkPath)) {
    const pointsAt = fs.realpathSync(linkPath)
    return fs.realpathSync(targetPath) === pointsAt
      ? `ok       ${label} -> ${targetPath}`
      : `WARN     ${label} already exists but points at ${pointsAt}`
  }
  if (dryRun) return `create   ${label} -> ${targetPath}`
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(targetPath, linkPath, 'junction')
  return `created  ${label} -> ${targetPath}`
}

/**
 * 往一个 preset 的 `compaction` 组里追加挂载行。
 *
 * 用**行级文本插入**而不是 YAML 反序列化再序列化：后者会把 preset 里的注释、
 * `!!js` 表达式和排版全部重写掉，等于毁了别人的配置文件。
 * @param file - preset 文件路径。
 * @param entry - 插件入口的绝对路径（正斜杠）。
 * @param dryRun - 只报告时不动盘。
 * @returns 一行人类可读的结果。
 */
function patchPreset(file, entry, dryRun, force) {
  const label = file.replace(`${DSH_HOME}${path.sep}`, '')
  const original = fs.readFileSync(file, 'utf8')
  const lines = original.split('\n')
  const existing = lines.findIndex(line => new RegExp(`^\\s*-\\s*id:\\s*${ROW_ID}\\s*$`).test(line))
  if (existing !== -1) {
    // 项目可能已经被移动/改名：行还在，但指向的路径失效了。这种情况必须**自愈**，
    // 否则 preset 会引用一个不存在的文件，而用户只会看到"插件没生效"。
    const current = /^\s*name:\s*'?([^'\n]+)'?\s*$/.exec(lines[existing + 1] ?? '')?.[1]?.trim()
    if (current === undefined) return `WARN     ${label} (${ROW_ID} row has no readable name)`
    if (current.replace(/\\/g, '/') === entry) return `ok       ${label} (row already present)`
    if (fs.existsSync(current) && !force) {
      return `WARN     ${label} points at ${current}, not this project — rerun with --force to repoint`
    }
    if (dryRun) return `repoint  ${label} (${current} -> ${entry})`
    lines[existing + 1] = lines[existing + 1].replace(current, entry)
    fs.writeFileSync(`${file}.bak`, original)
    fs.writeFileSync(file, lines.join('\n'))
    return `repaired ${label} (${current} -> ${entry})`
  }
  const groupIndex = lines.findIndex(line => new RegExp(`^\\s*-\\s*id:\\s*${GROUP_ID}\\s*$`).test(line))
  if (groupIndex === -1) return `SKIP     ${label} (no \`- id: ${GROUP_ID}\` group)`
  const groupIndent = lines[groupIndex].length - lines[groupIndex].trimStart().length
  // 该组的范围：直到下一个同级（或更外层）的列表项。
  let blockEnd = lines.length
  for (let i = groupIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (/^\s*-\s/.test(line) && indent <= groupIndent) {
      blockEnd = i
      break
    }
  }
  // 追加到**组内最后一行之后**，而不是紧跟 `config:`：让既有的服务提供者
  // （compaction-basic 提供 `ctx.compaction`）排在新行前面，与已验证的排布一致。
  const rowIndent = groupIndent + 4
  let insertAt = -1
  for (let i = groupIndex + 1; i < blockEnd; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (indent !== rowIndent || !line.trimStart().startsWith('- ')) continue
    let end = i
    for (let j = i + 1; j < blockEnd; j += 1) {
      if (lines[j].trim() === '') continue
      const nested = lines[j].length - lines[j].trimStart().length
      if (nested <= rowIndent) break
      end = j
    }
    insertAt = end + 1
    i = end
  }
  if (insertAt === -1) return `SKIP     ${label} (${GROUP_ID} group has no rows)`
  const rowPad = ' '.repeat(rowIndent)
  const keyPad = ' '.repeat(rowIndent + 2)
  // preset 里相邻行之间用空行分隔，跟齐这个排版。
  const lead = lines[insertAt - 1]?.trim() === '' ? [] : ['']
  const insertion = [
    ...lead,
    `${rowPad}- id: ${ROW_ID}`,
    `${keyPad}name: '${entry}'`,
  ]
  if (dryRun) return `patch    ${label} (append row after line ${insertAt})`
  const next = [
    ...lines.slice(0, insertAt),
    ...insertion,
    ...lines.slice(insertAt),
  ].join('\n')
  fs.writeFileSync(`${file}.bak`, original)
  fs.writeFileSync(file, next)
  return `patched  ${label} (backup at ${path.basename(file)}.bak)`
}

const options = parseArgs(process.argv.slice(2))
const dsh = resolveDshCheckout(options.dsh)

console.log(`dsh checkout : ${dsh}`)
console.log(`dsh home     : ${DSH_HOME}`)
console.log(`plugin entry : ${PLUGIN_ENTRY}`)
console.log(`mode         : ${options.dryRun ? 'dry-run' : 'apply'}`)
console.log('')

console.log('junctions:')
console.log('  ' + ensureJunction(
  path.join(PROJECT_ROOT, 'node_modules/@deepseek-ai/dsh-tools'),
  path.join(dsh, 'packages/core/tools'),
  options.dryRun,
))
console.log('  ' + ensureJunction(
  path.join(PROJECT_ROOT, 'node_modules/@deepseek-ai/cordis'),
  path.join(dsh, 'vendor/cordis'),
  options.dryRun,
))

const presets = options.presets.length > 0 ? options.presets : discoverPresets()
console.log('')
console.log(`presets (${presets.length}):`)
if (presets.length === 0) {
  console.log('  none found — pass --preset <agent.cordis.yml> explicitly')
}
for (const file of presets) console.log('  ' + patchPreset(file, PLUGIN_ENTRY, options.dryRun, options.force))

console.log('')
console.log('next steps:')
console.log('  1. node scripts/validate-presets.mjs                   # 确认挂载行与阈值')
console.log('  2. 新开一条对话（不必重启 dsh）—— 该会话即带上 compact_agents 工具')
