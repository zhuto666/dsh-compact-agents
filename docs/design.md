# 设计说明

本文件记录 `dsh-compact-agents` 的**契约出处**、**运行时语义**与**踩过的坑**，供维护者与审查者核对。所有结论都按**检出根目录的相对路径**标注(形如 `packages/compaction/...`)，可直接复查。

## 1. 为什么 DSH 没有现成的模型侧压缩入口

| 事实 | 位置 |
|---|---|
| 手动压缩的契约入口 `compactNow(agent, signal, sourceCommandId?)`，语义为"显式压缩，**即使低于自动压力阈值**" | `packages/compaction/compaction/src/index.ts:139` |
| 自动路径是 `compactIfNeeded(agent, trigger, signal)`，`trigger` 为 `'pressure' \| 'context-overflow'`——**尊重阈值**，不适用 | 同文件 `CompactionTrigger` |
| 唯一的 `compactNow` 调用者是 `/compact` 命令插件 | `packages/compaction/command-compact/src/index.ts:67` |
| 该命令经 `ctx.commands.register` 注册；命令解析只在交互式 UI 适配器里被调用 | `packages/compaction/command-compact/src/index.ts:101`、`packages/interaction/commands/src/index.ts:125/367` |
| `packages/compaction/` 下**没有任何** `registerTool` | 全目录检索 |

**结论**：headless 的子代理 / AgentTeams 成员没有命令面，队长也没有任何工具能替它们压缩。本插件补的就是这个缺口——把 `compactNow` 暴露成一个模型可调用的工具。

## 2. 运行时语义

### 2.1 覆盖范围

`ctx.agents.list()` 的定义是 *"All live agents, in registration order"*(`packages/core/agent/src/index.ts:587`)，返回**进程内所有活着的 agent**，与是否属于某个团队无关。`roots()`(`:597`)只返回 `owner === undefined` 的顶层 agent，用于越权判定；`get(id)`(`:567`)用于按 id 定位。

### 2.2 事件与作用域

- `agent/status` 的载荷是 `{ agent, status }`(`packages/core/agent/src/runtime-types.ts:277`)，由 agent loop 在每次状态迁移时发出(`packages/core/agent-loop/src/agent.ts:124`)。
- 它是**作用域事件**：路由主体是载荷里的 `agent`(`packages/core/scope/src/scoped-events.generated.ts:22`)。作用域标签的可见性规则是*"监听者带祖先标签即可收到后代派发的事件"*(`packages/core/scope/src/index.ts` 的 `scopeTarget` 注释)。
- 每个 agent 自建一个以自身对象为 key 的作用域(`packages/core/agent-loop/src/agent.ts:104`)；而 preset 的 standing mount 用一个**每个 preset 一份**的 key `{ agentPreset: <id> }` 建作用域(`packages/preset/agent-presets/src/index.ts:793`)，agent 的作用域挂在其下。
- **因此**：在 preset 组合里注册的监听器，能收到**该 preset 下所有 agent** 的状态事件——这正是排队机制能跨会话工作的原因。

### 2.3 生成代际与生效条件

- `ensureStanding` 每次比对 `compositionStamp` = `stat` 的 `mtimeMs` + `size`(`packages/preset/agent-presets/src/index.ts:829-843`)；戳变了就丢弃指针、为该 preset **重新挂载一代**，服务"本条及后续会话"。
- 子代理经 `composeFrom` → `standingMountFor(parentCtx)` 继承父代的 standing mount，**不再复查戳**。
- 已开始的会话会被 `select` / `swap` 以 `agent-preset/locked` 拒绝。

**操作结论**：改 preset 后**新开一条对话**即可生效，不必重启 DSH；但**重启会丢成员会话**，所以要压缩现有成员时应新开对话而不是重启。

### 2.4 忙碌与排队

`compactNow` 需要 `agent.runMaintenance`，该入口**仅限空闲**，agent 正在跑 turn 时同步抛 `ManualCompactionError('busy')`(`packages/compaction/compaction/src/index.ts:35-52`)。因此：

- 目标空闲 → 立即压缩，返回 `compacted`；
- 目标忙碌且 `whenBusy: "queue"`(默认) → 注册一次性的 `agent/status` 监听，等该 agent 转 `idle` 时补压，回报 `queued`；
- 调用者自己永远是忙碌的(它正在执行这次工具调用)，所以 `scope: "self"` **必然**走排队路径——这就是"没有子代理时主会话也能压自己"的实现方式。

监听器注册在插件自己的上下文上，随插件销毁；fire 后立即自注销，并用 `Set` 去重，避免同一 agent 被重复排队。

## 3. 踩过的坑

### 3.1 `isConcurrencySafe` 必须是**谓词**，不是布尔

`ToolDefinition` 里它的类型是 `isConcurrencySafe?(args: unknown): boolean`(`packages/core/tools/src/index.ts:261`)。`defineTool` 只在选项**为真值**时才保留该字段(`packages/core/tools/src/schema.ts`：`if (userIsConcurrencySafe)`)，所以写 `isConcurrencySafe: false` 会被**静默丢掉**，注册表里读到的是 `undefined`。正确写法：

```js
isConcurrencySafe: () => false,
```

好在漏掉时的默认值也是 `exclusive`(`packages/core/tools/src/index.ts:1268`：`if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }`)，所以危害是"意图没被记录、默认值一变就悄悄失效"，但它是真 bug——由 `integration-test.mjs` 抓出并加了断言(既断言谓词返回值，也断言 `ctx.tools.executionMode()` 的实测结果)。

### 3.2 preset 行的模块解析

- 绝对盘符路径 → `pathToFileURL` → `file:` 行(`packages/preset/agent-presets/src/specifier.ts:47`，注释写明"专为 Windows 盘符路径所必需")；
- **裸包名在 preset 里是从 harness 解析的**，不是从调用方目录；指向用户目录的包会解析失败；
- 本项目刻意零依赖，靠 junction 让插件自己能解析 `@deepseek-ai/dsh-tools`；Node 把 junction 解析到真实路径，因此与宿主是**同一个模块实例**。

### 3.3 挂载行必须留在 `compaction` 隔离组内

该组的 `isolate: { compaction: true, ... }` 让组内解析到本组提供的 `compaction` 服务(由 `compaction-basic` 提供)。挂到组外会解析不到 `ctx.compaction`。

### 3.4 改插件代码必须重启 DSH(ESM 模块缓存)

Node 的 ESM 模块缓存 `internal.loadCache` 按 **URL** 命中，而 preset 重新挂载仍用同一个 `file:` URL，因此**不会**重新执行插件模块：`PresetTree.import` 最终走 `internal.import(specifier, base, {})`(`packages/preset/agent-presets/src/mount.ts:102`)。

DSH 自带的 HMR 插件能热重载，正是因为它显式遍历并删除 `loadCache` 里对应 URL 的条目(`vendor/hmr/src/index.ts:467` 附近)；该插件在 profile 里默认 `disabled`。

**结论**：改 `index.js` ⇒ 必须重启 `dsh` 才生效；改 `install.mjs` 或 preset ⇒ 新开一条对话即可。`scripts/*.mjs` 是每次直接执行的脚本，不受模块缓存影响。

### 3.5 行级文本插入，而不是 YAML 往返

preset 里含注释与 `!!js` 表达式。用 YAML 反序列化再序列化会把注释、表达式与排版全部重写掉，等于毁掉用户的配置文件。因此安装脚本只做**行级文本插入**，并保证：

- 插在 `compaction` 组的**最后一行之后**(让既有的服务提供者排在前面，与已验证的排布一致)；
- 缩进按该组的实际缩进推导；
- 相邻行之间补空行，与文件排版一致；
- 幂等(已有该行则跳过)、改前留 `.bak`。

卸载按同样的行级方式删除，并吞掉多余空行——实测**安装 → 卸载后文件逐字节回到原状**。

## 4. 验证矩阵

