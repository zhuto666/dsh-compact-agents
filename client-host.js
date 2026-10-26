/**
 * 宿主组成里的那一行 —— 本包之所以需要一个"根入口"，是 DSH 客户端模块系统的硬约束。
 *
 * ## 为什么不能只挂在 preset 里
 *
 * 浏览器 half 不是想加载就能加载的：`ClientModuleRegistry`（`packages/client/modules`）
 * 只**遍历宿主 Loader 的 entries** 来决定给浏览器下发哪些客户端 bundle ——
 * `ctx.on('internal/plugin', fiber => { const entryName = fiber.entry?.options.name; if (entryName === undefined) return; … })`
 * 那行 `return` 就是关键：`fiber.entry` 为空的是"子插件或手动挂载"，直接被丢弃。
 * preset 里的行（`agent-presets` 用 `internal.import` 手动挂载）**不是 loader 行**，
 * 所以哪怕它声明了 `dsh.client`，浏览器也永远拿不到 —— 表现就是设置页里既没有命名空间也没有卡片。
 *
 * 于是本包需要在宿主组成里有一行（`dsh.bundle.patch` 注入，见 `cordis.patch.yml`）。
 * 这一行**只做两件事**：
 *   1. 让 `client-modules` 扫描到本包，从而把 `lib/client.js` 下发给浏览器；
 *   2. 在宿主根上注册 settings 命名空间 —— 位置比 preset 行更稳（没有 agent 在跑时也注册得上）。
 *
 * 工具 `compact_agents`、压缩提示、自动续写仍然只由 **preset 行**负责：那一行必须待在
 * preset 的 `compaction` realm 内（隔离是按服务名生效的，realm 外解析不到 `ctx.compaction`），
 * 而宿主根上根本没有 `compaction` 服务 —— 所以这里刻意 `inject = []`，不依赖任何服务，
 * 也就不会在根上挂起一个永远 pending 的行。
 *
 * `exports["."]` 指向本文件（完整插件在 `exports["./plugin"]`）。原因有两个：宿主组成里的
 * bundle 行只能写**裸包名** —— 子路径行名会被 `locatePkgJson` 在解析前直接判掉（见
 * `cordis.patch.yml` 里的说明），而裸包名解析的就是 `exports["."]`；preset 行则用绝对文件
 * 路径挂 `index.js`，不走 `exports`。所以本文件必须是 root-safe 的那一个。
 * 两处都调用 `registerSettings`，靠 `settings.js` 的模块级缓存保证**进程级只注册一次**
 * （真实的 `SettingsProvider.register` 对重复命名空间会直接抛错）。
 *
 * @module dsh-compact-agents/client-host
 */

import z from '@deepseek-ai/schemastery'
import { profileDirFromArgv, setActiveProfileDir } from './scripts/lib/presets.mjs'
import { scheduleSelfHeal } from './lib/self-heal.js'
import { registerSettings, seedConfigDefaults } from './settings.js'

export const name = 'dsh-compact-agents/client-host'

/** 不依赖任何服务：宿主根上没有 `compaction`，声明它只会让这一行永远 pending。 */
export const inject = []

//update-begin---author:admin ---date:2026-10-26  for：【bug】本模块 import 时就要算 seed（Config 的默认值），那会儿还没有 ctx；先用命令行猜出 profile，免得默认值读的是另一个 profile 的补丁-----------
setActiveProfileDir(profileDirFromArgv())
//update-end---author:admin ---date:2026-10-26  for：【bug】-----------

/** 表单字段的默认值（= preset 文件本次读到的现值）；与 `apply()` 里的锚点必须同源。 */
const seed = seedConfigDefaults()

/**
 * 设置表单的字段声明 —— 0.1.7 起**它本身就是**设置界面的来源，不再是"给宿主的一个提议"。
 *
 * 上游 601d6761e4 删掉了 `SettingsProvider.register()`，设置模型改成"宿主读每个 profile entry
 * 自己导出的 `Config`"：`packages/settings/settings/src/index.ts` 的 `describe()` 里
 * `schema = entry.fiber.runtime.Config`（私有方法 `schema(entry)`）、`ns = entry.options.id`，
 * 再用 `volatileForm()` 只保留带 `.volatile()` 的字段；写入走 `configEditor.edit()`，落在
 * profile 补丁的 `config:` 段。所以：
 *
 * - 字段顺序、默认值、取值范围都在这里 —— 浏览器半边只渲染，不再各写一份；
 * - 默认值取 {@link seedConfigDefaults}（preset 文件现值），于是界面一打开显示的就是
 *   "真正生效的值"，而不是插件凭空给的默认值；
 * - 每个字段**都要** `.volatile()`：`volatileForm()` 只认这个标记，漏掉就不出现在表单里；
 * - 字段改了会 dispose + 重挂这一行（`vendor/cordis/src/fiber.ts` 的 `update()`），
 *   于是 `apply()` 重跑、新值被同步到 preset 文件 —— 见 `settings.js` 的 `registerSettings`。
 */
export const Config = z.object({
  notice: z.boolean().default(seed.notice).volatile(),
  maxAutoContinues: z.number().step(1).min(0).max(10).default(seed.maxAutoContinues).volatile(),
  preemptiveRatio: z.number().min(0).max(1).default(seed.preemptiveRatio).volatile(),
  thresholdRatio: z.number().min(0.05).max(0.95).default(seed.thresholdRatio).volatile(),
  retainRatio: z.number().min(0.01).max(0.5).default(seed.retainRatio).volatile(),
  bootstrapMaxTokens: z.number().step(1).min(1024).max(200000).default(seed.bootstrapMaxTokens).volatile(),
})

/**
 * 注册设置面，让浏览器 half 有对应的命名空间可配对；随后排一次**自愈**。
 *
 * 自愈做的是"把本插件挂进每份随包 preset 的 compaction 组"—— `compact_agents` 工具、
 * 压缩播报、自动续写、回合结束预压全靠那一行，而 preset 声明只能改 profile 的
 * `cordis.patch.yml`。以前要用户手跑 `node scripts/install.mjs`；现在每次启动（含
 * 从社区更新版本后的重启/热载）自己检查一遍并补上，见 `lib/self-heal.js`。
 *
 * @param ctx - 宿主根上下文，携带 settings 服务、logger、profileContext 与 hmr。
 * @param config - 可选的同名行配置；`settings: false` 关闭设置面，`selfHeal: false` 关闭自愈。
 * @returns 注册完成后 resolve；失败只记 warn，绝不让宿主启动被这一行拖垮。
 */
export function apply(ctx, config) {
  //update-begin---author:admin ---date:2026-10-26  for：【bug】宿主行是唯一知道"当前跑的是哪个 profile"的地方：设置落盘与自愈都以它为准（旧逻辑会写到别的 profile）-----------
  try {
    const profile = ctx?.get?.('profileContext')
    if (typeof profile?.dir === 'string' && profile.dir !== '') setActiveProfileDir(profile.dir)
  } catch {
    // 桩上下文没有 get()：保持导入期猜出来的那个。
  }
  //update-end---author:admin ---date:2026-10-26  for：【bug】-----------
  return registerSettings(ctx, config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`compact-agents: client-host settings registration failed: ${message}`)
  }).finally(() => {
    scheduleSelfHeal(ctx, { enabled: config?.selfHeal !== false })
  })
}
