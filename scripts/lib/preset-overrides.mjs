/**
 * 随包 preset 的整份覆盖：发现、生成、写回。
 *
 * 为什么要有这个模块：ctx.compaction 在 preset 的 compaction realm 内隔离，插件行只能挂进
 * 每份 preset；而 DSH 会随时间新增 preset（0.2.1-alpha.3 新增了 cordis，并把它设成新建会话的
 * 默认预设）。旧版 install 只处理 discoverPresets() 找到的那个 profile 补丁、且只补文件里
 * **第一个** compaction 组，于是新增 preset 不会被覆盖（cordis 就是这么漏的），同一补丁里有
 * 多份 preset 时也只有第一份被补行。这里改成：以 DSH 检出里的随包 preset 为清单，逐份生成/
 * 更新整份覆盖；对用户自建的 preset（profile 里声明、随包里没有的）只补行、不重建 —— 重建会丢定制。
 *
 * 全部是行级文本手术：preset 与 profile 补丁里有大量注释、'!!js' 表达式与排版，反序列化再
 * 序列化会把它们全部毁掉。
 * @module scripts/lib/preset-overrides
 */
import path from 'node:path'
import { listEntries, readText } from './presets.mjs'

/** 随包 preset 的默认阈值（与历史上手工覆盖的取值一致）。 */
export const DEFAULT_THRESHOLD_RATIO = 0.3

/** 随包 preset 的默认保留比例。 */
export const DEFAULT_RETAIN_RATIO = 0.02

/** profile 补丁里"我们生成的注释块"的标记 —— 替换覆盖时据此把注释一起吞掉，避免叠加。 */
const OUR_COMMENT = 'dsh-compact-agents'

/**
 * 随包 preset 里的表达式在 profile 补丁上下文里解析不到 '@deepseek-ai/dsh-agent-preset'：
 * '!!js' 的 baseUrl 是补丁文件自己的目录（此处是 ~/.dsh/profiles/web），而该包只装在 DSH 检出里。
 * 改成从启动入口 process.argv[1] 解析，解析失败只少一个 skill 目录、不炸启动。
 */
const SAFE_SKILLS_EXPR = "(() => { try { return [process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(process.argv[1]).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')] } catch { return [] } })()"

/**
 * 列出 DSH 运行时里所有随包 preset。
 *
 * **两种布局都要认**（这是"升级后自动生效"的关键）：
 * - 源码检出：`<runtime>/packages/bundle/<bundle>/presets/*.patch.yml`；
 * - 打包安装（Electron 桌面版）：`<runtime>/node_modules/@deepseek-ai/dsh-web-app/presets/*.patch.yml`，
 *   而 `<runtime>` 常落在 `resources/app.asar` 内 —— 读盘要用 asar 感知的 {@link readText}。
 *
 * 只认检出的话，桌面版用户的随包清单会来自**另一个 DSH 版本**（本机 dev 检出与打包版
 * 已经漂移：打包版 standard 多一行 `tool-subagent-list-agents`），照它生成的覆盖会把
 * 工具行写坏，而且两份 preset 的 plugin 列表不会再随宿主升级刷新。
 * @param runtime - DSH 运行时根。
 * @returns '{ rowId, name, file, text }' 列表；目录不存在时为空。
 */
export function listShippedPresets(runtime) {
  const dirs = []
  const bundles = path.join(runtime, 'packages', 'bundle')
  for (const entry of listEntries(bundles)) {
    if (entry.directory) dirs.push(path.join(bundles, entry.name, 'presets'))
  }
  dirs.push(path.join(runtime, 'node_modules/@deepseek-ai/dsh-web-app/presets'))
  const found = []
  for (const dir of dirs) {
    for (const entry of listEntries(dir)) {
      if (entry.directory || !entry.name.endsWith('.patch.yml')) continue
      const file = path.join(dir, entry.name)
      let text
      try {
        text = readText(file)
      } catch {
        continue
      }
      const match = /- id: (preset-\S+)/.exec(text)
      if (match === null) continue
      if (found.some(item => item.rowId === match[1])) continue
      found.push({ rowId: match[1], name: match[1].replace(/^preset-/, ''), file, text })
    }
  }
  return found
}

/** 一行的缩进宽度。 */
function indentOf(line) {
  return line.length - line.trimStart().length
}

/**
 * 从随包 preset 文本里取出 'config:' 之下的插件列表，并把 4 个空格的 insert 缩进去掉。
 * @param text - 随包 preset 文件内容。
 * @returns 行数组；结构不认识时为 null。
 */
function configBody(text) {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex(line => /^\s{6}config:$/.test(line))
  if (at < 0) return null
  const body = lines.slice(at + 1).map(line => (line.startsWith('    ') ? line.slice(4) : line))
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  return body
}

