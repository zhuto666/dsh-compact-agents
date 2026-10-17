/**
 * 把插件的旋钮和压缩相关的 preset 参数搬进 DSH 的「设置」界面。
 *
 * ## 为什么要有这个文件
 *
 * 这些值本来散在 preset 的 YAML 里（`compaction-basic` 的 `thresholdRatio` /
 * `retainRatio`、`tool-bootstrap` 的 `bootstrapMaxTokens`），改一次要人工去编辑别人的
 * 配置文件。DSH 的设置系统给了正路：**插件注册一个 settings 命名空间**，浏览器 half
 * 在 `settings.plugin.item` 槽里按同一个命名空间注册一张卡片，设置页只负责把两者配对，
 * 从不需要理解命名空间的含义（`ui-settings-plugins/src/client/slot-contract.ts` 的原话：
 * "Keying on the namespace is what lets a plugin distributed outside this repository
 * contribute a card"）。
 *
 * ## 两类值，两种生效时机
 *
 * - `notice` / `maxAutoContinues` / `preemptiveRatio` 是**本插件自己**的旋钮 → 存在模块级
 *   `liveConfig` 里，会话事件的监听器在**事件发生的那一刻**读它，所以改完立即生效。
 * - `thresholdRatio` / `retainRatio` / `bootstrapMaxTokens` 属于 preset 里的其它插件，
 *   我们不能替它们改运行时策略 → 改的是**preset 文件本身**。preset 的挂载会记录文件
 *   stamp，stamp 变了就给**之后新建的会话**开新一代（`agent-presets` 的 mount 契约），
 *   所以不用重启 DSH，但已经在跑的会话不受影响。
 *
 * ## 注册为什么是进程级一次
 *
 * `SettingsProvider.register()` 对重复命名空间是**直接抛错**的，而它的注册挂在 provider
 * 自己的 fiber 上、并不随调用者卸载。本插件是挂在 preset 行上的（每次换代都会重新
 * apply 一次），所以必须用模块级缓存保证"一个进程只注册一次、后续换代复用同一个 scope"，
 * 否则换代时注册会抛 `settings namespace "…" is already registered`，那一代的行直接挂掉。
 *
 * @module dsh-compact-agents/settings
 */

import fs from 'node:fs'
import path from 'node:path'
import { DSH_HOME, discoverPresets } from './scripts/lib/presets.mjs'

/** 设置界面里的命名空间；浏览器 half 用它认领老设置页那张卡片（`settings.plugin.item` 的 key）。 */
export const SETTINGS_NAMESPACE = 'compact-agents'

/**
 * profile 组成里那一行的 entry id —— 0.1.7 起设置表单按它认领。
 *
 * 上游 601d6761e4 把设置模型换成了"宿主读 entry 自己的 Config"：
 * `packages/settings/settings/src/index.ts` 的 `describe()` 拿 `entry.options.id` 当命名空间
 * （`ns: entry.options.id`）、拿 `entry.fiber.runtime.Config` 当表单 schema
 * （`private schema(entry)` → `entry.fiber?.runtime?.Config`），而浏览器半边收到的正是这个 id。
 * 所以 `lib/client.js` 里 `ctx.configForms.get()` 的实参必须与 `cordis.patch.yml` 那一行的
 * `id:` 逐字一致 —— 它与 {@link SETTINGS_NAMESPACE} 是**两个不同的字符串**，别混。
 */
export const ENTRY_ID = 'compact-agents-client-host'

/** 命名空间的字段说明（同时是文档与测试的单一来源）。 */
export const SETTINGS_FIELDS = Object.freeze({
  notice: '"是否在对话区播报压缩进度" —— 属于本插件，改完立即生效',
  maxAutoContinues: '"被输出上限截断时自动续写几次" —— 属于本插件，改完立即生效',
  preemptiveRatio: '"回合结束时占用达到触发线的多少就先压一次"（0 关闭）—— 属于本插件，改完立即生效',
  thresholdRatio: '"压缩触发阈值比例"(0.35 = 窗口 100 万 tokens 时约 35 万处触发) —— 写进预设，并热同步给运行中的会话',
  retainRatio: '"压缩后保留比例" —— 写进预设，并热同步给运行中的会话',
  bootstrapMaxTokens: '"受控阶段的请求输出预算" —— 写进预设，新会话生效',
})

