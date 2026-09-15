# dsh-compact-agents

<div align="center">

**DeepSeek Harness 会话上下文强制压缩插件(模型可调用的 `compact_agents`)**

强制压缩忽略自动阈值 · 覆盖进程内**所有活会话**(主会话 / 普通子代理 / AgentTeams 成员一视同仁) · 没有子代理时主会话也能压自己 · 忙的目标自动排队、本轮结束立即补压 · 逐目标回报被遮蔽节点数与估算 token 数 · 只有顶层 agent 能扫描、子代理越权被拒 · 工具调用串行不并发 · 纯主机侧插件、零网络、零持久化、无客户端 bundle

[![version](https://img.shields.io/badge/version-0.1.0-4176E6)](https://github.com/zhuto666/dsh-compact-agents)

**v0.1.0**：首个版本。补上 DSH 缺失的"模型侧手动压缩"入口 —— `/compact` 只服务交互式 UI，headless 的子代理与团队成员没有命令面，队长也没有任何工具能替它们压缩。详见[设计说明](docs/design.md)。

[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org)

[English](README.en.md) | **中文**

</div>

---

## 功能总览

| 能力 | 入口 / 参数 | 说明 |
|---|---|---|
| 强制压缩(**忽略自动阈值**) | `compact_agents(scope)` | 走 `ctx.compaction.compactNow`，契约原文是*"Explicitly compact useful history **even below automatic pressure thresholds**"*；自动压缩要等阈值，本工具不等 |
| 覆盖**所有活会话** | `scope: "others"`(默认) / `"all"` | 覆盖范围是 `ctx.agents.list()`——主会话、普通子代理、AgentTeams 成员**一视同仁**，不是只挑团队成员 |
| 主会话压自己 | `scope: "self"` | **没有子代理时也有效**：调用者永远在 turn 中，必然走排队路径，本轮结束自动补压 |
| 指定目标 | `scope: "ids"` + `ids: [...]` | 只压列出的会话；找不到的 id 单独回报，不静默吞掉 |
| 忙则排队 | `whenBusy: "queue"`(默认) | 目标正在跑 turn 时不放弃：监听其 `agent/status → idle`，**这一轮一结束就补压**；`"skip"` 则直接报 `busy` 不动它 |
| 逐目标回报 | 返回值 `results[]` | 每个目标给出 `compacted` / `queued` / `noop` / `busy` / `error`，以及被遮蔽的节点数与估算 token 数 |
| 越权保护 | — | 只有**顶层 agent** 能扫描他人；子代理只能 `scope: "self"`，成员无法互压或压队长 |
| 串行调度 | — | 注册为 fail-closed 的 `exclusive`，一次扫描不会和另一个可能压同一会话的调用并行；超时 30 分钟(排队部分不计入，它在 turn 之后跑) |
| 自动压缩阈值(配套) | `compaction-basic` 配置 | 本插件**不改**自动策略；安装脚本顺带核对 `thresholdRatio`(DSH 默认 0.8×1M=800K 等于永不触发；建议 0.2~0.3，即 200K~300K 触发) |

## 为什么需要它

DSH 的手动压缩入口只有一个**人机命令** `/compact`(`@deepseek-ai/dsh-command-compact` 用 `ctx.commands.register` 注册，只服务交互式 UI 适配器)。于是：

- headless 的**子代理 / AgentTeams 成员**没有命令面，执行不了 `/compact`；
- **队长也没有任何工具**能替成员压缩——`packages/compaction/` 下没有任何 `registerTool`；
- 而自动压缩(`compaction-basic`)是**按阈值**触发的：阈值没到就不压。

结果就是"会话越跑越贵"过去只能靠**换人**(退役成员、新建成员)解决。本插件补上这个缺失的模型侧入口。

> 真实教训：一个成员会话曾以每次调用重发 **约 40 万 tokens** 的上下文跑到 348 次调用，累计 1.4 亿 cacheRead、¥10.87；而它只是"没人能替它压缩"。

## 安装

> 需求：Node.js ≥ 20 + DeepSeek Harness(带 `agent-presets` 的版本)。

### 一键安装(推荐)

```sh
git clone https://github.com/zhuto666/dsh-compact-agents.git
cd dsh-compact-agents
node scripts/install.mjs --dry-run     # 先预览要改什么(不改盘)
node scripts/install.mjs               # 确认后执行
```

脚本只做两件事，且**幂等**：

1. **建两个目录联接(junction)**，让插件能解析到 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/cordis`——本项目**刻意零依赖**(不装 node_modules)，Node 会把 junction 解析到真实路径，因此拿到的是和宿主**同一个模块实例**，没有双实例问题；
2. **往 preset 的 `compaction` 隔离组里追加一行挂载**：

```yaml
    - id: compact-agents
      name: '/absolute/path/to/dsh-compact-agents/index.js'   # 安装脚本会自动填成你的真实绝对路径
```

自动发现 `$DSH_HOME/.agent-presets/*/agent.cordis.yml` 与 `$DSH_HOME/profiles/*/node_modules/@linxin666/*/presets/*/agent.cordis.yml`；也可以用 `--preset <file>` 指定要处理的 preset。改文件前会留 `.bak` 备份，没有 `compaction` 组的 preset 直接跳过。

**DSH 检出位置同样是自动探测的，脚本和文档里不写死任何盘符**，依次尝试：

1. `--dsh <checkout>` / `$DSH_CHECKOUT` / `$DSH_HARNESS`；
2. 本项目 `node_modules` 里已有的联接目标(装过一次就连带记下了检出在哪儿)；
3. **PATH 上 `dsh` 启动器的真实入口**(包管理器生成的 shim 里写着 `dsh` 在哪儿)—— 全新克隆、什么线索都没有时，靠的就是这一条；
4. 各 profile 的 `node_modules`；
5. 家目录下的常见克隆位置。

全都落空才报错，并提示用 `--dsh` 指定。

**那行路径不是写死的，是安装时算出来的** —— `install.mjs` 用自己所在目录推导 `PLUGIN_ENTRY`，所以：

- 你在哪儿克隆/放这个项目，那行就指向哪儿；
- **项目被移动或改名后，重跑一次 `install.mjs` 就会自动改正**：发现已有行指向一个不存在的路径时直接 `repaired`；若旧路径仍然有效(例如另存了一份副本)，则只 `WARN` 不动手，加 `--force` 才重新指向。

```sh
node scripts/install.mjs --dry-run    # 预览(不改盘)
node scripts/install.mjs              # 执行；自动修复失效路径
node scripts/install.mjs --force      # 旧路径还有效时也强制重新指向
```

> **为什么不能像普通包那样只写包名？** 这不是偷懒，是 DSH 的既定语义：preset 行里的**裸包名是从 harness 安装位置解析的**(`agent-presets/src/mount.ts` 的 `PresetTree.import` 注释原文 *"a package name resolves from the harness base"*)，不是从用户目录；装在工作区/用户目录的包根本解析不到。所以第三方插件在这里只有两条路——写绝对路径，或把插件文件放进 preset 目录跟着走。本项目选前者：**单一真源**，不给每个 preset 留副本。

### 生效

**新开一条对话即可，不必重启 `dsh`。** preset 改动靠 standing mount 的**文件戳热重载**(戳 = `stat` 的 `mtimeMs` + `size`)：戳变了，下一条新会话重新挂载一代，就带上工具；已经 composed 的会话因 `agent-preset/locked` 拿不到，属预期。

> **想让现有的成员也被压，就别重启 DSH** —— 重启会丢掉所有成员/子代理会话(`ctx.agents.list()` 只覆盖活着的会话)，那就没东西可压了。新开一条对话不影响它们。

### 校验安装

```sh
node scripts/validate-presets.mjs
```

逐份报告挂载行位置、引用的文件是否存在、以及 `compaction-basic` 的 `thresholdRatio` / `retainRatio`。期望输出：

```
.agent-presets/liangshen/agent.cordis.yml
  rows           = compaction-basic,command-compact,compact-agents,tool-result-pruner
  thresholdRatio = 0.2  retainRatio = 0.05
  compact-agents -> /absolute/path/to/dsh-compact-agents/index.js (存在)
ALL OK (4 preset mounted)
```

### 更新 / 卸载

```sh
git -C dsh-compact-agents pull          # 更新:拉取后重新执行 install.mjs(幂等)
node scripts/uninstall.mjs --dry-run       # 卸载:先预览
node scripts/uninstall.mjs                 # 移除挂载行 + 删除自己建的 junction
```

卸载只删自己加的东西：preset 的注释、`!!js` 表达式、其它行一律不动(实测安装→卸载后文件**逐字节回到原状**)。插件目录与 `.bak` 备份不删，自行处理。

### 开发者本地调试

```sh
node scripts/integration-test.mjs    # 真机加载测试(真 cordis Context + 真 ToolRuntime)
node scripts/deferred-test.mjs       # 忙→排队→idle 补压 的行为测试(假 ctx)
node scripts/selftest.mjs            # 模块导入 + defineTool 规格自检
```

改完 `index.js` 后**必须重启 `dsh` 才能真正生效** —— 这一点很容易踩坑：

- Node 的 **ESM 模块缓存按 URL 命中**，preset 重新挂载**不会**清它(DSH 自己的 HMR 插件是靠显式清 `internal.loadCache` 才能热重载的，而它在 profile 里默认 `disabled`)；
- 所以"新开一条对话"只会重新挂载 **preset**，插件的模块本身仍是进程里已缓存的旧代码；
- `scripts/*.mjs` 是每次直接执行的脚本，**不受影响**，改完立即是新的。

> 只有**改了 `install.mjs` 或 preset** 时，新开对话就够了；**改了插件 `.js` 就必须重启 `dsh`**。

## 用法

模型侧调用(不是人机命令):

```
compact_agents(scope = "others" | "all" | "self" | "ids", ids?: string[], whenBusy = "queue" | "skip")
```

| scope | 含义 |
|---|---|
| `others`(默认) | 除调用者以外的**所有活会话** |
| `all` | **所有活会话**，含调用者自己 |
| `self` | 只压调用者自己 —— **没有子代理时也有效** |
| `ids` | 只压 `ids` 里列出的会话 |

典型说法：

- 「把其他会话都压一遍」→ `scope: "others"`
- 「我这条对话也一起压」→ `scope: "all"`(你自己会被排队，本轮结束补压)
- 「只压我自己」→ `scope: "self"`

> **模型没调用它？** 工具描述里已写明"用户要求压缩上下文时**立即调用**、不要反问"，但仍可能遇到模型选择先确认一下。最稳的说法是**把工具名说出来**：
>
> ```
> 调用 compact_agents，scope=all，把所有会话压一遍
> ```
>
> 工具本身与模型行为无关——只要它在工具清单里，点名调用必定执行。

返回每个目标一行，例如：

```
compact_agents: 3 compacted, 1 queued, 0 skipped, 0 failed (of 4 selected).
- sess_ab12: compacted, ~182340 tokens in 96 nodes — shadowed surface 12-107
- sess_cd34: compacted, ~45120 tokens in 31 nodes — shadowed surface 3-33
- sess_ef56: noop — nothing safely compactable (empty session, or one oversized retained unit)
- sess_gh78: queued — mid-turn; queued and will be compacted as soon as it goes idle
```

## 工作原理

对每个目标调用 `ctx.compaction.compactNow(agent, signal)`，然后把结果翻译成报告行。

**不绕过契约自身的约束**：

| 约束 | 原因 |
|---|---|
| 目标必须 **idle** 才能立即压 | `compactNow` 走 `agent.runMaintenance`，agent 正在跑 turn 时会同步抛 `ManualCompactionError('busy')` |
| **调用者自己永远 busy** | 它此刻正在执行这个工具调用 —— 所以走 `queue`，在**本轮结束时**补齐 |
| 只有**顶层 agent** 能扫描 | 防止成员互相压、或压队长；子代理只能用 `scope: "self"` |
| 一次一个摘要模型调用、**串行** | 每个目标都要真实调一次模型；排队的那部分在 turn 之后跑，不计入工具超时 |
| 只覆盖**活着的**会话 | 已结束/已归档的会话没有 live agent，`compactNow` 需要 Agent 句柄；压死会话也不省 token |
| 压缩**不会**修好"单个超大单元" | 契约明确：单个过大的保留单元或请求信封无法靠表面压缩修复，这种情况回报 `noop` |

细节(契约出处、事件语义、踩过的坑)见[设计说明](docs/design.md)。

## 状态与副作用

- **零持久化**：不写任何文件、不建账本、不改配置；压缩结果由 DSH 自身的会话日志记录。
- **零网络**：只有一次摘要模型调用(由 `compaction-basic` 经宿主 LLM 通道发出)，插件本身不出站。
- **不改变自动策略**：`compaction-basic` 的阈值与保留比例由 preset 决定，本插件不覆盖。
- **可在任何时候卸载**：移除挂载行即可，不留残留状态。

## 架构

```
dsh-compact-agents
├── index.js                     # 插件本体:注册 compact_agents 工具(唯一入口)
├── package.json                 # ESM 包声明(main → index.js)
├── scripts/
│   ├── lib/presets.mjs          # 三脚本共用:路径常量 + preset 发现(只有一处定义)
│   ├── install.mjs              # 一键安装/修复:junction + preset 行(幂等,带 .bak)
│   ├── uninstall.mjs            # 卸载:移除挂载行 + 删除自己建的 junction
│   ├── validate-presets.mjs     # 校验挂载行/阈值/路径
│   ├── integration-test.mjs     # 真机加载测试(真 Context + 真 ToolRuntime)
│   ├── deferred-test.mjs        # 排队补压行为测试(假 ctx)
│   └── selftest.mjs             # 模块与 defineTool 规格自检
├── docs/
│   └── design.md                # 设计说明:契约出处、约束、踩过的坑、测试矩阵
└── node_modules/@deepseek-ai/   # install.mjs 建的 junction(不进版本库)
    ├── dsh-tools -> <dsh checkout>/packages/core/tools
    └── cordis    -> <dsh checkout>/vendor/cordis
```

插件只 import 一个东西：`defineTool`(来自 `@deepseek-ai/dsh-tools`)。`cordis` 的 junction 只有 `integration-test.mjs` 需要。

**为什么 preset 行必须写绝对路径**：`agent-presets/src/specifier.ts` 的分类函数对绝对盘符路径走 `pathToFileURL`(注释写明"专为 Windows 盘符路径所必需")，变成 `file:` 行；而**裸包名在 preset 里是从 harness 解析的**，指向用户目录的包会解析失败。

## 开发与验证

```sh
node --check index.js                 # 语法自检
node scripts/selftest.mjs             # 模块导入 + defineTool 规格 + 参数枚举
node scripts/deferred-test.mjs        # 忙→排队→下次 idle 补压(假 ctx，不起 DSH)
node scripts/integration-test.mjs     # 真机:真 Context + 真 ToolRuntime，全链路
node scripts/validate-presets.mjs     # 4 份 preset 的挂载行与阈值
node scripts/install.mjs --dry-run    # 安装预演(不改盘)
```

`integration-test.mjs` 覆盖假 ctx 测不到的东西，且**零模型调用、零成本**(只给 `systemPrompt` / `compaction` / `agents` 三个最小桩服务)：`inject` 真的解析、`ctx.tools.register(defineTool(...))` 真的被注册表接受、`ctx.tools.get()` 查得到、`ctx.tools.executionMode()` 真的判成 `exclusive`、端到端 `execute()` 返回值真的过 output schema、`render()` 真的产出文本块、非顶层 sweep 真的被拒。断言清单见[设计说明](docs/design.md#4-验证矩阵)。

## 已知限制

- **只覆盖活着的会话**：已结束/已归档的会话拿不到 Agent 句柄；历史会话无法事后压缩(压了也不省 token)；
- **压缩不是免费的**：每个目标要真实调一次摘要模型，本身有 token 成本——目标是拿它换掉后续每次调用重发的巨额前缀；
- **单个超大保留单元无法修复**：契约明确表面压缩修不了这种情况，会回报 `noop`；
- **`scope: "self"` 是异步的**：工具立刻返回 `queued`，真正的压缩发生在本轮 turn 结束之后，结果写进 DSH 日志(`ctx.logger.info`)而不是工具返回值；
- **已 composed 的会话拿不到新工具**：preset 改动只对新会话生效，老会话需新开(或重启 DSH，但那会丢成员会话)；
- **不做孤儿数据/状态清理**：本插件无状态，无需清理。
- **只支持 DSH 开发检出布局**：安装脚本要求检出里同时有 `packages/core/tools` 与 `vendor/cordis`；`npm i -g` 全局安装的布局未验证(全局安装下这两个包的落点不同，需要另行适配)。

## 更新历史

- **v0.1.0** — 首个版本：`compact_agents` 工具(4 种 scope、忙则排队)、一键安装/卸载/校验脚本、四层验证(自检 / 行为测试 / 真机集成测试 / preset 校验)。
  - 安装脚本支持**失效路径自愈**(项目移动/改名后重跑即修正)与 `--force` 重新指向；
  - DSH 检出位置改为**自描述探测**(显式参数 → 既有联接 → PATH 上的 `dsh` 启动器 → profile → 家目录)，脚本与文档中不含任何本机盘符；
  - `uninstall.mjs` 只移除**指向本项目**的挂载行，避免克隆两份时误拆别人的安装。

## License

[Apache-2.0](LICENSE)
