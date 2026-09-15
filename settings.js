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
 * - `notice` / `maxAutoContinues` 是**本插件自己**的旋钮 → 存在模块级 `liveConfig` 里，
 *   会话事件的监听器在**事件发生的那一刻**读它，所以改完立即生效。
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

/** 设置界面里的命名空间；浏览器 half 必须用同一个字符串注册卡片。 */
export const SETTINGS_NAMESPACE = 'compact-agents'

/** 命名空间的字段说明（同时是文档与测试的单一来源）。 */
export const SETTINGS_FIELDS = Object.freeze({
  notice: '"是否在对话区播报压缩进度" —— 属于本插件，改完立即生效',
  maxAutoContinues: '"被输出上限截断时自动续写几次" —— 属于本插件，改完立即生效',
  thresholdRatio: '"压缩触发阈值比例"(0.35 = 350K tokens 触发) —— 写进 preset，新会话生效',
  retainRatio: '"压缩后保留比例" —— 写进 preset，新会话生效',
  bootstrapMaxTokens: '"受控阶段的请求输出预算" —— 写进 preset，新会话生效',
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
}

/** 本进程唯一那次注册用的作文层；用来判断某个值到底是不是"用户改过"。 */
let registeredBase = null

/** 进程级唯一的 settings scope；换代时复用它，避免重复注册抛错。 */
let registeredScope = null

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
}

/** `maxAutoContinues` 的默认值：连续截断时最多自动续写两次。 */
export const DEFAULT_MAX_AUTO_CONTINUES = 2

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
 * @returns 行号与该块的缩进；找不到 row 或 row 里没有 `config:` 时为 null。
 */