| 脚本 | 层次 | 断言要点 |
|---|---|---|
| `selftest.mjs` | 模块 | 可导入；`defineTool` 接受规格；工具名 `compact_agents`；参数枚举 `scope=others,all,self,ids`、`whenBusy=queue,skip`；`timeoutMs=1800000` |
| `deferred-test.mjs` | 行为(假 ctx) | 首次忙 → 回报 `queued`；**无关 agent 的 idle 不误触发**；真正 idle 后 `compactNow` 被再次调用；一次性监听器已注销；日志含遮蔽统计 |
| `integration-test.mjs` | 真机(真 Context + 真 ToolRuntime) | `inject` 解析；注册表可查出工具；参数/输出 schema 存在；`isConcurrencySafe` 是谓词且返回 `false`；`executionMode` 实测 `exclusive`；`execute(scope=others)` 排除调用者；返回值字段与 `CompactionResult` 一致；行内含压缩前后 token；`render()` 产出文本块；子代理扫描被拒；`scope=self` 忙时排队不报错；**`compaction/start` 追加可见提示(来源/summary/`surfaceOp`/非空 id)**；**`compaction/end` 给出 `213,400 → 49,800` 与遮蔽计数**；**失败压缩报"未完成"**；**无关事件不产生提示**；**`notice: false` 关掉提示但保留工具**；**`max-tokens` 轮结束自动续写一次且消息为冻结的 user**；**连续两次续写、第三次被上限拦住并播报**；**正常结束的轮次归还额度**；**`maxAutoContinues: 0` 关闭** |
| `client-test.mjs` | 浏览器 half(假 `__ModuleLoader__`；真 React 18 + `react-dom/server` 或桩，两种模式都跑；`CLIENT_TEST_STUBS=1` 强制走桩) | 工厂 id = 包名、只 require 种子模块、`apply`/`inject` 形态；**三处槽位都订阅**（`settings.section` + `plugins.bundle.config` + `settings.plugin.item`）；**三处的注册形状各自正确** —— 老设置页 `key:` = settings 命名空间 `compact-agents`、新插件页 `key:` = 包名 `dsh-compact-agents`（两者都不是 `entryKey:`），设置分区是 **list** 形状：`id: 'compact-agents'` + `order: 26` + `label: '压缩与自动续写'` 且**没有 `key`**；三者都拿到组件函数；注入面动作齐全；渲染出五个字段与两组生效时机题注、越界阻止保存、`status !== 'ready'` 只留一句提示不抛、保存走 `scope.set`、重置走 `scope.unset`、写入被拒不抛；**新插件页那份：正文容器是 `dsh-ca-page`、不画 `dsh-ca-card`/`dsh-ca-header`/箭头、与卡片共用同一个控制器、`view: 'summary'` 给出一行摘要**；**设置分区那份：自带 `dsh-ca-section` 外壳、标题 + 引言 + 五个字段 + 保存都在、未就绪时只留标题 + 一句提示、与另外两处共用同一个控制器**；**三处互不连累**（三个方向各一条：分别让插件页 / 老设置页 / 设置分区抛，断言另外两处仍注册上且有 `console.warn`） |
| `validate-presets.mjs` | 配置 | 每份 preset 可解析(含 `!!js` 标签)；挂载行在 `compaction` 组内；引用的绝对路径存在且指向本项目；报告 `thresholdRatio` / `retainRatio`；profile 侧"在 `dsh.profile.bundles` 里却不在 `dependencies` 里"→ FAIL 并打印修法（§8.5） |

`integration-test.mjs` 用四个最小桩服务(`systemPrompt` / `compaction` / `tokenMeter` / `agents`)代替整个 Harness，所以**零模型调用、零成本**，可以随时跑。

## 5. 与自动压缩的关系

本插件**不修改**自动策略，二者互补：

- `compaction-basic` 在**每一步边界**检查 `totalTokens >= contextWindow × thresholdRatio`，达线即摘要并遮蔽旧表面节点，然后**继续该轮**；
- 并在 `CONTEXT_WINDOW_EXCEEDED` 时强制压缩后重试(`maxOverflowRetries` 默认 1)；
- 触发线 = `contextWindow × thresholdRatio`，判定是 `measurement.totalTokens < spec.thresholdTokens` 就直接返回、否则压缩(`packages/compaction/compaction-basic/src/index.ts:305`)，即**达到阈值就压**。例如 1M 窗口 × 0.35 = **350K tokens** 触发(× 0.3 = 300K)；`retainRatio: 0.05` 保留最近 5%(50K)原文。
- DSH 默认 `thresholdRatio` 是 **0.8**(1M 窗口 ⇒ 800K)，实际等于"几乎永不触发"；安装脚本在校验输出里报告这个值，便于确认。

## 6. 压缩提示：为什么只能这么做

### 6.1 问题：对话区在压缩期间是**空的**

客户端为压缩注册了一个对话节点，但它在压缩**结束前不渲染**：

```ts
// packages/client/ui-chat/src/client/conversation-nodes/compaction.ts
buildViewNode: (context) => {
  const state = context.state ?? fallbackState(context)
  if (state.checkpoint === undefined) return null   // 没有完成检查点 ⇒ 不渲染
```

`checkpoint` 来自 `compactSource()`，而它匹配的是**压缩提交后才写入**的那条替代 `user/message`。所以从 `compaction/start` 到 `compaction/end` 之间，对话区没有任何节点 —— **自带自动压缩完全一样**：`正在压缩上下文…` 这个文案只存在于"轨迹"面板(`packages/client/ui-trajectory/src/client/locales.ts`)。

这就是观感"卡住"的来源：摘要模型调用要几秒到几十秒，而这段时间界面上什么都没有。

### 6.2 可选路径，以及为什么选了这条

| 方案 | 结论 |
|---|---|
| 改客户端 `compaction.ts`，让运行中也渲染一个节点 | **效果最好，但要改 DSH 本体 + 重建 `apps/web/dist`**。本项目坚持纯主机侧插件，放弃 |
| 追加自定义的 **log-only** 事件 | 不行：客户端兜底只渲染"表面事件"(`isAppendSurfaceEvent`)，未知的 log-only 事件没有任何节点 |
| 追加 `command/run` + `command/done` | 能借命令节点渲染出"运行中"，但那是**冒用别的子系统的事件**，会污染命令会话记录，放弃 |
| **追加插件来源的 `user/message`** | ✅ 采用。这正是框架自己注入"上下文注入"时用的通路 |

### 6.3 采用的实现

```js
session.append('user/message', {
  id: randomUUID(),
  role: 'user',
  content: [{ type: 'text', text: body }],
  source: { kind: 'plugin', plugin: 'dsh-compact-agents', form: 'notice', summary },
}, { surfaceOp: 'append' })
```

三点依据：

1. **客户端就是这么渲染的**。`source.kind === 'plugin'` 的 `user/message` 走 `ContextInjectionRow`，渲染成折叠行「上下文注入 · <插件名> · <摘要>」，不是用户气泡；`ContextFormed` 的 `{ form: 'notice', summary }` 让折叠态就带一行结论(`packages/llm/llm/src/message.ts:81`)。
2. **时序正好**。订阅 `session/event`(提交后同步派发的观察者 feed)，`compaction/start` 是在摘要模型调用**之前**追加的(`packages/compaction/compaction-basic/src/region.ts`，`session.append('compaction/start', lifecycle)` 在 `await summarizeCompaction(...)` 之上)，所以提示覆盖的正是那段静默等待；这一步用 `ctx.tokenMeter.measure(session)` 记下压缩前的估算。
3. **不会打破压缩**。契约明确允许："Context injected while the summary runs may sit between the marker pair; **only the selected span must remain stable**"(`packages/compaction/compaction/src/index.ts`，`compactNow` 的文档)。我们追加在表面尾部，不触碰被替换的区间，因此不会触发 `assertSelectedSpanStable` 失败。

**提示里还报"本会话用哪一档阈值"**（v0.6.1 补）：折叠行末尾带 `· 触发线 ×0.35`，取自 `ctx.compaction.config.thresholdRatio`（`modelPolicies` 命中时取命中那条）；读不到就整句不出现，不把"报诊断"变成新的失败点。正常情况下它总与 preset 文件一致（见 §6.4 的热同步）；只有热同步进不去时，正文才多一行写明两个值与"新开一条对话才会用上新值"。

### 6.4 阈值热同步：为什么能绕开"新会话生效"

**问题**：preset 里的压缩参数在**会话建立时**被读进 `compaction-basic`，它在构造时就 `resolveConfig()` 并 `deepFreeze`(`packages/compaction/compaction-basic/src/index.ts:129`)，之后改 preset 只对之后新建的会话生效 —— `agent-presets` 的 standing mount 虽然按文件戳换代，但"already joined"的会话保留自己那一代，且 `select`/`swap` 对已开始的会话直接抛 `agent-preset/locked`(`packages/preset/agent-presets/src/index.ts:735`)。于是"我改成 0.5 了，怎么还在按 200K 压"必然发生，正解是新开一条对话 —— 或者，由我们把新值送进去（v0.7.0）。

