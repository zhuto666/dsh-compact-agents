/**
 * 自愈：让"从社区更新插件版本"这一件事就够，不需要任何人再手跑 `node scripts/install.mjs`。
 *
 * ## 它修的是什么
 *
 * `compact_agents` 工具、对话区压缩播报、自动续写、回合结束预压，全都由 **preset 的
 * `compaction` 隔离组里的 `compact-agents` 行**提供。这一行没法随包下发 ——
 * preset 是 DSH 自己发的东西（0.1.7 起声明搬进 profile 的 `cordis.patch.yml`，0.2.x 里
 * 每份随包 preset 的插件列表都在那里被整份覆盖），插件要在里面插一行，只能改那个文件。
 *
 * 以前的答案是"装完手动跑 install.mjs"。实测的代价（2026-10-26）：桌面版把 DSH 打进
 * `resources/app.asar`，脚本按检出找随包 preset 找的是另一套安装，用户按 README 跑完
 * 还是"插件不生效"；而且 DSH 每升级一次、每加一份 preset，都得有人记得重跑。
 *
 * 所以改成运行时自愈：**宿主行 `client-host.js` 每次启动（含插件热更新后的重启/重载）
 * 检查一遍，"随包 preset 有没有被本 profile 覆盖"，缺什么补什么，然后让 hmr 热重组
 * 生效** —— 用户全程只做一件事：更新版本。
 *
 * ## 边界（这里刻意保守，出问题也只会退化成"下次启动生效"）
 *
 * - 只在**宿主行**跑（`client-host.js`），不在 preset 行跑：preset 行随会话换代反复 apply，
 *   而且它自己就在要被修改的那个文件所描述的对象里。
 * - 一个进程只跑一次（`scheduled`），延迟执行（默认 2s）：`apply()` 期间宿主的 loader 还在
 *   组合，这时候去 reconcile 会自己等自己。
 * - 任何一步失败都只 `logger.warn`，绝不抛出 —— 自愈失败不能连累插件本体。
 * - 写盘前留 `.bak-compact-agents`，写临时文件再 `rename`，与 install.mjs 同一套纪律。
 * - 热重组拿不到 `hmr` 服务（例如 `dsh --profile web` 之外的无 profile 场景）时只落文件，
 *   下次启动生效，并明确告诉用户为什么。
 * @module dsh-compact-agents/self-heal
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DSH_HOME, resolveDshRuntime, setActiveProfileDir } from '../scripts/lib/presets.mjs'
import {
  DEFAULT_RETAIN_RATIO,
  DEFAULT_THRESHOLD_RATIO,
  ensureDeclaredRows,
  listShippedPresets,
  syncOverrides,
} from '../scripts/lib/preset-overrides.mjs'

/** 本包安装位置（`lib/self-heal.js` 的上一级）；preset 行要指向它的 `index.js`。 */
const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** preset 行写法：`file://` URL（Windows 裸盘符会被 Node 当成 `e:` 协议）。 */
export const ENTRY_URL = pathToFileURL(path.join(PACKAGE_ROOT, 'index.js')).href

/** 本进程是否已经排过一次自愈 —— 宿主行可能因插件热更新重挂多次。 */
let scheduled = false

/** 上一次自愈的结果，供 `inspect` / 测试读取。 */
let lastReport

/**
 * 排定一次自愈（进程内只排一次）。
 * @param ctx - 宿主根上下文。
 * @param options - `delayMs` 延迟；`enabled: false` 关闭；`profile` 直接给出 profile 目录（测试用）。
 * @returns 定时器句柄（已 unref）。
 */
export function scheduleSelfHeal(ctx, options = {}) {
  if (scheduled || options.enabled === false) return undefined
  if (process.env.DSH_COMPACT_AGENTS_NO_SELF_HEAL === '1') return undefined
  scheduled = true
  const timer = setTimeout(() => {
    runSelfHeal(ctx, options).catch((error) => {
      lastReport = { status: 'failed', detail: error instanceof Error ? error.message : String(error) }
      warn(ctx, `自愈失败（不影响插件本体）: ${lastReport.detail}`)
    })
  }, options.delayMs ?? 2000)
  timer.unref?.()
  return timer
}

/**
 * 执行一次自愈。
 * @param ctx - 宿主根上下文（只用到 `get` / `logger`）。
 * @param options - `profile` profile 目录；`entry` preset 行写法；`thresholdRatio` / `retainRatio`；
 *   `runtime` DSH 运行时根；`dryRun` 只算不写（测试用）。
 * @returns '{ status, detail, changed, presets, hot }'。
 *   status: `ok` 已覆盖 / `repaired` 已修复 / `skipped` 不适用 / `failed` 修复失败。
 */
