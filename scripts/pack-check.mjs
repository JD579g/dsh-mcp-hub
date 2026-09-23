#!/usr/bin/env node
/**
 * dsh-mcp-hub · 发布包自检（npm pack 之后到底能不能装）
 *
 * Windows 开发者拿到的就是这个 tarball，所以「装完能不能跑」必须在打包这一层
 * 就被证明，而不是等到用户机器上才炸。这个脚本做三件事：
 *   1) npm pack 出真实 tarball；
 *   2) 校验 tarball 里必须有那些文件（package.json 的 files 字段漏一个就失败）；
 *   3) 把 tarball 解到临时目录，用 node **从解出来的那个副本**跑一遍内置服务
 *      清单与插件入口 import —— 验证的是发布物，不是当前工作区。
 *
 * 用法：node scripts/pack-check.mjs [--keep]
 * 退出码：0 通过，1 失败。
 */

import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const KEEP = process.argv.includes('--keep')

const REQUIRED = [
  'package/package.json',
  'package/lib/index.js',
  'package/lib/platform.js',
  'package/lib/client.js',
  'package/lib/host/runner.js',
  'package/lib/host/doctor.js',
  'package/lib/host/capabilities.js',
  'package/lib/host/state.js',
  'package/lib/host/http-api.js',
  'package/lib/host/terminal.js',
  'package/lib/servers/main.js',
  'package/lib/servers/device.js',
  'package/cordis.patch.yml',
  'package/install.ps1',
  'package/install.sh',
  'package/scripts/profile-manifest.mjs',
  'package/scripts/pack-check.mjs',
  'package/scripts/publish-npm.mjs',
  'package/scripts/publish-github.mjs',
  'package/tests/helpers.mjs',
  'package/tests/fs-paths.test.mjs',
  'package/docs/LAUNCH.md',
  'package/docs/architecture.svg',
  'package/icon.svg',
  'package/locale/en.json',
  'package/locale/zh.json',
  'package/docs/awesome-dsh-plugin-entry.yml',
  'package/CONTRIBUTING.md',
  'package/SECURITY.md',
  'package/LICENSE',
  'package/README.md',
  'package/README.zh.md',
  'package/CHANGELOG.md',
  'package/CODE_OF_CONDUCT.md',
  // 测试要一起发出去：Windows 用户可以自己跑 node tests/platform.test.mjs 复核，
  // install.ps1 -Verify 也依赖它们。
  'package/tests/platform.test.mjs',
  'package/tests/capabilities.test.mjs',
  'package/tests/installer.test.mjs',
  'package/tests/dsh-wiring.test.mjs',
]

const failures = []
const notes = []

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    code: result.status === null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  }
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-hub-packcheck-'))

let tarball = null
try {
  const pack = run(npm, ['pack', '--json', '--pack-destination', workDir])
  if (pack.code !== 0) {
    failures.push('npm pack 失败：' + (pack.stderr || pack.stdout || String(pack.error)))
  } else {
    const parsed = JSON.parse(pack.stdout)
    tarball = path.join(workDir, parsed[0].filename)
    notes.push('tarball：' + parsed[0].filename + '（' + parsed[0].size + ' bytes，' + parsed[0].files.length + ' 个文件）')
  }
} catch (error) {
  failures.push('npm pack 输出无法解析：' + String(error && error.message ? error.message : error))
}

// 版本号必须和 README 里写的一致（发布时最容易忘的一步）。
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
if (manifest.dsh === undefined || manifest.dsh.bundle === undefined) failures.push('package.json 缺少 dsh.bundle —— 装进 profile 后不会成为一层')
if (manifest.main !== 'lib/index.js') failures.push('package.json 的 main 不是 lib/index.js')

if (tarball !== null) {
  const list = run('tar', ['-tzf', tarball])
  if (list.code !== 0) {
    notes.push('没有可用的 tar，跳过内容清单校验（' + (list.stderr || '').trim() + '）')
  } else {
    const entries = new Set(list.stdout.split('\n').map((line) => line.trim().replace(/\r$/, '')).filter((line) => line !== ''))
    for (const required of REQUIRED) {
      if (!entries.has(required)) failures.push('tarball 缺少：' + required)
    }
    // lib/ 下的每个文件都得在包里：漏一个就是运行期 import 失败。
    const walk = async (dir, prefix) => {
      const out = []
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name)
        const key = prefix + '/' + item.name
        if (item.isDirectory()) out.push(...await walk(full, key))
        else out.push(key)
      }
      return out
    }
    for (const file of await walk(path.join(ROOT, 'lib'), 'package/lib')) {
      if (!entries.has(file)) failures.push('tarball 缺少 lib 文件：' + file)
    }
  }

  const extractDir = path.join(workDir, 'extract')
  await fs.mkdir(extractDir, { recursive: true })
  const extract = run('tar', ['-xzf', tarball, '-C', extractDir])
  if (extract.code !== 0) {
    failures.push('解包失败：' + (extract.stderr || extract.stdout))
  } else {
    const packed = path.join(extractDir, 'package')
    // 内置服务：从发布物里跑
    const servers = run(process.execPath, [path.join(packed, 'lib', 'servers', 'main.js'), 'list'], { cwd: packed })
    if (servers.code !== 0) failures.push('解包后的内置服务清单跑不起来：' + (servers.stderr || servers.stdout).slice(0, 400))
    else notes.push('内置服务清单：' + servers.stdout.trim().split('\n')[0])

    // 插件入口：从发布物里 import（不启动任何服务，只验模块能不能加载）
    const probe = [
      'const mod = await import(' + JSON.stringify('file://' + path.join(packed, 'lib', 'index.js').replace(/\\/g, '/')) + ');',
      'if (typeof mod.apply !== \'function\') throw new Error(\'apply 不是函数\');',
      'if (typeof mod.name !== \'string\') throw new Error(\'name 缺失\');',
      'const platform = await import(' + JSON.stringify('file://' + path.join(packed, 'lib', 'platform.js').replace(/\\/g, '/')) + ');',
      'if (platform.shellToolName(\'win32\') !== \'pwsh\') throw new Error(\'Windows shell 工具名不对\');',
      'console.log(JSON.stringify({ plugin: mod.name, shellWindows: platform.shellToolName(\'win32\'), shellPosix: platform.shellToolName(\'linux\') }));',
    ].join(' ')
    const loaded = run(process.execPath, ['--input-type=module', '-e', probe], { cwd: packed })
    if (loaded.code !== 0) failures.push('解包后的插件入口 import 失败：' + (loaded.stderr || loaded.stdout).slice(0, 400))
    else notes.push('插件入口：' + loaded.stdout.trim())
  }
}

if (!KEEP) await fs.rm(workDir, { recursive: true, force: true })
else notes.push('临时目录保留在：' + workDir)

const report = { ok: failures.length === 0, version: manifest.version, failures, notes }
console.log(JSON.stringify(report, null, 2))
process.exitCode = failures.length === 0 ? 0 : 1