**做法**：`ctx.compaction.config` 是实例上的**普通自有属性**（`readonly` 只是 TS 层面的；被冻结的是那个对象，不是属性），而压力判定每次调用都重新读它 ——

```js
// packages/compaction/compaction-basic/src/index.ts
const policy = resolveTargetPolicy(this.config, target)   // 调用时读，不是构造时缓存
const spec = resolveCompactSpec(policy, context.contextWindow)
if (measurement.totalTokens < spec.thresholdTokens) return null
```

所以把 `service.config` 换成一个新的（未冻结的）对象即可，**下一次步边界就按新阈值判**。触发点有三处，都是本插件已经在的位置：

1. **设置面保存**：`settings.js` 写盘成功后广播 `onPresetParamsChanged` → `syncAllPresetParams()` 遍历本进程里所有活着的代际（模块级 `liveMounts`），逐个同步。多代际覆盖，是因为"活着的会话"可能分散在好几代里。
2. **每次会话事件**：`registerSessionWatch` 的 handler 先同步、再生成提示 —— 于是手改 preset 文件（不走设置面）也会在下一个事件被捞起来；读文件走 `currentPresetValues()` 的 1 秒缓存，常态成本只是一次比较。
3. **挂载时**：`apply()` 末尾同步一次，自愈历史遗留的偏差。

**只碰两个旋钮**：`thresholdRatio` 与 `retainRatio` 都在 `ResolvedConfig` 里、且都在调用时被读。`bootstrapMaxTokens` 属于另一个插件（`tool-bootstrap.mjs` 在 `apply()` 里把值捕获进闭包），改不动，仍然只对新会话生效 —— 表单上它因此单独留在一个"新建会话生效"分组里。

**匹配规则与引擎一致**：`modelPolicies` 里 provider+model 精确命中的那条才是实际生效值，所以命中了就只改那条（连带重建数组），没命中才改全局。命中判断需要路由目标，取自 `session.requestHeader().config`。

**失败即退回，不猜**：配置对象形状不对、属性写不进去、写回后读出来的值不符，都原样返回；此时提示里的"旧代际"那行会说明两个值与出路。行配置 `livePresetParams: false` 整体关闭。

**自我反证（v0.7.1）**："写进去了"不等于"引擎吃了"。策略阈值是构造期冻结的值，若上游哪天把 `resolveCompactSpec` 的结果也缓存起来，我们的替换就会**静默失效** —— 而 `ctx.compaction.config` 里明明写着新值，提示会跟着撒谎。所以热同步之后留一个待验证，用**下一次策略自己决定的压缩**反算：

```
达线判定: measurement.totalTokens >= window * thresholdRatio
把 A(0.2) 抬到 B(0.5) 之后，若压缩发生在 before ∈ [window*A, window*B) 内 ⇒ 引擎用的还是 A
```

窗口从 `ctx.get('llm').resolveModelInfo(provider, model)` 取（注意必须 `ctx.get()`：`llm` 不在本插件的 `inject` 里，`ctx.llm` 会抛 `cannot get property "llm" without inject`），并在**补丁落下时**就预先查好 —— 等到压缩发生再查就晚了，那条路径是同步的。判定成立就把该代际标记为"引擎其实还在用 A"，此后提示按 A 报（`thresholdState` 优先读这个标记），并保留"新开一条对话"这条正路。

取证的边界（宁可不验，也不误报）：

- `compaction/start` 的 `data.turn === null` 是**回合之间的手动事务**（`/compact` 等），带 `sourceCommandId` 的是命令驱动的压缩 —— 两者在任意 token 数上都可能发生，不采信。
- 我们自己请求的压缩（`compact_agents` 工具）不采信：调用前后给该会话打一个 60 秒标记，窗口内该会话的压缩一律不作为证据。
- 反证的顺序必须在**同步之前**：先拿上一次补丁去验，再把新值同步进本轮。反过来的话，本轮压缩的 token 数还是按旧阈值判出来的，会被当新阈值的证据，自己冤枉自己。
- 调低阈值无法这样反证（"还没压"与"引擎忽略"不可区分），保持待验证、不下结论。

> ⚠️ 别把提示挂在 `stability: 'whole-surface'` 的那条路径上：`compactRegion(start, end, agent, signal)` 用整面快照比对(`assertWholeSurfaceUnchanged`)，运行期追加任何表面节点都会让它抛 `SurfaceChangedError`。自动压力路径与 `compactNow` 都是 `selected-span`，安全。

### 6.4 代价（诚实披露）

- 提示是 `user/message`，**会进入模型上下文**：每次压缩多几十个 token，模型下一轮能看到"刚压过"。这是有意的。
- 两条提示里都写了"这是一条状态提示，不需要回应"，避免模型把它当用户发言来回答。
- 行配置 `notice: false` 整体关闭；关闭后工具行为不变。
- 提示只对**能收到 `session/event` 的**上下文生效。preset 行挂在 `agentCtx` 上(`presets.mount(agentCtx, …)`，其文档写明 "the mount's registrations and listeners cover this agent")，所以该 agent 自己的压缩都能看到；没有事件总线的测试桩会被静默跳过。

## 7. 被输出上限截断：诊断与自动续写

### 7.1 现象

压缩之后对话区出现「已达到输出 token 上限 / 回答被截断…发送"继续"可让模型接着输出」，模型这一轮**一个字都没输出**，必须手动发"继续"。

### 7.2 诊断（全部来自实机会话日志）

客户端文案由 `turn/end` 的 `reason.kind === 'max-tokens'` 渲染（`ui-chat/conversation-nodes/turn-max-tokens.ts`；DeepSeek 适配器把 `finish_reason: 'length'` 映射成它，`llm-deepseek/src/translate.ts`），且该状态在整轮内**粘住**：任一步触顶，后面即使有正常结束的步也不会清除（`agent-loop/src/agent.ts`）。

把同一个会话日志里的 4 次截断对齐到时间线，**4/4 都落在 `compaction/end` 之后 9~12 条记录**，且每次都是：

```
request/header  … "reasoningEffort":"high","maxTokens":1024
assistant/message  usage: outputTokens=1024, reasoningTokens=1024   ← 正文 0 字
turn/end           {"kind":"max-tokens"}
```

`maxTokens: 1024` 不是适配器默认值（`llm-deepseek` 的 `DEFAULT_MAX_TOKENS` 是 256000），而是 preset 的 `tool-bootstrap` 给的：它在**每次 `compaction/end`** 把会话重置回受控阶段（`resetToControlled`），并在 `agent/request` 上强制 `maxTokens = bootstrapMaxTokens`，直到晋升后才剥掉：

```js
// <preset>/tool-bootstrap.mjs
if (event.type === 'compaction/end') resetToControlled(state, session)   // 每次压缩都重回受控阶段
ctx.on('agent/request', async (payload, next) => {
  const resolved = await next()
  return state.promoted ? resolved : { ...resolved, maxTokens: policy.bootstrapMaxTokens }
}, { prepend: true })
```

该开关的本意是"community-observed **We need trigger window**"——用极小的输出预算逼模型给出极简计划。**但它没考虑推理模型**：`max_tokens` 同时覆盖思考 token。实测同一会话 761 次带思考的请求：中位 371、75 分位 962、90 分位 1826、95 分位 2455、**最大 8574**，其中 **175 次（23%）≥ 1024**。于是这个窗口在 1024 下经常整份被思考吃光：正文 0 字，既没有"We need"锚定，还额外赔掉一整轮。

**结论**：这不是 DSH 的 bug，也不是本插件的 bug，而是 preset 的一个假设（模型不推理）在 `reasoningEffort: high` 下失效；阈值调到 0.2 让压缩真的开始发生之后才暴露出来。

### 7.3 两层处置

1. **根因侧（配置）**：把该 preset 的 `bootstrapMaxTokens` 调到能容纳"思考 + 正文"的量级（调到 16384：覆盖实测最大思考 8574 后仍留约 7800 token 正文，且远低于适配器默认 256000）。受控阶段的其它机制（裁剪工具面、最小提示、延迟注入）不受影响。
2. **兜底侧（本插件）**：`turn/end{reason: 'max-tokens'}` 时自动续写一次。