/** preset 参数分别在哪个 row 的 `config` 块里。 */
const PRESET_KEYS = Object.freeze({
  thresholdRatio: 'compaction-basic',
  retainRatio: 'compaction-basic',
  bootstrapMaxTokens: 'tool-bootstrap',
})

/** 数值型 preset 参数的取值范围，和 schema 保持一致。 */
const PRESET_RANGES = Object.freeze({
  thresholdRatio: [0.05, 0.95],
  retainRatio: [0.01, 0.5],
  bootstrapMaxTokens: [1024, 200000],
})

/** 本插件自己的旋钮的当前值；会话事件的监听器在这一刻读，所以是"立即生效"。 */
export const liveConfig = {
  notice: null,
  maxAutoContinues: null,
  preemptiveRatio: null,
}

/** 上次写进 preset 的值，用来判断某个字段是否真的需要落盘。 */
let appliedPresetValues = null

/** 仅测试用的 preset 文件清单覆盖；为 null 时用 {@link discoverPresets} 实测发现。 */
let presetFilesOverride = null

/** {@link currentPresetValues} 的取值缓存：`discoverPresets()` 要扫目录，不能每个会话事件都跑。 */
let presetValuesCache = null

/** 上面那份缓存的存活时间；够短，手改文件一秒内就会被发现。 */
const PRESET_VALUES_TTL_MS = 1000

/** 设置界面保存后要通知的监听器（见 {@link onPresetParamsChanged}）。 */
const presetParamListeners = new Set()

/**
 * 本次要读写的 preset 文件清单。
 * @returns preset 文件路径列表。
 */
function presetFiles() {
  return presetFilesOverride ?? discoverPresets()
}

/**
 * 仅供测试：把 preset 读写指向临时文件，避免测试动到真实配置。
 * @param files - 文件路径列表；传 null 恢复实测发现。
 */
export function setPresetFilesForTest(files) {
  presetFilesOverride = files
  presetValuesCache = null
  seedCache = null
}

/** `maxAutoContinues` 的默认值：连续截断时最多自动续写两次。 */
export const DEFAULT_MAX_AUTO_CONTINUES = 2

/** `preemptiveRatio` 的默认值：占用达到触发线的 90% 时，在回合结束就先压一次。 */
export const DEFAULT_PREEMPTIVE_RATIO = 0.9

/**
 * 解析行配置里的「回合结束预压比例」。
 *
 * 这是**作文层**：它进 settings 命名空间的 `base`，用户层（设置界面）盖在它上面，
 * 所以三层的优先级是「schema 默认 < preset 行配置 < 设置界面」。
 *
 * 语义：一轮结束时若占用已达「触发线 × 该比例」，就先把压缩做掉 —— 把摘要模型的耗时
 * 从"下一轮的第一个 token 之前"挪到"这一轮回答之后的空档里"。达线的兜底仍由
 * `compaction-basic` 负责，这一项只决定"要不要提前动手"。
 *
 * @param config - 行配置；`preemptiveRatio: 0` 或 `false` 关闭预压。
 * @returns 0 表示关闭，否则为触发线的占比（0 < r ≤ 1）。
 */
export function resolvePreemptiveRatio(config) {
  const raw = config?.preemptiveRatio
  if (raw === false) return 0
  if (raw === undefined) return DEFAULT_PREEMPTIVE_RATIO
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw
  return DEFAULT_PREEMPTIVE_RATIO
}

/**
 * 解析行配置里的自动续写次数上限。
 *
 * 这是**作文层**：它进 settings 命名空间的 `base`，用户层（设置界面）盖在它上面，
 * 所以三层的优先级是「schema 默认 < preset 行配置 < 设置界面」。
 *
 * @param config - 行配置；`maxAutoContinues: 0` 或 `false` 关闭自动续写。
 * @returns 0 表示关闭，否则为该会话允许的最大连续续写次数。
 */
export function resolveMaxAutoContinues(config) {
  const raw = config?.maxAutoContinues
  if (raw === false) return 0
  if (raw === undefined) return DEFAULT_MAX_AUTO_CONTINUES
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw
  return DEFAULT_MAX_AUTO_CONTINUES
}

