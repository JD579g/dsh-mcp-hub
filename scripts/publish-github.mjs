#!/usr/bin/env node
/**
 * dsh-mcp-hub · 一键上架 GitHub（幂等）
 *
 * 用你的 GitHub token 做完整套：
 *   1) 校验 token，读出账号身份；
 *   2) 创建仓库（已存在则复用）；
 *   3) 把本地提交的作者改成你的 GitHub 身份；
 *   4) 把 README 徽章、package.json 的 repository/bugs/homepage、
 *      issue 模板里的安全链接补成真实地址，并提交；
 *   5) 推送（token 只在推送瞬间写进 .git/config，推完立刻擦掉）；
 *   6) 用 API 确认 CI 已开始跑。
 *
 * 用法：
 *   GH_TOKEN=github_pat_xxx node scripts/publish-github.mjs
 *   node scripts/publish-github.mjs --token github_pat_xxx --repo dsh-mcp-hub --private
 *   node scripts/publish-github.mjs --check          # 只校验 token 与身份，不写任何东西
 *
 * token 权限（Fine-grained）：Contents RW + Administration RW + Workflows RW，Repository access = All
 *              （经典 PAT）：repo + workflow
 *
 * 脚本绝不会把 token 打印出来，也不会把它留在 .git/config 里。
 */

import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const API = 'https://api.github.com'

function parseArgs(argv) {
  const out = { token: '', repo: 'dsh-mcp-hub', private: false, check: false, yes: false, description: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(token + ' 需要一个值')
      index += 1
      return value
    }
    if (token === '--token') out.token = next()
    else if (token === '--repo') out.repo = next()
    else if (token === '--description') out.description = next()
    else if (token === '--private') out.private = true
    else if (token === '--public') out.private = false
    else if (token === '--check') out.check = true
    else if (token === '--yes' || token === '-y') out.yes = true
    else if (token === '--help' || token === '-h') out.help = true
    else throw new Error('未知参数：' + token)
  }
  out.token = out.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
  return out
}

const HELP = `用法：node scripts/publish-github.mjs [--token <pat>] [--repo <name>] [--private] [--check]

token 也可以放在环境变量 GH_TOKEN / GITHUB_TOKEN 里。
Fine-grained 权限：Contents RW + Administration RW + Workflows RW，Repository access = All repositories
经典 PAT 权限：repo + workflow`

/** 打印时永远不泄露 token。 */
function redact(text, token) {
  if (token === '') return String(text)
  return String(text).split(token).join('***')
}

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    code: result.status === null ? 1 : result.status,
    out: (result.stdout || '').trim(),
    err: (result.stderr || '').trim(),
  }
}

function git(args) {
  const result = sh('git', args)
  if (result.code !== 0 && args[0] !== 'diff') throw new Error('git ' + args.join(' ') + ' 失败：' + result.err)
  return result.out
}