function locateRowConfig(lines, rowId) {
  const rowPattern = new RegExp(`^(\\s*)-\\s*id:\\s*${rowId}\\s*$`)
  let rowLine = -1
  for (let i = 0; i < lines.length; i += 1) {
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
 * 就地改写一个 row 的 `config` 块里某个键；键不存在时插到 `config:` 的第一行。
 *
 * 只动这一行的**值**，其余文本原样保留 —— 包括行内注释后面的部分、缩进、以及文件其它行。
 * 真实 preset 里阈值后面就跟着一句解释为什么是这个数，那是有价值的信息，不能被改配置抹掉。
 *
 * @param lines - 文件按行切开的结果（**就地修改**）。
 * @param rowId - 目标 row 的 id。
 * @param key - 键名。
 * @param value - 要写入的字面量（已序列化好的 YAML 标量文本）。
 * @returns 是否发生了修改。
 */
export function setKeyInRow(lines, rowId, key, value) {
  const located = locateRowConfig(lines, rowId)
  if (located === null) return false
  const childIndent = ' '.repeat(located.configIndent + 2)
  for (let i = located.configLine + 1; i < located.end; i += 1) {
    const match = /^(\s*)([A-Za-z0-9_-]+):(.*)$/.exec(lines[i])
    if (match === null) continue
    if (match[1].length <= located.configIndent) break
    if (match[2] !== key) continue
    // 保留值后面的原始尾巴：对齐空白 + 行内注释；没有注释时是空串或行尾空白。
    const { tail } = splitScalar(match[3])
    const next = `${match[1]}${key}: ${value}${tail}`
    if (next === lines[i]) return false
    lines[i] = next
    return true
  }
  lines.splice(located.configLine + 1, 0, `${childIndent}${key}: ${value}`)
  return true
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
 * 把解出来的设置应用到插件：**用户改过的**自身旋钮进 `liveConfig`，preset 参数落盘。
 *
 * "改过"是拿解析结果和作文层比对得出的：相等说明用户没动过这一项，就该让各挂载的行配置
 * 说话（`liveConfig` 保持 null）。
 *
 * @param ctx - registrant context carrying the logger.
 * @param next - 命名空间解析后的值。
 * @param previous - 上一次的值；首轮为 undefined（此时不写盘）。
 */
function applySettings(ctx, next, previous) {
  const base = registeredBase ?? {}
  liveConfig.notice = next.notice === base.notice ? null : next.notice !== false
  liveConfig.maxAutoContinues = next.maxAutoContinues === base.maxAutoContinues
    || typeof next.maxAutoContinues !== 'number'
    ? null
    : next.maxAutoContinues
  if (previous === undefined) return
  const wanted = {}
  for (const key of Object.keys(PRESET_KEYS)) {
    if (typeof next[key] === 'number' && next[key] !== previous[key]) wanted[key] = next[key]
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
 * 注册设置命名空间。
 *
 * 一整块都是"有就用、没有就算了"：拿不到 settings 服务（精简上下文、测试桩）、
 * 或者 schemastery 联接没建好（旧安装），都只记一条 warn，绝不让插件挂掉。
 * 身份只注册一次 —— 见模块头"注册为什么是进程级一次"。
 *
 * **服务可能还没就绪**：本包在宿主组成里是一个 bundle 行，它完全可能早于提供 `settings`
 * 的那一层被 apply（compose 顺序由 profile 的 bundles 顺序决定）。所以这里不是"取一次、
 * 取不到就算了"，而是用 `ctx.inject` 等它出现 —— 否则表现就是"设置页里什么都没有"，
 * 且没有任何报错。
 *
 * @param ctx - registrant context carrying the settings service and logger.
 * @param config - 行配置；`settings: false` 可关掉整个设置面。
 * @returns 注册完成后 resolve；任何一步失败都不会 reject。
 */
export function registerSettings(ctx, config) {
  if (config?.settings === false) return Promise.resolve()
  if (registeredScope !== null) {
    // 换代复用：把当前值重新灌进本次挂载的 liveConfig（模块级，其实已经是同一份）。
    if (typeof ctx.get === 'function' && ctx.get('settings') !== undefined) {
      applySettings(ctx, registeredScope.get(), undefined)
    }
    return Promise.resolve()
  }
  // 让 settings 服务到场后再注册；服务被替换时回调会再跑一次，靠上面的缓存幂等。
  if (typeof ctx.inject === 'function') {
    return new Promise((resolve) => {
      ctx.inject(['settings'], (settingsCtx) => {
        void doRegister(settingsCtx, config).then(resolve, resolve)
      })
    })
  }
  return doRegister(ctx, config)
}

/**
 * 真正执行注册；`registerSettings` 负责"什么时候可以注册"。
 * @param ctx - context carrying the settings service and logger.
 * @param config - 行配置。
 * @returns 注册完成后 resolve；失败只记 warn。
 */
async function doRegister(ctx, config) {
  if (registeredScope !== null) return
  if (typeof ctx.get !== 'function') return
  let provider
  try {
    provider = ctx.get('settings')
  } catch {
    return
  }
  if (provider === undefined || typeof provider.register !== 'function') return
  let z
  try {
    ({ default: z } = await import('@deepseek-ai/schemastery'))
  } catch (error) {
    ctx.logger.warn(`compact-agents: 设置面未启用（解析不到 @deepseek-ai/schemastery，重新跑一次安装脚本可修复）: ${error.message}`)
    return
  }
  const { values } = readPresetValues(presetFiles())
  const base = {
    notice: config?.notice !== false,
    maxAutoContinues: resolveMaxAutoContinues(config),
    ...values,
  }
  const schema = z.object({
    notice: z.boolean().default(true),
    maxAutoContinues: z.number().step(1).min(0).max(10).default(2),
    thresholdRatio: z.number().min(0.05).max(0.95).default(0.35),
    retainRatio: z.number().min(0.01).max(0.5).default(0.05),
    bootstrapMaxTokens: z.number().step(1).min(1024).max(200000).default(16384),
  })
  try {
    // base = 作文层：本插件行配置的两个旋钮 + preset 文件里的现值。于是设置界面显示的
    // 就是"真正生效的值"（不是插件凭空给的默认值），而"已覆盖"标记来自 settings 的用户层。
    // applies 取保守的 'restart'：其中三项要等新会话才生效（卡片上逐项说明）。
    registeredScope = provider.register(SETTINGS_NAMESPACE, schema, {
      base,
      applies: 'restart',
    })
  } catch (error) {
    ctx.logger.warn(`compact-agents: 设置命名空间注册失败: ${error.message}`)
    return
  }
  registeredBase = base
  appliedPresetValues = { ...values }
  applySettings(ctx, registeredScope.get(), undefined)
  registeredScope.watch(next => {
    try {
      applySettings(ctx, next, appliedPresetValues ?? undefined)
    } catch (error) {
      ctx.logger.warn(`compact-agents: 应用设置失败: ${error.message}`)
    }
  })
  ctx.logger.info(`compact-agents: 设置面已注册（命名空间 ${SETTINGS_NAMESPACE}，${path.relative(DSH_HOME, presetFiles()[0] ?? '')} 等 preset 可改）`)
}

/** 仅供测试：清掉进程级注册状态。 */
export function resetSettingsStateForTest() {
  registeredScope = null
  registeredBase = null
  appliedPresetValues = null
  presetValuesCache = null
  liveConfig.notice = null
  liveConfig.maxAutoContinues = null
}
