/**
 * 三个脚本（install / uninstall / validate-presets）共用的路径与 preset 发现逻辑。
 *
 * 单独成文件是为了让"哪些 preset 需要打补丁"只有一处定义 —— 三份拷贝一定会漂移。
 * @module scripts/lib/presets
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 本项目根目录（本文件在 scripts/lib/ 下）。 */
export const PROJECT_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))

/** DSH 的 home（`~/.dsh`，可用 DSH_HOME 覆盖）。 */
export const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

/** 插件入口的绝对路径（正斜杠）—— 只用于本地文件比较，不要直接写进 preset 行。 */
export const PLUGIN_ENTRY = path.join(PROJECT_ROOT, 'index.js').split(path.sep).join('/')

//update-begin---author:admin ---date:2026-10-17  for：【bug】preset 行必须写 file:// URL：preset 子树走 EntryTree.import，Windows 裸盘符 E:/... 会被 Node 当成 e: 协议，报 ERR_UNSUPPORTED_ESM_URL_SCHEME，表现为「compact-agents (...): never started」、新建会话失败-----------
/** 插进 preset 行的插件入口 URL —— DSH profile 补丁里的 preset 行应该写它。 */
export const PLUGIN_ENTRY_URL = pathToFileURL(PLUGIN_ENTRY).href
//update-end---author:admin ---date:2026-10-17  for：【bug】-----------

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
 * 从 PATH 上找 `dsh` 启动器，并读出它指向的真实入口。
 *
 * 这是全新克隆时**唯一可用**的线索：包管理器生成的 shim 里写着 `dsh` 到底在哪儿，
 * 所以哪怕本项目还没建任何联接，也能反推出检出位置。shim 是 .cmd/.ps1(Windows)
 * 或 shell 脚本(POSIX)，文本里带一个绝对的 `.js/.mjs/.cjs` 入口路径。
 * @returns 入口文件路径列表（可能为空）。
 */
function dshLauncherEntries() {
  const names = process.platform === 'win32'
    ? ['dsh.cmd', 'dsh.exe', 'dsh.ps1', 'dsh']
    : ['dsh']
  const entries = []
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue
    for (const name of names) {
      const shim = path.join(dir, name)
      if (!fs.existsSync(shim)) continue
      let text
      try {
        text = fs.readFileSync(shim, 'utf8')
      } catch {
        continue
      }
      // 绝对路径（Windows 盘符或 POSIX 根）且以 JS 扩展名结尾。
      const match = /(?:[A-Za-z]:[\\/]|\/)[^"'\r\n]*?\.(?:js|mjs|cjs)/.exec(text)
      if (match !== null) entries.push(match[0])
    }
  }
  return entries
}

/**
 * 定位 DSH 检出，**不依赖任何硬编码盘符或用户目录**。
 *
 * 依次尝试：显式参数 → 本项目 `node_modules` 里既有的联接目标 → PATH 上的 `dsh`
 * 启动器(全新克隆时唯一有效的一招) → 各 profile 的 `node_modules` → 家目录下的
 * 常见克隆位置。前几条都是"自描述"的：装过一次之后，联接或启动器本身就记录了
 * 检出在哪里。
 * @param explicit - `--dsh` 或 `$DSH_CHECKOUT` 给出的路径。
 * @returns 检出根绝对路径。
 * @throws 全部候选都落空时抛出，并提示用 `--dsh` 指定。
 */
export function resolveDshCheckout(explicit) {
  const seeds = [
    explicit,
    process.env.DSH_HARNESS,
    path.join(PROJECT_ROOT, 'node_modules/@deepseek-ai/dsh-tools'),
    ...dshLauncherEntries(),
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
 * 一个文件里有没有指定 id 的插件行 —— 用来判断 profile 补丁是不是 0.1.7 那种
 * "preset 声明写在 YAML 里"的形态（那时 `- id: compaction-basic` 会作为插件行出现在补丁中）。
 * @param file - 待检查的文件。
 * @param rowId - 目标行 id。
 * @returns 命中则为 true；读不了也算 false。
 */
function declaresRow(file, rowId) {
  try {
    return new RegExp(`^\\s*-\\s*id:\\s*${rowId}\\s*$`, 'm').test(fs.readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

/**
 * 列出默认要处理的 preset 文件。
 *
 * **0.1.7 起位置变了**：上游 `d1e22a7e24`（#4569）删掉了 `@deepseek-ai/dsh-agent-presets` 的目录
 * 扫描，preset 声明搬进 profile 的 `cordis.patch.yml` —— 那里才是权威位置，也是读写都要落的地方。
 * 找到就**只用它**：旧位置的同名文件已经不被 DSH 读取，继续读写它们只会改到一份没人看的文件，
 * 让"在设置界面改压缩参数"这件事静默失效。
 *
 * 补丁里找不到相关行时才回退到旧位置，覆盖 0.1.6 及更早的安装：
 *   1. `$DSH_HOME/.agent-presets/<name>/agent.cordis.yml`（用户自建 preset）；
 *   2. `$DSH_HOME/profiles/<profile>/node_modules/@linxin666/<pkg>/presets/<name>/agent.cordis.yml`
 *      （发行版随 npm 包带进来的 preset）。
 *
 * 缺目录一律跳过，不报错 —— 换个 DSH 安装方式不该让脚本崩掉。
 * @returns 找到的 preset 文件路径列表（可能为空）。
 */
export function discoverPresets() {
  const current = []
  const profilesDir = path.join(DSH_HOME, 'profiles')
  if (fs.existsSync(profilesDir)) {
    for (const profile of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!profile.isDirectory()) continue
      const patch = path.join(profilesDir, profile.name, 'cordis.patch.yml')
      if (fs.existsSync(patch) && declaresRow(patch, 'compaction-basic')) current.push(patch)
    }
  }
  if (current.length > 0) return current

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
