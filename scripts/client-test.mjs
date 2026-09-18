/**
 * 客户端 half（`lib/client.js`）的 Node 层验证。
 *
 * 验的是浏览器里真正会发生的事，而不是"文件存在"：
 *   1. 用假的 `window.__ModuleLoader__` 执行 bundle，拿到它注册的 `{id, factory}`；
 *   2. 用桩 require 调用工厂 —— react 优先用 DSH 检出里**真实可解析**的 react
 *      （探测方式与 validate-presets.mjs 借 js-yaml 相同：createRequire 指向检出里的
 *      package.json），探测不到才退回桩；真实 react-dom/server 可用时再真渲染一次；
 *   3. 断言工厂形状、cordis `apply`/`inject`、命名空间绑定、slot 注册键、注入面动作；
 *   4. 断言卡片在"未就绪"与"就绪"两种状态下都能渲染：未就绪只留一句提示；就绪默认收起、
 *      展开后五个字段的中文标签与两组生效时机题注都在、两个枚举字段是下拉框；
 *      并且 save/reset 真的调到了 scope 的 set/unset。
 *
 * 卡片默认收起，而服务端渲染没有点击可点，所以展开态由 `renderOpen()` 打开组件接受的
 * `initiallyOpen`（不传它的那次渲染断言的正是"默认收起"）。"保存成功后自动收起"由
 * `useEffect` 驱动，服务端渲染不会跑 effect，故不在本文件覆盖。
 *
 * 运行：node scripts/client-test.mjs [--dsh <checkout>]
 * @module scripts/client-test
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { PROJECT_ROOT, resolveDshCheckout } from './lib/presets.mjs'

let failed = 0

/**
 * 一条断言。
 * @param label - 断言描述。
 * @param ok - 是否为真。
 * @param extra - 证据（失败时最有用）。
 */
