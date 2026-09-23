/**
 * dsh-mcp-hub · 在线 MCP 检索
 *
 * 「按需搜索、找到再装」：默认不把任何外部目录全量拉进来。
 *   1) 官方 MCP Registry（registry.modelcontextprotocol.io/v0.1/servers）
 *      —— 元数据最全：packages（npm/pypi/oci + 环境变量）与 remotes（streamable-http）。
 *   2) npm registry 搜索 —— 补上还没登记到官方 Registry 的包。
 *   3) GitHub 代码/仓库搜索 —— 可选；不带令牌时限额较低（10 次/分钟），
 *      设置 GITHUB_TOKEN 或 MCP_HUB_GITHUB_TOKEN 可提高。
 *
 * 依赖：只有 Node 内置 fetch。所有请求都带超时与结果条数上限。
 */

import { rankCandidates } from './capabilities.js'

const REGISTRY_BASE = process.env.MCP_HUB_REGISTRY_BASE || 'https://registry.modelcontextprotocol.io'
const NPM_BASE = process.env.MCP_HUB_NPM_BASE || 'https://registry.npmjs.org'
const GITHUB_API = process.env.MCP_HUB_GITHUB_API || 'https://api.github.com'

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map()

function cached(key, loader) {
  const hit = cache.get(key)
  const now = Date.now()
  if (hit !== undefined && now - hit.at < CACHE_TTL_MS) return hit.value
  const value = loader()
  cache.set(key, { at: now, value })
  return value
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController()
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 25000) || 25000)
  const attempts = Math.max(1, Number(options.attempts || 2) || 2)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'dsh-mcp-hub/1.0 (+https://github.com/deepseek-ai)',
        ...(options.headers || {}),
      },
    })
    const text = await response.text()
    if (!response.ok) {
      const error = new Error('HTTP ' + response.status + ' ' + response.statusText + '：' + url + ' :: ' + text.slice(0, 200))
      error.status = response.status
      throw error
    }
    return JSON.parse(text)
  } catch (error) {
    clearTimeout(timer)
    const retryable = error !== null && typeof error === 'object' && (error.name === 'AbortError' || error.status === undefined || error.status >= 500)
    if (retryable && attempts > 1) {
      await new Promise((resolve) => setTimeout(resolve, 700))
      return fetchJson(url, { ...options, attempts: attempts - 1 })
    }
    if (error && error.name === 'AbortError') throw new Error('请求超时（' + timeoutMs + 'ms，已尝试 ' + attempts + ' 次）：' + url)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function githubToken() {
  const token = process.env.MCP_HUB_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null
}

/** 把官方 Registry 的一条记录压缩成可读候选。 */
function compactRegistryRow(row) {
  const server = row !== null && typeof row === 'object' ? row.server : null
  if (server === null || typeof server !== 'object') return null
  const packages = (Array.isArray(server.packages) ? server.packages : []).map((pkg) => ({
    registryType: pkg.registryType,
    identifier: pkg.identifier,
    version: pkg.version,
    runtimeHint: pkg.runtimeHint || (pkg.registryType === 'npm' ? 'npx' : (pkg.registryType === 'pypi' ? 'uvx' : undefined)),
    transport: pkg.transport && pkg.transport.type ? pkg.transport.type : 'stdio',
    requiredEnv: (Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : []).filter((item) => item.isRequired === true).map((item) => item.name),
    optionalEnv: (Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : []).filter((item) => item.isRequired !== true).map((item) => item.name),
    runtimeArguments: (Array.isArray(pkg.runtimeArguments) ? pkg.runtimeArguments : []).map((item) => item.value),
  }))
  const remotes = (Array.isArray(server.remotes) ? server.remotes : []).map((remote) => ({
    type: remote.type,
    url: remote.url,
    requiredHeaders: (Array.isArray(remote.headers) ? remote.headers : []).filter((item) => item.isRequired === true).map((item) => item.name),
  }))
  return {
    source: 'registry',
    id: server.name,
    name: server.name,
    title: server.title || null,
    description: server.description || '',
    version: server.version || null,
    website: server.websiteUrl || null,
    repository: server.repository && server.repository.url ? server.repository.url : null,
    packages,
    remotes,
    installable: packages.length > 0 || remotes.length > 0,
    official: String(server.name).startsWith('io.modelcontextprotocol/') || String(server.name).startsWith('com.modelcontextprotocol/'),
  }
}

/**
 * 搜官方 MCP Registry。
 * @param {string} query 关键词
 * @param {number} limit 条数上限
 */
export async function searchOfficialRegistry(query, limit) {
  const key = 'reg:' + query + ':' + limit
  return cached(key, async () => {
    const url = REGISTRY_BASE + '/v0.1/servers?limit=' + Math.max(1, Math.min(100, limit)) +
      (query === '' ? '' : '&search=' + encodeURIComponent(query))
    const document = await fetchJson(url)
    const rows = Array.isArray(document.servers) ? document.servers : []
    const results = []
    for (const row of rows) {
      const compact = compactRegistryRow(row)
      if (compact === null) continue
      const meta = row._meta && row._meta['io.modelcontextprotocol.registry/official']
      if (meta !== undefined && meta.isLatest === false) continue
      results.push(compact)
    }
    return { nextCursor: document.metadata && document.metadata.nextCursor ? document.metadata.nextCursor : null, results }
  })
}

/** 搜 npm registry（补官方 Registry 的缺口）。 */
export async function searchNpm(query, limit) {
  const key = 'npm:' + query + ':' + limit
  return cached(key, async () => {
    if (query === '') return { results: [] }
    const size = Math.max(1, Math.min(50, limit))
    let document
    try {
      document = await fetchJson(NPM_BASE + '/-/v1/search?text=' + encodeURIComponent(query) + '&size=' + size)
    } catch (error) {
      // 某些镜像不支持 search 端点：退化成「按名字直接探测」
      const name = query.split(/\s+/)[0]
      const exact = await fetchJson(NPM_BASE + '/' + encodeURIComponent(name).replace('%40', '@')).catch(() => null)
      if (exact === null || exact.error !== undefined) throw error
      const latest = exact['dist-tags'] && exact['dist-tags'].latest
      const version = latest !== undefined && exact.versions ? exact.versions[latest] : undefined
      return {
        results: [{
          source: 'npm',
          id: exact.name,
          name: exact.name,
          title: null,
          description: exact.description || '',
          version: latest || null,
          packages: [{ registryType: 'npm', identifier: exact.name, version: latest, runtimeHint: 'npx', transport: 'stdio', requiredEnv: [], optionalEnv: [], runtimeArguments: [] }],
          remotes: [],
          installable: true,
          hasBin: version !== undefined && version.bin !== undefined,
        }],
      }
    }
    const objects = Array.isArray(document.objects) ? document.objects : []
    const results = objects.map((entry) => {
      const pkg = entry.package || {}
      const version = entry.score && entry.score.detail ? '' : ''
      return {
        source: 'npm',
        id: pkg.name,
        name: pkg.name,
        title: null,
        description: pkg.description || '',
        version: pkg.version || null,
        repository: pkg.links && pkg.links.repository ? pkg.links.repository : null,
        website: pkg.links && pkg.links.homepage ? pkg.links.homepage : null,
        downloads: entry.downloads ? entry.downloads.monthly : undefined,
        score: entry.score && typeof entry.score.final === 'number' ? Math.round(entry.score.final * 100) / 100 : undefined,
        packages: [{ registryType: 'npm', identifier: pkg.name, version: pkg.version, runtimeHint: 'npx', transport: 'stdio', requiredEnv: [], optionalEnv: [], runtimeArguments: [] }],
        remotes: [],
        installable: true,
        version_placeholder: version,
      }
    })
    return { results }
  })
}

/** 搜 GitHub（可选：无令牌时限额低，但足够偶发检索）。 */
export async function searchGitHub(query, limit) {
  const key = 'gh:' + query + ':' + limit
  return cached(key, async () => {
    const token = githubToken()
    const headers = token === null ? {} : { authorization: 'Bearer ' + token }
    const size = Math.max(1, Math.min(30, limit))
    const url = GITHUB_API + '/search/repositories?q=' + encodeURIComponent(query + ' mcp server in:name,description,readme') +
      '&sort=stars&order=desc&per_page=' + size
    const document = await fetchJson(url, { headers, timeoutMs: 20000 })
    const items = Array.isArray(document.items) ? document.items : []
    return {
      authenticated: token !== null,
      remaining: document.rate !== undefined ? document.rate : undefined,
      results: items.map((repo) => ({
        source: 'github',
        id: repo.full_name,
        name: repo.full_name,
        title: repo.name,
        description: repo.description || '',
        stars: repo.stargazers_count,
        updatedAt: repo.updated_at,
        repository: repo.html_url,
        language: repo.language,
        topics: Array.isArray(repo.topics) ? repo.topics : [],
        installable: false,
        note: 'GitHub 结果只给线索；要安装请优先用官方 Registry 的 packages/remotes，或用 mcp_hub(action="add", command=…) 手写启动命令',
      })),
    }
  })
}

/**
 * 核验候选要用的 npm 包是否真实存在，并取最新版本与下载量。
 * 一键安装前的「先验证」，避免装了个不存在的包。
 * @param {string} identifier npm 包名
 */
export async function verifyNpmPackage(identifier) {
  const key = 'verify:' + identifier
  return cached(key, async () => {
    const document = await fetchJson(NPM_BASE + '/' + String(identifier).replace('/', '%2F'), { timeoutMs: 15000 })
    if (document === null || typeof document !== 'object' || document.error !== undefined) {
      return { exists: false, identifier }
    }
    const latest = document['dist-tags'] && document['dist-tags'].latest ? document['dist-tags'].latest : null
    let downloads = null
    try {
      const stats = await fetchJson('https://api.npmjs.org/downloads/point/last-month/' + encodeURIComponent(identifier).replace('%40', '@'), { timeoutMs: 10000, attempts: 1 })
      if (stats !== null && typeof stats.downloads === 'number') downloads = stats.downloads
    } catch { /* 下载量拿不到不影响结论 */ }
    return {
      exists: true,
      identifier,
      latest,
      description: document.description || '',
      homepage: document.homepage || null,
      repository: document.repository && document.repository.url ? document.repository.url : null,
      downloadsLastMonth: downloads,
    }
  })
}

/**
 * 给一批候选补上「包是否可安装」的核验结果（只查 npm/pypi 里的 npm 包）。
 * 最多核验前 12 条，避免一次搜索打太多请求。
 */
export async function verifyCandidates(candidates) {
  const enriched = []
  let checked = 0
  for (const row of Array.isArray(candidates) ? candidates : []) {
    const pkg = Array.isArray(row.packages) ? row.packages.find((item) => item.registryType === 'npm' && item.identifier) : undefined
    if (pkg === undefined || checked >= 12) {
      enriched.push(row)
      continue
    }
    checked += 1
    try {
      const verification = await verifyNpmPackage(pkg.identifier)
      enriched.push({ ...row, verification })
    } catch (error) {
      enriched.push({ ...row, verification: { exists: false, identifier: pkg.identifier, error: String(error && error.message ? error.message : error) } })
    }
  }
  return enriched
}

/** 按 id 取一条官方 Registry 记录的完整信息。 */
export async function describeOfficial(id) {
  const key = 'describe:' + id
  return cached(key, async () => {
    const document = await fetchJson(REGISTRY_BASE + '/v0.1/servers?search=' + encodeURIComponent(id) + '&limit=20')
    const rows = Array.isArray(document.servers) ? document.servers : []
    const exact = rows.find((row) => row.server && row.server.name === id)
    const chosen = exact !== undefined ? exact : rows[0]
    if (chosen === undefined) return null
    const compact = compactRegistryRow(chosen)
    compact.raw = chosen.server
    return compact
  })
}

/**
 * 把一条检索结果翻译成注册表条目（不启动，只给配置）。
 * @param {object} candidate search/describe 返回的候选
 * @param {string} name 目标服务名（命名空间）
 * @param {object} overrides 覆盖项：args/env/url/headers
 */
export function candidateToServer(candidate, name, overrides = {}) {
  const source = candidate !== null && typeof candidate === 'object' ? candidate : {}
  const packages = Array.isArray(source.packages) ? source.packages : []
  const npmLike = packages.find((pkg) => pkg.registryType === 'npm' && pkg.identifier) ||
    packages.find((pkg) => pkg.registryType === 'pypi' && pkg.identifier)
  const remotes = Array.isArray(source.remotes) ? source.remotes : []
  const base = {
    name,
    label: source.title || source.name || name,
    description: source.description || '',
    tags: ['online'],
    source: 'online:' + String(source.source || 'unknown'),
    enabled: true,
  }
  if (npmLike !== undefined && (overrides.preferRemote !== true || remotes.length === 0)) {
    const runtime = npmLike.runtimeHint || (npmLike.registryType === 'npm' ? 'npx' : 'uvx')
    const args = []
    if (runtime === 'npx') args.push('-y')
    args.push(npmLike.identifier)
    for (const item of npmLike.runtimeArguments || []) args.push(item)
    for (const item of overrides.extraArgs || []) args.push(item)
    const env = {}
    for (const key of [...(npmLike.requiredEnv || []), ...(npmLike.optionalEnv || [])]) env[key] = ''
    Object.assign(env, overrides.env || {})
    return {
      ...base,
      transport: 'stdio',
      command: runtime === 'uvx' ? 'uvx' : (overrides.command || 'npx'),
      args: overrides.args || args,
      env,
      requires: (npmLike.requiredEnv || []).map((key) => '需要环境变量 ' + key),
      installable: true,
    }
  }
  const remote = remotes.find((item) => item.type === 'streamable-http') || remotes[0]
  if (remote !== undefined && remote.url) {
    const headers = {}
    for (const key of remote.requiredHeaders || []) headers[key] = ''
    Object.assign(headers, overrides.headers || {})
    return {
      ...base,
      transport: 'streamable-http',
      url: remote.url,
      headers,
      requires: (remote.requiredHeaders || []).map((key) => '需要请求头 ' + key),
      installable: true,
    }
  }
  return { ...base, installable: false, requires: ['该候选没有可直接使用的 npm/pypi 包或远程地址'] }
}

/** 多源一起搜：官方 Registry 优先，npm 补充，GitHub 可选。 */
export async function searchAll(query, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit || 10) || 10))
  const sources = Array.isArray(options.sources) && options.sources.length > 0 ? options.sources : ['registry', 'npm']
  const notes = []
  const results = []
  for (const source of sources) {
    try {
      if (source === 'registry') {
        const out = await searchOfficialRegistry(query, limit)
        results.push(...out.results)
      } else if (source === 'npm') {
        const out = await searchNpm(query, limit)
        // npm 搜索噪声大：只留 MCP 相关条目；官方 Registry 才是权威主源。
        const mcpLike = out.results.filter((row) => /mcp|modelcontextprotocol|context protocol/i.test(String(row.name) + ' ' + String(row.description)))
        results.push(...mcpLike)
      } else if (source === 'github') {
        const out = await searchGitHub(query, Math.min(limit, 10))
        notes.push('GitHub 检索' + (out.authenticated === true ? '（已用令牌）' : '（未用令牌，限额 10 次/分钟）'))
        results.push(...out.results)
      } else {
        notes.push('未知来源：' + source)
      }
    } catch (error) {
      notes.push(source + ' 检索失败：' + String(error && error.message ? error.message : error))
    }
  }
  const seen = new Set()
  const unique = []
  for (const row of results) {
    const key = String(row.source) + ':' + String(row.id)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(row)
  }
  // 智能排序：不重复 DSH 内置能力的、名称/描述最贴合的排前面。
  const installedKeys = new Set()
  for (const key of Array.isArray(options.installedKeys) ? options.installedKeys : []) installedKeys.add(String(key))
  // 重叠度参与排序，而「命令执行」这条规则按平台变化（Windows 上是 pwsh）。
  const ranked = rankCandidates(query, unique, installedKeys, { platform: options.platform || process.platform })
  return { query, count: ranked.length, notes, results: ranked.slice(0, Math.max(limit, 10)) }
}

export function githubTokenConfigured() {
  return githubToken() !== null
}