export async function runSelfHeal(ctx, options = {}) {
  const profileDir = options.profile ?? profileDirOf(ctx)
  if (profileDir === undefined) {
    lastReport = { status: 'skipped', detail: '拿不到 profile 目录（没有 profileContext，也没有 --profile）' }
    return lastReport
  }
  // 设置界面落盘也靠 discoverPresets()：这里把权威 profile 锚点交给它，否则会写到别的 profile。
  setActiveProfileDir(profileDir)
  const patchPath = options.patchPath ?? path.join(profileDir, 'cordis.patch.yml')
  if (!fs.existsSync(patchPath)) {
    lastReport = { status: 'skipped', detail: `没有 profile 补丁: ${patchPath}` }
    return lastReport
  }

  let runtime
  try {
    runtime = options.runtime ?? resolveDshRuntime()
  } catch (error) {
    lastReport = { status: 'skipped', detail: `找不到 DSH 运行时: ${error instanceof Error ? error.message : String(error)}` }
    return lastReport
  }
  const shipped = listShippedPresets(runtime)
  if (shipped.length === 0) {
    lastReport = { status: 'skipped', detail: `运行时里没有随包 preset: ${runtime}` }
    return lastReport
  }

  const original = fs.readFileSync(patchPath, 'utf8')
  const entry = options.entry ?? ENTRY_URL
  const ratios = {
    entry,
    thresholdRatio: options.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO,
    retainRatio: options.retainRatio ?? DEFAULT_RETAIN_RATIO,
  }
  // 1) 随包 preset 逐份整份覆盖（保留用户手工追加的行与调过的阈值）。
  const synced = syncOverrides(original, shipped, ratios)
  // 2) 用户自建的 preset 只补缺失的行与阈值，不重建。
  const shippedNames = new Set(shipped.map(preset => preset.name))
  const declared = ensureDeclaredRows(synced.text, shippedNames, ratios)

  if (declared.text === original) {
    lastReport = { status: 'ok', detail: `已覆盖 ${shipped.length} 份随包 preset`, changed: false, presets: shipped.map(p => p.name), hot: false }
    return lastReport
  }
  if (options.dryRun === true) {
    lastReport = { status: 'repaired', detail: 'dry-run：有改动但未写盘', changed: true, presets: shipped.map(p => p.name), hot: false }
    return lastReport
  }

  writeAtomic(patchPath, original, declared.text)
  const hot = await reconcile(ctx)
  lastReport = {
    status: 'repaired',
    detail: `已补上 ${shipped.length} 份随包 preset 的覆盖块（备份 ${path.basename(patchPath)}.bak-compact-agents）`,
    changed: true,
    presets: shipped.map(preset => preset.name),
    hot,
  }
  warn(ctx, `已自动修复 preset 覆盖（${lastReport.presets.join(', ')}）；${hot ? '已热重组，新会话生效' : '下次启动生效'}`)
  return lastReport
}

/**
 * 上一次自愈的报告（`inspect-presets` / 测试用）。
 * @returns 报告对象；没跑过为 undefined。
 */
export function selfHealReport() {
  return lastReport
}

/**
 * 仅供测试：清掉"已排定"标记与报告。
 */
export function resetSelfHealForTest() {
  scheduled = false
  lastReport = undefined
}

/**
 * 从上下文取 profile 目录。
 *
 * `profileContext` 是 DSH 在 profile 启动时 `provide` 的服务（`{ name, dir, patchPath, ... }`）；
 * 宿主行拿它最稳 —— 它同时也是"当前跑的到底是哪个 profile"的唯一权威答案。
 * @param ctx - 宿主上下文。
 * @returns profile 目录；拿不到为 undefined。
 */
function profileDirOf(ctx) {
  try {
    const profile = ctx?.get?.('profileContext')
    if (typeof profile?.dir === 'string' && profile.dir !== '') return profile.dir
    const patchPath = profile?.patchPath
    if (typeof patchPath === 'string' && patchPath !== '') return path.dirname(patchPath)
  } catch {
    // 桩上下文、或该服务不存在：交由调用方处理。
  }
  return undefined
}

/**
 * 让 hmr 热重组 profile，使补进去的 preset 行立刻可用于**新开的会话**。
 *
 * 与插件市场安装插件走同一条通道（`dsh-hmr` 的 `reconcileProfile` 必须包在 `runExclusive`
 * 里，见 `packages/hmr/src/index.ts` 的 "HMR profile reconciliation must run inside runExclusive"）。
 * @param ctx - 宿主上下文。
 * @returns 是否已热重组（false = 只能下次启动生效）。
 */
async function reconcile(ctx) {
  try {
    const hmr = ctx?.get?.('hmr')
    if (typeof hmr?.runExclusive !== 'function' || typeof hmr?.reconcileProfile !== 'function') return false
    const outcome = await hmr.runExclusive(() => hmr.reconcileProfile())
    return outcome?.restartReason === undefined
  } catch (error) {
    warn(ctx, `preset 覆盖已写入，但热重组失败（下次启动生效）: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * 写盘：备份 → 临时文件 → rename（与 install.mjs 同一套，避免半写）。
 * @param file - 目标文件。
 * @param original - 写前全文（写备份用）。
 * @param next - 新全文。
 */
function writeAtomic(file, original, next) {
  fs.writeFileSync(`${file}.bak-compact-agents`, original)
  fs.writeFileSync(`${file}.tmp`, next)
  fs.renameSync(`${file}.tmp`, file)
}

/**
 * 记一条 warn —— 没有 logger 的桩上下文不算错。
 * @param ctx - 宿主上下文。
 * @param message - 内容。
 */
function warn(ctx, message) {
  try {
    ctx?.logger?.warn?.(`compact-agents: ${message}`)
  } catch {
    // 没有 logger：不报。
  }
}

/**
 * profile 目录的 home 段（给日志用的短标签）。
 * @param dir - profile 目录。
 * @returns 形如 `<dsh home>/profiles/desktop` 的短标签。
 */
export function shortenProfileDir(dir) {
  return String(dir).split(path.sep).join('/').replace(String(DSH_HOME).split(path.sep).join('/'), '~/.dsh')
}
