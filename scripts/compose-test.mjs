/**
 * 组合验证：把本插件挂进**真实的 settings 服务**，并复刻 preset 里 `compaction` 组的隔离语义，
 * 看宿主 half 到底有没有把命名空间注册上。
 *
 * 与 settings-test.mjs 的区别：那个的 settings 服务是桩，只证明"调用参数对"；这里用的是检出里
 * 真的 `FileSettingsProvider`（写到临时文件，**绝不碰真实的 settings.yaml**），所以能证明
 * "在真实服务 + 真实隔离作用域下也注册得上" —— 也就是设置页到底会不会列出这个命名空间。
 *
 * 为什么必须复刻隔离：preset 里那一行长这样
 *   - id: compaction
 *     isolate: { compaction: true, toolResultPruner: true }
 *     config: [ …, compact-agents, … ]
 * 即本插件运行在一个 **isolated realm** 里。cordis 的隔离是按服务名生效的，理论上不该挡住
 * `settings`，但"理论上"不算证据，这个脚本就是来证伪的。
 *
 * 运行：node scripts/compose-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { resolveDshCheckout } from './lib/presets.mjs'
import { resetSettingsStateForTest, setPresetFilesForTest, SETTINGS_NAMESPACE } from '../settings.js'
import * as plugin from '../index.js'

let failed = 0

/**
 * 断言一行。
 * @param name - 断言名称。
 * @param ok - 是否通过。
 * @param evidence - 失败/成功时打印的证据。
 */
function check(name, ok, evidence = '') {
  if (ok) {
    console.log(`OK   ${name}${evidence === '' ? '' : ` — ${evidence}`}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name}${evidence === '' ? '' : ` — ${evidence}`}`)
}

/** 本插件 inject 的三个服务；只做到"能被解析"即可。 */
class StubTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
    /** 注册过的工具。 */
    this.registered = []
  }

  register(tool) {
    this.registered.push(tool)
  }
}

/** `compactNow` 不会被调用，只要服务在场。 */
class StubCompaction extends Service {
  constructor(ctx) {
    super(ctx, 'compaction')
  }
}

/** 会话监听只会用到 `list/roots/get`。 */
class StubAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
  }

  list() {
    return []
  }

  roots() {
    return []
  }
}

const dsh = resolveDshCheckout()
console.log(`DSH checkout: ${dsh}\n`)

// 真实的文件型 settings provider，文件落在临时目录。
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-agents-compose-'))
const settingsFile = path.join(sandbox, 'settings.yaml')
const providerUrl = pathToFileURL(path.join(dsh, 'packages/settings/settings-file/lib/index.js')).href
const { default: FileSettingsProvider } = await import(providerUrl)
check('the real FileSettingsProvider loads from the checkout', typeof FileSettingsProvider === 'function')

// preset 读写也指向临时夹具：本脚本会走真实的 update→watch→写回链路，
// 若不隔离就会**真的改写用户的 preset**（第一版就是这么踩的）。真实值的只读校验交给
// `npm run inspect`（scripts/inspect-presets.mjs）。
const presetFixture = path.join(sandbox, 'agent.cordis.yml')
fs.writeFileSync(presetFixture, [
  '- id: compaction',
  '  name: cordis:group',
  '  config:',
  '    - id: compaction-basic',
  '      name: ./basics.mjs',
  '      config:',
  '        thresholdRatio: 0.2   # 1M 窗口 x 0.2 = 200K 触发压缩',
  '        retainRatio: 0.05     # 压缩后保留最近 5% 窗口',
  '    - id: compact-agents',
  "      name: 'E:/dsh-compact-agents/index.js'",
  '- id: tool-bootstrap',
  '  name: ./tool-bootstrap.mjs',
  '  config:',
  '    bootstrapMaxTokens: 16384',
  '',
].join('\n'))

resetSettingsStateForTest()
setPresetFilesForTest([presetFixture])

const ctx = new Context()
ctx.plugin(FileSettingsProvider, { path: settingsFile, watch: false })
ctx.plugin(StubTools)
ctx.plugin(StubCompaction)
ctx.plugin(StubAgents)
await new Promise(resolve => setTimeout(resolve, 80))

check('the real settings service is up', typeof ctx.get('settings')?.register === 'function',
  ctx.get('settings') === undefined ? 'ctx.get("settings") === undefined' : 'ok')