### 7.4 自动续写的实现要点

```js
ctx.on('session/event', (session, event) => {
  if (event.type !== 'turn/end' || event.data.reason.kind !== 'max-tokens') { /* 正常结束：归还额度 */ }
  const agent = agents.list().find(a => a.session === session)
  agent.followup(continueMessage())   // = 人在界面上发一句话
})
```

| 决策 | 理由 |
|---|---|
| 用 `agent.followup(message)` 而不是 `session.append` | 前者是 `send(message,'next-turn',true)` + `wakeDriver`，**与人类发消息完全同路**（`session-controller/src/commands.ts` 里就是这么调）。单纯往表面 append 一条 `user/message` 不会唤醒 driver，对话仍然停着 |
| 消息 `source.kind` 用 `'user'` | preset 的 `messageSources` 白名单（如 `[user, goal]`）会过滤预步骤注入；用 `plugin` 来源可能被过滤出模型表面，`继续` 就白发了。代价是它在对话区显示为用户气泡 —— 因此额外播报一条提示行说明是自动发的 |
| 手写消息而不是 import `createUserMessage` | 语义等价（`deepFreeze(structuredClone(…))` + 新 id），但 `@deepseek-ai/dsh-llm` 在 harness 根 `node_modules` 里不存在，插件里的裸导入会解析失败（只保证 `@deepseek-ai/dsh-tools` 可解析） |
| 用 `setTimeout(…, 0)` 离开当前派发再开新一轮 | 避免在 `session/event` 观察者回调里重入 driver |
| **有次数上限**（`maxAutoContinues`，默认 2） | "截断→续写→又截断"会无止境烧 token。用满后改为播报提示，让人来决定 |
| **任一轮正常结束即清零** | 额度是"连续"次数：换了一个正常回答之后，下次再从 1 开始，不会长期耗尽 |
| 找不到活 agent 就放弃 | 会话可能已经结束；自动续写只服务于还能跑的会话 |

## 8. 设置面：把旋钮搬进宿主的插件配置界面

目标：压缩触发阈值、保留比例、受控阶段输出预算、提示开关、自动续写次数，五项都能在
**侧栏「插件」页**里改（DSH ≤ 0.1.5 是 **设置 → 插件 → 可配置**；上游 0.1.6 把这套界面搬走了，
两代宿主的差异与我们的双注册见 §8.5），不必再编辑 preset 的 YAML。

### 8.1 走官方正路，而不是自己画一个界面

DSH 对插件命名空间是**泛型**的：宿主枚举 `ctx.settingsScope.describe()` 里的命名空间，为每个命名空间
渲染一个**由插件自己提供**的表单，宿主从不知道这个命名空间是什么意思。0.1.6 之前这件事由设置页的
`ConfigurablePluginsTab` 做（`renderSlot('settings.plugin.item', {}, { entryKey: ns })`，该文件与它那份
slot 契约已被上游 `90af3110b7` 删除）；0.1.6 起搬到了侧栏「插件」页，改成按**包名**问 bundle 要表单
（`renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })`，详见 §8.5）。
**两代都是泛型的**，站外插件两条路都走得通。

老契约（`packages/client/ui-settings-plugins/src/client/slot-contract.ts`，随 `90af3110b7` 一起删除，
现在只剩 `lib/types/` 下的过时构建产物）把"按命名空间配对"的用意写得很明白：

> Keying on the namespace is what lets a plugin distributed outside this repository contribute a
> card: it registers its own settings namespace on the Host and its own card under that key in the
> browser, and the tab pairs the two without ever learning what the namespace means.

于是：宿主侧 `settings.register('compact-agents', schema, { base, applies })` —— **这一半两代都不变**；
浏览器侧**三处各注册一次**（v0.8.1 起；形状见 §8.5 与 §8.7）：`settings.section` 用 `id`/`order`/`label`
认领设置侧栏里自成一页的位置（list 槽位，没有键），老槽位 `settings.plugin.item` 用 settings 命名空间当键，
新槽位 `plugins.bundle.config` 用包名当键。
**没有通用兜底界面** —— 插件不提供表单，那个命名空间在哪个宿主里都不出现，所以表单是必需品。

| 决策 | 理由 |
|---|---|
| 宿主注册命名空间 + 自己写浏览器 half | 这是官方支持的站外插件形态；自己去改 DSH 的插件页（旧版是设置页）属于改宿主 |
| 浏览器 half 手写成单文件 bundle，不引打包器 | DSH 的客户端模块系统本身就是一张惰性 CJS 表（`window.__ModuleLoader__.load({ id, factory })`），产物形态可以直接照抄。项目"零依赖、离线可用"的原则因此不需要为界面破例 |
| 只 require 种子模块 `react` 与 `@deepseek-ai/dsh-client-store` | 种子模块由 shell 直接提供，不需要 `dsh.client.external`（没声明 external 却 require 非种子包会在启动时报错）。settings 通道走**服务** `ctx.settingsScope`，只在 `dsh.client.inject` 里声明包依赖边 |
| 登记键写 `key:` 而不是 `entryKey:` | `ctx.slots.register({ name, key })` 用的是 `key`；`entryKey` 是**渲染侧** `renderSlot` 的派发选项（新页 `packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:470`、老页 `ConfigurablePluginsTab.tsx` 都是这么传的）。两者不能混 |
| **进程级只注册一次** | `SettingsProvider.register()` 对重复命名空间直接 `throw`，而注册挂在该 provider 的 fiber 上、不随调用者卸载。本插件挂在 preset 行上、每次换代都会重新 apply，所以必须用模块级缓存复用同一个 scope，否则换代时那一行会直接挂掉 |
| 命名空间的 `base` 用 preset 文件里的**现值** | 表单里显示的就该是"真正生效的值"，而不是插件凭空给的默认值；三层优先级是「schema 默认 < 作文层（行配置 + preset 现值）< 用户层（界面）」 |
| `applies: 'restart'` | 五项里三项要等新会话才生效，取保守声明；表单上逐项写明真实时机（三处注册共用同一份正文，见 §8.5 / §8.7） |

### 8.2 两类值，两种生效机制

前三个值**属于 preset 里的其它插件**（`compaction-basic` 的 `thresholdRatio`/`retainRatio`、
`tool-bootstrap` 的 `bootstrapMaxTokens`）。插件改不了别人的运行时策略，所以改的是
**preset 文件本身**：preset 的挂载会记录文件 stamp，stamp 变了就给**之后新建的会话**开新一代
（`agent-presets` 的 mount 契约："Sessions already joined keep the generation they run on"）。
不用重启 DSH，但已在运行的会话不受影响。

后两个值是**本插件自己的**，会话事件发生时才读，所以改完立即生效。

| 决策 | 理由 |
|---|---|
| 按行做文本手术，不反序列化再序列化 | preset 里有注释、`!!js` 表达式和排版；读进来再写出去等于把别人的配置文件重排一遍。只定位目标 row 的 `config` 块、只替换目标那一行 |
| 写前备份 + 临时文件 rename | `<preset>.bak-compact-agents` 常驻一份"最近一次写前"的内容；rename 是原子的。界面改配置不该有把 preset 写坏的可能 |
| 越界值直接拒绝 | 表单与宿主 schema 两侧都校验，且宿主侧再挡一道范围，避免手改 settings.yaml 写出荒谬的阈值 |
| **`liveConfig` 只存"用户层覆盖"**，`null` 表示没覆盖 | 这是踩出来的：本插件按 preset 行多处挂载，行配置各不相同，而命名空间是**进程级唯一**的。第一版把解析结果直接写进模块级 `liveConfig`，于是任一个 preset 写的 `notice: false` 会把**所有** preset 的提示一起关掉（集成测试当场抓到这个回归）。现在解析结果与 `base` 比对，相等就退回各挂载自己的行配置 |

### 8.3 验证

