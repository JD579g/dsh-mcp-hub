/**
 * dsh-mcp-hub · 集成测试（假 cordis 上下文）
 *
 * 用最小实现的 ctx 把插件真正跑起来：
 *   - 检查注册表初始化与目录生成；
 *   - 检查默认内置服务是否全部连上、工具是否按 mcp__<server>__<tool> 注册；
 *   - 检查 mcp_hub 工具与 /mcp 命令；
 *   - 检查变更队列（add/disable/remove/reload）真的会改变运行态。
 *
 * 用法：node tests/plugin-integration.mjs
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// os.tmpdir()：Windows 上是 %TEMP%，POSIX 上是 /tmp，两边都对。
const DATA_DIR = path.join(os.tmpdir(), 'mcp-hub-test')
const REGISTRY = path.join(DATA_DIR, 'servers.json')

// 干净环境
await fs.rm(DATA_DIR, { recursive: true, force: true })

const registered = new Map()
const commands = new Map()
const listeners = new Map()
const fakeCtx = {
  get(service) {
    if (service === 'tools') {
      return {
        register(definition) {
          if (registered.has(definition.name)) throw new Error('duplicate tool: ' + definition.name)
          registered.set(definition.name, definition)
          return () => registered.delete(definition.name)
        },
      }
    }
    if (service === 'commands') {
      return {
        register(command) {
          if (commands.has(command.name)) throw new Error('duplicate command: ' + command.name)
          commands.set(command.name, command)
          return () => commands.delete(command.name)
        },
      }
    }
    return undefined
  },
  on(event, handler) {
    const list = listeners.get(event) || []
    list.push(handler)
    listeners.set(event, list)
    return () => {}
  },
}

const { importLib, sdkOrSkip } = await import('./helpers.mjs')
// 这个测试会真的把内置 MCP 服务拉起来，需要 SDK。
await sdkOrSkip('插件集成测试（假 cordis 上下文）')
const { apply } = await importLib('index.js')
apply(fakeCtx, {
  dataDir: DATA_DIR,
  registryFile: REGISTRY,
  reconcileIntervalMs: 1000,
  logLimit: 50,
  bootstrapServers: ['hub', 'files', 'util', 'kb'],
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 等初始化完成：注册表出现且默认服务上线
let ready = false
for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
  await sleep(500)
  try {
    const doc = JSON.parse(await fs.readFile(REGISTRY, 'utf8'))
    ready = doc.servers.length >= 4 && registered.has('mcp_hub') && [...registered.keys()].some((name) => name.startsWith('mcp__files__'))
  } catch { /* 还没写出来 */ }
}

const report = { ready }
report.registry = JSON.parse(await fs.readFile(REGISTRY, 'utf8'))
report.registeredToolCount = registered.size
report.sampleTools = [...registered.keys()].sort().slice(0, 40)
report.commands = [...commands.keys()]
report.mcpHubPresent = registered.has('mcp_hub')

// 调一次 mcp_hub（list / catalog）
if (registered.has('mcp_hub')) {
  const tool = registered.get('mcp_hub')
  const listed = await tool.execute({ action: 'list' }, {})
  report.listSummary = { servers: listed.servers.map((item) => ({ name: item.name, state: item.state, toolCount: item.toolCount })) }
  const catalog = await tool.execute({ action: 'catalog', q: '内置' }, {})
  report.catalogCount = catalog.count
}

// 走一遍 MCP 工具的真实调用：mcp__files__write → mcp__files__read
async function callTool(name, args) {
  const definition = registered.get(name)
  if (definition === undefined) throw new Error('missing tool: ' + name)
  const value = await definition.execute(args, {})
  return definition.output.render(args, value)[0].text
}

if (registered.has('mcp__files__write') && registered.has('mcp__files__read')) {
  // 必须用 os.tmpdir()：写死 /tmp 在 macOS 上是 /var/folders/...，在 Windows 上会变成
  // 当前盘符下的 \tmp，两者都落在允许根目录之外 —— CI 上就是这么炸的。
  const e2ePath = path.join(os.tmpdir(), 'mcp-hub-e2e.txt')
  await callTool('mcp__files__write', { path: e2ePath, content: 'e2e ok' })
  report.toolCallText = (await callTool('mcp__files__read', { path: e2ePath })).slice(0, 120)
}

