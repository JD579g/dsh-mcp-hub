/**
 * dsh-mcp-hub · 宿主 HTTP API（给浏览器界面用）
 *
 * 挂在宿主 webServer 上的 /mcp-hub/api/* 前缀路由：
 *   GET  /mcp-hub/api/overview                → 状态 + 已装服务 + 目录 + 运行态
 *   GET  /mcp-hub/api/search?q=&sources=      → 在线智能搜索（含去重标记）
 *   GET  /mcp-hub/api/describe?id=            → 候选择情与安装建议
 *   POST /mcp-hub/api/install                 → 一键安装（目录名 / 在线候选 / 自定义）
 *   POST /mcp-hub/api/action                  → enable / disable / remove / reload
 *
 * 浏览器访问的是本机 loopback，且这些路径不在 /api 信任围栏内。
 * 所有 handler 都自带超时与 JSON 错误包装，异常不会把请求挂死。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { searchAll, describeOfficial, candidateToServer, verifyCandidates } from './registry.js'
import { builtinCatalog, presetCatalog, defaultServers, normalizeServer } from './state.js'
import { builtinCapabilitiesFor, overlapRules, describeOverlap, overlapsFor, searchNativeTools, nativeToolsFor } from './capabilities.js'
import { runnerStatus } from '../platform.js'
import { buildDoctor } from './doctor.js'

const MAX_BODY_BYTES = 256 * 1024

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error('请求体不是合法 JSON：' + String(error && error.message ? error.message : error))
  }
}

/** 兼容两种调用：直接传 URL 对象，或传请求对象。 */
function asUrl(input) {
  if (input instanceof URL) return input
  return new URL((input !== null && input !== undefined && input.url) || '/', 'http://localhost')
}

function reply(response, status, payload) {
  const text = JSON.stringify(payload, null, 2)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  response.end(text)
}

/**
 * 安装上下文。
 * @param {object} deps
 * @param {object} deps.config 插件配置
 * @param {object} deps.state  createState 返回的实例
 * @param {object} deps.runner MCP 运行器
 * @param {(message:string)=>void} deps.log
 */