/**
 * 在 compaction 组内追加 compact-agents 行（已存在则不动）。
 * @returns 是否改动。
 */
function ensureCompactionRow(body, entry) {
  if (body.some(line => /^\s*- id: compact-agents$/.test(line))) return false
  const group = body.findIndex(line => /^\s*- id: compaction$/.test(line))
  if (group < 0) return false
  // 组的位置有两种缩进（随包覆盖 6 空格、profile 内联声明更深），一律按组自身的缩进算。
  const groupIndent = indentOf(body[group])
  let end = body.length
  for (let i = group + 1; i < body.length; i += 1) {
    const row = /^(\s*)- id: /.exec(body[i])
    if (row !== null && row[1].length <= groupIndent) {
      end = i
      break
    }
  }
  let last = end - 1
  while (last > group && body[last].trim() === '') last -= 1
  const pad = ' '.repeat(groupIndent + 4)
  body.splice(last + 1, 0, pad + '- id: compact-agents', pad + "  name: '" + entry + "'")
  return true
}

/**
 * 给 compaction-basic 补上（或更新）thresholdRatio / retainRatio。
 * @returns 是否改动。
 */
function ensureBasicConfig(body, thresholdRatio, retainRatio) {
  const basic = body.findIndex(line => /^\s*- id: compaction-basic$/.test(line))
  if (basic < 0) return false
  const baseIndent = indentOf(body[basic])
  const keyIndent = ' '.repeat(baseIndent + 2)
  const hasConfig = /^\s*config:$/.test(body[basic + 2] ?? '')
    && indentOf(body[basic + 2]) === baseIndent + 2
  if (!hasConfig) {
    body.splice(basic + 2, 0,
      keyIndent + 'config:',
      keyIndent + '  thresholdRatio: ' + thresholdRatio,
      keyIndent + '  retainRatio: ' + retainRatio,
    )
    return true
  }
  let changed = false
  const pairs = [['thresholdRatio', thresholdRatio], ['retainRatio', retainRatio]]
  for (const pair of pairs) {
    const key = pair[0]
    const value = pair[1]
    const at = body.findIndex((line, index) => index > basic + 2
      && new RegExp('^\\s*' + key + ':').test(line)
      && indentOf(line) === baseIndent + 4)
    if (at < 0) {
      body.splice(basic + 3, 0, keyIndent + '  ' + key + ': ' + value)
      changed = true
    } else if (!body[at].includes(String(value))) {
      body[at] = body[at].replace(/\d+(\.\d+)?/, String(value))
      changed = true
    }
  }
  return changed
}

/**
 * 生成一份 profile 顶层覆盖块。
 * @param preset - listShippedPresets() 的一项。
 * @param options - entry / thresholdRatio / retainRatio / date。
 * @returns 行数组；结构不认识时为 null。
 */
export function buildOverride(preset, options) {
  const body = configBody(preset.text)
  if (body === null) return null
  const unsafe = body.findIndex(line => line.includes('createRequire(baseUrl)'))
  if (unsafe >= 0) {
    body[unsafe] = ' '.repeat(indentOf(body[unsafe])) + '- !!js ' + SAFE_SKILLS_EXPR
  }
  ensureBasicConfig(body, options.thresholdRatio, options.retainRatio)
  ensureCompactionRow(body, options.entry)
  const date = options.date ?? new Date().toLocaleDateString('sv-SE')
  return [
    '# ' + date + ' (dsh-compact-agents): 把本插件装进 DSH 内置 ' + preset.name + ' 预设。',
    '# 由 scripts/install.mjs 按随包 ' + path.basename(preset.file) + ' 生成：整份重述 config，',
    '# 只多两处 —— compaction realm 内的 compact-agents 行、compaction-basic 的阈值。',
    '# DSH 升级后重跑 install 会按新随包内容刷新本块（已有阈值会被保留）。',
    '- id: ' + preset.rowId,
    "  name: '@deepseek-ai/dsh-agent-preset'",
    '  config:',
    ...body,
  ]
}

/**
 * 按缩进把一段行切成插件项（'- id:' 起，到下一个同级或更浅的项）。
 * @param lines - 行。
 * @param indent - 该层级的缩进：plugins 直接子项 6、组内 config 子项 10。
 * @returns '{ id, start, end, lines }' 列表。
 */
function listItems(lines, indent) {
  const items = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)- id: (\S+)$/.exec(lines[i])
    if (match === null || match[1].length !== indent) continue
    let end = lines.length
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = /^(\s*)- id: /.exec(lines[j])
      if (next !== null && next[1].length <= indent) {
        end = j
        break
      }
    }
    items.push({ id: match[2], start: i, end, lines: lines.slice(i, end) })
    i = end - 1
  }
  return items
}

