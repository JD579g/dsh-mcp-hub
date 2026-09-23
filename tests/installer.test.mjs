/**
 * dsh-mcp-hub · Windows 安装器测试
 *
 * 两段：
 *   A) 静态约束（任何平台都跑）：install.ps1 是 UTF-8 **带 BOM**（Windows PowerShell
 *      5.1 否则把中文读成乱码）、路径全用 Join-Path 拼（不写死 node_modules\\…）、
 *      调用 DSH 自己的插件通道、支持 -Uninstall、声明 #Requires 5.1。
 *   B) 真跑（机器上有 pwsh / powershell 时）：在临时 DSH_HOME 上完整走一遍
 *      安装 → 校验 profile 清单与 node_modules → 卸载 → 校验回到原样。
 *      没有 PowerShell 就明确跳过，不假装通过。
 *
 * 用法：node tests/installer.test.mjs
 *      MCP_HUB_PWSH=/path/to/pwsh 可指定解释器（自动在 PATH 里找 pwsh / powershell）。
 */

import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const INSTALLER = path.join(ROOT, 'install.ps1')

const checks = []
const record = (name, ok, detail) => checks.push({ name, ok: ok === true, detail: detail === undefined ? '' : String(detail) })

function which(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32' })
  return result.status === 0 ? (result.stdout || '').trim() : null
}

