# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

`dsh-compact-agents` 是 **DeepSeek Harness(DSH) 的站外插件**：给模型一个 `compact_agents` 工具，无视自动压力阈值强制压缩**进程内所有活会话**(主会话 / 子代理 / AgentTeams 成员)，并在浏览器里提供一份改参数的表单 —— v0.8.1 起主入口是**设置侧栏里自成一页的「压缩与自动续写」分区**(`settings.section`，0.1.5/0.1.6 两代宿主都有)，另有两处兜底：DSH ≥ 0.1.6 的**侧栏「插件」页**(`ui-plugin-manager`)、DSH ≤ 0.1.5 的**「设置 → 插件 → 可配置」**。

**零 npm 依赖、无构建步骤**。本项目不装 `node_modules`，而是由 `install.mjs` 建 junction 指向 DSH 检出，让 Node 解析到与宿主**同一个模块实例**(见 `scripts/install.mjs:42` 的 `ensureJunction`)。因此：

- 不要 `npm install` 任何东西，不要在 `package.json` 里加 `dependencies`；
- 插件本体只 import `@deepseek-ai/dsh-tools`；`@deepseek-ai/schemastery` 是**动态** import(缺了只少那份配置表单)；
- 浏览器 half 手写成单文件 bundle，只 require 平台种子模块(`react` 等)，不引打包器。

## 仓库地图

| 路径 | 职责 |
|---|---|
| `index.js` | preset 行入口。`compact_agents` 工具(scope `others`/`all`/`self`/`ids`；`whenBusy` `queue`/`skip`)、忙则排队补压、对话区压缩提示、被输出上限截断后的自动续写。`inject = ['tools','compaction','agents']` |
| `client-host.js` | 宿主组成那一行的入口(`exports["."]`)。只做两件事：让 `ClientModuleRegistry` 扫到本包、注册 settings 命名空间。刻意 `inject = []` |
| `settings.js` | 两个入口共用。settings 命名空间 `compact-agents`、preset 参数的行级文本读写、`liveConfig`、`resolveMaxAutoContinues`。`SETTINGS_FIELDS` 是字段文档与测试的**单一来源** |
| `lib/client.js` | 浏览器 half：**三处注册、同一份表单正文** —— ① `settings.section`(**list** 槽位，v0.8.1 新增的**主入口**：用 `id: 'compact-agents'` + `order: 26` + `label` 认领设置侧栏里自成一页的位置，**没有 `key`**，组件 `CompactAgentsSection` 自带 `dsh-ca-section` 并**自己画标题与引言**，因为设置壳只渲染内容列)；② 新插件页 `plugins.bundle.config`(`key` = 包名 `dsh-compact-agents`，`view: 'page'` 时给 `div.dsh-ca-page` + 正文、`view: 'summary'` 时给一行摘要，**不套卡片外壳**，页自己画标题/图标/面包屑)；③ 老设置页 `settings.plugin.item`(`key` = settings 命名空间 `compact-agents`，可折叠卡片)。手写 bundle，向 `window.__ModuleLoader__` 注册工厂 |
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
node scripts/client-test.mjs          # 单跑：浏览器 half(三处槽位注册 + 分区渲染 + 表单渲染；假 __ModuleLoader__ + 桩/真 React)
node scripts/dryrun-test.mjs          # 单跑：--dry-run 守卫(沙箱 DSH_HOME)
node scripts/validate-presets.mjs     # 校验：挂载行位置 / 引用路径 / thresholdRatio / retainRatio
node scripts/inspect-presets.mjs      # 只读：界面表单将显示的初值(一个文件都不写)
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

共享件：`settings.js`(设置命名空间 + preset 参数文本读写，两个入口都调，靠模块级缓存保证进程级只注册一次)、`lib/client.js`(浏览器 half 表单，**三处注册**共用同一份正文与同一个控制器)、`scripts/lib/presets.mjs`(路径常量与 preset 发现，**只有这一处定义**)。

`client-host.js` 刻意 `inject = []`：宿主根上**没有** `compaction` 服务，声明它只会让这一行永远 pending。

## 设置面：两个 half，五种旋钮

命名空间恒为 `compact-agents`(`client-host.js` 注册)。**三处注册的键/形状各不相同，别混**：① `settings.section` 是 **list** 槽位，用 `id: 'compact-agents'` + `order: 26` + `label: '压缩与自动续写'`，**没有 `key`**(v0.8.1 主入口，见 `docs/design.md` §8.7)；② `plugins.bundle.config` 是 keyed 槽位，键 = 包名 `dsh-compact-agents`；③ `settings.plugin.item` 是 keyed 槽位，键 = settings 命名空间 `compact-agents`。字段与生效机制分两类，**改字段要同时动 `settings.js` 的 `SETTINGS_FIELDS`/`PRESET_KEYS`/`PRESET_RANGES` 与浏览器 half**；三处注册里的 `label`/`order` 也在这一处 —— `lib/client.js` 的 `registerSection()`(`label` 跟着分区标题走；`order` 只决定侧栏排位、与字段无关)：