// 变更队列：新增内置 device（走 catalog 名）、停用 kb、再删掉 device
const tool = registered.get('mcp_hub')
if (tool !== undefined) {
  const added = await tool.execute({ action: 'add', name: 'device', fromCatalog: 'device' }, {})
  report.afterAdd = { created: added.created, started: added.started, running: added.running.map((item) => item.name) }
  report.deviceToolsAfterAdd = [...registered.keys()].filter((name) => name.startsWith('mcp__device__')).length
  const disabled = await tool.execute({ action: 'disable', name: 'kb' }, {})
  report.afterDisable = { stopped: disabled.stopped, kbToolsLeft: [...registered.keys()].filter((name) => name.startsWith('mcp__kb__')).length }
  const removed = await tool.execute({ action: 'remove', name: 'device' }, {})
  report.afterRemove = { stopped: removed.stopped, deviceToolsLeft: [...registered.keys()].filter((name) => name.startsWith('mcp__device__')).length }
  const tested = await tool.execute({ action: 'test', name: 'net' }, {})
  report.probeNet = { ok: tested.ok, tools: tested.tools.map((item) => item.rawName) }

  // 在线检索：官方 MCP Registry + npm（按需搜索，不预先全量拉取）
  const search = await tool.execute({ action: 'search', action_q: undefined, q: 'sqlite', sources: ['registry', 'npm'] }, {})
  report.searchSqlite = {
    count: search.count,
    notes: search.notes,
    top: search.results.slice(0, 4).map((row) => ({ source: row.source, id: row.id, how: (row.packages && row.packages[0]) ? row.packages[0].identifier : ((row.remotes && row.remotes[0]) ? row.remotes[0].url : null) })),
  }
  const first = search.results[0]
  if (first !== undefined) {
    const described = await tool.execute({ action: 'describe', name: first.id }, {})
    report.describeFirst = { kind: described.kind, found: described.found, suggestion: described.installSuggestion === undefined ? undefined : { transport: described.installSuggestion.transport, command: described.installSuggestion.command, args: described.installSuggestion.args } }
  }
  // 从在线候选安装并真正挂载（走 npm 包，首次会 npx 下载）
  const installTarget = search.results.find((row) => row.source === 'npm' && row.packages && row.packages[0] && /^@/.test(String(row.packages[0].identifier)) === false && row.packages[0].identifier)
  if (installTarget !== undefined) {
    try {
      const online = await tool.execute({ action: 'add', name: 'online-smoke', list_install: undefined, install: { transport: 'stdio', command: 'npx', args: ['-y', installTarget.packages[0].identifier] } }, {})
      report.installOnline = { created: online.created, started: online.started, failed: online.failed, tools: [...registered.keys()].filter((name) => name.startsWith('mcp__online-smoke__')).length }
      await tool.execute({ action: 'remove', name: 'online-smoke' }, {})
    } catch (error) {
      report.installOnline = { error: String(error && error.message ? error.message : error).slice(0, 300) }
    }
  }
}