/**
 * 在 YAML 文本里定位某个 row 的 `config` 块。
 *
 * 只看文本、不反序列化：preset 里有注释与 `!!js` 表达式，任何"读进来再写出去"的做法
 * 都会把别人的配置文件重排一遍。
 *
 * @param lines - 文件按行切开的结果。
 * @param rowId - 目标 row 的 id。
 * @param from - 从哪一行开始找；同一文件里可能有多个同名 row，逐个处理时要往后递。
 * @returns 行号与该块的缩进；找不到 row 或 row 里没有 `config:` 时为 null。
 */
function locateRowConfig(lines, rowId, from = 0) {
  const rowPattern = new RegExp(`^(\\s*)-\\s*id:\\s*${rowId}\\s*$`)
  let rowLine = -1
  for (let i = from; i < lines.length; i += 1) {
    if (rowPattern.test(lines[i])) {
      rowLine = i
      break
    }
  }
  if (rowLine === -1) return null
  const indent = rowPattern.exec(lines[rowLine])[1].length
  // 同级或更浅的下一个列表项就是本 row 的边界。
  let end = lines.length
  for (let i = rowLine + 1; i < lines.length; i += 1) {
    const sibling = /^(\s*)-\s*id:\s*\S/.exec(lines[i])
    if (sibling !== null && sibling[1].length <= indent) {
      end = i
      break
    }
  }
  for (let i = rowLine + 1; i < end; i += 1) {
    const match = /^(\s*)config:\s*$/.exec(lines[i])
    if (match !== null) return { end, configLine: i, configIndent: match[1].length }
  }
  return null
}

/**
 * 找出行内 YAML 注释的起始下标（`#` 且前面是空白，且不在引号内）。
 * @param text - `key:` 之后的整段文本（值 + 可能存在的行内注释）。
 * @returns 注释起始下标；没有注释时为 -1。
 */
function inlineCommentIndex(text) {
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    // YAML 规定：`#` 只有在行首或前面是空白时才开始注释。
    if (char === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) return i
  }
  return -1
}

/**
 * 剥掉行内注释并去掉首尾空白，得到纯值。
 *
 * 真实 preset 里阈值就是带注释写的（`thresholdRatio: 0.2   # 1M 窗口 x 0.2 = 200K 触发压缩`），
 * 不剥注释就会把注释当值解析成 NaN —— 读不到，写回时还会把用户的注释整段抹掉。
 *
 * @param text - `key:` 之后的整段文本。
 * @returns 纯值文本。
 */
function scalarOf(text) {
  return splitScalar(text).value
}

/**
 * 把 `key:` 之后的文本切成「纯值」与「值之后的原样尾巴（对齐空白 + 行内注释）」。
 *
 * 尾巴必须原样留着：真实 preset 里阈值后面跟着一句"为什么是这个数"，
 * 改配置时把它抹掉等于毁掉别人的注释。
 *
 * @param text - `key:` 之后的整段文本。
 * @returns 纯值与尾巴。
 */
function splitScalar(text) {
  const at = inlineCommentIndex(text)
  const span = at === -1 ? text : text.slice(0, at)
  const leading = span.length - span.trimStart().length
  const value = span.trim()
  return { value, tail: text.slice(leading + value.length) }
}

/**
 * 读一个 row 的 `config` 块里某个键的原始文本值。
 * @param lines - 文件按行切开的结果。
 * @param rowId - 目标 row 的 id。
 * @param key - 键名。
 * @returns 原始文本值（已去空白、已剥行内注释）；找不到时为 undefined。
 */
