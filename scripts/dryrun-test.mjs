/**
 * `--dry-run` 守卫：卸载脚本的"预演"必须真的只是预演。
 *
 * 为什么专门为这个写一个测试：卸载脚本会删联接、摘 preset 挂载行、从 profile 的
 * `dsh.profile.bundles` 里删登记 —— 而"预演"能不能拦住它们，全靠命令行参数被正确解析。
 * 第一版就出过这个事故：`--profile` 缺席时 `indexOf` 返回 -1、`profileArg + 1` 恰好是 0，
 * 于是第一个参数 `--dry-run` 被当成 profile 的值滤掉，**预演直接变成真的卸载**。
 * 这类 bug 不会报错、只会安静地毁掉安装，所以必须有断言钉住。
 *
 * 全程沙箱：`DSH_HOME` 指向临时目录，脚本碰不到任何真实配置。
 *
 * 运行：node scripts/dryrun-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0

/**
 * 断言一行。
 * @param name - 断言名称。
 * @param ok - 是否通过。
 * @param evidence - 证据文本。
 */
function check(name, ok, evidence = '') {
  if (ok) {
    console.log(`OK   ${name}${evidence === '' ? '' : ` — ${evidence}`}`)
    return
  }
  failed += 1
  console.log(`FAIL ${name}${evidence === '' ? '' : ` — ${evidence}`}`)
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-agents-dryrun-'))
const presetDir = path.join(sandbox, '.agent-presets', 'liangshen')
const profileDir = path.join(sandbox, 'profiles', 'web')
fs.mkdirSync(presetDir, { recursive: true })
fs.mkdirSync(profileDir, { recursive: true })

// 跑**沙箱里的脚本副本**，而不是仓库里的脚本：`PROJECT_ROOT` 由脚本自身位置推出
// （`resolve(dirname(scriptUrl), '..')`），所以副本眼里的"项目根"就是沙箱里的 repo ——
// 卸载脚本要删的那几个 node_modules 联接也就落在沙箱内，碰不到真实安装。
// （第一版直接跑仓库脚本，"真跑"那一轮把仓库自己的三个联接删掉了。）
const repoRoot = path.join(sandbox, 'repo')
fs.cpSync(path.join(PROJECT_ROOT, 'scripts'), path.join(repoRoot, 'scripts'), { recursive: true })
const junctionRoot = path.join(repoRoot, 'node_modules', '@deepseek-ai')
fs.mkdirSync(junctionRoot, { recursive: true })
const projectJunctions = ['dsh-tools', 'cordis', 'schemastery'].map((pkg) => {
  const link = path.join(junctionRoot, pkg)
  fs.symlinkSync(sandbox, link, 'junction')
  return link
})

// 夹具刻意写成"已安装"状态：有挂载行、bundle 清单里有本包。
const presetFile = path.join(presetDir, 'agent.cordis.yml')
fs.writeFileSync(presetFile, [
  '- id: compaction',
  '  name: cordis:group',
  '  config:',
  '    - id: compaction-basic',
  '      name: ./basics.mjs',
  '    - id: compact-agents',
  // 挂载行必须指向**副本的**项目根：`unpatchPreset` 只移除指向本项目的行，
  // 写成真实仓库路径时它会正确地 SKIP（那正是这条断言第一版失败的原因）。
  `      name: '${repoRoot.replace(/\\/g, '/')}/index.js'`,
  '',
].join('\n'))
const profileManifest = path.join(profileDir, 'package.json')
fs.writeFileSync(profileManifest, `${JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dsh: { profile: { bundles: ['dsh-compact-agents', '@deepseek-ai/dsh-base'] } },
}, null, 2)}\n`)

const before = new Map([presetFile, profileManifest].map(file => [file, fs.readFileSync(file, 'utf8')]))

const run = (args) => {
  try {
    const stdout = execFileSync(process.execPath, [path.join(repoRoot, 'scripts/uninstall.mjs'), ...args], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: sandbox, DSH_PROFILE: 'web' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { stdout, status: 0 }
  } catch (error) {
    return { stdout: `${error.stdout ?? ''}${error.stderr ?? ''}`, status: error.status ?? 1 }
  }
}

const preview = run(['--dry-run'])
check('the preview exits cleanly', preview.status === 0, `exit=${preview.status}`)
check('the preview announces itself as a dry run', preview.stdout.includes('mode: dry-run'),
  preview.stdout.split('\n')[0] ?? '')
check('the preview reports what it *would* remove rather than claiming to have removed it',
  preview.stdout.includes('remove') && !preview.stdout.includes('removed'),
  (preview.stdout.split('\n').find(line => line.includes('remove')) ?? '').trim())
check('the preview leaves the preset mount row alone',
  fs.readFileSync(presetFile, 'utf8') === before.get(presetFile))
check('the preview leaves the profile bundle list alone',
  fs.readFileSync(profileManifest, 'utf8') === before.get(profileManifest))
check('no backup files are written by a preview',
  fs.readdirSync(presetDir).length === 1 && fs.readdirSync(profileDir).length === 1,
  fs.readdirSync(profileDir).join(','))
check('the preview leaves the project junctions alone',
  projectJunctions.every(link => fs.existsSync(link)), projectJunctions.length + ' link(s)')

// 反向断言：**真正**执行时必须真的动手，否则上面的"没动"可能只是因为脚本什么都没干。
const applied = run([])
check('a real run exits cleanly', applied.status === 0, `exit=${applied.status}`)
check('a real run announces itself as apply', applied.stdout.includes('mode: apply'))
check('a real run removes the preset mount row',
  !fs.readFileSync(presetFile, 'utf8').includes('compact-agents'))
check('a real run unregisters the profile bundle',
  !JSON.parse(fs.readFileSync(profileManifest, 'utf8')).dsh.profile.bundles.includes('dsh-compact-agents'))
check('a real run keeps a backup of the profile manifest',
  fs.existsSync(`${profileManifest}.bak-compact-agents`))
check('a real run removes the project junctions',
  projectJunctions.every(link => !fs.existsSync(link)), projectJunctions.length + ' link(s)')

// 幂等：再跑一次不该失败（真实卸载常常被重复执行）。
const again = run([])
check('a second real run is idempotent', again.status === 0 && again.stdout.includes('ok'),
  `exit=${again.status}`)

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL OK' : `\n${failed} failure(s)`)
process.exit(failed === 0 ? 0 : 1)