export function createHttpApi(deps) {
  const { config, state, runner, log } = deps
  const permission = deps.permission
  const terminal = deps.terminal
  const doctor = buildDoctor({ config, state, runner, log, terminal })
  const mobile = config.isMobileDsha === true
  // Windows 上 DSH 的命令执行工具叫 pwsh 而不是 bash：所有「你已经有了」的
  // 提示都必须按这个平台事实走，否则 Windows 开发者会把提示当噪音。
  const platform = config.platform
  const nativeOptions = { mobile, platform }

  /** 当前平台可用的原生工具（手机专属能力在桌面上不展示）。 */
  function nativeTools() {
    return nativeToolsFor(nativeOptions)
  }

  /** 每次请求都重新探测：用户可能刚装好 npx/uvx。 */
  function runnerRows() {
    return runnerStatus()
  }

  function runnerMissing(runners) {
    const status = runnerRows()
    const missing = []
    for (const id of Array.isArray(runners) ? runners : []) {
      const row = status.find((item) => item.id === id)
      if (row !== undefined && row.available !== true) missing.push({ id: row.id, label: row.label, installHint: row.installHint })
    }
    return missing
  }

  /** 目录里已经装了哪些名字（按启动命令指纹判重，不只看名字）。 */
  function installedIndex() {
    const byName = new Map()
    for (const server of state.state.servers) {
      byName.set(server.name, server)
      if (server.transport === 'stdio') {
        const key = 'stdio:' + [server.command, ...(server.args || [])].join(' ')
        if (!byName.has(key)) byName.set(key, server)
      } else {
        const key = 'http:' + server.url
        if (!byName.has(key)) byName.set(key, server)
      }
    }
    return byName
  }

  function runtimeFor(name) {
    return runner.list().find((item) => item.name === name)
  }

  /** 已安装服务的界面视图。 */
  function installedView() {
    return state.state.servers.map((server) => {
      const runtime = runtimeFor(server.name)
      const enabled = server.enabled !== false
      return {
        name: server.name,
        label: server.label || server.name,
        description: server.description || '',
        tags: server.tags || [],
        source: server.source || 'user',
        transport: server.transport,
        enabled,
        state: !enabled ? 'disabled' : (runtime === undefined ? 'failed' : 'running'),
        toolCount: runtime === undefined ? 0 : runtime.toolCount,
        tools: runtime === undefined ? [] : runtime.tools,
        command: server.transport === 'stdio' ? [server.command, ...(server.args || [])].join(' ') : server.url,
        result: state.state.results.get(server.name) || null,
        builtin: (server.args || []).some((item) => String(item).includes('/lib/servers/main.js')),
        overlap: overlapsFor(server, nativeOptions),
        permission: server.permission || 'always',
      }
    })
  }

  function catalogView() {
    const installed = installedIndex()
    return [...builtinCatalog(config), ...presetCatalog()].map((entry) => {
      const isMobileOnly = Array.isArray(entry.platforms) && entry.platforms.includes('android') && entry.platforms.includes('desktop') === false
      const missing = runnerMissing(entry.runners)
      return {
        name: entry.name,
        label: entry.label,
        description: entry.description,
        tags: entry.tags,
        transport: entry.transport,
        command: entry.transport === 'stdio' ? [entry.command, ...(entry.args || [])].join(' ') : entry.url,
        requires: entry.requires || [],
        runners: entry.runners || [],
        runnerMissing: missing,
        mobileOnly: isMobileOnly,
        supported: isMobileOnly ? mobile : true,
        builtin: entry.builtin === true,
        installed: installed.has(entry.name) || installed.has(entry.transport === 'stdio' ? 'stdio:' + [entry.command, ...(entry.args || [])].join(' ') : 'http:' + entry.url),
      }
    })
  }

  /** 在线候选的界面视图：补上「已安装」与「与 DSH 内置能力重叠」标记。 */
  function candidateView(row, installed) {
    const pkg = Array.isArray(row.packages) ? row.packages[0] : undefined
    const remote = Array.isArray(row.remotes) ? row.remotes[0] : undefined
    const installKey = pkg !== undefined
      ? 'stdio:' + ['npx', '-y', pkg.identifier].join(' ')
      : (remote !== undefined ? 'http:' + remote.url : null)
    return {
      id: row.id,
      name: row.name,
      title: row.title || null,
      description: row.description || '',
      version: row.version || null,
      source: row.source,
      repository: row.repository || null,
      website: row.website || null,
      stars: row.stars,
      packages: Array.isArray(row.packages) ? row.packages : [],
      remotes: Array.isArray(row.remotes) ? row.remotes : [],
      installable: row.installable !== false,
      installed: installKey !== null && installed.has(installKey),
      overlap: describeOverlap(row, nativeOptions),
      verification: row.verification || null,
      note: row.note,
    }
  }

  async function handleOverview() {
    const running = runner.list()
    return {
      ok: true,
      plugin: { name: 'dsh-mcp-hub', dataDir: config.dataDir, registryFile: config.registryFile },
      enabled: config.enabled,
      installed: installedView(),
      catalog: catalogView(),
      capabilities: builtinCapabilitiesFor(nativeOptions),
      overlapRules: overlapRules(platform),
      permission: {
        modes: permission === undefined ? [] : permission.modes(),
        stats: permission === undefined ? null : permission.snapshot(),
      },
      terminal: { enabled: terminal !== undefined && terminal !== null, shell: terminal === undefined ? null : terminal.shell },
      nativeTools: nativeTools(),
      platform: {
        id: config.platform,
        label: config.osLabel,
        mobileDsha: mobile,
        home: config.fsRoots[0],
        fsRoots: config.fsRoots,
        dataDir: config.dataDir,
        pathSeparator: config.platform === 'win32' ? ';' : ':',
        shells: terminal === undefined || terminal === null ? [] : terminal.shells.map((item) => ({ command: item.command, label: item.label })),
      },
      runners: runnerRows(),
      counts: {
        installed: state.state.servers.length,
        running: running.length,
        tools: running.reduce((sum, item) => sum + item.toolCount, 0),
        catalog: state.state.catalog.length,
        native: nativeTools().length,
      },
      lastReconcile: state.state.lastReconcile,
      failures: state.state.reconcileFailures,
      log: (deps.logLines || []).slice(-30),
    }
  }

  async function handleSearch(query) {
    const url = asUrl(query)
    const text = String(url.searchParams.get('q') || '').trim()
    if (text === '') return { ok: false, error: '缺少 q' }
    const sourcesParam = url.searchParams.get('sources')
    const sources = sourcesParam === null || sourcesParam === ''
      ? ['registry', 'npm']
      : sourcesParam.split(',').map((item) => item.trim()).filter((item) => item !== '')
    const out = await searchAll(text, { limit: 12, sources })
    const installed = installedIndex()
    const verified = await verifyCandidates(out.results).catch(() => out.results)
    // 原生工具也进结果：它们不需要安装，但统一展示「其实不用装」。
    const native = searchNativeTools(text, nativeOptions).map((tool) => ({
      id: 'native:' + tool.tool,
      kind: 'native',
      source: 'native',
      name: tool.tool,
      title: tool.label,
      description: tool.description,
      installable: false,
      installed: true,
      permissionable: tool.permissionable === true,
      overlap: { level: 'none', hits: [], summary: 'DSH 原生工具，无需安装' },
      note: '这是 DSH 自带能力；可在原生工具区设置权限',
    }))
    return {
      ok: true,
      query: out.query,
      notes: [...out.notes, native.length > 0 ? '另有 ' + native.length + ' 个 DSH 原生工具命中' : ''].filter((item) => item !== ''),
      count: verified.length + native.length,
      native,
      results: verified.map((row) => candidateView(row, installed)),
    }
  }

  async function handleDescribe(input) {
    const url = asUrl(input)
    const id = String(url.searchParams.get('id') || '').trim()
    if (id === '') return { ok: false, error: '缺少 id' }
    const registered = state.state.servers.find((item) => item.name === id)
    if (registered !== undefined) return { ok: true, kind: 'installed', server: installedView().find((item) => item.name === id) }
    const inCatalog = state.catalogIndex().get(id)
    if (inCatalog !== undefined) {
      return {
        ok: true,
        kind: 'catalog',
        server: {
          name: inCatalog.name,
          label: inCatalog.label,
          description: inCatalog.description,
          tags: inCatalog.tags,
          transport: inCatalog.transport,
          command: inCatalog.transport === 'stdio' ? [inCatalog.command, ...(inCatalog.args || [])].join(' ') : inCatalog.url,
          requires: inCatalog.requires || [],
        },
      }
    }
    const online = await describeOfficial(id)
    if (online === null) return { ok: true, found: false }
    const suggestion = candidateToServer(online, suggestName(id), {})
    return { ok: true, kind: 'online', candidate: candidateView(online, installedIndex()), installSuggestion: suggestion }
  }

  function suggestName(id) {
    const base = String(id).replace(/^[^/]*\//, '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 28)
    const safe = base === '' ? 'mcp' : base
    if (!state.state.servers.some((item) => item.name === safe)) return safe
    for (let index = 2; index < 100; index += 1) {
      const candidate = (safe.slice(0, 26) + '-' + index).slice(0, 32)
      if (!state.state.servers.some((item) => item.name === candidate)) return candidate
    }
    return (safe.slice(0, 30) + '-x')
  }

  /** 一键安装：目录名 / 在线候选 ID / 完全自定义配置。 */
  async function handleInstall(body) {
    const mode = String(body.mode || 'catalog')
    const name = typeof body.name === 'string' && body.name !== '' ? body.name : null
    if (mode === 'catalog') {
      const entryName = name || String(body.catalogName || '')
      if (entryName === '') return { ok: false, error: '缺少要安装的目录条目名' }
      const entry = state.catalogIndex().get(entryName)
      if (entry === undefined) return { ok: false, error: '目录里没有：' + entryName }
      // 桌面/手机平台差异：手机专属服务在桌面上直接拦下，并说明原因。
      const mobileOnly = Array.isArray(entry.platforms) && entry.platforms.includes('android') && entry.platforms.includes('desktop') === false
      if (mobileOnly && mobile !== true) {
        return { ok: false, error: '「' + entryName + '」是手机（DSHA 安卓）专属能力，当前平台是 ' + config.osLabel + '，装了也没有意义', mobileOnly: true }
      }
      // 运行器缺失就别让用户白等一次失败：直接把安装命令给他。
      const missing = runnerMissing(entry.runners)
      if (missing.length > 0) {
        return {
          ok: false,
          error: '「' + entryName + '」需要 ' + missing.map((item) => item.label).join('、') + '，当前没找到。',
          fix: missing.map((item) => item.label + '：' + item.installHint).join('\n'),
          runnerMissing: missing,
        }
      }
      const target = name !== null && name !== entryName ? name : entryName
      const result = await state.applyMutation({ action: 'add', payload: { name: target, fromCatalog: entryName, enabled: true } })
      return { ok: true, action: 'install', target, ...result, installed: installedView() }
    }
    if (mode === 'online') {
      const id = String(body.id || '')
      if (id === '') return { ok: false, error: '缺少候选 id' }
      const online = await describeOfficial(id)
      if (online === null) return { ok: false, error: '在线 Registry 里没有：' + id }
      const target = name !== null ? name : suggestName(online.name || online.id)
      const suggestion = candidateToServer(online, target, {
        env: body.env,
        headers: body.headers,
        extraArgs: Array.isArray(body.extraArgs) ? body.extraArgs : undefined,
        preferRemote: body.preferRemote === true,
      })
      if (suggestion.installable === false) return { ok: false, error: '该候选没有可直接使用的包或远程地址', suggestion }
      const result = await state.applyMutation({ action: 'add', payload: { ...suggestion, name: target, enabled: true } })
      return { ok: true, action: 'install', target, ...result, installed: installedView() }
    }
    if (mode === 'custom') {
      if (name === null) return { ok: false, error: '自定义安装需要 name' }
      const server = normalizeServer({
        name,
        transport: body.transport,
        command: body.command,
        args: body.args,
        env: body.env,
        url: body.url,
        headers: body.headers,
        label: body.label,
        description: body.description,
        tags: body.tags,
        enabled: true,
      }, null)
      const result = await state.applyMutation({ action: 'add', payload: server })
      return { ok: true, action: 'install', target: name, ...result, installed: installedView() }
    }
    return { ok: false, error: '未知安装模式：' + mode }
  }

  async function handleAction(body) {
    const action = String(body.action || '')
    const name = typeof body.name === 'string' ? body.name : ''
    if (['enable', 'disable', 'remove', 'test', 'add'].includes(action) && name === '' && action !== 'add') {
      return { ok: false, error: action + ' 需要 name' }
    }
    if (action === 'reload') {
      const result = await state.applyMutation({ action: 'reload', payload: {} })
      return { ok: true, action, ...result, installed: installedView() }
    }
    if (action === 'enable' || action === 'disable' || action === 'remove') {
      const result = await state.applyMutation({ action, payload: { name } })
      return { ok: true, action, name, ...result, installed: installedView() }
    }
    if (action === 'test') {
      const server = state.state.servers.find((item) => item.name === name) || state.catalogIndex().get(name)
      if (server === undefined) return { ok: false, error: '注册表和目录里都没有：' + name }
      const probe = await runner.probe(server, config.toolCallTimeoutMs)
      return { ok: true, action, name, probe }
    }
    return { ok: false, error: '未知动作：' + action }
  }

  /** 改某个 MCP 服务的调用权限（always / session / ask / disabled）。 */
  async function handlePermission(body) {
    const name = String(body.name || '')
    const mode = String(body.mode || '')
    if (name === '') return { ok: false, error: '需要 name' }
    if (!['always', 'session', 'ask', 'disabled'].includes(mode)) return { ok: false, error: '未知权限：' + mode }
    const server = state.state.servers.find((item) => item.name === name)
    if (server === undefined) return { ok: false, error: '注册表里没有服务：' + name }
    server.permission = mode
    await state.saveRegistry()
    // 权限收紧时丢掉「本会话已同意」的缓存，避免旧授权继续生效
    if (permission !== undefined && (mode === 'ask' || mode === 'disabled')) permission.revoke(name)
    log('权限变更：' + name + ' → ' + mode)
    return { ok: true, name, permission: mode, installed: installedView() }
  }

  /** 终端：run / poll / close / new。 */
  async function handleTerminal(input, body, method) {
    const url = asUrl(input)
    if (terminal === undefined || terminal === null) return { ok: false, error: '终端服务未启用' }
    if (method === 'GET') {
      const id = String(url.searchParams.get('id') || '')
      if (id === '') return { ok: false, error: '需要 id' }
      return terminal.poll(id, url.searchParams.get('cursor') || 0)
    }
    const action = String(body.action || 'run')
    const id = typeof body.id === 'string' && body.id !== '' ? body.id : null
    if (action === 'run') {
      const command = String(body.command || '')
      const result = terminal.run(id, command)
      return { ok: result.ok !== false, ...result }
    }
    if (action === 'new') {
      const result = terminal.run(null, ':')
      return { ok: true, id: result.id, note: '新会话已创建' }
    }
    if (action === 'close') {
      if (id === null) return { ok: false, error: '需要 id' }
      return { ok: true, closed: terminal.close(id, 'user') }
    }
    if (action === 'stat') {
      if (id === null) return { ok: true, sessions: terminal.list() }
      return { ok: true, stat: terminal.stat(id) }
    }
    return { ok: false, error: '未知终端动作：' + action }
  }

  /** 通用分发：把 HTTP 请求映射到一个 JSON 结果。 */
  async function dispatch(request) {
    const url = new URL(request.url || '/', 'http://localhost')
    const route = url.pathname.replace(/^\/mcp-hub\/api\//, '')
    if (request.method === 'GET') {
      if (route === 'overview') return handleOverview()
      if (route === 'search') return handleSearch(url)
      if (route === 'describe') return handleDescribe(url)
      if (route === 'terminal') return handleTerminal(url, {}, 'GET')
      if (route === 'doctor') return { ok: true, ...(await doctor()) }
      if (route === 'ping') return { ok: true, pong: Date.now() }
      return { ok: false, error: '未知路由：GET ' + route }
    }
    const body = await readBody(request)
    if (route === 'install') return handleInstall(body)
    if (route === 'action') return handleAction(body)
    if (route === 'permission') return handlePermission(body)
    if (route === 'terminal') return handleTerminal(url, body, 'POST')
    return { ok: false, error: '未知路由：POST ' + route }
  }

  /**
   * 注册路由；webServer 不可用时静默跳过（界面只是没有数据源，不会更糟）。
   * @param {object} ctx cordis 上下文
   */
  function register(ctx) {
    let done = false
    const attempt = (source, label) => {
      if (done) return true
      const webServer = source.get('webServer')
      if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return false
      try {
        webServer.register({
          kind: 'prefix',
          path: '/mcp-hub/api',
          async handler(request, response) {
            try {
              const result = await dispatch(request)
              reply(response, result !== null && result.ok === false ? 400 : 200, result)
            } catch (error) {
              reply(response, 500, { ok: false, error: String(error && error.message ? error.message : error) })
            }
          },
        })
        done = true
        log('已注册 HTTP API：/mcp-hub/api/*（' + (label || 'direct') + '）')
        return true
      } catch (error) {
        log('注册 HTTP 路由失败：' + String(error && error.message ? error.message : error))
        return false
      }
    }
    // 先直接试一次；行启动顺序不保证 webServer 已就绪，所以再挂一个服务注入等待。
    if (attempt(ctx, 'direct')) return true
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['webServer'], (scoped) => { attempt(scoped, 'service-inject') })
        log('webServer 尚未就绪：已挂上服务注入，等它出现后注册 /mcp-hub/api/*')
        return true
      } catch (error) {
        log('挂服务注入失败：' + String(error && error.message ? error.message : error))
      }
    }
    log('webServer 不可用：界面数据源不可用（模型侧工具与 /mcp 命令仍然可用）')
    return false
  }

  return { register, installedView, catalogView, candidateView, suggestName, handleInstall, handleAction, handlePermission, handleTerminal, handleOverview, handleSearch, handleDescribe, doctor, runnerRows, runnerMissing }
}