export function readKeyInRow(lines, rowId, key) {
  const located = locateRowConfig(lines, rowId)
  if (located === null) return undefined
  for (let i = located.configLine + 1; i < located.end; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^(\s*)([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (match === null) continue
    // 缩进回到 config 同级说明这个块已经结束。
    if (match[1].length <= located.configIndent) break
    if (match[2] === key) return scalarOf(match[3])
  }
  return undefined
}

/**
 * 数值 → 百分比文本（0.3 → `30%`，0.025 → `2.5%`）。
 * @param value - 比例。
 * @returns 不带多余零的百分比文本。
 */
function percentText(value) {
  return `${Number((value * 100).toFixed(2))}%`
}

/**
 * 某一个键在**当前取值**下的规范注释文本。
 * @param key - 键名。
 * @param value - 即将写入的值。
 * @returns 注释正文；该键没有规范说法时返回 null（保持原注释不动）。
 */
function canonicalComment(key, value) {
  if (key === 'thresholdRatio') return `窗口占用达 ${percentText(Number(value))} 时触发压缩`
  if (key === 'retainRatio') return `压缩后保留最近 ${percentText(Number(value))} 窗口的原文`
  if (key === 'bootstrapMaxTokens') return '受控阶段单次请求的输出预算'
  return null
}

/**
 * 值改了，行尾那句**带数字**的注释就过时了 —— 刷新它，避免文件里留着自相矛盾的解释
 * （真实案例：`retainRatio: 0.02  # 压缩后保留最近 5% 窗口 = 50K 原文`）。
 *
 * 只碰"注释里出现数字"的行：那种注释是照着旧值算出来的。没有数字的注释是用户自己的话
 * （为什么这么设、注意什么），一律原样保留；本来没有注释的行也不替用户加。
 *
 * @param key - 键名。
 * @param value - 即将写入的值。
 * @param tail - 值后面的原始尾巴（对齐空白 + 可能的行内注释）。
 * @returns 新的尾巴。
 */
function refreshComment(key, value, tail) {
  const comment = /#(.*)$/.exec(tail)
  if (comment === null || !/[0-9]/.test(comment[1])) return tail
  const text = canonicalComment(key, value)
  if (text === null) return tail
  return `${tail.slice(0, comment.index)}# ${text}`
}

/**
 * 就地改写一个 row 的 `config` 块里某个键；键不存在时插到 `config:` 的第一行。
 *
 * 只动这一行的**值**，其余文本原样保留 —— 包括缩进、以及文件其它行。行内注释是个例外：
 * 带数字的那种是照着旧值算出来的，值一改就该跟着改（见 {@link refreshComment}），
 * 否则解释会和值打架。没有数字的注释（"为什么设成这样"）照旧原样留着。
 *
 * @param lines - 文件按行切开的结果（**就地修改**）。
 * @param rowId - 目标 row 的 id。
 * @param key - 键名。
 * @param value - 要写入的字面量（已序列化好的 YAML 标量文本）。
 * @returns 是否发生了修改。
 */
export function setKeyInRow(lines, rowId, key, value) {
  let changed = false
  let from = 0
  // 同一个 row id 在一个文件里可能出现多次：0.1.7 起多个 preset 的声明内联在同一个 profile
  // 补丁里（每个 preset 的 plugins 数组各带一份 `compaction-basic`），而"改阈值"的语义是
  // **所有**挂载它的 preset 一起改 —— 只改第一个会让其余预设静默停在旧值。
  while (from < lines.length) {
    const located = locateRowConfig(lines, rowId, from)
    if (located === null) break
    const childIndent = ' '.repeat(located.configIndent + 2)
    let hit = false
    for (let i = located.configLine + 1; i < located.end; i += 1) {
      const match = /^(\s*)([A-Za-z0-9_-]+):(.*)$/.exec(lines[i])
      if (match === null) continue
      if (match[1].length <= located.configIndent) break
      if (match[2] !== key) continue
      // 值后面的尾巴：对齐空白 + 行内注释；没有注释时是空串或行尾空白。
      const { tail } = splitScalar(match[3])
      const next = `${match[1]}${key}: ${value}${refreshComment(key, value, tail)}`
      if (next !== lines[i]) {
        lines[i] = next
        changed = true
      }
      hit = true
      break
    }
    if (!hit) {
      lines.splice(located.configLine + 1, 0, `${childIndent}${key}: ${value}`)
      changed = true
      from = located.end + 1
      continue
    }
    from = located.end
  }
  return changed
}

/**
 * 从 preset 文件里读出当前的 preset 参数，作为 settings 命名空间的 `base`。
 *
 * 于是设置页显示的是**真正生效的值**（来自 preset 文件），而不是插件凭空给的默认值；
 * 用户在界面上改过之后，"已覆盖"标记来自 settings 自己的 user 层。
 *
 * @param files - 要扫描的 preset 文件；缺省用 {@link discoverPresets}。
 * @returns 找到的键值对（第一个命中的文件胜出），以及各文件的读取错误。
 */
export function readPresetValues(files) {
  const values = {}
  const problems = []
  for (const file of files ?? presetFiles()) {
    let lines
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n')
    } catch (error) {
      problems.push(`${file}: ${error.message}`)
      continue
    }
    for (const [key, rowId] of Object.entries(PRESET_KEYS)) {
      if (values[key] !== undefined) continue
      const raw = readKeyInRow(lines, rowId, key)
      if (raw === undefined || raw === '') continue
      const parsed = Number(raw)
      if (Number.isFinite(parsed)) values[key] = parsed
    }
  }
  return { values, problems }
}

/** {@link seedConfigDefaults} 的一次性结果：`Config` 的默认值与 `apply()` 的锚点必须同源。 */
let seedCache = null

/**
 * 设置表单六个字段的默认值 —— 也是判断"用户改过没有"的作文层锚点。
 *
 * `Config` 必须在**模块加载时**就给出静态默认值，而"真正生效的值"在 preset 文件里
 * （用户可能直接编辑过）。所以这里同步读一次文件、拿它当默认值：界面一打开显示的就是
 * 生效值；而用户没动过的字段在 {@link registerSettings} 里与本函数的返回值相等，
 * 于是不会被无谓地写回 preset —— 这是"不覆盖用户手改"的唯一防线。
 *
 * 结果缓存到进程结束：`client-host.js` 的 `Config` 与 `apply()` 里的锚点必须是同一次读取，
 * 否则两次之间文件一变就会被误判成"用户改过"。
 *
 * @returns 六个字段的默认值；preset 读不到时给保守默认。
 */
export function seedConfigDefaults() {
  if (seedCache !== null) return seedCache
  let preset = {}
  try {
    preset = readPresetValues(presetFiles()).values
  } catch {
    preset = {}
  }
  seedCache = {
    notice: true,
    maxAutoContinues: DEFAULT_MAX_AUTO_CONTINUES,
    preemptiveRatio: DEFAULT_PREEMPTIVE_RATIO,
    thresholdRatio: preset.thresholdRatio ?? 0.35,
    retainRatio: preset.retainRatio ?? 0.05,
    bootstrapMaxTokens: preset.bootstrapMaxTokens ?? 16384,
  }
  return seedCache
}

/**
 * 当前 preset 文件里的值 —— 用来判断"本会话是不是还在用旧代际"，也是热同步的目标值。
 *
 * 压缩参数是在**会话建立时**被读进 `compaction-basic` 的（它在构造时 `resolveConfig` 并
 * `deepFreeze`），之后改 preset 只对之后新建的会话生效（`agent-presets` 的 standing mount
 * 按文件戳换代，已加入的会话保留它那一代）。本插件用 {@link currentPresetValues} 读到的新值
 * 热同步进活着的会话，见 `index.js` 的 `syncPresetParams`。
 *
 * 一秒缓存：会话事件里会频繁问到它，而 `discoverPresets()` 要扫目录 —— 缓存把这件事变成
 * 一次比较；写盘成功时立刻失效，所以刚保存的值马上能看到。
 *
 * @returns 文件里的 preset 参数（读不到就是空对象）。
 */
export function currentPresetValues() {
  const now = Date.now()
  if (presetValuesCache !== null && now - presetValuesCache.at < PRESET_VALUES_TTL_MS) {
    return presetValuesCache.values
  }
  let values = {}
  try {
    values = readPresetValues(presetFiles()).values
  } catch {
    values = {}
  }
  presetValuesCache = { at: now, values }
  return values
}

/**
 * 当前 preset 文件里的压缩触发阈值。
 * @returns 文件里的 `thresholdRatio`；读不到时为 null（宁可不报，也不猜）。
 */
export function currentPresetThreshold() {
  const { thresholdRatio } = currentPresetValues()
  return typeof thresholdRatio === 'number' ? thresholdRatio : null
}

/**
 * 登记一个"preset 参数变了"的监听器（设置界面保存时触发）。
 *
 * 用途是热同步：设置卡片把值写进 preset 文件后，活着的会话仍跑着旧代际 —— 本插件借这个回调
 * 把新值直接写进运行中的 `compaction-basic` 配置（见 `index.js`）。注册方是模块顶层的
 * `index.js`，因此一个进程只登记一次。
 *
 * @param listener - 收到新的 preset 参数时调用；抛错不会影响其他监听器。
 */
export function onPresetParamsChanged(listener) {
  presetParamListeners.add(listener)
}

/** 通知所有监听器；单个监听器抛错不影响写入结果，也不影响其他监听器。 */
function notifyPresetParamsChanged(values) {
  for (const listener of presetParamListeners) {
    try {
      listener(values)
    } catch {
      // 监听器自己的问题不该让"保存设置"失败。
    }
  }
}

/**
 * 把 preset 参数写进所有"含对应 row"的 preset 文件。
 *
 * 写前先落一份固定名的备份（`<file>.bak-compact-agents`，只保留最近一次写前的状态），
 * 再用临时文件 + rename 原子替换 —— 设置面板改配置不该有把 preset 写坏的可能。
 *
 * @param values - 要写入的 preset 参数（未包含的键不动）。
 * @param files - 要写的 preset 文件；缺省用 {@link discoverPresets}。
 * @returns 逐个文件的处理结果，供调用方记录。
 */
export function writePresetValues(values, files) {
  const report = []
  for (const file of files ?? presetFiles()) {
    let original
    try {
      original = fs.readFileSync(file, 'utf8')
    } catch (error) {
      report.push({ file, status: 'unreadable', detail: error.message })
      continue
    }
    const lines = original.split('\n')
    const changedKeys = []
    for (const [key, value] of Object.entries(values)) {
      const rowId = PRESET_KEYS[key]
      if (rowId === undefined || value === undefined) continue
      if (readKeyInRow(lines, rowId, key) === undefined && locateRowConfig(lines, rowId) === null) continue
      const [min, max] = PRESET_RANGES[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        report.push({ file, status: 'rejected', detail: `${key}=${value} 超出 ${min}..${max}` })
        continue
      }
      if (setKeyInRow(lines, rowId, key, String(value))) changedKeys.push(key)
    }
    if (changedKeys.length === 0) {
      report.push({ file, status: 'unchanged', detail: '' })
      continue
    }
    const next = lines.join('\n')
    try {
      fs.writeFileSync(`${file}.bak-compact-agents`, original)
      const temporary = `${file}.compact-agents.tmp`
      fs.writeFileSync(temporary, next)
      fs.renameSync(temporary, file)
      report.push({ file, status: 'written', detail: changedKeys.join(', ') })
    } catch (error) {
      report.push({ file, status: 'failed', detail: error.message })
    }
  }
  return report
}

/**
 * 解开 volatile 引用：0.1.7 起 `.volatile()` 字段进 `apply()` 时是 **`Volatile` 对象**
 * （`typeof` 是 `'object'`，真值要 `.get()` 取），不是标量。按标量用它就会静默失效 ——
 * 比较恒"不等"、`typeof === 'number'` 恒 false、落盘永不发生（2026-09-24 实测）。
 *
 * @param value - 行配置里的一个字段值。
 * @returns 真实值；标量字段原样返回。
 */
export function plainValue(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
}

/**
 * 把行配置折成六个标量字段。
 *
 * @param config - 行配置（可能带 `Volatile` 引用，也可能只写了被覆盖的字段）。
 * @returns 只含已知字段的普通对象；缺的字段是 `undefined`（＝没被覆盖）。
 */
export function plainRowConfig(config) {
  const out = {}
  if (config === null || typeof config !== 'object') return out
  for (const key of Object.keys(SETTINGS_FIELDS)) out[key] = plainValue(config[key])
  return out
}

/**
 * 读**当前**行配置 —— 不依赖 `apply()` 重跑。
 *
 * 上游 `601d6761e4` 的 volatile 契约是"就地更新、不重挂插件"
 * （`packages/settings/settings/tests/configuration.spec.ts:9` 原话
 * "updates the real consumer without remounting"），所以 `apply()` 里那次
 * `registerSettings` 拿到的永远是**启动那一刻**的值；设置界面保存后的新值只能现读：
 * `configEditor.entries()` 的 `entry.options.config` 就是宿主落盘的那份行配置（标量）。
 *
 * @param ctx - 带 `configEditor` 服务的上下文；旧版没有该服务时返回 undefined。
 * @returns 六个标量字段；读不到时 undefined。
 */
function readLiveRowConfig(ctx) {
  try {
    const editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined
    if (editor === undefined || typeof editor.entries !== 'function') return undefined
    const entry = editor.entries().find(row => row.options?.id === ENTRY_ID)
    if (entry === undefined) return undefined
    return plainRowConfig(entry.options?.config)
  } catch {
    return undefined
  }
}

/** 已经装过监听的挂载上下文 —— 重复调用不叠加监听。 */
const watchedConfigs = new WeakSet()

/**
 * 盯着行配置的变化，读到新值就再应用一次。
 *
 * 触发点是 DSH 既有的两个事件：`app-boot/config-reload`（每次 profile 补丁 reconcile 之后，
 * 见 packages/boot/app-boot/src/index.ts:298）与 `settings/document-updated`。两者都只是
 * "可能变了"的信号，真正的值现读一次行配置；没变时 {@link applySettings} 自己早退。
 *
 * @param ctx - 挂载上下文。
 * @param anchor - 作文层锚点。
 */
function watchLiveRowConfig(ctx, anchor) {
  if (typeof ctx?.on !== 'function' || watchedConfigs.has(ctx)) return
  watchedConfigs.add(ctx)
  const refresh = () => {
    const live = readLiveRowConfig(ctx)
    if (live === undefined) return
    try {
      applySettings(ctx, live, anchor)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        ctx.logger.warn(`compact-agents: 应用设置变化失败: ${message}`)
      } catch {
        // 桩上下文没有 logger。
      }
    }
  }
  ctx.on('app-boot/config-reload', refresh)
  ctx.on('settings/document-updated', (namespace) => {
    if (namespace === ENTRY_ID || namespace === SETTINGS_NAMESPACE) refresh()
  })
}