| 层 | 覆盖 |
|---|---|
| 文本手术 | 嵌套 `config` 块的定位、兄弟 row 不串键、注释与缩进保留、只改一行、键不存在时插入、同一值不重写 |
| 落盘 | 备份内容、无残留临时文件、字节级"只有目标行变了"、越界拒绝、幂等 |
| 注册 | 命名空间名、`applies`、`base` 携带行配置与 preset 现值、schema 真能解析、**二次挂载不重复注册**、变更后自身旋钮立即生效且 preset 参数落盘 |
| 两端一致性 | 表单里的字段集合必须**逐个等于**宿主 schema 的字段；两端的命名空间字符串必须一致。这个接口是刻意在两端各写一份的，没有守卫就会悄悄漂移 |
| 浏览器 half | 工厂 id = 包名、`apply`/`inject` 形态、只 require 种子模块、**三处各注册一次且形状正确**（设置分区 = **list** 槽位 `settings.section`，用 `id`/`order`/`label`；插件页 = keyed，键 = 包名；老设置页 = keyed，键 = settings 命名空间）、真 React 渲染出五个字段与生效时机、越界阻止保存、`status !== 'ready'` 只渲染提示不抛、保存走 `scope.set`、重置走 `scope.unset`、写入被拒不抛、**一处注册失败不连累另外两处**（端到端清单见 §4 的 `client-test.mjs` 行，第三处的机制与理由见 §8.7） |

### 8.4 为什么浏览器 half 需要一行落在宿主组成里

`ClientModuleRegistry`（`packages/client/modules/src/index.ts`）决定把哪些客户端 bundle 下发给浏览器，
而它**只认宿主 Loader 的 entries**：

- 构造时只做 `for (const entry of ctx.loader.entries())`；
- 增量监听走 `ctx.on('internal/plugin', fiber => { const entryName = fiber.entry?.options.name; if (entryName === undefined) return; … })`
  —— 那行 `return` 是整段语义的核心：`fiber.entry` 为空的是"子插件或手动挂载"，直接丢弃。

preset 里的行由 `agent-presets` 用 `internal.import` **手动挂载**（见 3.2），本来就不是 loader 行，
`fiber.entry` 为空。于是：

| 只挂 preset 时的症状 | 机制 |
|---|---|
| 插件配置界面里始终不出这个命名空间 | 宿主侧注册那一层同样没被扫到 |
| 表单/卡片不出现 | 浏览器根本没收到 `lib/client.js` |
| **没有任何报错** | 整条丢弃路径是静默的，日志里也看不出来 |

**两个挂载点的职责分工**：

| 挂载点 | 谁建的 | 载体 | 负责 | 为什么必须在这里 |
|---|---|---|---|---|
| preset 行 | `install.mjs` | `<DSH_HOME>/.agent-presets/*/agent.cordis.yml` 的 `compaction` 组 | `compact_agents` 工具、压缩进度提示、`max-tokens` 后自动续写 | 必须待在 `compaction` realm 内（见 3.3）：cordis 的隔离按服务名生效，realm 外解析不到 `ctx.compaction` |
| 宿主组成里的 bundle 行 | `install.mjs --profile`（登记 profile 的 `dsh.profile.bundles`；包内 `dsh.bundle.patch` → `cordis.patch.yml`） | 宿主 Loader 的一行：`id: compact-agents-client-host` / `name: 'dsh-compact-agents/client-host'`（入口 `client-host.js`） | 被 `client-modules` 扫到（从而把 `lib/client.js` 下发给浏览器）、在宿主根注册 settings 命名空间 | 只有 loader 行才进得了 `ClientModuleRegistry`；手动挂载的行在 `fiber.entry` 那一行就被丢弃 |

**为什么 `client-host.js` 的 `inject = []`**：宿主根上**没有** `compaction` 服务（它由 preset realm 内的
`compaction-basic` 提供），声明这个依赖只会让这一行永远 pending。所以这个入口不依赖任何服务，只做两件事：
让 `client-modules` 扫到本包的 `dsh.client` 声明、在宿主根上注册 settings 命名空间。工具与提示仍归 preset 行。

**注册只做一次，但要等服务就绪**：两处入口都调用 `registerSettings`，靠 `settings.js` 的模块级缓存保证
**进程级只注册一次**（真实的 `SettingsProvider.register` 对重复命名空间直接抛错）。而 bundle 行完全可能
**早于提供 `settings` 服务的那一层**被 apply —— compose 顺序由 profile 的 `bundles` 顺序决定 —— 所以
`registerSettings` 用 `ctx.inject(['settings'], cb)` **等服务就绪**再注册，而不是同步取一次
`ctx.get('settings')` 取不到就放弃：旧写法在这种情况下会**静默地什么都不注册**，症状与上表第一条完全一样。

**形态先例**：这不是自创写法。已装的站外插件 `@a9i5k4/dsh-auto-memory` 就是同一形态 —— `package.json`
声明 `dsh.bundle.patch: './cordis.patch.yml'`、`dsh.client: { platform: 'web', inject: [ …, '@deepseek-ai/dsh-client-ui-settings' ] }`
与 `exports['./client']: './lib/client.js'`，patch 内容就是 `- insert: [ { id, name } ]`。本插件采用与它相同的形态。

**这一节的结论怎么验证的**：

| 手段 | 证明什么 |
|---|---|
| `scripts/compose-test.mjs` | 用**检出里真实的 `FileSettingsProvider`**（写到临时文件，绝不碰真实 `settings.yaml`）而不是桩，并复刻 preset 的 `isolate` 语义（`ctx.isolate('compaction', …)`）跑通 —— 证明"在真实服务 + 真实隔离作用域下也注册得上"，也就是这个命名空间确实进了宿主的设置清单（表单最终显示在哪个宿主上是浏览器 half 的事，见 §8.5） |
| 同上，另一段 | 刻意**先挂宿主组成那一行、后挂 `settings` 服务**，证明 `ctx.inject` 的等待路径真的在服务到场后完成了注册 —— 这正是上文那句"毫无报错"的回归测试 |
| `scripts/inspect-presets.mjs` | **只读**核对真实 preset 里读到的生效值（界面表单将显示的初值），一个文件都不写 |
| 源码对照 | `ClientModuleRegistry` 的两处遍历与那行 `return` 直接抄自检出源码（`packages/client/modules/src/index.ts`），不是推断 |

> ⚠️ **测试隔离教训**：`compose-test.mjs` 会走真实的 `update → watch → 写回` 链路。第一版没有把 preset
> 读写指向临时夹具，于是这个"验证"脚本**真的改写了用户的 preset** —— 把 `thresholdRatio` 写成了 `0.42`。
> 现在它在最前面调用 `setPresetFilesForTest([临时夹具])`，开头还会拍下真实 preset 的**全文快照**、结尾逐字节比对：
> 只要有一个字被改动就立即失败（`npm test` 会跑到它，也可以单独 `node scripts/compose-test.mjs`）。
> 判据刻意**不是**"阈值必须是某个数字" —— `thresholdRatio` 本来就是给人调的旋钮，硬编码期望值会把
> 「用户调过参」（preset 里的值由用户自定）误报成「测试污染了配置」，让这条防线恒失败。
> 凡是要写盘的测试，夹具必须显式指向临时文件，不能依赖"我以为它不会写"。

### 8.5 插件配置界面的宿主换了：老槽位没有渲染方（v0.8.0）

**上游改动**：`90af3110b7 feat(web): host plugin configuration on the Plugins page`
（检出 `ddefc45fbc` / `0.1.6-alpha.2`，release commit `6b1808f432`）把插件配置从设置页搬到侧栏
**插件页**（`ui-plugin-manager`），并删掉了老宿主 —— `git show --diff-filter=D --name-only 90af3110b7`
可见它删掉了 `packages/client/ui-settings-plugins/src/client/ConfigurablePluginsTab.tsx`
（连同 `slot-contract.ts`、`PluginCard.tsx`/`PluginCard.module.css`、`tab-store.ts`）。今天在
`packages/client/**/src` 里 grep `'settings.plugin.item'` **已经没有任何命中**，只剩
`packages/client/ui-settings-plugins/lib/types/client/ConfigurablePluginsTab.d.ts` 这类构建产物里的过时声明。

**为什么是静默失败**（这一节存在的理由）：