| 字段 | 归属 | 写在哪 | 生效 |
|---|---|---|---|
| `notice` | 本插件 | `liveConfig` | 立即(会话事件监听器实时读) |
| `maxAutoContinues` | 本插件 | `liveConfig` | 立即 |
| `thresholdRatio` | 宿主 compaction | preset 的 `compaction-basic` 行 | **保存即热同步**进运行中的实例；文件供新会话 |
| `retainRatio` | 宿主 compaction | preset 的 `compaction-basic` 行 | 同上 |
| `bootstrapMaxTokens` | 宿主 tool-bootstrap | preset 的 `tool-bootstrap` 行 | 仅新会话(值在 `apply()` 里被捕获进闭包，改不动) |

优先级三层：**schema 默认 < preset 行配置 < 设置界面(用户层)**。`maxAutoContinues` 默认 2，`0`/`false` 关闭自动续写。

契约：宿主侧的 schema 由 `@deepseek-ai/schemastery` **动态** import 提供(缺了只少那份配置表单，不影响工具)；表单在命名空间未 `ready` 时只渲染一句提示，**任何时候都不许抛异常**(同一棵树里别的卡片会被带崩)。**三处注册都必须各自包 try/catch**：同一 key/`id` 重复注册会抛、宿主版本差异也可能抛，一处注册不上(只 `console.warn` 一行)不能连累另外两处 —— `lib/client.js` 的 `registerInto()` 与 `registerSection()` 就是这么做的，`client-test.mjs` 三个方向各锁一条。

**阈值与保留比例走"热同步"**：DSH 的既定语义是"已开始的会话不能换 preset"(`agent-preset/locked`)，而 `compaction-basic` 又把配置在构造时 `deepFreeze` —— 于是"改了 preset 要新开对话"。本插件的做法是把 `ctx.compaction.config` 整个换成一个新对象(它是实例上的普通自有属性，冻结的是被指向的对象、不是属性)，因为压力判定每次调用都现读 `this.config`，所以下一次步边界即生效。三条纪律，改动前必读：

- 只同步 `thresholdRatio` / `retainRatio`（都在 `ResolvedConfig` 里、都在调用时读），并守住 `retainRatio < thresholdRatio`；`bootstrapMaxTokens` 不在其中。
- `modelPolicies` 精确命中 provider+model 时**只改命中那条**（连带重建数组），没命中才改全局 —— 与引擎 `resolveTargetPolicy` 同款。
- 写完**读回校验**，读不到/写不进/形状不对一律原样返回并保留"旧代际"提示兜底；`livePresetParams: false` 可整体关闭。别把这条路径写成会抛异常的强依赖。
- **自我反证（v0.7.1）**：写进去 ≠ 引擎吃了。补丁落下时留一个待验证（并预先用 `ctx.get('llm').resolveModelInfo` 查好窗口 —— `llm` 不在 inject 里，`ctx.llm` 会抛），下一次**策略自己决定**的压缩若发生在 `[窗口×旧值, 窗口×新值)` 内，就判定引擎没吃，此后按旧值报。采信边界：`data.turn === null`、带 `sourceCommandId`、以及我们自己工具触发的压缩（60 秒会话标记）一律不采信；反证必须在**同步之前**（顺序反了会拿按旧阈值判出来的本次压缩当新阈值的证据）。

## 改动生效时机(最容易踩的坑)

| 改了什么 | 生效方式 |
|---|---|
| 插件 `.js`(`index.js` / `settings.js` / `client-host.js`) | **必须重启 `dsh`** —— Node 的 ESM 模块缓存按 URL 命中，preset 重新挂载不会清它 |
| preset 里的参数(挂载行、`thresholdRatio` / `retainRatio` / `bootstrapMaxTokens`) | **新开一条对话**即可(standing mount 按文件戳 `mtimeMs`+`size` 换代) |
| 宿主组成(`cordis.patch.yml`、`package.json` 的 `dsh.*`) | **必须重启 `dsh`**，重启后**设置侧栏里那个自成一页的「压缩与自动续写」分区**与**侧栏「插件」页**里的表单才会出现(旧版 DSH ≤ 0.1.5 才有「设置 → 插件 → 可配置」那张卡片；三处共用同一份 `lib/client.js`) |
| `scripts/*.mjs` | 每次直接执行，不受模块缓存影响，改完立即生效 |

> **想让现有成员会话也被压，就别重启 DSH**：重启会丢掉所有成员/子代理会话(`ctx.agents.list()` 只覆盖活着的会话)。要压就新开一条对话。

## 关键约束(改前必读)

