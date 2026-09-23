#!/usr/bin/env node
/**
 * dsh-mcp-hub · GitHub 仓库设置（话题 / 标签 / Release）
 *
 * 这些设置没法靠 push 完成，只能用 API 打。脚本把它做成可重复执行的，
 * 谁 fork 都能一键把仓库收拾成一样的形状。
 *
 * 用法：
 *   GH_TOKEN=xxx node scripts/setup-github.mjs --repo JD579g/dsh-mcp-hub
 *   GH_TOKEN=xxx node scripts/setup-github.mjs --topics --labels --release
 *
 * token 权限（fine-grained）：
 *   - Metadata: Read（自动）
 *   - Administration: Read and write   → 设置话题
 *   - Issues: Read and write           → 创建标签
 *   - Contents: Read and write         → 创建 Release
 * 缺哪个权限就只跳过对应那一步，并把 GitHub 的原话打出来（其余照做）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const API = 'https://api.github.com'

const TOPICS = [
  'dsh', 'dsh-plugin', 'mcp', 'mcp-server', 'model-context-protocol',
  'windows', 'powershell', 'cordis', 'deepseek', 'ai-tools',
]

const LABELS = [
  ['needs-triage', 'fbca04', '等待维护者确认'],
  ['platform/windows', '1d76db', 'Windows 相关问题（本项目的主战场）'],
  ['platform/macos', '1d76db', 'macOS 相关问题'],
  ['platform/linux', '1d76db', 'Linux 相关问题'],
  ['platform/android', '1d76db', 'Android / DSHA 手机端'],
  ['area/installer', '5319e7', 'install.ps1 / install.sh 与 profile 清单'],
  ['area/ui', '5319e7', '设置页「MCP 工具」界面'],
  ['area/search', '5319e7', '在线搜索与目录（Registry / npm / GitHub）'],
  ['area/permissions', '5319e7', '调用权限与审批'],
  ['area/builtin-servers', '5319e7', '7 个内置 MCP 服务'],
  ['area/terminal', '5319e7', '内置终端'],
  ['area/platform', '5319e7', '平台层（路径策略 / shell / 拒绝清单）'],
  ['ci', '0e8a16', 'GitHub Actions 与发布流程'],
  ['dependencies', '0366d6', '依赖升级'],
  ['breaking', 'b60205', '破坏性变更'],
]

function parseArgs(argv) {
  const out = { token: '', repo: '', topics: false, labels: false, release: false, tag: '', name: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = () => { index += 1; return argv[index] }
    if (flag === '--token') out.token = next()
    else if (flag === '--repo') out.repo = next()
    else if (flag === '--tag') out.tag = next()
    else if (flag === '--name') out.name = next()
    else if (flag === '--topics') out.topics = true
    else if (flag === '--labels') out.labels = true
    else if (flag === '--release') out.release = true
    else if (flag === '--all') { out.topics = true; out.labels = true; out.release = true }
    else if (flag === '--help' || flag === '-h') out.help = true
    else throw new Error('未知参数：' + flag)
  }
  out.token = out.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
  if (!out.topics && !out.labels && !out.release) { out.topics = true; out.labels = true; out.release = true }
  return out
}

async function api(token, route, options = {}) {
  const response = await fetch(API + route, {
    method: options.method || 'GET',
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-mcp-hub-setup',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let body = null
  try { body = text === '' ? null : JSON.parse(text) } catch { body = text }
  return { status: response.status, ok: response.ok, body }
}

const HINT = {
  403: '（这就是缺权限：话题要 Administration、标签要 Issues、Release 要 Contents，都是 Read and write）',
  404: '（仓库不存在，或 token 没覆盖这个仓库）',
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    console.log('用法：node scripts/setup-github.mjs --repo <owner/name> [--topics] [--labels] [--release] [--tag v1.2.0]')
    return 0
  }
  if (args.token === '') { console.error('缺少 token：--token 或 GH_TOKEN'); return 2 }

  let repo = args.repo
  if (repo === '') {
    const me = await api(args.token, '/user')
    if (!me.ok) { console.error('token 校验失败：HTTP ' + me.status); return 1 }
    const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
    repo = me.body.login + '/' + manifest.name
  }
  console.log('==> 仓库：' + repo)

  let failures = 0

  if (args.topics) {
    const result = await api(args.token, '/repos/' + repo + '/topics', { method: 'PUT', body: { names: TOPICS } })
    if (result.ok) console.log('  OK  话题：' + TOPICS.join(', '))
    else { failures += 1; console.error('  X   话题失败：HTTP ' + result.status + ' ' + (HINT[result.status] || '')) }
  }

  if (args.labels) {
    let created = 0
    let skipped = 0
    let denied = 0
    for (const [name, color, description] of LABELS) {
      const result = await api(args.token, '/repos/' + repo + '/labels', { method: 'POST', body: { name, color, description } })
      if (result.status === 201) created += 1
      else if (result.status === 422) skipped += 1
      else if (result.status === 403) { denied += 1; if (denied === 1) console.error('  X   标签失败：HTTP 403 ' + HINT[403]) }
      else { failures += 1; console.error('  X   ' + name + '：HTTP ' + result.status) }
    }
    if (denied === 0) console.log('  OK  标签：新建 ' + created + ' 个，已存在 ' + skipped + ' 个')
  }

  if (args.release) {
    const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
    const tag = args.tag || ('v' + manifest.version)
    const changelog = await fs.readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
    // 取当前版本那一节当 Release 说明
    const marker = '## [' + manifest.version + ']'
    const start = changelog.indexOf(marker)
    const body = start < 0 ? changelog.slice(0, 4000) : changelog.slice(start, changelog.indexOf('\n## [', start + 1) < 0 ? undefined : changelog.indexOf('\n## [', start + 1))
    const result = await api(args.token, '/repos/' + repo + '/releases', {
      method: 'POST',
      body: { tag_name: tag, name: tag + ' · ' + (args.name || manifest.name), body, draft: false, prerelease: false },
    })
    if (result.ok) console.log('  OK  Release：' + result.body.html_url)
    else if (result.status === 422) console.log('  OK  Release 已存在（' + tag + '）')
    else { failures += 1; console.error('  X   Release 失败：HTTP ' + result.status + ' ' + JSON.stringify(result.body).slice(0, 200)) }
  }

  return failures === 0 ? 0 : 1
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  console.error('setup-github：' + (error && error.message ? error.message : String(error)))
  process.exitCode = 1
})