async function api(token, route, options = {}) {
  const response = await fetch(API + route, {
    method: options.method || 'GET',
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-mcp-hub-publish',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = text === '' ? null : JSON.parse(text) } catch { parsed = text }
  return { status: response.status, ok: response.ok, body: parsed, headers: response.headers }
}

async function replaceInFile(relative, replacements) {
  const file = path.join(ROOT, relative)
  let text = await fs.readFile(file, 'utf8')
  const original = text
  for (const [from, to] of replacements) text = text.split(from).join(to)
  if (text !== original) {
    await fs.writeFile(file, text, 'utf8')
    return true
  }
  return false
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    console.log(HELP)
    return 0
  }
  if (args.token === '') {
    console.error('缺少 token：用 --token 传，或设环境变量 GH_TOKEN / GITHUB_TOKEN。')
    console.error('Fine-grained 需要 Contents RW + Administration RW + Workflows RW；经典 PAT 需要 repo + workflow。')
    return 2
  }

  // ── 1) 身份 ───────────────────────────────────────────────────────────────
  const me = await api(args.token, '/user')
  if (!me.ok) {
    console.error('token 校验失败：HTTP ' + me.status + ' ' + redact(JSON.stringify(me.body).slice(0, 200), args.token))
    console.error('常见原因：token 过期、权限不足（新建仓库需要 Administration: write）。')
    return 1
  }
  const login = me.body.login
  const id = me.body.id
  const name = me.body.name || login
  const email = me.body.email || (id + '+' + login + '@users.noreply.github.com')
  const repo = args.repo
  const full = login + '/' + repo
  console.log('==> 账号：' + login + '（' + name + '）');
  console.log('==> 目标仓库：' + full + '（' + (args.private ? '私有' : '公开') + '）')

  // 权限自检：workflow 文件必须能推
  const scopes = me.headers.get('x-oauth-scopes')
  if (scopes !== null && scopes !== undefined && !scopes.includes('workflow') && !scopes.includes('repo')) {
    console.warn('  !  经典 PAT 的 scope 里没有 workflow/repo，推送 .github/workflows/ 可能被拒。')
  }

  if (args.check) {
    const existing = await api(args.token, '/repos/' + full)
    console.log(JSON.stringify({
      ok: true,
      check: true,
      login,
      name,
      email,
      repoExists: existing.ok,
      scopes: scopes || '(fine-grained，无 scope 列表)',
    }, null, 1))
    return 0
  }

  // ── 2) 创建仓库（幂等）────────────────────────────────────────────────────
  const existing = await api(args.token, '/repos/' + full)
  if (existing.ok) {
    console.log('  OK  仓库已存在，直接复用')
  } else if (existing.status === 404) {
    const created = await api(args.token, '/user/repos', {
      method: 'POST',
      body: {
        name: repo,
        description: args.description || 'DSH 的 MCP 与工具一键部署中枢：桌面优先（Windows 友好），设置页一键装机、在线搜索与 DSH 原生工具去重、四级调用权限、内置终端，以及 7 个零依赖内置 MCP 服务。',
        private: args.private,
        has_issues: true,
        has_wiki: false,
        has_projects: false,
        auto_init: false,
      },
    })
    if (!created.ok) {
      console.error('创建仓库失败：HTTP ' + created.status + ' ' + redact(JSON.stringify(created.body).slice(0, 300), args.token))
      return 1
    }
    console.log('  OK  已创建 ' + created.body.full_name)
  } else {
    console.error('检查仓库失败：HTTP ' + existing.status + ' ' + redact(JSON.stringify(existing.body).slice(0, 300), args.token))
    return 1
  }

  // ── 3) 提交身份 ───────────────────────────────────────────────────────────
  git(['config', 'user.name', name])
  git(['config', 'user.email', email])
  const amended = sh('git', ['commit', '--amend', '--reset-author', '--no-edit'])
  if (amended.code !== 0) console.warn('  !  重设作者失败（可能还没有提交）：' + amended.err.split('\n')[0])

  // ── 4) 补真实地址（幂等：已经是真实地址就跳过）────────────────────────────
  const url = 'https://github.com/' + full
  const changed = []
  if (await replaceInFile('README.md', [
    ['[![CI](https://github.com/OWNER/dsh-mcp-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/dsh-mcp-hub/actions/workflows/ci.yml)',
     '[![CI](' + url + '/actions/workflows/ci.yml/badge.svg)](' + url + '/actions/workflows/ci.yml)'],
  ])) changed.push('README.md 徽章')

  const manifestPath = path.join(ROOT, 'package.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  if (manifest.repository === undefined || manifest.repository.url !== 'git+' + url + '.git') {
    manifest.repository = { type: 'git', url: 'git+' + url + '.git' }
    manifest.bugs = { url: url + '/issues' }
    manifest.homepage = url + '#readme'
    manifest.author = { name, url: 'https://github.com/' + login }
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    changed.push('package.json 仓库字段')
  }
  if (await replaceInFile('.github/ISSUE_TEMPLATE/config.yml', [
    ['url: https://github.com', 'url: ' + url + '/security/advisories/new'],
  ])) changed.push('issue 模板安全链接')
  if (await replaceInFile('CONTRIBUTING.md', [
    ['git clone https://github.com/<owner>/dsh-mcp-hub.git', 'git clone ' + url + '.git'],
  ])) changed.push('CONTRIBUTING 克隆地址')

  if (changed.length > 0) {
    git(['add', '-A'])
    git(['commit', '-m', 'docs: 补上仓库地址、CI 徽章与 issue 安全链接'])
    console.log('  OK  已提交：' + changed.join('、'))
  } else {
    console.log('  OK  地址信息已是最新，无需改动')
  }

  // ── 5) 推送（token 只在推的这一刻进 .git/config，随后立即擦掉）────────────
  const cleanUrl = url + '.git'
  const remoteList = git(['remote'])
  if (remoteList.split('\n').includes('origin')) git(['remote', 'set-url', 'origin', cleanUrl])
  else git(['remote', 'add', 'origin', cleanUrl])
  const branch = 'main'
  let pushed = false
  try {
    git(['remote', 'set-url', 'origin', 'https://x-access-token:' + args.token + '@github.com/' + full + '.git'])
    const push = sh('git', ['push', '--force', 'origin', 'HEAD:' + branch])
    if (push.code !== 0) {
      console.error('推送失败：' + redact(push.err, args.token))
      return 1
    }
    pushed = true
    console.log('  OK  已推送到 ' + full + '（分支 ' + branch + '）')
  } finally {
    git(['remote', 'set-url', 'origin', cleanUrl])
  }
  if (!pushed) return 1

  // ── 6) 确认 CI ────────────────────────────────────────────────────────────
  await new Promise((resolve) => setTimeout(resolve, 8000))
  const runs = await api(args.token, '/repos/' + full + '/actions/runs?per_page=3')
  console.log('')
  console.log('仓库：' + url)
  console.log('Issues：' + url + '/issues  （Bug / Feature 模板已就位）')
  if (runs.ok && Array.isArray(runs.body.workflow_runs) && runs.body.workflow_runs.length > 0) {
    for (const run of runs.body.workflow_runs.slice(0, 3)) {
      console.log('CI：' + run.name + ' · ' + run.status + (run.conclusion ? ' · ' + run.conclusion : '') + ' → ' + run.html_url)
    }
  } else {
    console.log('CI：暂时还看不到 workflow run（Actions 可能被仓库设置禁用，或还在排队）→ ' + url + '/actions')
  }
  console.log('')
  console.log('提示：推完就可以在 GitHub 上吊销这个 token 了。')
  return 0
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  console.error('publish-github：' + (error && error.message ? error.message : String(error)))
  process.exitCode = 1
})