function findPwsh() {
  if (process.env.MCP_HUB_PWSH) return process.env.MCP_HUB_PWSH
  for (const candidate of ['pwsh', 'powershell', 'pwsh.exe', 'powershell.exe']) {
    const found = which(candidate, ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'])
    if (found !== null) return candidate
  }
  return null
}

// ── A) 静态约束 ─────────────────────────────────────────────────────────────
const raw = await fs.readFile(INSTALLER)
const text = raw.toString('utf8')

record('install.ps1 存在且是 UTF-8 BOM（Windows PowerShell 5.1 读中文的前提）',
  raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF,
  raw.subarray(0, 3).toString('hex'))

record('声明 #Requires -Version 5.1', text.includes('#Requires -Version 5.1'))
record('走 DSH 自己的插件通道（dsh plugin --profile … add）',
  text.includes("'plugin'") && text.includes("'--profile'") && text.includes("'add'") && text.includes('Resolve-DshLauncher'))
record('支持 -Uninstall', text.includes('$Uninstall'))
record('支持 -Verify 自检', text.includes('$Verify'))
record('Node 版本下限与 package.json 的 engines 一致（>= 20）', text.includes('-lt 20'))
record('没有把 node_modules 路径写死成反斜杠字面量',
  !text.includes('node_modules\\') && !/Join-Path[^\n]*node_modules\\\\/.test(text))
record('没有用 ConvertTo-Json 改写 profile 清单（交给 node 助手）',
  !text.includes('ConvertTo-Json') && text.includes('ConvertFrom-Json'))
record('本地路径会归一成 file: 规格（Windows 反斜杠问题）', text.includes('function ConvertTo-FileSpec'))
record('引用清单助手 scripts/profile-manifest.mjs', text.includes('profile-manifest.mjs'))
record('没有绕过 DSH、直接写死全局安装路径',
  !text.includes('AppData') || text.includes("Join-Path (Join-Path $env:APPDATA 'npm') 'node_modules'"))

// macOS 自带的是 bash 3.2：变量名后面紧跟多字节字符（中文全角括号等）时，
// 它会把那个字符的第一个字节吞进变量名，set -u 于是报 "PROFILE?: unbound variable"。
// 真实事故：install.sh 的收尾提示里写了 "$PROFILE）"，在 macOS runner 上直接退出码非 0。
const shText = await fs.readFile(path.join(ROOT, 'install.sh'), 'utf8')
const varThenNonAscii = /\$[A-Za-z_0-9][A-Za-z0-9_]*[^\x00-\x7f]/.exec(shText)
record('install.sh：变量名后面不紧跟非 ASCII 字符（macOS bash 3.2 会把它吞进变量名）',
  varThenNonAscii === null, varThenNonAscii === null ? '' : '发现：' + varThenNonAscii[0])
record('install.sh：存在且可执行位合理', shText.includes('#!/usr/bin/env bash'))

// ── 清单助手本身：install / uninstall / status 幂等 ─────────────────────────
const helperDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-hub-helper-'))
try {
  const profileDir = path.join(helperDir, 'profiles', 'web')
  await fs.mkdir(path.join(profileDir, 'node_modules', 'dsh-mcp-hub'), { recursive: true })
  await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'startup' } },
  }, null, 2))
  await fs.writeFile(path.join(profileDir, 'node_modules', 'dsh-mcp-hub', 'package.json'), JSON.stringify({
    name: 'dsh-mcp-hub', version: '0.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2))

  const helper = path.join(ROOT, 'scripts', 'profile-manifest.mjs')
  const runHelper = (args) => {
    const result = spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8' })
    return { code: result.status, out: result.stdout || '', err: result.stderr || '' }
  }
  const install = runHelper(['--profile-dir', profileDir, '--mode', 'install', '--spec', 'file:/tmp/x.tgz'])
  const afterInstall = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'))
  record('清单助手：install 成功', install.code === 0, install.err.trim())
  record('清单助手：把包名写进 dsh.profile.bundles',
    Array.isArray(afterInstall.dsh.profile.bundles) && afterInstall.dsh.profile.bundles.includes('dsh-mcp-hub'))
  record('清单助手：写入 dependencies',
    afterInstall.dependencies !== undefined && afterInstall.dependencies['dsh-mcp-hub'] === 'file:/tmp/x.tgz')

  const again = runHelper(['--profile-dir', profileDir, '--mode', 'install', '--spec', 'file:/tmp/x.tgz'])
  const afterSecond = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'))
  record('清单助手：重复 install 幂等（bundles 不重复）',
    again.code === 0 && afterSecond.dsh.profile.bundles.filter((item) => item === 'dsh-mcp-hub').length === 1)

  const uninstall = runHelper(['--profile-dir', profileDir, '--mode', 'uninstall'])
  const afterUninstall = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'))
  record('清单助手：uninstall 清干净 dependencies 与 bundles',
    uninstall.code === 0 &&
    (afterUninstall.dependencies === undefined || afterUninstall.dependencies['dsh-mcp-hub'] === undefined) &&
    !afterUninstall.dsh.profile.bundles.includes('dsh-mcp-hub'))
} finally {
  await fs.rm(helperDir, { recursive: true, force: true })
}

// ── B) 真跑一遍安装 / 卸载（需要 PowerShell）────────────────────────────────
const pwsh = findPwsh()
const runtime = { powershell: pwsh, ran: false, steps: [] }

if (pwsh !== null) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-hub-home-'))
  const profileDir = path.join(home, 'profiles', 'web')
  await fs.mkdir(path.join(profileDir, 'node_modules'), { recursive: true })
  await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } },
  }, null, 2))

  const runInstaller = (args) => {
    const result = spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-File', INSTALLER, ...args], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: home },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300000,
    })
    return { code: result.status, out: (result.stdout || '') + (result.stderr || '') }
  }

  try {
    const install = runInstaller(['-Profile', 'web'])
    runtime.ran = true
    runtime.steps.push({ step: 'install', code: install.code })
    record('安装器（真跑）：退出码 0', install.code === 0, install.out.slice(-600))

    const manifest = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'))
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
    record('安装器（真跑）：插件进入 dsh.profile.bundles', bundles.includes('dsh-mcp-hub'), JSON.stringify(bundles))
    record('安装器（真跑）：dependencies 记录了来源', manifest.dependencies?.['dsh-mcp-hub'] !== undefined,
      String(manifest.dependencies?.['dsh-mcp-hub']))

    const entry = path.join(profileDir, 'node_modules', 'dsh-mcp-hub', 'lib', 'index.js')
    let entryOk = false
    try { await fs.access(entry); entryOk = true } catch { entryOk = false }
    record('安装器（真跑）：node_modules 里真的有插件入口', entryOk, entry)

    if (entryOk) {
      const smoke = spawnSync(process.execPath, [path.join(profileDir, 'node_modules', 'dsh-mcp-hub', 'lib', 'servers', 'main.js'), 'list'], {
        encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      })
      record('安装器（真跑）：装好的副本能列内置服务', smoke.status === 0, (smoke.stderr || '').slice(0, 300))
    }

    const uninstall = runInstaller(['-Profile', 'web', '-Uninstall'])
    runtime.steps.push({ step: 'uninstall', code: uninstall.code })
    record('卸载器（真跑）：退出码 0', uninstall.code === 0, uninstall.out.slice(-600))
    const after = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'))
    const afterBundles = Array.isArray(after.dsh?.profile?.bundles) ? after.dsh.profile.bundles : []
    record('卸载器（真跑）：bundles 与依赖都清空', !afterBundles.includes('dsh-mcp-hub') && after.dependencies?.['dsh-mcp-hub'] === undefined,
      JSON.stringify({ bundles: afterBundles, dependencies: after.dependencies || null }))
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
} else {
  runtime.steps.push({ step: 'skipped', reason: 'PATH 里没有 pwsh / powershell' })
}