- **preset 行必须写绝对路径**：裸包名在 preset 里是**从 harness 解析**的(`agent-presets` 的 `PresetTree.import`)，指向用户目录的包会解析失败。
- **bundle 行的行名必须是裸包名**，不能写 `dsh-compact-agents/client-host`：`ClientModuleRegistry.locatePkgJson()` 对含 `/` 的说明符直接判为非客户端行并静默跳过。裸包名解析 `exports["."]` → 所以根入口必须是 root-safe 的 `client-host.js`。
- **preset 的 YAML 与 profile 的 `package.json` 一律做行级文本手术**，绝不反序列化再序列化 —— 那会重写掉注释、`!!js` 表达式与排版。读写前留 `.bak` / `.bak-compact-agents`，写盘走临时文件 + `rename`。卸载后文件应逐字节回到原状。
- **settings 命名空间进程级只注册一次**：`SettingsProvider.register()` 对重复命名空间直接抛错，而本插件在多个 preset 行上反复 apply，必须复用 `settings.js` 的模块级缓存。同时注册要等服务就绪(`ctx.inject(['settings'], …)`)，bundle 行可能早于 settings 服务被 apply。
- **profile 里"只写 `dsh.profile.bundles`、不写 `dependencies`"会被新版插件页整条过滤掉，而且是静默的**：插件页只列 `installed || optional || error` 的 bundle，而 `installed` 的判据是 profile 的 `dependencies` 里有没有这个包名(`packages/boot/plugin-manager/src/index.ts` 的 `listBundles()`；`reconcile()` 只往 `dsh.profile.bundles` 写、从不写 `dependencies`)。`install.mjs` 现在两处都写、并优先走官方通道 `dsh plugin add <本项目目录> --profile <名>`；`validate-presets.mjs` 对这种"半装"状态直接 FAIL 并打印修法。
- **随包发行的 preset 会被它自己的插件升级整份重写**，丢掉我们的挂载行(实测 `@linxin666/dsh-liangshen`；工具随之失效而别处不报错)：修法是重跑 `node scripts/install.mjs`，`validate-presets.mjs` 对随包 preset 缺行会给 FAIL 并点明这一句。另外同名的手工 preset **永远不会被读到** —— `agent-presets` 的 roots 顺序是随包根最先、用户根最后("an earlier root wins a duplicate id: a shipped preset shadows any directory that claimed its name")，所以要改就改随包那份，或者给自建 preset 换一个 id。
- **`liveConfig` 只存"用户层覆盖"，`null` 表示没覆盖**：解析结果与 `base` 比对，相等就退回各挂载自己的行配置。否则任一个 preset 写的 `notice: false` 会把所有 preset 的提示一起关掉(已发生过一次回归)。
- **`isConcurrencySafe` 必须是谓词**(`() => false`)，写布尔字面量会被 `defineTool` 静默丢掉。`timeoutMs` 给到 30 分钟：一次扫描等于多次串行摘要调用。
- **只有顶层 agent 能扫别人**：`scope !== 'self'` 时调用者必须在 `ctx.agents.roots()` 里，否则抛错(子代理只能压自己)。这是契约，别放宽。
- **浏览器 half 只能 require 平台种子模块**(`react` / `@deepseek-ai/dsh-client-store` / `@deepseek-ai/dsh-client-ui-primitives`)；设置读写通道走 `ctx.settingsScope` 服务，不是 `require` —— 所以 `package.json` 的 `dsh.client.inject` 声明提供方即可，无需 `dsh.client.external`。**不要把 `@deepseek-ai/dsh-client-ui-plugin-manager` 加进 `dsh.client.inject`**：那份 slot 契约只做 `import type`、运行时从不 import 它(契约原话 "it never imports this package at runtime")，而 `dsh.client.inject` 是**包级**加载/预取边(官方注释：informational, never apply sequencing)，不是"这个包在不在"的可选探测 —— 跨版本共存靠 `ctx.slots.inject()` 等声明，不靠它。没有构建步骤 ⇒ **写不了 JSX**，用 `React.createElement`。老槽位那个折叠卡片外壳是官方 `PluginCard` 的手写同构版(那两份源文件在 0.1.6 随老槽位一起被删，只剩 0.1.5 的形态可参照)；新插件页那份**不套这个外壳**。
- 订阅 `session/event` 追加 `user/message` 提示时，只能追加在**表面尾部**；不要挂到 `stability: 'whole-surface'` 那条路径上，否则会抛 `SurfaceChangedError`。

## 测试与夹具

**凡是要写盘的测试，夹具必须显式指向临时文件。** 用 `setPresetFilesForTest([...])`(`settings.js`)把 preset 读写改成临时夹具 —— `compose-test.mjs` 会走真实的 `update → watch → 写回` 链路，第一版漏了这一步，**真的把用户 preset 的 `thresholdRatio` 改写成了 0.42**。

所以 `compose-test.mjs` 开头拍下真实 preset 的**全文快照**、结尾逐字节比对(见该文件顶部 `realPresets`)。判据是"一个字都没动"，**不是**硬编码某个取值 —— `thresholdRatio` 是用户可调旋钮(preset 里的值由用户自定)，拿 `0.2` 当期望值会把「用户调过参」误报成「测试污染了配置」，让这条防线恒失败。

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