/**
 * 把旧项里多出来的组内子项补进新项（本机在 ptc 的 delegation 组里手工补了
 * tool-ralph / tool-subagent-codex / tool-subagent-claude-code）。
 * @param oldLines - 旧项的行。
 * @param nextLines - 新项的行。
 * @returns 合并后的行。
 */
function mergeItem(oldLines, nextLines) {
  const nextIds = new Set(listItems(nextLines, 10).map(item => item.id))
  const extras = listItems(oldLines, 10).filter(item => !nextIds.has(item.id))
  if (extras.length === 0) return nextLines
  let insertAt = nextLines.length
  while (insertAt > 0 && nextLines[insertAt - 1].trim() === '') insertAt -= 1
  return [
    ...nextLines.slice(0, insertAt),
    ...extras.flatMap(item => item.lines),
    ...nextLines.slice(insertAt),
  ]
}

/**
 * 刷新覆盖块时，保留旧块里有、新块里没有的插件行（两层：plugins 直接子项 + 组内 config 子项）。
 *
 * 为什么：用户会在 preset 里手工补一些随包没有的行。按随包重新生成时若直接丢掉，
 * 等于"升级一次少一批工具"。纯新增是安全的（随包不会因为少一行而失效），
 * 所以这里只做"保留"，绝不删除旧块独有的行。
 * @param oldLines - 旧块。
 * @param nextLines - 新块。
 * @returns 合并后的行。
 */
function mergeExtraRows(oldLines, nextLines) {
  let result = nextLines.slice()
  for (const item of listItems(oldLines, 6)) {
    const target = listItems(result, 6).find(candidate => candidate.id === item.id)
    if (target === undefined) {
      let insertAt = result.length
      while (insertAt > 0 && result[insertAt - 1].trim() === '') insertAt -= 1
      result = [...result.slice(0, insertAt), ...item.lines, ...result.slice(insertAt)]
      continue
    }
    result = [
      ...result.slice(0, target.start),
      ...mergeItem(item.lines, target.lines),
      ...result.slice(target.end),
    ]
  }
  return result
}

/**
 * 找 profile 补丁里某个 preset 的顶层覆盖块。
 * @param lines - 文件行。
 * @param rowId - 'preset-<name>'。
 * @returns '{ start, end }'（end 不含）或 null。
 */
export function findBlock(lines, rowId) {
  const target = new RegExp('^(\\s*)- id: ' + rowId + '$')
  let start = -1
  let baseIndent = 0
  for (let i = 0; i < lines.length; i += 1) {
    const match = target.exec(lines[i])
    if (match === null) continue
    start = i
    baseIndent = match[1].length
    break
  }
  if (start < 0) return null
  // 块结束判据按缩进：同级或更浅的 '- id:' / '- insert:'。顶层覆盖(0)与
  // '- insert:' 里内联声明的 preset(4) 用同一套规则。
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const row = /^(\s*)- id: /.exec(lines[i])
    const insert = /^(\s*)- insert:$/.exec(lines[i])
    const indent = row?.[1].length ?? insert?.[1].length
    if (indent !== undefined && indent <= baseIndent) {
      end = i
      break
    }
  }
  return { start, end }
}

/**
 * 读块内 compaction-basic 的既有阈值（覆盖时保留用户调过的值）。
 * @param lines - 块的行。
 * @returns '{ thresholdRatio, retainRatio }'，读不到时为空对象。
 */