/**
 * 把解出来的设置应用到插件：**用户改过的**自身旋钮进 `liveConfig`，preset 参数落盘。
 *
 * "改过"是拿解析结果和作文层比对得出的：相等说明用户没动过这一项，就该让各挂载的行配置
 * 说话（`liveConfig` 保持 null）。
 *
 * @param ctx - registrant context carrying the logger.
 * @param next - 行配置解析后的值。
 * @param anchor - 作文层锚点（{@link seedConfigDefaults} 的结果）；省略时按空对象算。
 */
function applySettings(ctx, next, anchor) {
  const base = anchor ?? {}
  liveConfig.notice = next.notice === base.notice || next.notice === undefined
    ? null
    : next.notice !== false
  liveConfig.maxAutoContinues = next.maxAutoContinues === base.maxAutoContinues
    || typeof next.maxAutoContinues !== 'number'
    ? null
    : next.maxAutoContinues
  liveConfig.preemptiveRatio = next.preemptiveRatio === base.preemptiveRatio
    || typeof next.preemptiveRatio !== 'number'
    ? null
    : next.preemptiveRatio
  // 落盘底数取**文件现值**，不是启动那一刻的 seed：seed 是冻结的，用户把旋钮改回启动时的原值
  // 会被当成"没改过"而静默不写 —— 界面显示回去了、preset（新会话读的那份）却停在旧值。
  // "不覆盖手改 preset" 的防线仍在别处：表单只把**用户真在界面上存过的字段**写进行配置，
  // 没存过的是 undefined，下面那个 typeof 判定直接跳过。
  const baseline = currentPresetValues()
  const wanted = {}
  for (const key of Object.keys(PRESET_KEYS)) {
    if (typeof next[key] === 'number' && next[key] !== baseline[key]) wanted[key] = next[key]
  }
  if (Object.keys(wanted).length === 0) return
  const report = writePresetValues(wanted, presetFiles())
  presetValuesCache = null
  appliedPresetValues = { ...appliedPresetValues, ...wanted }
  for (const entry of report) {
    if (entry.status === 'written') ctx.logger.info(`compact-agents: ${entry.file} <- ${entry.detail}`)
    else if (entry.status === 'failed' || entry.status === 'unreadable' || entry.status === 'rejected') {
      ctx.logger.warn(`compact-agents: preset 写入失败 (${entry.status}): ${entry.file} ${entry.detail}`)
    }
  }
  // 写盘之后立刻广播：活着的会话跑的还是旧代际，`index.js` 靠这个回调把新值热同步进去。
  notifyPresetParamsChanged({ ...appliedPresetValues, ...wanted })
}

