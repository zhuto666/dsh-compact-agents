/**
 * 一键安装 / 修复：建好两个 junction、往 preset 的 `compaction` 隔离组里追加挂载行、
 * 把本包登记成 profile 的 bundle **与依赖**（后者决定新版插件页里能不能看见我们）。
 *
 * 幂等：已存在的东西原样跳过；重复运行安全。
 *
 * 用法：
 *   node scripts/install.mjs                              # 自动探测 DSH 检出与 preset
 *   node scripts/install.mjs --dsh /path/to/deepseek-harness
 *   node scripts/install.mjs --preset <agent.cordis.yml> [--preset ...]
 *   node scripts/install.mjs --dry-run                    # 只报告将要做什么（不跑外部命令）
 *   node scripts/install.mjs --profile web                # 指定 profile（默认 web）
 *   node scripts/install.mjs --no-cli                     # 不调用 `dsh plugin add`，只做手写登记
 *
 * 为什么需要这些步骤：见 README 的「安装」与「架构」两节。
 * @module scripts/install
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DSH_HOME, PLUGIN_ENTRY, PROJECT_ROOT, ROW_ID, GROUP_ID, discoverPresets, resolveDshCheckout } from './lib/presets.mjs'

/** 解析命令行参数（比另两个脚本多一个 `--dsh`）。 */
function parseArgs(argv) {
  const options = { dsh: process.env.DSH_CHECKOUT, presets: [], dryRun: false, force: false, cli: true, profile: process.env.DSH_PROFILE ?? 'web' }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--dry-run') options.dryRun = true
    else if (token === '--force') options.force = true
    else if (token === '--no-cli') options.cli = false
    else if (token === '--dsh') options.dsh = argv[++i]
    else if (token === '--preset') options.presets.push(argv[++i])
    else if (token === '--profile') options.profile = argv[++i]
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
 * 往一个 profile 的 `dsh.profile.bundles` 里加一个包名。
 *
 * 用**行级文本插入**而不是 JSON 反序列化再序列化：后者会把这个文件重排一遍，
 * 而它可能带着用户自己的排版与（未来的）注释。
 *
 * @param manifestPath - profile 的 package.json 路径。
 * @param packageName - 要登记为 bundle 的包名。
 * @param dryRun - 只报告时不动盘。
 * @returns 一行人类可读的结果。
 */
function registerProfileBundle(manifestPath, packageName, dryRun) {
  const label = manifestPath.replace(`${DSH_HOME}${path.sep}`, '')
  let original
  try {
    original = fs.readFileSync(manifestPath, 'utf8')
  } catch (error) {
    return `WARN     ${label} 读取失败: ${error.message}`
  }
  if (new RegExp(`"${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(original)) {
    return `ok       ${label} (bundle already listed)`
  }
  const anchor = /("bundles"\s*:\s*\[)(\r?\n)/.exec(original)
  if (anchor === null) return `WARN     ${label} (找不到 dsh.profile.bundles 数组)`
  if (dryRun) return `create   ${label} += ${packageName}`
  const insertAt = anchor.index + anchor[1].length
  const indent = /\n(\s*)"/.exec(original.slice(anchor.index))?.[1] ?? '   '
  const next = `${original.slice(0, insertAt)}${anchor[2]}${indent}"${packageName}",${original.slice(insertAt)}`
  fs.writeFileSync(`${manifestPath}.bak-compact-agents`, original)
  fs.writeFileSync(manifestPath, next)
  return `created  ${label} += ${packageName}`
}

/**
 * 往 profile 的 `dependencies` 里登记本包（本地 `link:` 依赖）。
 *
 * ## 为什么非登记不可（这不是洁癖，是"插件页里能不能看见我们"的开关）
 *
 * 新版插件页（侧栏「插件」，`ui-plugin-manager`）只列
 * `pkg.installed || pkg.optional || pkg.error` 三种 bundle；`installed` 的判据是
 * **profile 的 `dependencies` 里有没有这个包名**（`plugin-manager.listBundles()`）。
 * 只写进 `dsh.profile.bundles` 而不进 dependencies 的话：
 * `installed=false`、`optional=false`、`error=undefined` → 整条被页面过滤掉，
 * 表现就是"插件页里根本没有这个插件"，而且**没有任何报错**。
 *
 * 用 `link:` 把本目录挂成依赖（pnpm 对本地目录就用这个协议），于是 `pnpm install`
 * 不会去 registry 找包，插件页也能读到我们的 `dsh.bundle.patch` 与各行。
 * 同样是行级文本插入 + 写前备份，失败时回滚，不留半写状态。
 *
 * @param manifestPath - profile 的 package.json 路径。
 * @param packageName - 要登记的包名。
 * @param targetDir - 本项目的绝对目录。
 * @param dryRun - 只报告时不动盘。
 * @returns 一行人类可读的结果。
 */
function registerProfileDependency(manifestPath, packageName, targetDir, dryRun) {
  const label = manifestPath.replace(`${DSH_HOME}${path.sep}`, '')
  let original
  try {
    original = fs.readFileSync(manifestPath, 'utf8')
  } catch (error) {
    return `WARN     ${label} 读取失败: ${error.message}`
  }
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`"${escaped}"\\s*:`).test(original)) return `ok       ${label} (dependency already listed)`
  const anchor = /("dependencies"\s*:\s*\{)(\r?\n)/.exec(original)
  if (anchor === null) return `WARN     ${label} (找不到 dependencies 对象)`
  if (dryRun) return `create   ${label} += ${packageName}: link:${targetDir}`
  const insertAt = anchor.index + anchor[1].length
  const indent = /\n(\s*)"/.exec(original.slice(anchor.index))?.[1] ?? '    '
  const spec = `link:${targetDir.split(path.sep).join('/')}`
  const next = `${original.slice(0, insertAt)}${anchor[2]}${indent}"${packageName}": "${spec}",${original.slice(insertAt)}`
  fs.writeFileSync(`${manifestPath}.bak-compact-agents`, original)
  try {
    fs.writeFileSync(manifestPath, next)
  } catch (error) {
    // 写坏了就把备份原样放回去 —— 卸载脚本认这份备份，半写状态会让它认不出来。
    fs.writeFileSync(manifestPath, original)
    return `WARN     ${label} 写入失败并已回滚: ${error.message}`
  }
  return `created  ${label} += ${packageName}: ${spec}`
}

/**
 * 先试着走官方通道 `dsh plugin add <本地目录>`。
 *
 * 官方通道把 `dependencies`、`dsh.profile.bundles` 与实际安装一次做完
 * （`plugin-manager.installBundle()` 内部就是 `pnpm add <spec>` + 选出新依赖 + 加进
 * `dsh.profile.bundles` + 热重载；`parseInstallSpec` 接受绝对路径与 `file:`/`link:` 前缀，
 * 插件页「添加插件」走的是同一条路），比我们手写 JSON 更不容易漂移。
 *
 * 注意是 `add` 不是 `install`：`dsh plugin` 只是把参数原样转发给 profile 目录里的 pnpm，
 * 而 pnpm 的 `install <pkg>` 语义不对（`add` 才是加依赖）。
 *
 * 失败（没装 pnpm、被别的进程锁住、被 safe-delete 拦下……）不算错：调用方会回落手写路径，
 * 报告里留一行原因。
 *
 * @param packageDir - 本项目目录。
 * @param profile - profile 名。
 * @returns `{ok, detail}`；未尝试时 `ok === false` 且 detail 说明原因。
 */
function tryOfficialInstall(packageDir, profile) {
  const result = spawnSync('dsh', ['plugin', 'add', packageDir, '--profile', profile], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 300000,
  })
  if (result.error !== undefined) return { ok: false, detail: result.error.message }
  if (result.status !== 0) {
    const tail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().split('\n').filter(Boolean).slice(-2).join(' / ')
    return { ok: false, detail: tail === '' ? `exit ${result.status}` : tail }
  }
  return { ok: true, detail: 'dsh plugin add' }
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
// 设置面要用 schemastery 声明命名空间的 schema（动态 import，缺了只会少一个设置页，不会让插件挂掉）。
console.log('  ' + ensureJunction(
  path.join(PROJECT_ROOT, 'node_modules/@deepseek-ai/schemastery'),
  path.join(dsh, 'vendor/schemastery'),
  options.dryRun,
))

const presets = options.presets.length > 0 ? options.presets : discoverPresets()
console.log('')
console.log(`presets (${presets.length}):`)
if (presets.length === 0) {
  console.log('  none found — pass --preset <agent.cordis.yml> explicitly')
}
for (const file of presets) console.log('  ' + patchPreset(file, PLUGIN_ENTRY, options.dryRun, options.force))

// ── 宿主组成里的 bundle ──────────────────────────────────────────────────────
// 浏览器 half（那张表单）**必须**靠宿主 Loader 的行才能被发现：
// `ClientModuleRegistry` 只遍历宿主 Loader 的 entries，手动挂载（preset 行）会被直接丢弃。
// 所以除了 preset 行，本包还要作为 profile 的一个 bundle 出现在宿主组成里 —— 而且必须
// 同时进 `dependencies`，否则新版插件页会把它整条过滤掉（见 registerProfileDependency 的注释）。
const profileManifest = path.join(DSH_HOME, 'profiles', options.profile, 'package.json')
console.log('')
console.log(`profile bundle (${options.profile}):`)
// 官方通道优先：`dsh plugin add` 会把 dependencies、bundles 与实际安装一次做完。
// dry-run 不跑外部命令（预演不该有副作用），`--no-cli` 可以完全跳过它。
if (options.cli && !options.dryRun) {
  const official = tryOfficialInstall(PROJECT_ROOT, options.profile)
  console.log('  ' + (official.ok
    ? 'ok       dsh plugin add（官方通道已完成依赖与 bundle 登记）'
    : `note     dsh plugin add 未成功（${official.detail}）—— 回落到手写登记`))
} else {
  console.log(`  note     跳过 dsh plugin add（${options.dryRun ? 'dry-run' : '--no-cli'}）`)
}
console.log('  ' + ensureJunction(
  path.join(DSH_HOME, 'profiles', options.profile, 'node_modules', 'dsh-compact-agents'),
  PROJECT_ROOT,
  options.dryRun,
))
console.log('  ' + registerProfileDependency(profileManifest, 'dsh-compact-agents', PROJECT_ROOT, options.dryRun))
console.log('  ' + registerProfileBundle(profileManifest, 'dsh-compact-agents', options.dryRun))

console.log('')
console.log('next steps:')
console.log('  1. node scripts/validate-presets.mjs                   # 确认挂载行、阈值与 profile 依赖')
console.log('  2. node scripts/inspect-presets.mjs                    # 表单会显示哪些初值')
console.log('  3. 重启 dsh —— 宿主组成变了，插件与浏览器 half 都要重新加载；')
console.log('     重启后：侧栏「插件」→ 找到 dsh-compact-agents → 详情页里有「压缩与自动续写」表单')
console.log('     （老版本 dsh ≤ 0.1.5 仍在「设置 → 插件 → 可配置」里出现同一张卡片）；')
console.log('     compact_agents 工具照旧只需新开一条对话（不必重启）。')