export function extractThresholds(lines) {
  const values = {}
  for (const line of lines) {
    const threshold = /^\s*thresholdRatio:\s*([0-9.]+)\s*(?:#.*)?$/.exec(line)
    if (threshold !== null) values.thresholdRatio = Number(threshold[1])
    const retain = /^\s*retainRatio:\s*([0-9.]+)\s*(?:#.*)?$/.exec(line)
    if (retain !== null) values.retainRatio = Number(retain[1])
  }
  return values
}

/**
 * 比较新旧块是否等价（忽略注释、空行与行尾空格）—— 等价就不写盘，保持幂等。
 */
function sameBlock(oldLines, newLines) {
  const normalize = (lines) => lines
    .filter(line => !line.trimStart().startsWith('#'))
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')
  const a = normalize(oldLines)
  const b = normalize(newLines)
  return a.length === b.length && a.every((line, index) => line === b[index])
}

/**
 * 把已有块（含上方我们生成的注释）换成新块。
 */
function replaceBlock(lines, block, next) {
  let start = block.start
  let probe = start - 1
  while (probe >= 0 && (lines[probe].trim() === '' || lines[probe].startsWith('#'))) {
    if (lines[probe].startsWith('#') && lines[probe].includes(OUR_COMMENT)) {
      let up = probe
      while (up > 0 && lines[up - 1].startsWith('#') && lines[up - 1].includes(OUR_COMMENT)) up -= 1
      start = up
      break
    }
    probe -= 1
  }
  return [...lines.slice(0, start), ...next, ...lines.slice(block.end)]
}

/**
 * 逐份同步随包 preset 覆盖：已有块按需重建，缺的追加到文件末尾。
 * @param text - profile 补丁全文。
 * @param presets - listShippedPresets() 结果。
 * @param options - entry / thresholdRatio / retainRatio / dryRun。
 * @returns '{ text, report }'。
 */
export function syncOverrides(text, presets, options) {
  let lines = text.split(/\r?\n/)
  const report = []
  for (const preset of presets) {
    const existing = findBlock(lines, preset.rowId)
    const kept = existing === null ? {} : extractThresholds(lines.slice(existing.start, existing.end))
    const block = buildOverride(preset, {
      ...options,
      thresholdRatio: kept.thresholdRatio ?? options.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO,
      retainRatio: kept.retainRatio ?? options.retainRatio ?? DEFAULT_RETAIN_RATIO,
    })
    if (block === null) {
      report.push({ name: preset.name, action: 'skip', detail: '结构不认识（没有 6 空格 config: 块）' })
      continue
    }
    if (existing !== null) {
      const oldLines = lines.slice(existing.start, existing.end)
      const merged = mergeExtraRows(oldLines, block)
      if (sameBlock(oldLines, merged)) {
        report.push({ name: preset.name, action: 'ok', detail: '已是最新' })
        continue
      }
      report.push({ name: preset.name, action: 'updated', detail: '按随包内容刷新（保留手工追加的行）' })
      if (options.dryRun !== true) lines = replaceBlock(lines, existing, merged)
      continue
    }
    report.push({ name: preset.name, action: 'added', detail: '此前未覆盖' })
    if (options.dryRun !== true) {
      const tail = lines.length > 0 && lines[lines.length - 1].trim() === '' ? [] : ['']
      lines = [...lines, ...tail, ...block]
    }
  }
  return { text: lines.join('\n'), report }
}

/**
 * 给 profile 里**自建**的 preset（随包清单里没有的）补 compaction 行与阈值。
 *
 * 只做"缺什么补什么"：不重建整份 config —— 那是用户从旧安装迁移来的定制内容，重建会抹掉。
 * @param text - profile 补丁全文。
 * @param shippedNames - 随包 preset 名集合（standard/ptc/minimal/cordis）。
 * @param options - entry / thresholdRatio / retainRatio / dryRun。
 * @returns '{ text, report }'。
 */
export function ensureDeclaredRows(text, shippedNames, options) {
  let lines = text.split(/\r?\n/)
  const report = []
  const targets = []
  for (let i = 0; i < lines.length; i += 1) {
    // preset 声明有两种形态：profile 顶层覆盖(0 缩进)，或 '- insert:' 里内联声明(更深)。
    const match = /^(\s*)- id: (preset-(\S+))$/.exec(lines[i])
    if (match === null || shippedNames.has(match[3])) continue
    targets.push({ rowId: match[2], name: match[3] })
  }
  for (const target of targets) {
    const block = findBlock(lines, target.rowId)
    if (block === null) continue
    const slice = lines.slice(block.start, block.end)
    if (!slice.some(line => /^\s*- id: compaction$/.test(line))) {
      report.push({ name: target.name, action: 'skip', detail: '没有 compaction 组（该 preset 不压缩，正常）' })
      continue
    }
    const hasRow = slice.some(line => /^\s*- id: compact-agents$/.test(line))
    const hasThreshold = slice.some(line => /^\s*thresholdRatio:/.test(line))
    if (hasRow && hasThreshold) {
      report.push({ name: target.name, action: 'ok', detail: '已挂载' })
      continue
    }
    if (options.dryRun === true) {
      report.push({ name: target.name, action: hasRow ? 'updated' : 'added', detail: hasRow ? '补阈值' : '补挂载行' })
      continue
    }
    // 把块内 config 体交回同一套处理函数：块里 '  config:' 之后的相对行。
    const at = slice.findIndex(line => /^\s*config:$/.test(line))
    const body = at < 0 ? slice : slice.slice(at + 1)
    const changedRow = hasRow ? false : ensureCompactionRow(body, options.entry)
    const changedThreshold = hasThreshold ? false : ensureBasicConfig(body, options.thresholdRatio, options.retainRatio)
    if (!changedRow && !changedThreshold) {
      report.push({ name: target.name, action: 'ok', detail: '已挂载' })
      continue
    }
    lines = replaceBlock(lines, block, [...slice.slice(0, at + 1), ...body])
    report.push({ name: target.name, action: 'updated', detail: '补齐挂载行/阈值' })
  }
  return { text: lines.join('\n'), report }
}