function check(label, ok, extra = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra === '' ? '' : ` — ${extra}`}`)
  if (!ok) failed += 1
}

/** 平台种子模块白名单（packages/client/web/src/seed.ts）——bundle 只准 require 这些。 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
]

// ---------------------------------------------------------------------------
// 0. 借 DSH 检出：只为拿"真实可解析的 react"，拿不到就退桩。
// ---------------------------------------------------------------------------
const dshFlag = process.argv.indexOf('--dsh')
let checkout
try {
  checkout = resolveDshCheckout(dshFlag === -1 ? undefined : process.argv[dshFlag + 1])
} catch (error) {
  checkout = undefined
  console.log(`note: DSH checkout not found (${error.message.split('\n')[0]}) — falling back to stubs`)
}
console.log(`DSH checkout: ${checkout ?? '(none)'}`)

// 检出根的 node_modules 只有 @deepseek-ai/*，react 由 pnpm 隔离在包级 node_modules 里，
// 所以按"锚点"逐个试：根 → web 应用 → 客户端包 → 商店包。
const REQUIRE_ANCHORS = [
  'package.json',
  'apps/web/package.json',
  'packages/client/web/package.json',
  'packages/client/store/package.json',
]

/**
 * 从检出里真解析一个模块（自描述：只用检出根 + 包内相对路径）。
 * @param specifier - 模块名。
 * @returns `{module, anchor}`，解析不到则为 undefined。
 */
function probe(specifier) {
  if (checkout === undefined) return undefined
  for (const anchor of REQUIRE_ANCHORS) {
    try {
      return { module: createRequire(path.join(checkout, anchor))(specifier), anchor }
    } catch {
      // 换下一个锚点。
    }
  }
  return undefined
}

const realProbe = {
  react: probe('react'),
  server: probe('react-dom/server'),
  store: probe('@deepseek-ai/dsh-client-store'),
  // ui-primitives 的产物是 ESM + CSS 模块，Node 侧 require 多半解析不了（未知扩展名 .css）；
  // 解析不到就用桩，桩提供 bundle 真正用到的那两个原子（Tag / IconChevronDownOutline14）。
  primitives: probe('@deepseek-ai/dsh-client-ui-primitives'),
}
// CLIENT_TEST_STUBS=1 强制走桩分支，用来验证"拿不到真 react 时断言元素树"这条路。
const forceStubs = process.env.CLIENT_TEST_STUBS === '1'
const realReact = forceStubs ? undefined : realProbe.react
const realServer = forceStubs ? undefined : realProbe.server
const realStore = forceStubs ? undefined : realProbe.store
const realPrimitives = forceStubs ? undefined : realProbe.primitives
if (forceStubs) console.log('note: CLIENT_TEST_STUBS=1 — forcing the stub branch')
console.log(`react          : ${realReact === undefined ? 'stub' : `real ${realReact.module.version} (${realReact.anchor})`}`)
console.log(`react-dom/server: ${realServer === undefined ? 'stub' : `real (${realServer.anchor})`}`)
console.log(`client-store   : ${realStore === undefined ? 'stub' : `real (${realStore.anchor})`}`)
console.log(`ui-primitives  : ${realPrimitives === undefined ? 'stub' : `real (${realPrimitives.anchor})`}`)
console.log('')

// ---------------------------------------------------------------------------
// 1. 加载 bundle：假 window，Node 下没有 document。
// ---------------------------------------------------------------------------
let registration
const fakeWindow = {
  __ModuleLoader__: {
    load(record) {
      if (registration !== undefined) throw new Error('client-test: bundle registered twice')
      registration = record
    },
  },
}
const bundleSource = fs.readFileSync(path.join(PROJECT_ROOT, 'lib', 'client.js'), 'utf8')
new Function('window', bundleSource)(fakeWindow)

check('bundle executes and registers exactly one factory', registration !== undefined)
check('registration id is the package name', registration?.id === 'dsh-compact-agents', String(registration?.id))
check('registration is { id, factory }', typeof registration?.factory === 'function')

// ---------------------------------------------------------------------------
// 2. 桩 require 表。
// ---------------------------------------------------------------------------
const requireCalls = []

/** 兜底 React：createElement 造可遍历的元素树；三个 hook 是无状态实现（静态断言够用）。 */
const reactStub = {
  version: 'stub',
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  // 卡片用 useState/useRef/useEffect 管"点开/收起"与"保存成功后收起"。桩不需要记住它们：
  // 桩分支里组件是被直接调用的，每次渲染都是一次干净调用，元素树断言只看初值。
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useRef(initial) { return { current: initial } },
  useEffect() {},
}

/** 本次实际使用的 React 实现 —— 桩原子的元素必须由同一个实现造出来。 */
const reactImpl = realReact?.module ?? reactStub

/**
 * 兜底 ui-primitives：只提供 bundle 用到的那两个原子，形状与官方一致
 * （Tag 渲染一枚带 data-tone 的 span，箭头渲染一个 svg）。
 */
const primitivesStub = {
  Tag: props => reactImpl.createElement(
    'span',
    { className: props.className, 'data-tone': props.tone ?? 'outline' },
    props.children,
  ),
  IconChevronDownOutline14: props => reactImpl.createElement('svg', { className: props.className, 'aria-hidden': 'true' }),
}

/** 兜底快照 store：语义与真的一致（getSnapshot 立即可见 / set 后通知订阅者）。 */
function createStoreStub(init) {
  let state = init
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    set(next) {
      state = next
      for (const listener of [...listeners]) listener()
    },
    update(mutator) {
      const draft = structuredClone(state)
      mutator(draft)
      state = draft
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const modules = new Map([
  ['react', reactImpl],
  ['@deepseek-ai/dsh-client-store',
    realStore?.module ?? { createSnapshotStore: createStoreStub }],
  ['@deepseek-ai/dsh-client-ui-primitives', realPrimitives?.module ?? primitivesStub],
  ['@deepseek-ai/dsh-client-ui-slots', { resolveSlotLabel: label => (typeof label === 'string' ? label : undefined) }],
  ['@deepseek-ai/dsh-client-ui-settings', {}],
])

/** 浏览器里的 `require`：未声明的模块必须显形，而不是静默给 undefined。 */
function stubRequire(id) {
  requireCalls.push(id)
  if (!modules.has(id)) throw new Error(`client-test: unexpected require("${id}")`)
  return modules.get(id)
}

const bundleExports = registration.factory(stubRequire)

check('factory exports a cordis apply()', typeof bundleExports.apply === 'function')
check('factory exports an inject list', Array.isArray(bundleExports.inject), JSON.stringify(bundleExports.inject))
check('inject declares settingsScope and slots',
  bundleExports.inject.includes('settingsScope') && bundleExports.inject.includes('slots'),
  JSON.stringify(bundleExports.inject))
check('bundle only requires platform seed modules (no dsh.client.external needed)',
  requireCalls.length > 0 && requireCalls.every(id => PLATFORM_MODULES.includes(id)),
  requireCalls.join(', '))
check('bundle requires react + client-store only',
  requireCalls.includes('react') && requireCalls.includes('@deepseek-ai/dsh-client-store'),
  requireCalls.join(', '))
check('bundle requires the ui-primitives seed module for Tag + chevron',
  requireCalls.includes('@deepseek-ai/dsh-client-ui-primitives'), requireCalls.join(', '))

// ---------------------------------------------------------------------------
// 3. 桩 ctx：真跑 apply，看它绑了哪个命名空间、往哪个 slot 注册了什么。
// ---------------------------------------------------------------------------
const SECTION = { notice: true, maxAutoContinues: 2, thresholdRatio: 0.2, retainRatio: 0.05, bootstrapMaxTokens: 4096 }

/** 一个真会记账的 settings scope 桩：set/unset 会改自己的 user 层并通知订阅者。 */
function createScopeStub(section) {
  let snapshot = {
    status: 'ready',
    value: { ...section },
    base: { ...section },
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const listeners = new Set()
  const calls = []
  const emit = () => { for (const listener of [...listeners]) listener() }
  const writeSet = async (field, value) => {
    calls.push({ op: 'set', field, value })
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      user: { ...(snapshot.user ?? {}), [field]: value },
      value: { ...snapshot.value, [field]: value },
    }
    emit()
  }
  const scope = {
    calls,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: writeSet,
    async unset(field) {
      calls.push({ op: 'unset', field })
      const user = { ...(snapshot.user ?? {}) }
      delete user[field]
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        user: Object.keys(user).length === 0 ? undefined : user,
        value: { ...snapshot.value, [field]: snapshot.base?.[field] },
      }
      emit()
    },
    async mutate() {},
    setStatus(status) {
      snapshot = { ...snapshot, status }
      emit()
    },
    setWritable(writable) {
      snapshot = { ...snapshot, writable }
      emit()
    },
    breakWrites() {
      scope.set = async () => { throw new Error('client-test: injected write failure') }
    },
    restoreWrites() {
      scope.set = writeSet
    },
  }
  return scope
}

const scope = createScopeStub(SECTION)
const boundSpecs = []
const injectCalls = []
const registrations = []
const effects = []
const ctx = {
  settingsScope: {
    bind(spec) {
      boundSpecs.push(spec)
      return scope
    },
  },
  slots: {
    inject(name, contribute) {
      injectCalls.push(name)
      return contribute()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  effect(factory, label) {
    effects.push(label)
    return factory()
  },
}

bundleExports.apply(ctx)

check('apply binds the compact-agents settings namespace',
  boundSpecs.length === 1 && boundSpecs[0].namespace === 'compact-agents',
  JSON.stringify(boundSpecs.map(spec => spec.namespace)))
/** 按槽位名找一条注册（两个宿主各一条）。 */
const regBySlot = name => registrations.find(entry => entry.options?.name === name)
const cardReg = regBySlot('settings.plugin.item')
const panelReg = regBySlot('plugins.bundle.config')
check('apply subscribes to both hosts (old settings page + new Plugins page)',
  injectCalls.includes('settings.plugin.item') && injectCalls.includes('plugins.bundle.config'),
  injectCalls.join(', '))
check('老设置页：注册键是 settings 命名空间（字段名是 "key"，不是 "entryKey"）',
  cardReg?.options?.key === 'compact-agents' && !('entryKey' in (cardReg?.options ?? {})),
  JSON.stringify(cardReg?.options))
check('新插件页：槽位是 plugins.bundle.config，注册键是包名',
  panelReg?.options?.key === 'dsh-compact-agents', JSON.stringify(panelReg?.options))
check('both hosts receive a component function',
  typeof cardReg?.component === 'function' && typeof panelReg?.component === 'function')

const face = cardReg.options.inject()
const panelFace = panelReg.options.inject()
check('inject face carries actions edit/resetField/save/discard',
  ['edit', 'resetField', 'save', 'discard'].every(name => typeof face[name] === 'function'),
  Object.keys(face).join(', '))
check('inject face carries a snapshot store under hooks.compactAgentsCard',
  typeof face.hooks?.compactAgentsCard?.getSnapshot === 'function'
  && typeof face.hooks?.compactAgentsCard?.subscribe === 'function')

// ---------------------------------------------------------------------------
// 4. 渲染：注入面折成渲染器会给的 props（hooks → useCompactAgentsCard）。
// ---------------------------------------------------------------------------
const cardComponent = cardReg.component
/** 新插件页的组件：只渲染表单主体，不许自带卡片外壳（页自己画标题与面包屑）。 */
const panelComponent = panelReg.component

/**
 * 把注入面折成组件 props，等价于渲染器的绑定。
 * @param injectedFace - `options.inject()` 的返回值。
 * @returns 组件 props。
 */
function faceView(injectedFace) {
  const { hooks, ...actions } = injectedFace
  return {
    ...actions,
    useCompactAgentsCard: selector => selector(hooks.compactAgentsCard.getSnapshot()),
  }
}

/**
 * 渲染一次卡片。
 *
 * 有真 react + react-dom 时用 renderToStaticMarkup 渲染真 HTML；否则退回元素树：
 * 直接调用组件函数拿它返回的元素（桩 React 不会自己求值函数组件，遍历
 * `createElement(cardComponent, …)` 只会得到一个空壳）。
 * @param props - 组件 props。
 * @returns `{markup, element}`；markup 仅有真 react-dom 时才有值。
 */
function render(props) {
  if (realReact !== undefined && realServer !== undefined) {
    const element = realReact.module.createElement(cardComponent, props)
    return { markup: realServer.module.renderToStaticMarkup(element), element }
  }
  return { markup: undefined, element: cardComponent(props) }
}

/**
 * 像用户点开卡片那样渲染展开态。
 *
 * 卡片默认收起（与官方 PluginCard 一致），而服务端渲染没有点击可点，所以直接把组件接受的
 * `initiallyOpen` 打开 —— 展开后就是用户在浏览器里看到的那棵树。反过来说，不开这个开关的
 * `render(faceView(face))` 断言的就是"默认收起"。
 * @param injectedFace - `options.inject()` 的返回值。
 * @returns `{markup, element}`。
 */
function renderOpen(injectedFace) {
  return render({ ...faceView(injectedFace), initiallyOpen: true })
}

/**
 * 深度收集元素树里的文本。
 * @param node - React 元素 / 字符串 / 数组。
 * @param out - 累加器。
 * @returns 文本片段列表。
 */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && node.props !== undefined) collectText(node.props.children, out)
  return out
}

/**
 * 元素树里所有控件（input / select）的记录（markup 不可用时用它们做断言）。
 * 每条是控件自己的 props 加上 `tag`（元素名），因为 `<select>` 没有 type 属性可看。
 * @param node - React 元素 / 字符串 / 数组。
 * @param out - 累加器。
 * @returns `{...props, tag}` 列表。
 */
function collectControls(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectControls(child, out)
    return out
  }
  if (node.type === 'input' || node.type === 'select') out.push({ ...node.props, tag: node.type })
  collectControls(node.props?.children, out)
  return out
}

/**
 * 文本证据：有 markup 用 markup，否则用元素树。
 * @param rendered - render() 的结果。
 * @returns 可搜索的字符串。
 */
function textOf(rendered) {
  return rendered.markup ?? collectText(rendered.element).join('|')
}

// 4a. 未就绪：只显示提示，绝不抛错。
for (const status of ['loading', 'unavailable', 'weird']) {
  scope.setStatus(status)
  let threw
  let rendered
  try {
    rendered = render(faceView(face))
  } catch (error) {
    threw = error
  }
  check(`status=${status} renders without throwing and says 设置尚未就绪`,
    threw === undefined && textOf(rendered ?? { markup: '' }).includes('设置尚未就绪'),
    threw === undefined ? '' : String(threw))
}

// 4b. 组件在"没有 props / 没有 hook"时也不能崩（真渲染器下这就是一次真实渲染）。
try {
  const bare = render({})
  check('component renders with empty props (no crash, says 设置尚未就绪)',
    textOf(bare).includes('设置尚未就绪'))
} catch (error) {
  check('component renders with empty props (no crash, says 设置尚未就绪)', false, String(error))
}

// 4c. 就绪：默认只渲染折叠的头部；展开后五个字段、时机分组、保存/放弃都在。
scope.setStatus('ready')
const LABELS = ['压缩提示播报', '自动续写次数上限', '压缩触发阈值比例', '压缩后保留比例', '受控阶段输出预算']
const collapsed = render(faceView(face))
const collapsedText = textOf(collapsed)
check('ready card starts collapsed: header only, no field rows',
  collapsedText.includes('压缩与自动续写') && !LABELS.some(label => collapsedText.includes(label)),
  collapsedText.replace(/\s+/g, ' ').slice(0, 140))
const ready = renderOpen(face)
const readyText = textOf(ready)
const missing = LABELS.filter(label => !readyText.includes(label))
check('expanded card shows all five field labels', missing.length === 0, `missing: ${missing.join(', ')}`)
check('expanded card groups the fields by when they take effect (one caption per group)',
  (readyText.match(/立即生效/g) ?? []).length === 1
  && (readyText.match(/写入预设并热同步/g) ?? []).length === 1
  && (readyText.match(/新建会话生效/g) ?? []).length === 1,
  `立即生效 x${(readyText.match(/立即生效/g) ?? []).length} / 热同步 x${(readyText.match(/写入预设并热同步/g) ?? []).length} / 新建会话生效 x${(readyText.match(/新建会话生效/g) ?? []).length}`)
check('expanded card renders 保存 / 放弃修改', readyText.includes('保存') && readyText.includes('放弃修改'))
const readyControls = collectControls(ready.element)
check('enum fields render as selects (notice + maxAutoContinues)',
  ready.markup === undefined
    ? readyControls.filter(control => control.tag === 'select').length === 2
    : (ready.markup.match(/<select/g) ?? []).length === 2,
  ready.markup === undefined ? 'element tree' : `markup: ${(ready.markup.match(/<select/g) ?? []).length} select(s)`)
check('drafts are seeded from the effective section rows (0.2 in a text box, 2 in a select)',
  ready.markup !== undefined
    ? ready.markup.includes('value="0.2"') && /value="2"[^>]*selected/.test(ready.markup)
    : readyControls.some(control => control.value === '0.2') && readyControls.some(control => control.value === '2'),
  ready.markup === undefined ? 'element tree' : 'static markup')

// 4d. 非法草稿：卡片报错并阻止保存。
face.edit('thresholdRatio', '9')
const invalidState = face.hooks.compactAgentsCard.getSnapshot()
check('out-of-range draft marks the field invalid and blocks saving',
  invalidState.invalid === true && invalidState.fields.thresholdRatio.invalid === true
  && invalidState.dirty === true,
  JSON.stringify(invalidState.fields.thresholdRatio))
const invalidRendered = renderOpen(face)
check('invalid draft renders a Chinese error line and disables 保存',
  textOf(invalidRendered).includes('取值不合法')
  || textOf(invalidRendered).includes('已阻止保存'),
  realReact === undefined ? 'element tree' : 'static markup')
const callsBefore = scope.calls.length
await face.save()
check('save refuses while a draft is invalid', scope.calls.length === callsBefore,
  `${scope.calls.length - callsBefore} write(s)`)
face.discard()
check('discard drops the staged edit', face.hooks.compactAgentsCard.getSnapshot().dirty === false)

// 4e. 保存：写真的落到 scope.set，并回读进快照。
face.edit('maxAutoContinues', '5')
const dirtyState = face.hooks.compactAgentsCard.getSnapshot()
check('edit stages a draft (dirty, not yet written)',
  dirtyState.dirty === true && dirtyState.fields.maxAutoContinues.text === '5'
  && scope.calls.length === callsBefore,
  JSON.stringify(dirtyState.fields.maxAutoContinues))
const dirtyRendered = render(faceView(face))
check('a card holding unstaged edits says 未保存 on its header (visible while collapsed)',
  textOf(dirtyRendered).includes('未保存')
  && !LABELS.some(label => textOf(dirtyRendered).includes(label)),
  textOf(dirtyRendered).replace(/\s+/g, ' ').slice(0, 140))
await face.save()
check('save writes the staged value through scope.set',
  scope.calls.some(call => call.op === 'set' && call.field === 'maxAutoContinues' && call.value === 5),
  JSON.stringify(scope.calls.at(-1)))
const savedState = face.hooks.compactAgentsCard.getSnapshot()
check('after save the draft is re-seeded and clean',
  savedState.dirty === false && savedState.saving === false && savedState.failed === false
  && savedState.fields.maxAutoContinues.text === '5',
  JSON.stringify(savedState.fields.maxAutoContinues))
check('a user-layer entry marks the field overridden',
  savedState.fields.maxAutoContinues.overridden === true)
const overriddenRendered = renderOpen(face)
const overriddenText = textOf(overriddenRendered)
const resetCount = (overriddenText.match(/重置/g) ?? []).length
check('overridden field offers 重置', resetCount === 1, `${resetCount} reset control(s)`)

// 4f. 重置：先暂存清除，保存时调 scope.unset 回到未覆盖状态。
face.resetField('maxAutoContinues')
check('resetField stages a clear (still dirty before save)',
  face.hooks.compactAgentsCard.getSnapshot().dirty === true)
await face.save()
check('save applies the clear through scope.unset',
  scope.calls.some(call => call.op === 'unset' && call.field === 'maxAutoContinues'),
  JSON.stringify(scope.calls.at(-1)))
const resetState = face.hooks.compactAgentsCard.getSnapshot()
check('after reset the field is no longer overridden',
  resetState.fields.maxAutoContinues.overridden === false
  && resetState.fields.maxAutoContinues.text === '2',
  JSON.stringify(resetState.fields.maxAutoContinues))

// 4g. 写失败：标 failed、保住草稿、不抛。
scope.breakWrites()
face.edit('notice', 'false')
let writeThrew
try {
  await face.save()
} catch (error) {
  writeThrew = error
}
const failedState = face.hooks.compactAgentsCard.getSnapshot()
check('a rejected write marks failed instead of throwing',
  writeThrew === undefined && failedState.failed === true && failedState.dirty === true,
  JSON.stringify({ failed: failedState.failed, dirty: failedState.dirty }))
const failedRendered = renderOpen(face)
check('failed save renders the Chinese failure line',
  textOf(failedRendered).includes('保存未生效'))
face.discard()
scope.restoreWrites()

// 4h. 只读文档：控件禁用而不是消失。
scope.setWritable(false)
const readonlyRendered = renderOpen(face)
const readonlyState = face.hooks.compactAgentsCard.getSnapshot()
check('read-only document still renders the five labels',
  LABELS.every(label => textOf(readonlyRendered).includes(label)))
check('read-only document reports writable=false and disables the controls',
  readonlyState.writable === false
  && (readonlyRendered.markup === undefined
    || readonlyRendered.markup.includes('disabled')),
  String(readonlyState.writable))
scope.setWritable(true)

// 4i. effect 注册了释放回调（HMR / 卸载时解订阅）。
check('apply registers a disposer through ctx.effect',
  effects.length === 1 && typeof effects[0] === 'string', effects.join(', '))

// ---------------------------------------------------------------------------
// 5. 新插件页（侧栏「插件」）那份表单：同一份正文，但不许自带卡片外壳。
//    上游 90af3110b7 把插件配置搬到插件页后，老槽位没有任何渲染方 —— 只注册老槽位
//    就是"卡片凭空消失且毫无报错"。这一节锁住新槽位的形状。
// ---------------------------------------------------------------------------
/**
 * 渲染新插件页里的表单。
 * @param props - 面板 props（`view` + 注入面）。
 * @returns `{markup, element}`。
 */
function renderPanel(props) {
  if (realReact !== undefined && realServer !== undefined) {
    const element = realReact.module.createElement(panelComponent, props)
    return { markup: realServer.module.renderToStaticMarkup(element), element }
  }
  return { markup: undefined, element: panelComponent(props) }
}

/**
 * 深度收集元素树里的 className。
 * @param node - React 元素 / 字符串 / 数组。
 * @param out - 累加器。
 * @returns className 列表。
 */
function collectClasses(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectClasses(child, out)
    return out
  }
  if (typeof node.props?.className === 'string') out.push(node.props.className)
  collectClasses(node.props?.children, out)
  return out
}

const panelText = rendered => textOf(rendered)
const panelMarkupOrClasses = rendered => rendered.markup ?? collectClasses(rendered.element).join(' ')

const panelReady = renderPanel({ ...faceView(panelFace), view: 'page' })
check('插件页表单：五个字段、两组时机题注与保存/放弃都在',
  LABELS.every(label => panelText(panelReady).includes(label))
  && panelText(panelReady).includes('保存') && panelText(panelReady).includes('放弃修改'),
  panelText(panelReady).replace(/\s+/g, ' ').slice(0, 160))
check('插件页表单：不画自己的卡片外壳（没有 dsh-ca-card / dsh-ca-header / 箭头）',
  !panelMarkupOrClasses(panelReady).includes('dsh-ca-card')
  && !panelMarkupOrClasses(panelReady).includes('dsh-ca-header')
  && !panelMarkupOrClasses(panelReady).includes('dsh-ca-chevron'),
  panelMarkupOrClasses(panelReady).slice(0, 160))
check('插件页表单：正文容器是 dsh-ca-page',
  panelMarkupOrClasses(panelReady).includes('dsh-ca-page'))
const panelControls = collectControls(panelReady.element)
check('插件页表单：两个枚举字段仍是下拉框',
  panelReady.markup === undefined
    ? panelControls.filter(control => control.tag === 'select').length === 2
    : (panelReady.markup.match(/<select/g) ?? []).length === 2)
check('插件页表单：与卡片共用同一个控制器（改一处两端一致）',
  panelFace.hooks?.compactAgentsCard === face.hooks?.compactAgentsCard)

const panelSummary = renderPanel({ ...faceView(panelFace), view: 'summary' })
check('插件页列表项要一行摘要时给出一行（触发阈值 + 保留比例）',
  panelText(panelSummary).includes('压缩触发阈值比例')
  && panelText(panelSummary).includes('压缩后保留比例')
  && !panelText(panelSummary).includes('放弃修改'),
  panelText(panelSummary).replace(/\s+/g, ' ').slice(0, 120))

scope.setStatus('loading')
const panelPending = renderPanel({ ...faceView(panelFace), view: 'page' })
check('插件页表单：命名空间未就绪时只留一句提示，不抛异常',
  panelText(panelPending).includes('设置尚未就绪'))
scope.setStatus('ready')

// 5b. 一个槽位注册失败不能连累另一个（重复注册会抛，版本差异也可能抛）。
const warnings = []
const originalWarn = console.warn
console.warn = message => { warnings.push(String(message)) }
try {
  const isolate = (failingSlot) => {
    const fresh = registration.factory(stubRequire)
    const seen = []
    fresh.apply({
      settingsScope: { bind: () => scope },
      slots: {
        inject(name, contribute) { return contribute() },
        register(options) {
          if (options.name === failingSlot) throw new Error('client-test: injected slot failure')
          seen.push(options.name)
          return () => {}
        },
      },
      effect: factory => factory(),
    })
    return seen
  }
  const withoutPanel = isolate('plugins.bundle.config')
  check('新槽位注册失败时，老设置页那张卡仍然注册上',
    withoutPanel.includes('settings.plugin.item') && warnings.length > 0,
    `${withoutPanel.join(', ')} | warn: ${warnings[0] ?? '(none)'}`)
  const withoutCard = isolate('settings.plugin.item')
  check('老槽位注册失败时，插件页那份表单仍然注册上',
    withoutCard.includes('plugins.bundle.config'),
    withoutCard.join(', '))
} finally {
  console.warn = originalWarn
}

console.log(failed === 0 ? '\nALL OK' : `\n${failed} failure(s)`)
process.exit(failed === 0 ? 0 : 1)