// ── HTTP API：权限、终端、原生工具检索 ─────────────────────────────────────
{
  const { createServer } = await import('node:http')
  const { createHttpApi } = await importLib('host', 'http-api.js')
  const { createPermissionGate } = await importLib('host', 'permission.js')
  const { createTerminalService } = await importLib('host', 'terminal.js')
  const { createMcpRunner } = await importLib('host', 'runner.js')
  const { createState, resolveConfig } = await importLib('host', 'state.js')

  const httpConfig = resolveConfig({ dataDir: DATA_DIR, registryFile: REGISTRY, bootstrapServers: ['files', 'util'] })
  // 独立工具表，避免与主插件的注册表撞名
  const apiTools = new Map()
  const apiToolsService = {
    register(definition) {
      apiTools.set(definition.name, definition)
      return () => apiTools.delete(definition.name)
    },
  }
  const httpRunner = createMcpRunner({ tools: apiToolsService, log: () => {} })
  const gate = createPermissionGate({ approver: () => ({ request: async () => 'rejected' }), permissionOf: () => ({ permission: 'ask' }), log: () => {} })
  const term = createTerminalService({ log: () => {}, cwd: '/root' })
  const httpState = createState({ config: httpConfig, runner: httpRunner, log: () => {} })
  await httpState.buildCatalog()
  await httpState.loadRegistry()
  await httpState.reconcile()
  const api = createHttpApi({ config: httpConfig, state: httpState, runner: httpRunner, log: () => {}, logLines: [], permission: gate, terminal: term })
  // 直接调 handler，避免自己造 HTTP 协议层
  async function get(route, params) {
    const url = new URL('http://localhost/mcp-hub/api/' + route + (params ? '?' + new URLSearchParams(params).toString() : ''))
    if (route === 'overview') return api.handleOverview()
    if (route === 'search') return api.handleSearch(url)
    if (route === 'describe') return api.handleDescribe(url)
    if (route === 'terminal') return api.handleTerminal(url, {}, 'GET')
    return { ok: false, error: 'no route' }
  }
  async function post(route, body) {
    if (route === 'permission') return api.handlePermission(body)
    if (route === 'terminal') return api.handleTerminal(new URL('http://localhost/mcp-hub/api/terminal'), body, 'POST')
    if (route === 'action') return api.handleAction(body)
    if (route === 'install') return api.handleInstall(body)
    return { ok: false, error: 'no route' }
  }

  const overview = await get('overview')
  report.api = { overviewOk: overview.ok, installed: overview.installed.length, nativeTools: overview.nativeTools.length, permissionModes: overview.permission.modes.length, terminal: overview.terminal.enabled }

  const nativeSearch = await get('search', { q: 'bash' })
  report.api.nativeHits = (nativeSearch.native || []).map((item) => item.name)

  const before = overview.installed.find((item) => item.name === 'files')
  const changed = await post('permission', { name: 'files', mode: 'ask' })
  report.api.permissionChanged = { ok: changed.ok, mode: changed.installed.find((item) => item.name === 'files').permission, was: before.permission }

  // 权限闸门真实行为：配置 ask + 审批返回 rejected → 拒绝执行
  const denied = await gate.check('files', { agent: { session: { id: 'sess-1' } }, callId: 'call-1' })
  report.api.gateDenied = { allowed: denied.allowed, reason: String(denied.reason).slice(0, 40) }
  const gate2 = createPermissionGate({ approver: () => ({ request: async () => 'allowed-once' }), permissionOf: () => ({ permission: 'session' }), log: () => {} })
  const firstAsk = await gate2.check('files', { agent: { session: { id: 'sess-2' } }, callId: 'c1' })
  const secondAsk = await gate2.check('files', { agent: { session: { id: 'sess-2' } }, callId: 'c2' })
  report.api.gateSession = { first: firstAsk.allowed, second: secondAsk.allowed, cached: secondAsk.cached === true }
  const gate3 = createPermissionGate({ approver: () => ({ request: async () => 'allowed-once' }), permissionOf: () => ({ permission: 'disabled' }), log: () => {} })
  const disabled = await gate3.check('files', { agent: { session: { id: 's' } } })
  report.api.gateDisabled = { allowed: disabled.allowed }

  // 终端：跑一条命令并取回输出
  const run = await post('terminal', { action: 'run', command: 'echo mcp-hub-terminal && pwd' })
  await sleep(600)
  const polled = await get('terminal', { id: run.id, cursor: 0 })
  report.api.terminal = { runOk: run.ok === true, id: run.id, output: String(polled.output || '').slice(0, 160) }
  await post('terminal', { action: 'close', id: run.id })
  term.dispose()
  await httpRunner.stopAll()
}

// 卸载：应触发 dispose 关掉全部子进程
for (const handler of listeners.get('dispose') || []) handler()
await sleep(800)

console.log(JSON.stringify(report, null, 2))
const ok = report.ready === true &&
  report.registeredToolCount > 0 &&
  report.afterDisable !== undefined && report.afterDisable.kbToolsLeft === 0 &&
  report.afterRemove !== undefined && report.afterRemove.deviceToolsLeft === 0 &&
  report.probeNet !== undefined && report.probeNet.ok === true
process.exitCode = ok ? 0 : 1