| 环节 | 源码事实 |
|---|---|
| 老槽位没有任何声明方 | 新页的三个槽位是它 `main` 行的 `children`：`packages/client/ui-plugin-manager/src/client/index.ts:88-92`（`plugins.item` / `plugins.bundle.config` / `plugins.row.config`）；`settings.plugin.item` 不在其中，`src` 里也无处声明 |
| `slots.inject` 对**永不声明**的槽位不跑回调 | `packages/client/ui-renderer/src/client/registry.ts:209` 的 `inject(key, callback)`：`reconcile()` 里 `const spec = this._core.specDynamic(key)`，紧接着 `if (spec === undefined) return`（`:238`）—— 声明不存在就直接返回，不抛错、不重试、不留日志；只有 `subscribeDeclaration` 收到声明后才跑（`:261`），而那个声明永远不会来 |
| 只有**直接** register 到未声明槽位才抛 | `packages/client/ui-slots/src/index.ts:1203-1207`：`if (!rec?.spec)` 就 `throw new Error('slot "…" is not declared (a parent entry's children table must declare it)')`。我们走的是 `inject` 把 `register` 包在回调里，所以这条异常根本没机会触发 |

症状因此只有一种：**卡片凭空消失、毫无报错**。它不是渲染失败（renderer 那边收不到入口），也不是
注册冲突（没人抢 key），而是"注册从未发生"。**想靠报错发现是不可能的** —— 这条路径上没有任何会写日志的分支。

**新契约**（`packages/client/ui-plugin-manager/src/client/slot-contract.ts`）：

- 三个槽位分工：`plugins.item`（列表根，`kind: 'list'`，**已被官方配置页占用**）、
  `plugins.bundle.config`（`kind: 'keyed'`，**键 = bundle 的包名**）、`plugins.row.config`
  （keyed，键 = `<包名>#<行 id>`，由 `rowConfigKey` 生成，`config-ledger.ts:36`）。
- `plugins.bundle.config` 的契约原话（`slot-contract.ts:34-36`）："A bundle's own configuration,
  **keyed by the bundle's package name** and rendered on the bundle's page between its description
  and its rows (`view: 'page'` only)."
- 两种 view：`PluginConfigViewProps { view: 'summary' | 'page' }`（`slot-contract.ts:16-19`）——
  `summary` 只渲染标题下那一行，`page` 渲染带自己保存控件的表单；**标题、图标、面包屑由页面自己画**
  （文件头注释原话 "The page draws the title, the icon, and the crumb itself."，`:10`）。
- 调用点：`PluginManagerPage.tsx:470` —— `renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })`，
  键就是包名；而且这一段只在**该 bundle 真的注册了表单**时才渲染（`configured={ledger.bundles.has(openPkg.name)}`，`:966`；
  `ledger.bundles` 就是 `plugins.bundle.config` 已注册键的集合，`config-ledger.ts:51-66`）。

**我们的处理**（`lib/client.js`）：

> v0.8.1 起再加**第三处** `settings.section`（设置侧栏里自成一页，现在是主入口）—— 见 §8.7。
> 这一节记的是 v0.8.0 那两处与它们各自的静默失败；那两条分析**仍然成立**，只是不再是我们唯一的出路。

- **同一份正文两端复用**：`formBody(state, face)`；新端 `CompactAgentsPanel` 在 `view: 'page'` 时返回
  `div.dsh-ca-page` + 共用正文，`view: 'summary'` 时返回一行 `dsh-ca-summary` 摘要 —— **不套卡片外壳**，
  因为页自己已经画了标题/图标/面包屑；老端 `CompactAgentsCard` 仍是可折叠卡片（头部、箭头、收起自己画）。
- **两端键不同，这是有意的**：新槽位 `key: PACKAGE_NAME`（`'dsh-compact-agents'`），老槽位
  `key: NAMESPACE`（`'compact-agents'`）。新页按包名找 bundle 表单，老设置页按 settings 命名空间配对卡片，
  两个键域不能混（`key:` 与渲染侧 `entryKey` 的区别见 §8.1 的表）。
- **失败隔离**：`registerInto()` 把 `slots.inject(...)` 与 `register(...)` 各自包 try/catch，
  失败只 `console.warn('dsh-compact-agents: 注册到 … 失败：…')` 并返回空 disposer —— 同一 key 重复注册会抛、
  版本差异也可能抛，但**一个槽位注册不上不能连累另一个**。

**第二处静默失败：新版插件页的过滤条件**

插件页只列三种 bundle：

```ts
// packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:861-864
const listed = state.packages.filter(pkg => !BUILTIN_PROFILE_BUNDLES.has(pkg.name)
  && (pkg.installed || pkg.optional || pkg.error !== undefined))
const mine = listed.filter(pkg => pkg.installed || !pkg.optional)
```

`installed` 的判据是**profile 的 `dependencies` 里有没有这个包名**：
`packages/boot/plugin-manager/src/index.ts` 的 `listBundles()`（`:194-224`）里
`const dependencies = Object.keys(manifest.dependencies ?? {})`（`:197`）、
`const installed = dependencies.includes(name)`（`:202`）；参与遍历的名字取自
`[...selected, ...dependencies, ...Object.keys(installation.dependencies ?? {})]`（`:199`，
其中 `selected` 就是 profile 的 `dsh.profile.bundles`）。而 `reconcile()`
（`packages/boot/plugin-manager/src/operations.ts:72-97`）在包声明了 `dsh.bundle` 时把它加进
`dsh.profile.bundles`（`:90-92`），**从不加进 `dependencies`**。

所以"只写 `dsh.profile.bundles`、不写 `dependencies`"这个状态是：
`installed=false`、`optional=false`、`error=undefined` → 被 `listed` 整条过滤掉 →
**插件页里根本没有这个插件，也没有任何报错**。DSH ≤ 0.1.5 时代的安装脚本（只做前者）正好落在这一格。

**修法：两处都写 + 官方通道优先 + 回滚**

| 位置 | 做法 |
|---|---|
| `scripts/install.mjs` 的 `registerProfileDependency()` | 往 profile 的 `dependencies` 里行级插入 `"dsh-compact-agents": "link:<本项目绝对路径，正斜杠>"`；写前留 `<package.json>.bak-compact-agents`，写失败把备份原样放回（`:115-141`） |
| 同上，`tryOfficialInstall()` | **优先**走官方通道 `spawnSync('dsh', ['plugin','add', dir, '--profile', profile])`；`--dry-run` 与 `--no-cli` 跳过；失败只记一行 `note` 再回落到手写登记 —— 没装 pnpm / 被别的进程锁住 / 被 safe-delete 拦下都不算错（`:161-173`、`:304-311`） |
| `scripts/uninstall.mjs` 的 `unregisterProfileDependency()` | 对称摘除（`:105`） |
| `scripts/validate-presets.mjs` | ①"在 `dsh.profile.bundles` 里却不在 `dependencies` 里" → **FAIL** 并打印修法（`node scripts/install.mjs` 或 `dsh plugin add …`）；②随包发行的 preset（路径含 `node_modules`）缺我们的挂载行时，文案点明"被发行包重写掉了，重跑 `node scripts/install.mjs`"；profile 不存在或本插件没装 → SKIP（`:96-125`、`:51-56`） |

官方通道为什么是 `add` 不是 `install`：`dsh plugin` 只是把参数原样转发给 profile 目录里的 pnpm
（`apps/cli/src/args.ts:171-183` 的 `plugin` 子命令 → `apps/cli/src/plugin.ts:12` 的 `runPlugin`），
`plugin-manager.installBundle()`（`packages/boot/plugin-manager/src/index.ts:338-398`）内部就是
`runPnpm(['add', spec])`（`:358`）→ 挑出新依赖（`:368-373`）→ `selectBundle(name, true)` 写进
`dsh.profile.bundles`（`:390`）→ 热重载；`pnpm` 退出后任一步失败都会 `restoreFiles()` 把
`package.json` 与 `pnpm-lock.yaml` 还原（`:330-331` 的契约原话："that fails, is cancelled, or adds a
package without a bundle patch restores `package.json` and `pnpm-lock.yaml` as they were"）。
`parseInstallSpec()`（`packages/boot/plugin-manager/src/install-spec.ts:51-57`）接受绝对路径与
`file:` / `link:` 前缀（`kind: 'path'`），插件页「添加插件」走的是同一条路。

**兼容性结论**：DSH ≥ 0.1.6 走新槽位，≤ 0.1.5 走老槽位，**两边同一份正文**（`formBody`）、同一个
控制器（两端状态与"已覆盖/重置"语义完全一致），表单字段与生效时机逐项相同；谁有宿主谁渲染，
不需要版本判断 —— `slots.inject` 本身就是"等声明"的语义。`npm test` 里的 `client-test.mjs` 三处都锁（§4）。
v0.8.1 再加的第三处 `settings.section` **与这两个 keyed 槽位无关**，它在两代宿主上都存在，见 §8.7。

