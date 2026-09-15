/**
 * 三个脚本（install / uninstall / validate-presets）共用的路径与 preset 发现逻辑。
 *
 * 单独成文件是为了让"哪些 preset 需要打补丁"只有一处定义 —— 三份拷贝一定会漂移。
 * @module scripts/lib/presets
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本项目根目录（本文件在 scripts/lib/ 下）。 */
export const PROJECT_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))

/** DSH 的 home（`~/.dsh`，可用 DSH_HOME 覆盖）。 */
export const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

/** 插件入口的绝对路径（正斜杠）—— preset 行里写的就应该是它。 */
export const PLUGIN_ENTRY = path.join(PROJECT_ROOT, 'index.js').split(path.sep).join('/')

/** preset 挂载行使用的行 id。 */
export const ROW_ID = 'compact-agents'

/** preset 里承载 compaction 相关插件的隔离组 id。 */
export const GROUP_ID = 'compaction'

/**
 * 一个目录是否是可用的 DSH 检出。
 *
 * 两个标志文件缺一不可：`packages/core/tools`（插件要解析的 `@deepseek-ai/dsh-tools`）
 * 与 `vendor/cordis`（宿主框架）。只认检出，不认"随便一个装了 dsh 的 node_modules"。
 * @param dir - 待检查目录。
 * @returns 是检出则为 true。
 */
export function isDshCheckout(dir) {
  return fs.existsSync(path.join(dir, 'packages/core/tools/package.json'))
    && fs.existsSync(path.join(dir, 'vendor/cordis/package.json'))
}

/**
 * 从一个已知的包目录向上找检出根 —— 检出可能装在任意深度，不能写死盘符。
 * @param from - 起始目录（通常是某个 `@deepseek-ai/*` 包的真实路径）。
 * @returns 检出根，找不到则为 undefined。
 */
function walkUpToCheckout(from) {
  let dir = from
  for (let depth = 0; depth < 8; depth += 1) {
    if (isDshCheckout(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * 定位 DSH 检出，**不依赖任何本机盘符**。
 *
 * 依次尝试：显式参数 → 本项目 `node_modules` 里既有的联接目标 → 各 profile 的
 * `node_modules` 里的 `@deepseek-ai/dsh-tools` → 家目录下的常见克隆位置。
 * 前两条是"自描述"的：安装过一次之后，联接本身就记录了检出在哪里。
 * @param explicit - `--dsh` 或 `$DSH_CHECKOUT` 给出的路径。
 * @returns 检出根绝对路径。
 * @throws 全部候选都落空时抛出，并提示用 `--dsh` 指定。
 */
export function resolveDshCheckout(explicit) {
  const seeds = [
    explicit,
    process.env.DSH_HARNESS,
    path.join(PROJECT_ROOT, 'node_modules/@deepseek-ai/dsh-tools'),
  ]
  const profiles = path.join(DSH_HOME, 'profiles')
  if (fs.existsSync(profiles)) {
    for (const profile of fs.readdirSync(profiles, { withFileTypes: true })) {
      seeds.push(path.join(profiles, profile.name, 'node_modules/@deepseek-ai/dsh-tools'))
    }
  }
  seeds.push(
    path.join(os.homedir(), 'deepseek-harness'),
    path.join(os.homedir(), 'dy', 'deepseek-harness'),
    path.join(os.homedir(), 'code', 'deepseek-harness'),
  )
  for (const seed of seeds) {
    if (typeof seed !== 'string' || seed === '') continue
    // 既有的联接要解到真实路径，否则向上走会停在插件自己的目录里。
    let start = seed
    try {
      start = fs.realpathSync(seed)
    } catch {
      // 不存在就按原样试：用户可能直接把检出根传了进来。
    }
    const found = walkUpToCheckout(start)
    if (found !== undefined) return found
  }
  throw new Error(
    'cannot locate the DSH checkout; pass --dsh <checkout> or set DSH_CHECKOUT '
    + '(it must contain packages/core/tools and vendor/cordis)',
  )
}

/**
 * 列出默认要处理的 preset 文件：
 *   1. `$DSH_HOME/.agent-presets/<name>/agent.cordis.yml`（用户自建 preset）；
 *   2. `$DSH_HOME/profiles/<profile>/node_modules/@linxin666/<pkg>/presets/<name>/agent.cordis.yml`
 *      （发行版随 npm 包带进来的 preset）。
 *
 * 缺目录一律跳过，不报错 —— 换个 DSH 安装方式不该让脚本崩掉。
 * @returns 找到的 preset 文件路径列表（可能为空）。
 */
export function discoverPresets() {
  const found = []
  const userPresets = path.join(DSH_HOME, '.agent-presets')
  if (fs.existsSync(userPresets)) {
    for (const entry of fs.readdirSync(userPresets, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(userPresets, entry.name, 'agent.cordis.yml')
      if (fs.existsSync(file)) found.push(file)
    }
  }
  const profiles = path.join(DSH_HOME, 'profiles')
  if (fs.existsSync(profiles)) {
    for (const profile of fs.readdirSync(profiles, { withFileTypes: true })) {
      if (!profile.isDirectory()) continue
      const shipped = path.join(profiles, profile.name, 'node_modules/@linxin666')
      if (!fs.existsSync(shipped)) continue
      for (const pkg of fs.readdirSync(shipped, { withFileTypes: true })) {
        const presetsDir = path.join(shipped, pkg.name, 'presets')
        if (!fs.existsSync(presetsDir)) continue
        for (const preset of fs.readdirSync(presetsDir, { withFileTypes: true })) {
          const file = path.join(presetsDir, preset.name, 'agent.cordis.yml')
          if (fs.existsSync(file)) found.push(file)
        }
      }
    }
  }
  return found
}

/**
 * 从 argv 里取出 `--preset <file>`（可重复）与 `--dry-run`。
 * @param argv - `process.argv.slice(2)`。
 * @param tool - 出现在报错信息里的脚本名。
 * @returns 解析结果。
 */
export function parseCommonArgs(argv, tool) {
  const options = { presets: [], dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--dry-run') options.dryRun = true
    else if (token === '--preset') options.presets.push(argv[++i])
    else throw new Error(`${tool}: unknown argument ${token}`)
  }
  return options
}
