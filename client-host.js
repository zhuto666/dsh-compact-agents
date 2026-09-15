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
 * 两处都调用 `registerSettings`，靠 `settings.js` 的模块级缓存保证**进程级只注册一次**
 * （真实的 `SettingsProvider.register` 对重复命名空间会直接抛错）。
 *
 * @module dsh-compact-agents/client-host
 */

import { registerSettings } from './settings.js'

export const name = 'dsh-compact-agents/client-host'

/** 不依赖任何服务：宿主根上没有 `compaction`，声明它只会让这一行永远 pending。 */
export const inject = []

/**
 * 注册设置面，让浏览器 half 有对应的命名空间可配对。
 * @param ctx - 宿主根上下文，携带 settings 服务与 logger。
 * @param config - 可选的同名行配置；`settings: false` 关闭设置面。
 * @returns 注册完成后 resolve；失败只记 warn，绝不让宿主启动被这一行拖垮。
 */
export function apply(ctx, config) {
  return registerSettings(ctx, config).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`compact-agents: client-host settings registration failed: ${message}`)
  })
}
