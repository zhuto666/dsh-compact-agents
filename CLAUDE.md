# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

`dsh-compact-agents` 是 **DeepSeek Harness(DSH) 的站外插件**：给模型一个 `compact_agents` 工具，无视自动压力阈值强制压缩**进程内所有活会话**(主会话 / 子代理 / AgentTeams 成员)，并在浏览器「设置 → 插件」里提供一张改参数的卡片。

**零 npm 依赖、无构建步骤**。本项目不装 `node_modules`，而是由 `install.mjs` 建 junction 指向 DSH 检出，让 Node 解析到与宿主**同一个模块实例**(见 `scripts/install.mjs:42` 的 `ensureJunction`)。因此：

- 不要 `npm install` 任何东西，不要在 `package.json` 里加 `dependencies`；
- 插件本体只 import `@deepseek-ai/dsh-tools`；`@deepseek-ai/schemastery` 是**动态** import(缺了只少一个设置页)；
- 浏览器 half 手写成单文件 bundle，只 require 平台种子模块(`react` 等)，不引打包器。

## 仓库地图

| 路径 | 职责 |
|---|---|
| `index.js` | preset 行入口。`compact_agents` 工具(scope `others`/`all`/`self`/`ids`；`whenBusy` `queue`/`skip`)、忙则排队补压、对话区压缩提示、被输出上限截断后的自动续写。`inject = ['tools','compaction','agents']` |
| `client-host.js` | 宿主组成那一行的入口(`exports["."]`)。只做两件事：让 `ClientModuleRegistry` 扫到本包、注册 settings 命名空间。刻意 `inject = []` |
| `settings.js` | 两个入口共用。settings 命名空间 `compact-agents`、preset 参数的行级文本读写、`liveConfig`、`resolveMaxAutoContinues`。`SETTINGS_FIELDS` 是字段文档与测试的**单一来源** |
| `lib/client.js` | 浏览器 half：设置页那张卡片。手写 bundle，向 `window.__ModuleLoader__` 注册工厂 |
| `cordis.patch.yml` | `dsh.bundle.patch` 指向的补丁：往宿主组成插入 `id: compact-agents-client-host` 一行 |
| `scripts/lib/presets.mjs` | 路径常量(`PROJECT_ROOT`/`DSH_HOME`/`PLUGIN_ENTRY`/`ROW_ID`/`GROUP_ID`)与检出、preset 发现。**只有这一处定义** |
| `scripts/*.mjs` | 独立测试/工具脚本，无框架(见「常用命令」) |
| `docs/design.md` | 维护者视角的设计与踩坑记录；`README.md` / `README.en.md` 是用户视角 |

`package.json` 的 `dsh.*` 是给宿主读的元数据(`compatibility` / `client.platform`+`client.inject` / `bundle.patch`)，`dshhub` 是插件市场清单。改它们等同于改宿主组成。

## 常用命令

```sh
npm test                              # 全套 8 个脚本(顺序见 package.json scripts.test)
node scripts/selftest.mjs             # 单跑：模块导入 + defineTool 规格 + 参数枚举
node scripts/deferred-test.mjs        # 单跑：忙 → 排队 → idle 补压(假 ctx，不起 DSH)
node scripts/settings-test.mjs        # 单跑：真 schemastery + 真 Context + preset 文本手术
node scripts/compose-test.mjs         # 单跑：真 FileSettingsProvider + 复刻 preset isolate 语义
node scripts/integration-test.mjs     # 单跑：真 cordis Context + 真 ToolRuntime(零模型调用、零成本)
node scripts/client-test.mjs          # 单跑：浏览器 half(假 __ModuleLoader__ + 桩 require)
node scripts/dryrun-test.mjs          # 单跑：--dry-run 守卫(沙箱 DSH_HOME)
node scripts/validate-presets.mjs     # 校验：挂载行位置 / 引用路径 / thresholdRatio / retainRatio
node scripts/inspect-presets.mjs      # 只读：设置页将显示的初值(一个文件都不写)
node --check index.js                 # 语法自检

node scripts/install.mjs --dry-run    # 安装预演(不改盘)
node scripts/install.mjs              # 安装/修复(幂等，失效路径自愈)
node scripts/uninstall.mjs --dry-run  # 卸载预演
```

没有测试框架：每个 `scripts/*.mjs` 都是独立可跑的脚本，断言失败即非零退出。`install.mjs` 额外支持 `--dsh <checkout>` / `$DSH_CHECKOUT`(检出位置)、`--preset <file>`(可重复)、`--profile <name>`(默认 `web`)、`--force`。

