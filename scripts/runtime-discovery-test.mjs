/**
 * 运行时根发现的回归测试：打包安装（尤其 macOS）必须能被定位到。
 *
 * 背景（2026-11-23）：mac 用户报"插件不生效"。根因是 `resolveDshRuntime()` 只认
 * 开发检出、PATH 上的 `dsh` 启动器与 `argv[1]` —— 而 macOS 桌面版三样都没有，
 * 于是自愈拿到 `skipped: 找不到 DSH 运行时`，preset 里永远没有 `compact-agents` 行。
 * 修法是把宿主自己 export 的 `DSH_INSTALL_DIR` 与打包安装的固定位置加进种子。
 *
 * 断言：
 * 1. `DSH_INSTALL_DIR` 指向打包布局时，解析到它的根；
 * 2. 它排在 `DSH_HARNESS`/`DSH_CHECKOUT` 之前（前者是正在跑的那套，后者可能是另一代版本）。
 * 全程只在临时目录里造夹具，不碰真实 DSH 安装。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DSH_COMPACT_AGENTS_QUIET = '1'

const { resolveDshRuntime } = await import('./lib/presets.mjs')

/** 造一份"打包安装"夹具：`<root>/node_modules/@deepseek-ai/dsh-web-app/presets/`。 */
function fakePackagedInstall(parent, label) {
  const root = path.join(parent, label)
  const presets = path.join(root, 'node_modules/@deepseek-ai/dsh-web-app/presets')
  fs.mkdirSync(presets, { recursive: true })
  fs.writeFileSync(path.join(presets, 'standard.patch.yml'), '# fixture\n')
  // 宿主 export 的是 dsh 包目录，不是根 —— 让夹具与真实布局同形。
  const installDir = path.join(root, 'node_modules/@deepseek-ai/dsh')
  fs.mkdirSync(installDir, { recursive: true })
  return { root, installDir }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compact-agents-runtime-'))
const saved = { ...process.env }

try {
  const packaged = fakePackagedInstall(sandbox, 'packaged')
  // 另一个"更新的版本"：DSH_HARNESS 指向它，用来验证顺序。
  const other = fakePackagedInstall(sandbox, 'other')

  for (const key of ['DSH_INSTALL_ANCHOR', 'DSH_CHECKOUT', 'DSH_HARNESS']) delete process.env[key]
  // 把 PATH 指空，避免本机真实的 dsh 启动器抢先命中。
  process.env.PATH = ''
  process.env.DSH_INSTALL_DIR = packaged.installDir

  assert.equal(
    resolveDshRuntime(),
    packaged.root,
    'DSH_INSTALL_DIR 必须解析到打包安装的运行时根',
  )
  console.log('ok 1 - DSH_INSTALL_DIR 解析到打包安装根')

  process.env.DSH_HARNESS = other.root
  assert.equal(
    resolveDshRuntime(),
    packaged.root,
    'DSH_INSTALL_DIR（正在跑的安装）必须排在 DSH_HARNESS（可能是另一代版本）之前',
  )
  console.log('ok 2 - DSH_INSTALL_DIR 优先于 DSH_HARNESS')

  delete process.env.DSH_INSTALL_DIR
  delete process.env.DSH_HARNESS
  const failed = (() => {
    try {
      return { value: resolveDshRuntime() }
    } catch (error) {
      return { error }
    }
  })()
  assert.equal(
    failed.error instanceof Error,
    true,
    `所有种子都落空时必须抛出可诊断错误（实际返回了 ${String(failed.value)}）`,
  )
  assert.equal(
    failed.error.message.includes('cannot locate the DSH runtime'),
    true,
    '错误信息里要带修法，否则用户只能看到一句"不生效"',
  )
  console.log('ok 3 - 全落空时抛出可诊断错误')
} finally {
  process.env = saved
  fs.rmSync(sandbox, { recursive: true, force: true })
}

console.log('runtime-discovery-test: all assertions passed')