`package.json` 的 `dsh.client.inject` **没有**加 `@deepseek-ai/dsh-client-ui-plugin-manager`，理由：

- 契约原话就写着注册方**运行时从不 import 这个包**（`slot-contract.ts:5-6`）："A registrant merges this
  contract with `import type` and registers through `ctx.slots`; it never imports this package at runtime."
  —— 把它写进包级 `inject`，等于声明一条并不存在的模块依赖。
- `dsh.client.inject` 是**包级**的加载/预取边，不是"这个包在不在"的可选探测：
  `packages/client/ui-workspace/src/client/index.ts:61-67` 的注释写明这些边 "are informational
  (loading/prefetch metadata, **never apply sequencing**)"；而客户端对图上不存在的 inject 目标**直接跳过**
  （`packages/client/modules/src/client/system.ts:207-210`；`packages/client/modules/tests/loader.client.spec.ts:748`
  的用例名就叫 "absent optional inject rows"）。
- 所以加它**换不来我们要的语义**：我们要的是"槽位被声明了就注册、没声明就安静等"，只有
  `ctx.slots.inject()` 提供（上表第二行）；把只有新宿主才有的包名写死进包级声明，等于把
  "新宿主才有"当成"所有宿主都有"的前提。顺带澄清一个容易想当然的说法：这条边**不会**让老宿主上的
  浏览器 half 加载失败（不存在的目标被跳过），它只是**什么也保证不了**。

### 8.6 两条已知限制（诚实披露）

**① 插件页那个启用/停用开关只管浏览器 half，管不到 `compact_agents` 工具。** 那个开关动的是宿主组成里的
`compact-agents-client-host` 行（本包 `dsh.bundle.patch` 插进去的那一行）：关掉它，表单/卡片不再出现，
**但工具照常可用**；反过来，想让工具停下来只能动 preset 那一行（删掉它，或给那一行加 `disabled`）—— 插件页的开关够不着它。
根因就是 §8.4 的两个挂载点：一个 bundle（浏览器 half）加一行 preset（工具与压缩提示），插件页只认前者。

**② 随包发行的 preset 会被它自己的插件升级整份重写，丢掉我们的挂载行。** 实测 `@linxin666/dsh-liangshen`：
升级后 `<profile>/node_modules/@linxin666/*/presets/*/agent.cordis.yml` 的 `compaction` 组里我们的行没了
（工具随之失效，而 preset 本身仍能解析，别处不会有报错）。修法是重跑 `node scripts/install.mjs`；
`scripts/validate-presets.mjs` 对"路径含 `node_modules` 的 preset 缺我们的行"专门给一句 FAIL 文案点明原因
（`:51-56`）。同一处还有一层遮蔽：**同名的手工 preset 永远不会被读到** —— `agent-presets` 的 roots 顺序是
随包根最先、用户根最后（`packages/preset/agent-presets/src/index.ts:181-185`），而它的注释写明 "an earlier
root wins a duplicate id: a shipped preset shadows any directory that claimed its name"（`:125-128`）。
所以 `~/.dsh/.agent-presets/liangshen` 会被同名的随包 preset 盖掉：要改就改随包那份（并在下次升级后重跑安装
脚本），或者给自建 preset 换一个 id。

### 8.7 为什么最后落成"自成一页的设置分区"（v0.8.1）

§8.5 的结论是"没得选，只能去插件页"。这一节记的是**为什么最终不接受那个答案**，以及第三处注册的
机制、代价与边界。

**上游决定**：`90af3110b7`（细节见 §8.5）把插件配置搬去侧栏插件页、删掉老渲染方，架构笔记的原话是
「插件页承载配置；设置只保留清单」「`settings.plugin.item` slot 退役」。也就是说，对新宿主而言
"设置里改参数"这条路被官方**收走**了。

**用户诉求**：升级后用户的原话是"不能设置那些参数了…你应该和插件同级按钮"。他原来那张卡片在
**设置 → 内置插件 →「配置」标签页**里；上游给的替代路径是"去插件页 → 找到本包 → 进详情" ——
多两级导航，而且它只在插件页真的列出本包时才存在（§8.5 的第二处静默失败：只列
`installed || optional || error` 的 bundle，`installed` 的判据是 profile `dependencies` 含包名）。

**为什么 `settings.section` 是正解**：

- **它是官方给插件的一等公民位置**，核心分区与第三方插件都走它。官方同位的 order 序列：
  `general` 0（`packages/client/ui-settings-general/src/client/index.ts:187`）、
  `models` 10（`packages/client/ui-settings-models/src/client/index.ts:131`）、
  `plugins` 15（`packages/client/ui-settings-plugins/src/client/index.ts:187`）、
  `agent-presets` 20（`packages/client/ui-agent-preset/src/client/index.ts:215`）、
  `archived-sessions` 25（`packages/client/ui-settings-unarchive-sessions/src/client/index.ts:41`）。
  已装的其它站外插件同样登记在它上面：`dsh-cost-meter` 的「费用」order 30（`.../dsh-cost-meter/lib/client.js`）、
  `dshmarket` 的「插件市场」order 40（`.../dshmarket/client/client.js`）—— 这两个包在 profile 的
  `node_modules` 里、不在检出里，故只给 profile 相对路径，复查时按包名 grep 即可。
- **与宿主版本无关**：0.1.5 与 0.1.6 都声明并渲染 `settings.section`。§8.5 的两处是"谁有宿主谁渲染"，
  这一处是"**两代都有**"—— 不必再赌某个 keyed 槽位还存不存在，也不必跟着官方下一次搬迁再追一次。
- **机制**：它是 **list** 槽位（`packages/client/ui-settings/src/client/contract/slots.ts:54`：
  `'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }`），
  注册形状是 `id`（认领位置，也是渲染侧 `only` 过滤的键）+ `order`（排位）+ `label`（侧栏那一行文字），
  **没有 `key`** —— 这正是它不能复用 `registerInto()` 的原因（见下）。
- **壳只渲染内容列，标题必须自己画**：设置壳是
  `renderSlot('settings.section', { close: onClose }, { only: active })`
  （`packages/client/ui-settings-general/src/client/SettingsRoot.tsx:101`）—— 用户在设置里看到的
  「内置插件」标题是**那个分区组件自己画的**，壳不给。所以我们的组件自带
  `.dsh-ca-section`/`.dsh-ca-heading`/`.dsh-ca-intro`，尺寸照抄官方
  `packages/client/ui-settings-plugins/src/client/PluginsSettingsSection.module.css` 的
  `.section`（`gap: 12px`、`max-width: 760px`）/`.heading`（`18px/600`）/`.intro`（`13px`、tertiary 色）。

**三处注册的分工**（`lib/client.js` 的 `apply()`）：

| # | 槽位 | 槽位形状 | 注册键 | 组件 | 宿主 |
|---|---|---|---|---|---|
| 1 | `settings.section` | list | `id: 'compact-agents'` + `order: 26` + `label: '压缩与自动续写'` | `CompactAgentsSection`（自画标题 + 引言） | 设置侧栏，**两代都有**（主入口，v0.8.1 新增） |
| 2 | `plugins.bundle.config` | keyed | `key: 'dsh-compact-agents'`（包名） | `CompactAgentsPanel`（`view: 'page'` 给正文、`'summary'` 给一行摘要；**不套卡片外壳**） | DSH ≥ 0.1.6 插件页 |
| 3 | `settings.plugin.item` | keyed | `key: 'compact-agents'`（settings 命名空间） | `CompactAgentsCard`（可折叠卡片，头/箭头/收起自己画） | DSH ≤ 0.1.5 设置页 |

三处共用**同一个** `CompactAgentsCardController` 与**同一份** `formBody`，所以字段集合、生效时机题注、
"已覆盖/重置"语义与保存行为逐项相同 —— 同屏出现两份，也只是同一份状态被渲染了两次，不会出现两个值。

**失败隔离**：list 槽位的形状与 keyed 不同（`id`/`order`/`label`，没有 `key`），所以新增了一个
`registerSection()`；`registerSection()` 与 `registerInto()` 都把 `slots.inject(...)` 与 `register(...)`
各自包 try/catch，失败只 `console.warn` 一行并返回空 disposer。`scripts/client-test.mjs` 对**三个方向**
各锁一条（让任一处抛，断言另外两处仍注册上），见 §4。