## 架构：两个挂载点，缺一不可

| 挂载点 | 入口文件 | 负责 | 为什么必须在这里 |
|---|---|---|---|
| **preset 行**(`<DSH_HOME>/.agent-presets/*/agent.cordis.yml` 的 `compaction` 组内，绝对路径指向 `index.js`) | `index.js` | `compact_agents` 工具、对话区压缩提示、被输出上限截断后的自动续写 | cordis 的隔离**按服务名**生效：只有 `compaction` realm 内才解析得到 `ctx.compaction` |
| **宿主组成里的 bundle 行**(profile 的 `dsh.profile.bundles` → 本包 `dsh.bundle.patch` → `cordis.patch.yml` 插入 `id: compact-agents-client-host`) | `client-host.js` | 让 `ClientModuleRegistry` 扫到本包(从而把 `lib/client.js` 下发给浏览器)、在宿主根注册 settings 命名空间 | 该注册表**只遍历宿主 Loader 的 entries**；`fiber.entry` 为空的手动挂载行被直接丢弃，且**毫无报错** |

共享件：`settings.js`(设置命名空间 + preset 参数文本读写，两个入口都调，靠模块级缓存保证进程级只注册一次)、`lib/client.js`(浏览器 half 卡片)、`scripts/lib/presets.mjs`(路径常量与 preset 发现，**只有这一处定义**)。

`client-host.js` 刻意 `inject = []`：宿主根上**没有** `compaction` 服务，声明它只会让这一行永远 pending。

## 设置面：两个 half，五种旋钮

命名空间恒为 `compact-agents`(`client-host.js` 注册，`lib/client.js` 按同名字符串挂卡片)。字段与生效机制分两类，**改字段要同时动 `settings.js` 的 `SETTINGS_FIELDS`/`PRESET_KEYS`/`PRESET_RANGES` 与浏览器 half**：

| 字段 | 归属 | 写在哪 | 生效 |
|---|---|---|---|
| `notice` | 本插件 | `liveConfig` | 立即(会话事件监听器实时读) |
| `maxAutoContinues` | 本插件 | `liveConfig` | 立即 |
| `thresholdRatio` | 宿主 compaction | preset 的 `compaction-basic` 行 | 新会话 |
| `retainRatio` | 宿主 compaction | preset 的 `compaction-basic` 行 | 新会话 |
| `bootstrapMaxTokens` | 宿主 compaction | preset 的 `tool-bootstrap` 行 | 新会话 |

优先级三层：**schema 默认 < preset 行配置 < 设置界面(用户层)**。`maxAutoContinues` 默认 2，`0`/`false` 关闭自动续写。

契约：宿主侧的 schema 由 `@deepseek-ai/schemastery` **动态** import 提供(缺了只少一个设置页，不影响工具)；卡片在命名空间未 `ready` 时只渲染一句提示，**任何时候都不许抛异常**(同一棵树里别的卡片会被带崩)。

## 改动生效时机(最容易踩的坑)

| 改了什么 | 生效方式 |
|---|---|
| 插件 `.js`(`index.js` / `settings.js` / `client-host.js`) | **必须重启 `dsh`** —— Node 的 ESM 模块缓存按 URL 命中，preset 重新挂载不会清它 |
| preset 里的参数(挂载行、`thresholdRatio` / `retainRatio` / `bootstrapMaxTokens`) | **新开一条对话**即可(standing mount 按文件戳 `mtimeMs`+`size` 换代) |
| 宿主组成(`cordis.patch.yml`、`package.json` 的 `dsh.*`) | **必须重启 `dsh`**，设置页卡片才会出现 |
| `scripts/*.mjs` | 每次直接执行，不受模块缓存影响，改完立即生效 |

> **想让现有成员会话也被压，就别重启 DSH**：重启会丢掉所有成员/子代理会话(`ctx.agents.list()` 只覆盖活着的会话)。要压就新开一条对话。

## 关键约束(改前必读)