/**
 * 应用一次行配置 —— 0.1.7 起这就是设置面的全部。
 *
 * 上游 601d6761e4 删掉了 `SettingsProvider.register()`：设置表单不再由插件往宿主推命名空间，
 * 而是**宿主直接读 entry 自己导出的 `Config`**（`packages/settings/settings/src/index.ts` 的
 * `describe()`：`ns = entry.options.id`、`schema = entry.fiber.runtime.Config`）。于是这里
 * 不再注册任何东西 —— 表单的读写在宿主手里，插件只剩一件事：把行配置同步到它真正生效的地方
 * （自身旋钮进 `liveConfig`，压缩参数落 preset 文件）。
 *
 * 触发时机有两处：① `apply()` 本身（cordis 在 entry 的 config 变化时会 dispose + 重挂，
 * `vendor/cordis/src/fiber.ts` 的 `update()` → `_reload()`）；② 0.1.7 起表单字段是
 * `.volatile()` 的，**保存不重挂插件**（`settings/tests/configuration.spec.ts:9` 原话
 * "updates the real consumer without remounting"），所以新值只能靠
 * {@link watchLiveRowConfig} 订阅事件现读 —— 光等 `apply()` 重跑是等不到的。
 *
 * 一整块「有就用、没有就算了」：没有 logger 的桩上下文、preset 读不到，都只记一条 warn，
 * 绝不让插件挂掉。
 *
 * @param ctx - registrant context carrying the logger.
 * @param config - 行配置；`settings: false` 可关掉整个设置面。
 * @param anchor - 这一行的"作文层"。`liveConfig` 里 null 的含义是"没被覆盖、按各挂载自己的
 *   行配置走"，所以比对基准必须是**本行**配置解析出的值：profile 那一行（`client-host.js`）
 *   没有额外旋钮 —— 它的字段就是表单本身 —— 省略此参即可；preset 行（`index.js`）则传
 *   它自己的行配置，否则某一行设的 `maxAutoContinues: 5` 会被当成全局覆盖、污染其它行。
 * @returns 总是 resolve；任何一步失败都不会 reject。
 */
