# dsh-compact-agents

<div align="center">

**DeepSeek Harness 会话上下文强制压缩插件：一个模型可调用的 `compact_agents` 工具 + 一块设置界面里的参数表单**

强制压缩忽略自动阈值 · 覆盖进程内**所有活会话**（主会话 / 普通子代理 / AgentTeams 成员） · 忙的目标自动排队、本轮结束立即补压 · 逐目标回报遮蔽节点数与估算 token 数 · **压缩过程在对话区可见** · **被输出上限截断时自动续写** · 参数在**设置**里自成一页直接改 · 零网络、零依赖、无构建步骤

[![version](https://img.shields.io/badge/version-0.8.4-4176E6)](https://github.com/zhuto666/dsh-compact-agents)

[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933)](https://nodejs.org)

[English](README.en.md) | **中文**

</div>

---

## 安装

> 需要 Node.js ≥ 20 + 带 `agent-presets` 的 DeepSeek Harness。

```sh
dsh plugin add E:\dsh-compact-agents --profile web    # 官方通道，推荐
```

本仓库另有等价的**幂等**脚本，官方通道失败（或加了 `--no-cli`）时用它：

```sh
node scripts/install.mjs --dry-run    # 先预览要改什么（不改盘）
node scripts/install.mjs              # 执行：profile 依赖 + bundle 登记 + junction + preset 挂载行
node scripts/validate-presets.mjs     # 校验：挂载行 / 引用路径 / 阈值 / README 版本徽章 / profile 依赖
node scripts/uninstall.mjs --dry-run  # 卸载前先预览
```

> preset 挂载行写的是**绝对路径**：preset 里的裸包名是从 harness 安装位置解析的，指向用户目录的包根本解析不到。项目移动或改名后，重跑一次 `install.mjs` 就会自动修正。

## 它解决什么问题

DSH 的手动压缩入口只有一个**人机命令** `/compact`：

- headless 的**子代理 / AgentTeams 成员**没有命令面，执行不了 `/compact`；
- 也**没有任何模型侧工具**能替别的会话压缩 —— `packages/compaction/` 下没有一个 `registerTool`；
- 而自动压缩（`compaction-basic`）**按阈值**触发：阈值没到就不压。

于是"会话越跑越贵"过去只能靠**换人**（退役成员、新建成员）解决。本插件补上这个缺失的模型侧入口。

> 实测：一个成员会话每次调用重发**约 40 万 tokens** 的上下文，跑到 348 次调用、累计 1.4 亿 cacheRead、¥10.87 —— 它只是"没人能替它压缩"。

## 装完请重启一次 `dsh`

宿主组成变了（profile 里多了一个 bundle），而客户端模块的 rev 只在 `dsh` **启动时**计算 —— 不重启，设置里的表单不会出现。

**首次安装有个次序问题**：想让**现有的**成员/子代理也被压，就别急着重启 —— 重启会丢掉所有活会话（`ctx.agents.list()` 只覆盖活着的会话），那就没东西可压了。先压完再重启，或者重启后重开成员。`compact_agents` 工具本身不依赖这次重启：preset 行装好，新开一条对话就能用。

之后只改 preset 里的参数不必重启（见下面的生效时机）。

## 怎么用

模型侧调用，不是人机命令：

```
compact_agents(scope = "others" | "all" | "self" | "ids", ids?: string[], whenBusy = "queue" | "skip")
```

| scope | 含义 |
|---|---|
| `others`（默认） | 除调用者以外的**所有活会话** |
| `all` | **所有活会话**，含调用者自己 |
| `self` | 只压调用者自己 —— **没有子代理时也有效** |
| `ids` | 只压 `ids` 里列出的会话 |

典型说法：「把其他会话都压一遍」→ `others`；「我这条对话也一起压」→ `all`（你自己会被排队，本轮结束补压）；「只压我自己」→ `self`。

> **模型没调用它？** 工具描述里已写明"用户要求压缩上下文时**立即调用**、不要反问"，但仍可能遇到模型先确认一下。最稳的说法是**把工具名说出来**：
>
> ```
> 调用 compact_agents，scope=all，把所有会话压一遍
> ```
>
> 只要工具在清单里，点名调用必定执行。

返回每个目标一行：

```
compact_agents: 3 compacted, 1 queued, 0 skipped, 0 failed (of 4 selected).
- sess_ab12: compacted, ~213,400 → ~49,800 tokens — shadowed surface 12-107
- sess_ef56: noop, ~0 tokens shadowed — nothing safely compactable (empty session, or one oversized retained unit)
- sess_gh78: queued — mid-turn; queued and will be compacted as soon as it goes idle
```

`beforeTokens` / `afterTokens` 是用 `ctx.tokenMeter` 实测的表面估算；测不到时为 `-1`。

行为边界：只有**顶层 agent** 能扫描他人（子代理只能用 `scope: "self"`）；每个目标必须 **idle** 才能立即压（忙的按 `whenBusy` 排队，`skip` 则直接报 `busy`）；一次扫描**串行**执行、超时 30 分钟（排队那部分在 turn 之后跑，不计入）。

### 压缩会在对话区留下可见提示

**任何**压缩（包括阈值触发的自动压缩）都会在对话区留下一行提示；`compaction/start` 是在摘要模型调用**之前**写的，所以它正好盖住原本什么都看不见的等待：

```
▸ 上下文注入 · dsh-compact-agents · 正在压缩上下文…（当前 213,400 tokens） · 触发线 ×0.35
▸ 上下文注入 · dsh-compact-agents · 上下文压缩完成：约 213,400 → 49,800 tokens，已遮蔽 37 个历史节点
```

末尾的 `触发线 ×0.35` 是**本会话实际生效的值**；只有热同步真的进不去时才会多一行说明两个值与出路：

```
⚠️ 预设文件里现在是 ×0.5，本会话这个实例仍按 ×0.2（热同步没成功）：新开一条对话才会用上新值。
```

用行配置 `notice: false` 关闭。提示本身是一条 `user/message`，模型下一轮也看得到 —— 这是有意的（让模型知道上下文刚被压过）。见[设计说明 §6](docs/design.md)。

### 被输出上限截断时会自动续写

一轮以 `turn/end{reason: 'max-tokens'}` 结束时，插件**替用户发一句"继续"**（`agent.followup`，和人在界面上发言同一条路），让对话自己走下去：

```
▸ 上下文注入 · dsh-compact-agents · 上一轮被输出上限截断，已自动续写（1/2）
继续                                    ← 插件以用户身份发出的（和用户手打的一样）
```

次数上限由 `maxAutoContinues` 控制（**默认 2**，`0`/`false` 关闭），用满后改为提示，避免无止境烧 token；**任一轮正常结束即清零**，所以额度是"连续"次数。为什么需要它：压缩后 preset 常把下一个请求的输出预算压得很小，若模型开着高推理，思考 token 与正文共享这份预算、很容易整份被吃光 → 正文 0 字被判截断（[设计说明 §7](docs/design.md)）。

### 在界面里改这些参数

**首选：设置里自成一页** —— 打开 **设置** → 侧栏 **「压缩与自动续写」**，它与「通用设置 / 模型 / 内置插件 / Agent 预设」**同级**（DSH 0.1.5 与 0.1.6 都在）。另外两处是**同一份表单、同一个控制器**：DSH ≥ 0.1.6 侧栏「插件」页里本包的详情页；DSH ≤ 0.1.5 的 **设置 → 插件 → 可配置** 折叠卡片。

![「设置 → 压缩与自动续写」页：左侧是真实界面截图，编号与右侧图例一一对应](docs/images/settings-section-annotated.png)

> 图里「设置」左栏能看到它与「内置插件」同级。图里的数值是实拍机器上 preset 的**现值**（两张比例带「已覆盖」标记），不等于出厂默认 —— 默认值见下面表格。DSH ≤ 0.1.5 的老卡片长什么样，见 `docs/images/settings-card-annotated.png`（仅存档）。

这个表单是**纯参数表单**：插件在界面上**没有自己的按钮**，压缩与自动续写都是**自动发生**的；框架自带的「重置」只是还原入口。DSH 里唯一的手动压缩入口是**自带**的人机命令 `/compact`（不是本插件）—— 本插件提供的是模型侧工具 `compact_agents`。

字段名与生效时机 —— 界面按生效时机分成三组，组标题就是下面这三行：

**立即生效 · 动作发生时读取，改完下一次压缩或续写即生效。**

| 字段 | 含义 | 取值 |
|---|---|---|
| `压缩提示播报` | 压缩完成后是否在对话区播报遮蔽节点数与估算 token 数，默认开启 | 下拉 `开启` / `关闭` |
| `自动续写次数上限` | 回复被输出上限截断时自动续写的次数上限，0 表示关闭，默认 2 | 下拉 `0` `1` `2` `3` `5` `10` |

**写入预设并热同步 · 写进预设配置，同时热同步给正在运行的会话，下一次步边界即生效。**

| 字段 | 含义 | 取值 |
|---|---|---|
| `压缩触发阈值比例` | 上下文占用达到窗口的这个比例时触发压缩；默认 0.35，即窗口 100 万 tokens 时约在 35 万处触发 | 0.05 – 0.95（DSH 出厂值是 `0.8`，1M 窗口 ≈ 800K，实际等于几乎不触发） |
| `压缩后保留比例` | 压缩后保留的上下文比例，越小压得越狠；默认 0.05，即窗口 100 万 tokens 时至少留 5 万 tokens 的原文（按整条消息对齐，实际会略多） | 0.01 – 0.5 |

**新建会话生效 · 写进预设配置，只在新会话读取，已在运行的会话不受影响。**

| 字段 | 含义 | 取值 |
|---|---|---|
| `受控阶段输出预算` | 压缩后那一小段"受控阶段"里，单次请求的输出 token 预算；它是**输出**预算，`max_tokens` 把思考（reasoning）token 也算在内，所以 1024 时可能光思考就吃满、正文一个字都出不来 | 整数，1024 – 200000 |

表单还会标出哪些字段是**你覆盖过的**，每个字段旁的「重置」回到预设里的值。

调参速查（机制与取舍见[设计说明 §9](docs/design.md)）：

| 你想要的 | 怎么调 |
|---|---|
| 更省钱、更快 | 阈值调小（早压）+ 保留比例调小 |
| 少打断、记得住刚说的 | 保留比例调大（`0.08~0.1`） |
| 受控阶段老被截断（反复自动续写） | 输出预算调大（`32768`） |
| 压缩太频繁、嫌它老在总结 | 阈值调大（`0.3~0.4`） |

> 行配置 `notice: false` / `maxAutoContinues: 0` / `livePresetParams: false` 分别关掉提示、自动续写与热同步；`settings: false` 整体关掉设置面（工具与提示不受影响）。

## 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| 设置里没有「压缩与自动续写」 | 装完没重启 `dsh`；客户端模块的 rev 只在启动时算 | 重启一次 `dsh` |
| 表单在，但侧栏「插件」页里整条看不到本包 | 包名只写进了 `dsh.profile.bundles`、没写进 profile `dependencies` —— 新版插件页只列 `installed \|\| optional \|\| error` 的 bundle，**毫无报错** | `node scripts/install.mjs`（两处都写），再重启；`validate-presets.mjs` 会把这种半装状态判成 FAIL |
| 界面上既没有命名空间也没有表单，且**毫无报错** | 只挂了 preset、没登记成 profile bundle —— 浏览器根本收不到 `lib/client.js` | 同上（[§8.4](docs/design.md)） |
| 老设置页（DSH ≤ 0.1.5）里卡片凭空消失，也不报错 | 老槽位 `settings.plugin.item` 在 ≥ 0.1.6 已无渲染方；`slots.inject` 对没人声明的槽位是**静默**的，注册上去既不抛错也不显示 | 用「设置 → 压缩与自动续写」或插件页详情页，别依赖老槽位（[§8.5](docs/design.md)） |
| 预设文件里明明是新阈值，会话仍按旧值压 | 热同步没进去（配置形状变了／写不进去）；提示里会同时报出两个值 | 新开一条对话才会用上新值（[§6](docs/design.md)） |
| 压缩提示里出现"新开一条对话才会用上新值" | 自我反证发现引擎仍按旧阈值判（证据是下一次**策略自己决定**的压缩） | 同上 |
| 升级 `@linxin666/*` 之后 `compact_agents` 工具没了 | 随包发行的 preset 被它自己的升级整份重写，我们的挂载行丢了 | 重跑 `node scripts/install.mjs`；`validate-presets.mjs` 会先告诉你是哪一份 |
| 自己改的 preset 不生效 | 同 id 的**发行** preset 会遮蔽用户 preset（`agent-presets` 的 roots 顺序是随包最先、用户最后） | 改随包那份（并在下次升级后重跑安装脚本），或给自建 preset 换个 id |
| 插件页里关掉本插件，`compact_agents` 却还能用 | 那个开关只动宿主组成里的 bundle 行，工具由 **preset 行**提供 | 要整体停用：`node scripts/uninstall.mjs` |

## 更新 / 卸载

```sh
git -C dsh-compact-agents pull
node scripts/install.mjs              # 更新后重跑，幂等
node scripts/uninstall.mjs --dry-run  # 卸载：先预览
node scripts/uninstall.mjs            # 移除挂载行 + bundle 与依赖登记 + 自己建的 junction
```

卸载只删自己加的东西：preset 里的注释、`!!js` 表达式、其它行一律不动（实测安装 → 卸载后文件**逐字节回到原状**），profile `package.json` 按行摘除、保留原排版。插件目录与 `.bak` / `.bak-compact-agents` 备份不删，自行处理。卸载同样改了宿主组成，**重启 `dsh` 后表单才消失**。

## 深入设计

正文只留结论；根因、契约出处、踩过的坑与验证矩阵都在 [docs/design.md](docs/design.md)：

| 想知道的 | 看 |
|---|---|
| 为什么 DSH 没有现成的模型侧压缩入口 | [§1](docs/design.md) |
| 覆盖范围、事件语义、忙碌与排队 | [§2](docs/design.md) |
| 挂载与路径解析、ESM 模块缓存等坑 | [§3](docs/design.md) |
| 验证矩阵：每个脚本断言什么 | [§4](docs/design.md) |
| 与自动压缩（`compaction-basic`）的关系 | [§5](docs/design.md) |
| 压缩提示与阈值热同步 | [§6](docs/design.md) |
| 输出上限截断与自动续写 | [§7](docs/design.md) |
| 设置面：宿主组成那一行（§8.4）、两处静默失败（§8.5）、已知限制（§8.6）、为什么自成一页（§8.7） | [§8](docs/design.md) |
| 压缩参数的机制与调参取舍 | [§9](docs/design.md) |

代码结构：`index.js`（preset 行入口：注册工具 + 会话监听）、`client-host.js` + `cordis.patch.yml`（宿主组成行入口：下发浏览器 half + 注册设置命名空间）、`settings.js`（设置命名空间与 preset 参数读写）、`lib/client.js`（浏览器 half，手写单文件、无构建步骤 —— **界面文案的唯一权威**）、`scripts/*`（安装 / 卸载 / 校验 / 测试）。

开发：

```sh
node scripts/validate-presets.mjs   # 挂载行 / 路径 / 阈值 / README 版本徽章 / profile 依赖
node scripts/inspect-presets.mjs    # 只读：表单将显示的初值
npm test                            # 自检 / 行为 / 真机集成 / 设置面 / 浏览器 half
```

改了插件的 `.js`（含 `client-host.js` / `settings.js`）或宿主组成相关文件（`cordis.patch.yml`、`package.json` 的 `dsh.*` 声明），**必须重启 `dsh`** —— ESM 模块缓存按 URL 命中，重新挂载 preset 不会清它（[§3.4](docs/design.md)）；只改 preset 则新开一条对话即可。凡会写盘的测试必须显式指向临时夹具，不能依赖"我以为它不会写"（[§8.4](docs/design.md)）。

## 已知限制

- **只覆盖活着的会话**：已结束/已归档的会话拿不到 Agent 句柄，事后压缩也不省 token。
- **压缩不是免费的**：每个目标要真实调一次摘要模型，本身有 token 成本。
- **单个超大保留单元无法修复**：契约明确表面压缩修不了这种情况，回报 `noop`。
- **`scope: "self"` 是异步的**：工具立刻返回 `queued`，真正的压缩发生在本轮 turn 结束之后，结果写进 DSH 日志而不是工具返回值。
- **已 composed 的会话拿不到新工具**：preset 改动只对新会话生效；老会话需新开（重启会丢成员会话）。
- **不做孤儿数据/状态清理**：本插件无状态（零持久化、零网络、不改变自动压缩策略）。
- **只支持 DSH 开发检出布局**：安装脚本要求检出里同时有 `packages/core/tools` 与 `vendor/cordis`；全局 `npm i -g` 的布局未验证。
- **插件页的启用/停用开关只管浏览器 half**：关掉它，动的是宿主组成里那一行（`compact-agents-client-host`），表单不再出现；而 `compact_agents` 工具由 **preset 行**提供，与这个开关无关，照常可用。
- **随包发行的 preset 会被它自己的插件升级冲掉**：`<profile>/node_modules/@linxin666/*/presets/*/agent.cordis.yml` 里那一行是安装时插进去的，插件升级会整份重写掉它；重跑 `node scripts/install.mjs` 即可。同一处还有一层遮蔽：同 id 的发行 preset 会盖掉用户自建的 preset。

## 更新历史

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)，日期为该版本的提交日；本仓库不使用 tag，除最新一条外，版本号标题都链接到对应的提交。条目只记**对使用者可见**的变化，按 `新增` / `变更` / `修复` / `文档` 分类。

### 0.8.4 — 2026-09-20

**文档**（无代码改动）

- 「更新历史」重写为「版本 + 日期 + 变更类型」的结构化列表，补齐 0.5.x 系列与逐版本提交链接，删除叙述性文字，只保留对使用者可见的变化。

### [0.8.3](https://github.com/zhuto666/dsh-compact-agents/commit/a4ce296) — 2026-09-20

**文档**（无代码改动）

- 重写 `README.md` 与 `README.en.md`（583 / 617 行 → 各 255 行），章节按「安装 → 使用 → 排错 → 设计说明」重组，删除与 `docs/design.md` 重复的机制叙述。
- 主截图更换为 DSH `0.1.6-alpha.2` 实拍的「设置 → 压缩与自动续写」页：`docs/images/settings-section-annotated.png`（①–⑥ 标注 + 右侧图例）与未标注原图 `docs/images/settings-section.png`；DSH ≤ 0.1.5 的插件页卡片图转为存档，不再作为主图引用。
- `docs/images/README.md` 同步：收录表、标注约定与截图来源/做法。
- `package.json` 的 `dshhub.summary` 改为「表单自成一页：设置 → 「压缩与自动续写」」，与 v0.8.1 之后的实际入口一致。

### [0.8.2](https://github.com/zhuto666/dsh-compact-agents/commit/7935293) — 2026-09-18

**修复**（文档，无代码改动）

- 参数分组更正为界面上的三组：`压缩触发阈值比例`、`压缩后保留比例` 由「新建会话生效」改为「写入预设并热同步」（v0.7.0 起保存即热同步进运行中的会话）。
- 文档字段名与界面标签逐字对齐：`压缩进度提示` → `压缩提示播报`，`自动续写次数` → `自动续写次数上限`。

### [0.8.1](https://github.com/zhuto666/dsh-compact-agents/commit/5f91f64) — 2026-09-18

**新增**

- 注册官方 `settings.section` 槽位：设置侧栏新增「压缩与自动续写」一页，与「通用设置 / 模型 / 内置插件 / Agent 预设」同级（DSH 0.1.5 与 0.1.6 均可用）。

**变更**

- 参数表单由三处注册（设置分区、插件页详情、≤0.1.5 折叠卡片）共用同一份正文与同一个控制器，各自独立容错：单处注册失败不影响其余入口。

### [0.8.0](https://github.com/zhuto666/dsh-compact-agents/commit/53e7837) — 2026-09-18

**修复**

- 参数卡片在 DSH 0.1.6 上不显示：老槽位 `settings.plugin.item` 的渲染方已被上游移除，且槽位未声明时 `ctx.slots.inject` 静默不执行。新增注册 `plugins.bundle.config`（键为包名）。
- 本包在插件页被整条过滤：该页只列 profile `dependencies` 中的包，仅登记 `dsh.profile.bundles` 不够。安装脚本改为同时写入两者。

### [0.7.4](https://github.com/zhuto666/dsh-compact-agents/commit/2a72433) — 2026-09-16

**修复**

- README 版本徽章与 `package.json` 对齐（原停留在 `0.4.0`，而市场收录抓取的正是 README）。
- 「徽章版本 == `package.json` 版本」纳入 `npm test` 校验。

### [0.7.3](https://github.com/zhuto666/dsh-compact-agents/commit/daa5498) — 2026-09-15

**修复**

- 写入预设参数时同步刷新行尾带数字的注释，避免值与注释（如 `0.02` 与「5%」）自相矛盾；不含数字的注释属于用户自己的话，一律保留。

### [0.7.2](https://github.com/zhuto666/dsh-compact-agents/commit/f07ac81) — 2026-09-15

**变更**

- 界面文案统一为 DSH 官方中文术语「预设」「提示词」（`token` 保留原样）。

### [0.7.1](https://github.com/zhuto666/dsh-compact-agents/commit/dd45ab4) — 2026-09-15

**修复**

- 热同步增加效果校验：以策略自己决定的下一次压缩反证引擎是否采用新阈值，校验不通过时不再报告为已生效。

### [0.7.0](https://github.com/zhuto666/dsh-compact-agents/commit/0f9167c) — 2026-09-15

**新增**

- 阈值与保留比例保存后热同步进运行中的 `compaction-basic` 实例，下一次步边界生效，无需新开会话或重启 `dsh`。
- `bootstrapMaxTokens` 不受影响：该项由另一个插件读取，仍只对新会话生效。

### [0.6.1](https://github.com/zhuto666/dsh-compact-agents/commit/2e0f0fe) — 2026-09-15

**新增**

- 压缩提示报出**本会话实际生效的触发线**；热同步失败时同时给出预设值与实例值，以及恢复方式。

### [0.6.0](https://github.com/zhuto666/dsh-compact-agents/commit/e70f51e) — 2026-09-15

**变更**

- 压缩触发阈值默认值 `0.2` → `0.35`，避免尚未使用的窗口空间被提前压缩。

**修复**

- 测试守卫由局部比对改为全文快照比对，消除长期存在的误报。

### [0.5.6](https://github.com/zhuto666/dsh-compact-agents/commit/2523d8a) — 2026-09-15

**文档**

- `CLAUDE.md` 补充仓库地图、设置面五个参数的归属与生效机制；移除一条与全局硬约束冲突的约定。

### [0.5.5](https://github.com/zhuto666/dsh-compact-agents/commit/dc52b6c) — 2026-09-15

**文档**

- 加入带标注的设置界面截图。

### [0.5.4](https://github.com/zhuto666/dsh-compact-agents/commit/1bb19ff) — 2026-09-15

**文档**

- 加入压缩链路示意图，并预留界面截图位。

### [0.5.3](https://github.com/zhuto666/dsh-compact-agents/commit/a97f3eb) — 2026-09-15

**文档**

- 逐个说明五个参数各自管什么。

### [0.5.2](https://github.com/zhuto666/dsh-compact-agents/commit/9666200) — 2026-09-15

**变更**

- 设置卡片改用官方插件卡的紧凑样式。

### [0.5.1](https://github.com/zhuto666/dsh-compact-agents/commit/83a823a) — 2026-09-15

**修复**

- 宿主组成里的行名必须为裸包名：带子路径的行名会被静默丢弃。

### [0.5.0](https://github.com/zhuto666/dsh-compact-agents/commit/bd1ceb6) — 2026-09-15

**修复**

- 设置卡片不显示：浏览器 half 必须在宿主组成中注册一行。

### [0.4.0](https://github.com/zhuto666/dsh-compact-agents/commit/61177ac) — 2026-09-15

**新增**

- 五项参数搬进「设置」界面：新增 settings 命名空间与手写单文件的浏览器 half（零依赖）；前三项写入预设文件，后两项立即生效。

**修复**

- 阈值带行内注释时读取失败，且写回会抹掉注释。

### [0.3.0](https://github.com/zhuto666/dsh-compact-agents/commit/5b457af) — 2026-09-15

**新增**

- 一轮以 `turn/end{reason: 'max-tokens'}` 结束时，以用户身份自动续写；次数上限由 `maxAutoContinues` 控制。

### [0.2.0](https://github.com/zhuto666/dsh-compact-agents/commit/2ef2d3d) — 2026-09-15

**新增**

- 对话区可见的压缩提示：播报遮蔽节点数与估算 token 数（`notice: false` 关闭）。
- 工具回执补上压缩前后的 token 数。

### [0.1.0](https://github.com/zhuto666/dsh-compact-agents/commit/d837b68) — 2026-09-15

**新增**

- 首个版本：`compact_agents` 工具（4 种 scope、忙则排队）、一键安装/卸载/校验脚本、四层验证。

## License

[Apache-2.0](LICENSE)
