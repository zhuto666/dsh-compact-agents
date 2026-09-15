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