// ── C) install.sh（macOS / Linux）同样真跑一遍 ────────────────────────────
const bashOk = spawnSync('bash', ['-c', 'command -v node >/dev/null'], { encoding: 'utf8' }).status === 0
if (bashOk) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-hub-sh-'))
  const profileDir = path.join(home, 'profiles', 'web')
  await fs.mkdir(profileDir, { recursive: true })
  await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'startup' } },
  }, null, 2))
  try {
    const run = (args) => spawnSync('bash', [path.join(ROOT, 'install.sh'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: home },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300000,
    })
    const install = run(['--profile', 'web'])
    record('install.sh（真跑）：退出码 0', install.status === 0, ((install.stdout || '') + (install.stderr || '')).slice(-400))
    const manifest = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'))
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
    record('install.sh（真跑）：插件进入 dsh.profile.bundles', bundles.includes('dsh-mcp-hub'), JSON.stringify(bundles))
    let entryOk = false
    try { await fs.access(path.join(profileDir, 'node_modules', 'dsh-mcp-hub', 'lib', 'index.js')); entryOk = true } catch { entryOk = false }
    record('install.sh（真跑）：node_modules 里有插件入口（链接或复制）', entryOk)

    const uninstall = run(['--profile', 'web', '--uninstall'])
    record('install.sh --uninstall（真跑）：退出码 0', uninstall.status === 0, ((uninstall.stdout || '') + (uninstall.stderr || '')).slice(-400))
    const after = JSON.parse(await fs.readFile(path.join(profileDir, 'package.json'), 'utf8'))
    record('install.sh --uninstall（真跑）：bundles 与依赖都清空',
      !(Array.isArray(after.dsh?.profile?.bundles) ? after.dsh.profile.bundles : []).includes('dsh-mcp-hub') &&
      after.dependencies?.['dsh-mcp-hub'] === undefined)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
} else {
  record('install.sh：跳过（本机没有 bash）', true, 'skipped')
}

const failures = checks.filter((item) => !item.ok)
const report = {
  ok: failures.length === 0,
  powershell: runtime,
  total: checks.length,
  passed: checks.length - failures.length,
  failures: failures.map((item) => item.name + (item.detail ? ' — ' + item.detail : '')),
  checks,
}
console.log(JSON.stringify(report, null, 1))
if (runtime.ran !== true) {
  console.log('注意：本机没有 PowerShell，只跑了静态约束与清单助手；安装器本体未真跑。')
}
console.log(failures.length === 0
  ? 'Windows 安装器测试通过 ✅' + (runtime.ran ? '（含真跑安装/卸载）' : '（静态 + 清单助手）')
  : 'Windows 安装器测试失败 ❌ ' + failures.length + ' 项')
process.exitCode = failures.length === 0 ? 0 : 1