// 复刻 preset：同一个 label 把两个服务名隔离进同一个 realm，插件挂在这个 realm 里。
const realm = Symbol('compaction-realm')
const isolated = ctx.isolate('compaction', realm).isolate('toolResultPruner', realm)
check('the isolated realm is a distinct context', isolated !== ctx)
// 隔离是按服务名生效的：realm 外的 `compaction` 在 realm 内**看不见**，所以必须在 realm 内提供
// （真实 preset 里是 `compaction-basic` 提供的；本行能跑起来正是因为它待在同一个 realm 里）。
check('the outer compaction service is indeed hidden inside the realm',
  isolated.get('compaction') === undefined,
  isolated.get('compaction') === undefined ? 'hidden as expected' : 'still visible')
isolated.plugin(StubCompaction)
check('settings still resolves inside the isolated realm',
  typeof isolated.get('settings')?.register === 'function',
  isolated.get('settings') === undefined ? 'isolated.get("settings") === undefined' : 'ok')

isolated.plugin(plugin, {})
await new Promise(resolve => setTimeout(resolve, 120))

const described = ctx.get('settings').describe({ redactSecrets: false })
const namespaces = described.map(entry => entry.ns)
console.log(`\n设置页会列出的命名空间: ${namespaces.join(', ')}\n`)

const mine = described.find(entry => entry.ns === SETTINGS_NAMESPACE)
check('the plugin registers its namespace against the real settings service', mine !== undefined,
  namespaces.join(','))
if (mine !== undefined) {
  check('the namespace resolves the preset values as its base layer',
    typeof mine.value.thresholdRatio === 'number' && typeof mine.value.bootstrapMaxTokens === 'number',
    JSON.stringify(mine.value))
  check('the namespace declares its effect timing', mine.applies !== undefined, String(mine.applies))
}

// 用户改一次，验证真的写到了文件（临时文件）里。
if (mine !== undefined) {
  await ctx.get('settings').update(SETTINGS_NAMESPACE, { thresholdRatio: 0.42 })
  const after = fs.readFileSync(settingsFile, 'utf8')
  check('a user update lands in the settings document', after.includes('thresholdRatio'), after.trim().split('\n').slice(-3).join(' | '))
  const again = ctx.get('settings').describe({ redactSecrets: false }).find(entry => entry.ns === SETTINGS_NAMESPACE)
  check('the updated value is what the UI would show', again?.value?.thresholdRatio === 0.42,
    String(again?.value?.thresholdRatio))
}

// 换代复用：同一个进程里再挂一次不应该把注册打崩（真实 register 对重复命名空间会 throw）。
let secondMountError = null
try {
  const secondRealm = ctx.isolate('compaction', Symbol('second-realm')).isolate('toolResultPruner', Symbol('second-realm-2'))
  secondRealm.plugin(plugin, {})
  await new Promise(resolve => setTimeout(resolve, 120))
} catch (error) {
  secondMountError = error
}
check('a second mount (a new preset generation) does not break registration',
  secondMountError === null && ctx.get('settings').describe({ redactSecrets: false })
    .filter(entry => entry.ns === SETTINGS_NAMESPACE).length === 1,
  secondMountError === null ? 'one namespace' : secondMountError.message)

// 宿主组成里的那一行：它可能在 settings 服务就绪**之前**就被 apply（bundle 顺序决定），
// 所以这里刻意先挂它、后挂 settings 服务 —— 正是"设置页什么都没有且毫无报错"的那个坑。
{
  resetSettingsStateForTest()
  const hostCtx = new Context()
  hostCtx.plugin(StubTools)
  const { apply: applyClientHost, inject: clientHostInject, name: clientHostName } = await import('../client-host.js')
  check('the host-side entry needs no services', Array.isArray(clientHostInject) && clientHostInject.length === 0,
    JSON.stringify(clientHostInject))
  check('the host-side entry has its own plugin name', typeof clientHostName === 'string' && clientHostName.length > 0,
    String(clientHostName))
  const pending = applyClientHost(hostCtx, {})
  check('applying before the settings service exists does not throw', pending instanceof Promise)
  await new Promise(resolve => setTimeout(resolve, 60))
  check('nothing is registered while the service is absent',
    hostCtx.get('settings') === undefined,
    String(hostCtx.get('settings')))
  hostCtx.plugin(FileSettingsProvider, { path: path.join(sandbox, 'host-settings.yaml'), watch: false })
  await pending
  await new Promise(resolve => setTimeout(resolve, 60))
  const hostNamespaces = hostCtx.get('settings').describe({ redactSecrets: false }).map(entry => entry.ns)
  check('the namespace registers once the settings service arrives (mount order independent)',
    hostNamespaces.includes(SETTINGS_NAMESPACE), hostNamespaces.join(','))
}

