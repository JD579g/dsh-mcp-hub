#!/usr/bin/env node
/**
 * dsh-mcp-hub · 发布到 npm（带自检，避免发出半成品）
 *
 *   node scripts/publish-npm.mjs --dry-run            # 不需要 token，看一眼会发什么
 *   NPM_TOKEN=npm_xxx node scripts/publish-npm.mjs
 *
 * 做的事：写一个只在本进程用的临时 .npmrc → 校验 token（npm whoami）→
 * 检查版本是否已存在 → 跑 pack-check（保证 tarball 内容完整）→ npm publish →
 * 从 registry 回读版本与 tarball 摘要确认 → 删掉临时 .npmrc。
 *
 * npm token 需要：Granular Access Token，Packages 权限 Read and write
 * （首次发布一个新包名时，账号要开启 2FA-bypass 或在本机交互登录，
 *   否则 npm 会要求 OTP；此时改用 npm login + npm publish）。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function parseArgs(argv) {
  const out = { token: '', dryRun: false, otp: '', tag: 'latest', yes: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const next = () => { index += 1; return argv[index] }
    if (token === '--token') out.token = next()
    else if (token === '--otp') out.otp = next()
    else if (token === '--tag') out.tag = next()
    else if (token === '--dry-run') out.dryRun = true
    else if (token === '--yes' || token === '-y') out.yes = true
    else if (token === '--help' || token === '-h') out.help = true
    else throw new Error('未知参数：' + token)
  }
  out.token = out.token || process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || ''
  return out
}

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, ...(options.env || {}) },
    maxBuffer: 32 * 1024 * 1024,
  })
  return { code: result.status === null ? 1 : result.status, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() }
}

const redact = (text, token) => (token === '' ? String(text) : String(text).split(token).join('***'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    console.log('用法：node scripts/publish-npm.mjs [--dry-run] [--token <npm token>] [--otp <code>] [--tag latest]')
    console.log('token 也可放在 NPM_TOKEN 环境变量里；--dry-run 不需要 token。')
    return 0
  }

  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
  console.log('==> ' + manifest.name + '@' + manifest.version)

  // ── 1) 发布包自检 ─────────────────────────────────────────────────────────
  console.log('==> npm pack 自检')
  const check = sh(process.execPath, [path.join(ROOT, 'scripts', 'pack-check.mjs')])
  if (check.code !== 0) {
    console.error(check.out)
    console.error('发布包自检没通过，先修好再发。')
    return 1
  }
  console.log('  OK  发布包内容完整')

  if (args.dryRun) {
    const dry = sh(npm, ['publish', '--dry-run', '--tag', args.tag])
    console.log(dry.out || dry.err)
    console.log('  OK  dry-run 完成（没有真的发布）')
    return 0
  }

  if (args.token === '') {
    console.error('缺少 npm token：用 --token 传，或设 NPM_TOKEN。')
    console.error('也可以用 npm login 交互登录后直接 npm publish。')
    return 2
  }

  // ── 2) 临时 .npmrc（只给这次发布用，结束就删）─────────────────────────────
  const rcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-hub-npmrc-'))
  const rcFile = path.join(rcDir, '.npmrc')
  await fs.writeFile(rcFile, '//registry.npmjs.org/:_authToken=' + args.token + '\nregistry=https://registry.npmjs.org/\n', { mode: 0o600 })
  try {
    const who = sh(npm, ['whoami', '--userconfig', rcFile])
    if (who.code !== 0) {
      console.error('npm token 校验失败：' + redact(who.err || who.out, args.token))
      return 1
    }
    console.log('  OK  npm 身份：' + who.out)

    const published = sh(npm, ['view', manifest.name + '@' + manifest.version, 'version'])
    if (published.code === 0 && published.out.trim() === manifest.version) {
      console.error('registry 上已经有 ' + manifest.name + '@' + manifest.version + '：先改 package.json 的 version 再发。')
      return 1
    }

    console.log('==> npm publish --access public --tag ' + args.tag)
    const publishArgs = ['publish', '--access', 'public', '--tag', args.tag, '--userconfig', rcFile]
    if (args.otp !== '') publishArgs.push('--otp', args.otp)
    const result = sh(npm, publishArgs)
    console.log(result.out || '')
    if (result.code !== 0) {
      console.error(redact(result.err, args.token))
      return 1
    }

    await new Promise((resolve) => setTimeout(resolve, 4000))
    const verify = sh(npm, ['view', manifest.name, 'version', 'dist.tarball'])
    console.log('==> registry 回读：')
    console.log(verify.out || '(暂时读不到，稍等几秒再 npm view ' + manifest.name + ')')
    console.log('')
    console.log('发布完成。之后可以：')
    console.log('  dsh plugin --profile web add ' + manifest.name)
    return 0
  } finally {
    await fs.rm(rcDir, { recursive: true, force: true })
  }
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  console.error('publish-npm：' + (error && error.message ? error.message : String(error)))
  process.exitCode = 1
})