export function registerSettings(ctx, config, anchor) {
  if (config?.settings === false) return Promise.resolve()
  try {
    const seed = seedConfigDefaults()
    // "上一次"取与 `Config` 默认值同源的那三个 preset 参数：用户没动过的字段必然与它相等，
    // 于是只有真正改过的值才落盘 —— 这是"不覆盖手改 preset"的唯一防线。
    // 它同时是热同步广播的底数（`index.js` 拿它跟运行中会话的实际值比对）。
    const previous = {
      thresholdRatio: seed.thresholdRatio,
      retainRatio: seed.retainRatio,
      bootstrapMaxTokens: seed.bootstrapMaxTokens,
    }
    appliedPresetValues = previous
    applySettings(ctx, plainRowConfig(config), anchor ?? seed)
    // 只有宿主那一行（不传锚点）负责盯变化：preset 行传了锚点，它的行配置是"本代 mount 那一刻
    // 的旋钮"，不该由它改写 liveConfig；而保存后的新值只有宿主那一行读得到。
    if (anchor === undefined) watchLiveRowConfig(ctx, seed)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      ctx.logger.warn(`compact-agents: 应用行配置失败: ${message}`)
    } catch {
      // 连 logger 都没有的桩上下文：没有可报的地方。
    }
  }
  return Promise.resolve()
}

/** 仅供测试：清掉进程级注册状态。 */
export function resetSettingsStateForTest() {
  appliedPresetValues = null
  seedCache = null
  presetValuesCache = null
  liveConfig.notice = null
  liveConfig.maxAutoContinues = null
  liveConfig.preemptiveRatio = null
}