resetSettingsStateForTest()
setPresetFilesForTest(null)

// 宿主组成那一行的**行名形态**：整个发现链上最容易静默失败的一环。
// `ClientModuleRegistry.locatePkgJson()` 先算
//   pathLike = 以 '.' 开头 | 以 'file:' 开头 | 绝对路径
//   expectedPackageName = pathLike ? undefined : exactPackageSpecifier(loaderName)
//   if (!pathLike && expectedPackageName === undefined) return undefined
// 而 exactPackageSpecifier 对含 '/' 的说明符返回 undefined —— 于是子路径行名会在**解析之前**
// 就被判为非客户端行、静默跳过（组成树里那一行还在、--dump-config 看得见，浏览器却什么都没有）。
{
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  // 这里断言的是**不变量本身**（行名必须是裸包名），而不是去 import 那个函数：
  // `packages/client/modules/lib/client.js` 是浏览器侧构建，导入需要整个 window 环境；
  // 规则以源码为准（`src/client/manifest.ts` 的 `exactPackageSpecifier` + `src/index.ts`
  // 的 `locatePkgJson` 开头那三行），下面两条断言正对着它的两个分支。
  const looksPathLike = (name) => name.startsWith('.') || name.startsWith('file:') || path.isAbsolute(name)
  const isSubpath = (name) => name.includes('/') || name.includes(':')

  // 不引 js-yaml（本仓库无依赖，且补丁文件形状固定）：直接读那一行的 name。
  const patchText = fs.readFileSync(path.join(projectRoot, 'cordis.patch.yml'), 'utf8')
  const rowName = /^\s*name:\s*'([^']+)'\s*$/m.exec(patchText)?.[1] ?? ''
  check('the bundle patch has exactly one insert row', (patchText.match(/^\s*name:/gm) ?? []).length === 1,
    JSON.stringify(rowName))
  check('the host row name is not path-like and not a subpath (so locatePkgJson does not bail)',
    rowName !== '' && !looksPathLike(rowName) && !isSubpath(rowName), rowName)
  check('a subpath row name would have been rejected by that gate (the exact bug)',
    isSubpath('dsh-compact-agents/client-host'), 'dsh-compact-agents/client-host')

  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const rootExport = manifest.exports?.['.']
  const rootRel = typeof rootExport === 'string' ? rootExport : rootExport?.default
  const rootEntry = await import(pathToFileURL(path.join(projectRoot, rootRel)).href)
  check('exports["."] is the root-safe entry (no compaction dependency)',
    Array.isArray(rootEntry.inject) && rootEntry.inject.length === 0,
    `${rootRel} inject=${JSON.stringify(rootEntry.inject)}`)
  check('the full plugin stays reachable for the preset row (which needs compaction)',
    Array.isArray(plugin.inject) && plugin.inject.includes('compaction'), JSON.stringify(plugin.inject))
}

// 守卫：本脚本绝不改写真实 preset（第一版正是漏了这条，把 thresholdRatio 写成了 0.42）。
const realPresets = (await import('./lib/presets.mjs')).discoverPresets()
const polluted = realPresets.filter((file) => {
  if (!fs.existsSync(file)) return false
  const text = fs.readFileSync(file, 'utf8')
  const row = /thresholdRatio:\s*([0-9.]+)/.exec(text)
  return row !== null && Number(row[1]) !== 0.2
})
check('the real preset files are left untouched by this test', polluted.length === 0,
  polluted.length === 0 ? `${realPresets.length} file(s) still at 0.2` : polluted.join(', '))

fs.rmSync(sandbox, { recursive: true, force: true })

console.log(failed === 0 ? '\nALL OK' : `\n${failed} failure(s)`)
process.exit(failed === 0 ? 0 : 1)