- **preset 行必须写绝对路径**：裸包名在 preset 里是**从 harness 解析**的(`agent-presets` 的 `PresetTree.import`)，指向用户目录的包会解析失败。
- **bundle 行的行名必须是裸包名**，不能写 `dsh-compact-agents/client-host`：`ClientModuleRegistry.locatePkgJson()` 对含 `/` 的说明符直接判为非客户端行并静默跳过。裸包名解析 `exports["."]` → 所以根入口必须是 root-safe 的 `client-host.js`。
- **preset 的 YAML 与 profile 的 `package.json` 一律做行级文本手术**，绝不反序列化再序列化 —— 那会重写掉注释、`!!js` 表达式与排版。读写前留 `.bak` / `.bak-compact-agents`，写盘走临时文件 + `rename`。卸载后文件应逐字节回到原状。
- **settings 命名空间进程级只注册一次**：`SettingsProvider.register()` 对重复命名空间直接抛错，而本插件在多个 preset 行上反复 apply，必须复用 `settings.js` 的模块级缓存。同时注册要等服务就绪(`ctx.inject(['settings'], …)`)，bundle 行可能早于 settings 服务被 apply。
- **`liveConfig` 只存"用户层覆盖"，`null` 表示没覆盖**：解析结果与 `base` 比对，相等就退回各挂载自己的行配置。否则任一个 preset 写的 `notice: false` 会把所有 preset 的提示一起关掉(已发生过一次回归)。
- **`isConcurrencySafe` 必须是谓词**(`() => false`)，写布尔字面量会被 `defineTool` 静默丢掉。`timeoutMs` 给到 30 分钟：一次扫描等于多次串行摘要调用。
- **只有顶层 agent 能扫别人**：`scope !== 'self'` 时调用者必须在 `ctx.agents.roots()` 里，否则抛错(子代理只能压自己)。这是契约，别放宽。
- **浏览器 half 只能 require 平台种子模块**(`react` / `@deepseek-ai/dsh-client-store` / `@deepseek-ai/dsh-client-ui-primitives`)；设置读写通道走 `ctx.settingsScope` 服务，不是 `require` —— 所以 `package.json` 的 `dsh.client.inject` 声明提供方即可，无需 `dsh.client.external`。没有构建步骤 ⇒ **写不了 JSX**，用 `React.createElement`。卡片外壳是官方 `PluginCard` 的手写同构版(那两个源文件不可 import)。
- 订阅 `session/event` 追加 `user/message` 提示时，只能追加在**表面尾部**；不要挂到 `stability: 'whole-surface'` 那条路径上，否则会抛 `SurfaceChangedError`。

## 测试与夹具

**凡是要写盘的测试，夹具必须显式指向临时文件。** 用 `setPresetFilesForTest([...])`(`settings.js`)把 preset 读写改成临时夹具 —— `compose-test.mjs` 会走真实的 `update → watch → 写回` 链路，第一版漏了这一步，**真的把用户 preset 的 `thresholdRatio` 改写成了 0.42**。

所以 `compose-test.mjs` 开头拍下真实 preset 的**全文快照**、结尾逐字节比对(见该文件顶部 `realPresets`)。判据是"一个字都没动"，**不是**硬编码某个取值 —— `thresholdRatio` 是用户可调旋钮(本机四份 preset 都是 `0.5`)，拿 `0.2` 当期望值会把「用户调过参」误报成「测试污染了配置」，让这条防线恒失败。

`integration-test.mjs` 用四个最小桩服务(`systemPrompt` / `compaction` / `tokenMeter` / `agents`)代替整个 Harness，**零模型调用**，可随时跑；它覆盖假 ctx 测不到的东西(注册表接受、`executionMode` 实测、output schema、`render()` 产物、越权被拒、提示与自动续写的端到端行为)。断言全集见 `docs/design.md` §4。

## 文档

- `README.md`(中文，主) / `README.en.md`(英文) —— 用户视角：安装、用法、参数含义、已知限制。**改行为要同步两份**。
- `docs/design.md` —— 维护者视角：契约出处(按检出相对路径标注，如 `packages/compaction/compaction/src/index.ts:139`)、运行时语义、踩过的坑、测试矩阵。**改行为前先读对应小节，发现新的坑补一节进去**。
- commit 用中文 Conventional Commits 并在标题尾带版本号，如 `fix: bundle 行名必须是裸包名 —— 子路径行名会被静默丢弃 (v0.5.1)`；同步 bump `package.json` 的 `version`。

## 代码约定

- 本仓库**没有 `.java` 文件**，因此不写 `update-begin` / `update-end` 痕迹注释 —— 全局硬规则 4 只对 Java 生效，且明确禁止写进 `.js`/`.md`/`.yml`(见 `~/.dsh/AGENTS.md` 硬规则 4)。
- 注释与文档默认中文；`index.js` 里面向模型的 `description`、参数说明、工具输出保持英文。
- 注释写"为什么"，且尽量带上源码出处；本仓库现有代码的注释密度很高，改动时**跟齐这个密度**。
- **提交前跑 `npm test`**：`validate-presets.mjs` 会连真实 preset 一起校验(挂载行位置、绝对路径、`thresholdRatio`)，跳过它等于把用户配置的守卫关掉。