**代价与限制**（照实写）：

- 三个宿主同屏时**可能看到两份内容相同的表单**（设置分区 + 插件页详情）。值完全一致（共用控制器），
  但观感上重复 —— 这是"不赌槽位"换来确定性的代价。
- `order: 26` 是**位置选择，不是契约**：排在官方 25（已归档会话）之后、第三方（费用 30、插件市场 40）
  之前。官方若再插入新的核心分区，我们的排位会跟着挪，功能不受影响。
- 分区组件的 owner props 只有 `{ close }`（关闭设置面板，`packages/client/ui-settings/src/client/contract/slots.ts:123-126`
  的 `SettingsSectionOwnerProps`），我们**用不上**，因此不自画关闭按钮；与插件页那份的差别也仅剩"谁画标题"。
- **与 §8.5 的关系**：那两条静默失败分析仍然成立 —— 老槽位依旧没有任何渲染方；插件页那条过滤条件
  依旧会静默吞掉"半装"的 bundle。`settings.section` 只是让这两条不再是**唯一**出路。

## 9. 压缩参数的机制与调参取舍

§5 列出了那几个旋钮，§8.2 讲了两类生效机制；这一节补上**它们为什么长这样、调它们各自的代价是什么**。
用户视角的"怎么理解、怎么调"在仓库根 `README.md` 的「每个参数到底在管什么」一节，这里只讲机制与设计理由。

### 9.1 一次压缩的完整链路（示意）

以 1M 窗口（≈100 万 tokens）、`thresholdRatio: 0.35`、`retainRatio: 0.05`、`bootstrapMaxTokens: 16384` 为例：

```
压之前   系统提示 1 万 + 历史 34 万 = 35 万
         └─ totalTokens ≥ 窗口 × 0.35 → 达线，进入压缩

压缩中   summarizeCompaction(...) 真实调用一次摘要模型
         把"最近 5 万"以外的表面节点【遮蔽】(mask) 掉，并换成摘要
         └─ 遮蔽 = 移出发送内容，不是删除节点；回报里的"遮蔽节点数"就是这次选中的区间

压之后   系统提示 1 万 + 摘要 0.3 万 + 最近原文 5 万 ≈ 6.3 万
         └─ "最近 5 万" = retainRatio 0.05 × 窗口 100 万

随后     tool-bootstrap 在 compaction/end 上 resetToControlled：
         此后每个 agent/request 被强制 maxTokens = bootstrapMaxTokens，直到会话晋升
```

三个参数各管一段，互不重叠：`thresholdRatio` 管**触发**，`retainRatio` 管**保真边界**，
`bootstrapMaxTokens` 管**压完那几轮的输出上限**。没有一个参数管"摘要写得好不好"——那是摘要模型自己的职责，
本插件与这两个 preset 插件都不介入。

把上面这条链路画成流程图（节点数值与文字版逐字一致）：

```mermaid
flowchart TD
    A["压缩前：系统提示 1 万 + 历史 34 万<br/>≈ 35 万 tokens"] --> B["撞到 thresholdRatio 0.35 的触发线<br/>（1M 窗口 × 0.35 = 35 万）"]
    B --> C["压缩：把「最近 5 万」以外的部分<br/>遮蔽成一段摘要（不删除，只移出发送内容）"]
    C --> D["压缩后：系统提示 1 万 + 摘要 0.3 万 + 最近原文 5 万<br/>≈ 6.3 万 tokens"]
    D --> E["「最近 5 万」= retainRatio 0.05 × 1M 窗口"]
    D --> F["进入受控阶段：<br/>此后每次请求最多输出 bootstrapMaxTokens"]
```

### 9.2 为什么必须留一块原文（`retainRatio` 的设计理由）

- 摘要是**有损**的：细节、精确的标识符、代码片段都可能被抹掉。
- 但**近因**恰恰最可能马上被用到：刚贴的代码、刚提的需求、刚纠正的错误。全量摘要化就会得到
  "我刚说过的它当没看见"这种最伤信任的表现。
- 所以设计上把"保真"做成一条**可调的线**，而不是全有或全无：线内原文一字不差，线外只剩摘要。
- 单位取**窗口比例**而不是**消息条数**：条数与 token 量完全不成比例（一条贴了 500 行代码的消息
  可以顶上几百条短消息），而成本的真实量纲是 token。这也是它不能被"最近 N 条"替代的原因。

| 调整 | 代价 |
|---|---|
| 调小（如 `0.01` = 保留 1 万） | 一个几百行的代码文件就接近 1 万 tokens，刚贴的内容压完即被总结掉，表现为"转头就忘" |
| 调大（如 `0.2` = 保留 20 万） | 压完仍剩约 25 万，很快再次撞线 → **压缩抖动**：反复压、反复打断 |
| `0.05`（现值） | 一般对话够用；经常贴大文件的场景建议 `0.08~0.1` |

### 9.3 为什么压缩后要进"受控阶段"（`bootstrapMaxTokens` 的设计理由）

该开关（受控阶段）的本意是 "community-observed **We need trigger window**"：用极小的输出预算逼模型先给出
极简计划，再放开。它挂在 `compaction/end` 上（`resetToControlled`），所以**每次压缩之后**都会重新进入
受控阶段——设计意图是防止"刚清出来的空间被一篇长回答又塞满"，让这次压缩不至于白做。会话"晋升"
（`state.promoted`）之后 `agent/request` 上的强制 `maxTokens` 被剥掉，恢复模型本身的大预算，
所以**受控阶段是压缩之后的一段临时限流，不是永久设置**。

关键约束在于：**`max_tokens` 同时覆盖思考（reasoning）token**。这不是 DSH 的 bug，而是该 preset 的一个
隐含假设（模型不推理）在 `reasoningEffort: high` 下失效——压缩阈值调到 0.2、压缩真的开始发生之后才暴露。
实测同一会话 761 次带思考的请求：思考 token 中位 371、75 分位 962、90 分位 1826、95 分位 2455、最大 8574，
其中 **23% ≥ 1024**；而 preset 把 `bootstrapMaxTokens` 给了 1024，于是这个窗口经常整份被思考吃光
（实测 4/4 次截断都是 `outputTokens=1024, reasoningTokens=1024`、正文 0 字，见 §7）。插件的兜底是
"被截断时自动续写"（§7.4），代价是现象变成**锯齿状输出**（说一半 → 自动继续 → 接着说）。

| 调整 | 代价 |
|---|---|
| 调小（如 `1024`） | 省，但思考一超线就正文 0 字；靠自动续写补，来回多花轮次 |
| 调大（如 `32768`） | 不易截断，但受控阶段每轮都可能很贵，且"重新锚定/极简计划"的设计意图被削弱 |
| `16384`（现值） | 覆盖实测最大思考 8574 后仍留约 7800 token 正文，是折中值 |

### 9.4 为什么这三个值只能写进 preset

`thresholdRatio` / `retainRatio` 属于 `compaction-basic`，`bootstrapMaxTokens` 属于 `tool-bootstrap`。
运行时策略在各自的插件里，本插件没有修改别人策略的接口，所以只能改**preset 文件本身**：
preset 的 standing mount 按文件 stamp（`mtimeMs` + `size`）识别新一代，因此改动**只对之后新建的会话生效**，
已经在运行的会话保持它 join 时的那一代——与 §2.3、§8.2 是同一套机制。反过来，压缩提示开关与自动续写次数
是本插件自己的行配置，事件发生时才读，**改完立即生效**。

这也是"为什么不去改运行时策略"的理由：越过所属插件直接改运行时值，就等于在别人的契约之外动它的状态；
写 preset 文件则是走它自己的配置入口，且天然留下 `.bak-compact-agents` 备份与可回滚的文本差异。

### 9.5 速查：调参的取舍方向

| 目标 | 调整 |
|---|---|
| 更省钱、更快 | 阈值调小（早压）+ 保留比例调小 |
| 少打断、记得住刚说的 | 保留比例调大（`0.08~0.1`） |
| 受控阶段老被截断（反复自动续写） | 输出预算调大（`32768`） |
| 压缩太频繁、嫌它老在总结 | 阈值调大（`0.3~0.4`） |

恢复默认：各字段的「重置」回到 preset 里的值；`thresholdRatio: 0.8` 是 DSH 出厂值（1M 窗口 ⇒ 800K，
实际等于"几乎永不触发"）。


