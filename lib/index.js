/**
 * dsh-mcp-hub · 宿主插件入口
 *
 * 一个「MCP 与工具一键部署」插件：维护一份可手改的服务注册表，运行时直连
 * MCP 服务并把它们的工具注册进 DSH；同时内置一套零依赖的 MCP 工具包
 * （files / exec / net / kb / util / device / hub，共 59 个工具），
 * 无需联网、无需 npx 即可用。
 *
 * 设计纪律（与同目录 dsh-auto-compact 一致）：
 *   - 模块顶层不 import 任何第三方包，也不写模块级 inject：
 *     缺服务只会少做一件事，永远不会让整棵 plugin tree 加载失败。
 *   - 所有对外回调都包 try/catch，异常只记录。
 *   - 直连模式：加/卸服务是运行时操作，不写 cordis.yml、不需要重启。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createMcpRunner } from './host/runner.js'
import { createState, resolveConfig, runtimeEnv, SERVER_ENTRY, BUILTIN_NAMES, queryEnvelopeId } from './host/state.js'
import { searchAll, describeOfficial, candidateToServer, githubTokenConfigured } from './host/registry.js'
import { createHttpApi } from './host/http-api.js'
import { createPermissionGate } from './host/permission.js'
import { createTerminalService } from './host/terminal.js'

export const name = 'dsh-mcp-hub'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')

function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (error instanceof Error) return error.message || String(error)
  return typeof error === 'string' ? error : JSON.stringify(error)
}

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })
const obj = (description) => ({ type: 'object', properties: {}, additionalProperties: true, description })
const strArray = (description) => ({ type: 'array', items: { type: 'string' }, description })

function jsonOutput() {
  return {
    // 注意：output.schema 会被 tools.register() 按「原始 JSON Schema」校验，
    // 只认 object/array/string/number/integer/boolean/null；写成 { type: 'json' }
    // 会在真实 DSH 里注册时抛错（假 ctx 测试发现不了，真装配测试能）。
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render(_args, value) {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
  }
}

/**
 * Plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const startedAt = Date.now()
  const logLines = []
  const state = {
    disposed: false,
    lastMutationId: null,
    lastError: null,
    reconciles: 0,
    mutations: 0,
    failures: 0,
    timer: null,
  }

  const log = (message) => {
    const line = new Date().toISOString() + ' ' + message
    logLines.push(line)
    while (logLines.length > config.logLimit) logLines.shift()
    try { console.log('[dsh-mcp-hub] ' + message) } catch { /* 忽略 */ }
    void fs.mkdir(path.dirname(config.logFile), { recursive: true })
      .then(() => fs.appendFile(config.logFile, line + '\n', 'utf8'))
      .catch(() => {})
  }

  if (!config.enabled) {
    log('已在配置中禁用（enabled: false），不连接任何 MCP 服务')
    return
  }

  // 引导：加载器并行启动各行，apply 时 tools 行常常还没就绪，
  // 这时 ctx.get('tools') 必然是 undefined。用 ctx.inject 建一个子 fiber 等服务出现，
  // 既不会让本行 pending（不会拖垮插件树），也不会漏掉启动。
  let booted = false
  const boot = (activeCtx) => {
    if (booted) return
    const candidate = activeCtx.get('tools')
    if (candidate === undefined || candidate === null || typeof candidate.register !== 'function') return
    booted = true
    try {
      start(activeCtx, candidate)
    } catch (error) {
      log('启动失败：' + describeError(error))
    }
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], (scoped) => boot(scoped))
    } catch (error) {
      log('挂 tools 服务注入失败：' + describeError(error))
    }
  }
  boot(ctx)

  function start(activeCtx, tools) {

  // MCP 子进程需要 DSH 桥令牌来使用 device 服务：从宿主环境或文件补齐。
  void ensureBridgeToken()

  // 审批通道（ctx.approval）用于「使用时询问」；取不到就按失败关闭处理。
  const permission = createPermissionGate({
    // 每次调用都现读：审批服务可能比本插件晚就绪（懒解析，避免拿到 undefined 就永久失败关闭）。
    approver: () => {
      const live = activeCtx.get('approval')
      return live !== undefined && live !== null && typeof live.request === 'function' ? live : undefined
    },
    permissionOf: (server) => hub.state.servers.find((item) => item.name === server) || {},
    log,
  })
  const terminal = createTerminalService({ log, cwd: process.env.DSH_WORKSPACE || process.cwd() })
  const runner = createMcpRunner({ tools, log, permissionGate: (server, exec) => permission.check(server, exec) })
  const hub = createState({ config, runner, log })
  const httpApi = createHttpApi({ config, state: hub, runner, log, logLines, permission, terminal })

  const install = async () => {
    // 每一步独立容错：注册工具失败不该把命令、路由、MCP 服务一起带走。
    const step = async (label, run) => {
      try {
        return await run()
      } catch (error) {
        state.failures += 1
        state.lastError = describeError(error)
        log('步骤失败（' + label + '）：' + state.lastError)
        return undefined
      }
    }
    await step('生成目录', () => hub.buildCatalog())
    await step('读取注册表', () => hub.loadRegistry())
    await step('注册 mcp_hub 工具', () => installTool())
    await step('注册 /mcp 命令', () => installBridge())
    await step('注册 HTTP 路由', () => httpApi.register(activeCtx))
    const result = await step('连接 MCP 服务', () => hub.reconcile()) || { failed: [] }
    log('就绪：注册表 ' + hub.state.servers.length + ' 项，已连接 ' + runner.list().length + ' 个服务（工具 ' +
      runner.list().reduce((sum, item) => sum + item.toolCount, 0) + ' 个）' +
      (result.failed !== undefined && result.failed.length > 0 ? '，失败 ' + result.failed.length + ' 个' : ''))
    state.timer = setInterval(() => { void tick() }, Math.max(1000, config.reconcileIntervalMs))
    if (typeof state.timer.unref === 'function') state.timer.unref()
  }

  // ── /mcp 命令：用户侧入口 ────────────────────────────────────────────────
  function installBridge() {
    const registerWith = (service) => {
      if (service === undefined || service === null || typeof service.register !== 'function') return false
      try {
        service.register({
        name: 'mcp',
        description: 'MCP Hub：查看/搜索/启用/停用/添加/卸载 MCP 服务。子命令：doctor（环境体检）、list、catalog、search <关键词>、describe <候选ID>、enable <名>、disable <名>、add <名> [目录名]、remove <名>、test <名>、permission <名> <权限>、reload、status。',
        input: { hint: '[doctor|list|catalog|search <关键词>|describe <ID>|enable <名>|disable <名>|add <名> [目录名]|remove <名>|test <名>|permission <名> <always|session|ask|disabled>|reload|status]' },
        async handler(invocation) {
          const raw = String((invocation && invocation.rawInput) || '').trim()
          const [sub, ...rest] = raw.split(/\s+/).filter((item) => item !== '')
          try {
            const text = await runCommandText(sub, rest)
            return { kind: 'success', text }
          } catch (error) {
            return { kind: 'error', text: 'MCP Hub：' + describeError(error) }
          }
        },
        })
        return true
      } catch (error) {
        log('注册 /mcp 命令失败：' + describeError(error))
        return false
      }
    }
    // 命令服务可能比本插件晚就绪：先直接试，再挂注入等待。
    if (registerWith(activeCtx.get('commands'))) {
      log('已注册 /mcp 命令')
      return
    }
    if (typeof activeCtx.inject === 'function') {
      try {
        activeCtx.inject(['commands'], (scoped) => {
          if (registerWith(scoped.get('commands'))) log('已注册 /mcp 命令（等 commands 就绪后）')
        })
        return
      } catch (error) {
        log('挂 commands 服务注入失败：' + describeError(error))
      }
    }
    log('commands 服务不可用：/mcp 命令未注册（模型侧 mcp_hub 工具仍然可用）')
  }

  async function runCommandText(sub, rest) {
    const action = sub === undefined || sub === '' ? 'list' : sub
    if (action === 'list' || action === 'ls') return textList()
    if (action === 'status') return JSON.stringify(statusReport(), null, 2)
    if (action === 'catalog') return textCatalog(rest.join(' '))
    if (action === 'search') {
      const query = rest.join(' ')
      if (query === '') throw new Error('search 需要关键词')
      const out = await searchAll(query, { limit: 10, sources: ['registry', 'npm'] })
      return textSearch(out)
    }
    if (action === 'describe') {
      if (rest.length === 0) throw new Error('describe 需要候选 ID')
      return JSON.stringify(await describeCandidate(rest.join(' ')), null, 2)
    }
    if (action === 'enable' || action === 'disable' || action === 'remove') {
      if (rest.length === 0) throw new Error(action + ' 需要服务名')
      const result = await hub.applyMutation({ action, payload: { name: rest[0] } })
      return textAction(action, rest[0], result)
    }
    if (action === 'add') {
      if (rest.length === 0) throw new Error('add 需要服务名（内置：' + BUILTIN_NAMES.join('/') + '；目录名见 /mcp catalog）')
      const name = rest[0]
      const fromCatalog = rest[1] === undefined ? name : rest[1]
      const result = await hub.applyMutation({ action: 'add', payload: { name, fromCatalog } })
      return textAction('add', name, result)
    }
    if (action === 'test') {
      if (rest.length === 0) throw new Error('test 需要服务名')
      const result = await probeServer(rest[0])
      return JSON.stringify(result, null, 2)
    }
    if (action === 'doctor' || action === 'check') {
      const report = await httpApi.doctor()
      const lines = ['体检：' + report.summary, '平台：' + report.platform.label + (report.platform.mobileDsha ? '（DSH 安卓）' : '')]
      for (const item of report.items) {
        const mark = item.level === 'ok' ? '✓' : (item.level === 'warn' ? '!' : '✗')
        lines.push(mark + ' ' + item.title + '：' + item.detail + (item.fix === null ? '' : '  → 修复：' + item.fix))
      }
      return lines.join('\n')
    }
    if (action === 'permission' || action === 'perm') {
      if (rest.length < 2) throw new Error('permission 需要「服务名 权限」；权限取 always / session / ask / disabled')
      const result = await setPermission(rest[0], rest[1])
      return '权限已更新：' + result.name + ' → ' + result.permission
    }
    if (action === 'reload') {
      const result = await hub.applyMutation({ action: 'reload', payload: {} })
      return '已重新同步：启动 ' + (result.started || []).length + '，停止 ' + (result.stopped || []).length + '，失败 ' + (result.failed || []).length
    }
    throw new Error('未知子命令：' + action)
  }

  function textList() {
    const rows = hub.state.servers.map((server) => {
      const runtime = runner.list().find((item) => item.name === server.name)
      const mark = server.enabled === false ? '停用' : (runtime === undefined ? '未连接' : '运行中')
      const command = server.transport === 'stdio' ? [server.command, ...(server.args || [])].join(' ') : server.url
      return '- [' + mark + '] ' + server.name + '（' + (runtime === undefined ? 0 : runtime.toolCount) + ' 个工具）' + (server.label ? ' · ' + server.label : '') + '\n    ' + command
    })
    return ['已注册 ' + hub.state.servers.length + ' 个 MCP 服务：', ...rows].join('\n')
  }

  function textCatalog(query) {
    const index = hub.catalogIndex()
    const needle = String(query || '').toLowerCase()
    const rows = [...index.values()]
      .filter((entry) => needle === '' || (entry.name + ' ' + entry.label + ' ' + entry.description).toLowerCase().includes(needle))
      .map((entry) => {
        const installed = hub.state.servers.some((item) => item.name === entry.name)
        const command = entry.transport === 'stdio' ? [entry.command, ...(entry.args || [])].join(' ') : entry.url
        return '- ' + entry.name + (installed ? '（已安装）' : '') + ' · ' + entry.label + '\n    ' + entry.description + '\n    ' + command +
          (entry.requires && entry.requires.length > 0 ? '\n    ⚠ ' + entry.requires.join('；') : '')
      })
    return ['目录共 ' + index.size + ' 项，匹配 ' + rows.length + ' 项：', ...rows].join('\n')
  }

  function textSearch(out) {
    const lines = ['搜索「' + out.query + '」命中 ' + out.count + ' 条：']
    for (const row of out.results.slice(0, 15)) {
      const pkg = (row.packages || [])[0]
      const remote = (row.remotes || [])[0]
      const how = pkg !== undefined ? (pkg.runtimeHint || 'npx') + ' ' + pkg.identifier : (remote !== undefined ? remote.url : '（仅线索）')
      const env = pkg !== undefined && pkg.requiredEnv && pkg.requiredEnv.length > 0 ? '  需要环境变量：' + pkg.requiredEnv.join('、') : ''
      lines.push('- [' + row.source + '] ' + row.id + (row.title ? '（' + row.title + '）' : '') + '\n    ' + String(row.description || '').slice(0, 140) + '\n    ' + how + env)
    }
    for (const note of out.notes || []) lines.push('· ' + note)
    lines.push('下一步：/mcp describe <候选ID> 看细节，或 /mcp add <你的服务名> <候选ID> 直接安装')
    return lines.join('\n')
  }

  function textAction(action, name, result) {
    const lines = [action + ' ' + name + ' 完成']
    if (result.created !== undefined) lines.push('新建条目：' + String(result.created))
    if (result.enabled !== undefined) lines.push('启用状态：' + String(result.enabled))
    if (result.started !== undefined) lines.push('本次启动：' + (result.started.length > 0 ? result.started.join('、') : '无'))
    if (result.stopped !== undefined) lines.push('本次停止：' + (result.stopped.length > 0 ? result.stopped.join('、') : '无'))
    if (result.failed !== undefined && result.failed.length > 0) lines.push('失败：' + result.failed.map((item) => item.name + '（' + item.error + '）').join('；'))
    return lines.join('\n')
  }

  // ── 宿主侧模型工具 ──────────────────────────────────────────────────────
  function installTool() {
    tools.register({
      name: 'mcp_hub',
      description: 'MCP 与工具一键部署中枢（桌面优先，Windows 友好）。action=doctor 先做环境体检（缺 npx/uvx 会直接给安装命令）；action=list 看已注册服务与运行状态；action=catalog 浏览内置与预设目录（含零依赖内置工具包）；action=search 按需搜官方 MCP Registry/npm/GitHub（不要预先全量拉取，搜到再装；结果会标注与 DSH 内置工具的重叠）；action=describe 看某候选的细节与安装建议；action=add 安装（目录预设 / 在线候选 / 自定义 command）；action=enable/disable/remove 按名切换；action=permission 设置调用权限（always/session/ask/disabled）；action=test 先探测再安装；action=reload 全量重同步。变更即时生效，无需重启。',
      parameters: {
        action: { type: 'string', required: true, enum: ['list', 'status', 'catalog', 'search', 'describe', 'enable', 'disable', 'remove', 'add', 'test', 'reload', 'permission', 'doctor'], description: '要执行的动作；permission 设置调用权限；doctor 做环境体检' },
        permission: { type: 'string', enum: ['always', 'session', 'ask', 'disabled'], description: 'permission 动作的目标权限：always 永久启用 / session 本会话问一次 / ask 每次询问 / disabled 禁用' },
        name: str('服务名（enable/disable/remove/add/test/describe 需要）；describe 也可传在线候选 ID'),
        q: str('search 的关键词；catalog 也可用它过滤'),
        sources: strArray('search 的来源，可选 registry / npm / github，默认 ["registry","npm"]'),
        fromCatalog: str('add 时：目录里的预设名（缺省等于 name）'),
        install: obj('add 时：直接给一条服务配置覆盖（transport/command/args/env/url/headers）'),
        transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'add 自定义服务时的传输方式' },
        command: str('add 自定义 stdio 服务时的可执行文件，例如 node / npx / python3'),
        args: strArray('add 自定义 stdio 服务时的参数数组'),
        env: obj('add 自定义服务时的环境变量表'),
        url: str('add 自定义 streamable-http 服务时的地址'),
        headers: obj('add 自定义 streamable-http 服务时的请求头'),
        description: str('add 时的一句话说明'),
        tags: strArray('add 时的标签'),
        enabled: bool('add 后是否立即启用，默认 true'),
      },
      output: jsonOutput(),
      async execute(args) {
        const action = String(args.action === undefined ? 'list' : args.action)
        if (action === 'status') return statusReport()
        if (action === 'list') {
          return {
            registry: config.registryFile,
            servers: hub.state.servers.map((server) => {
              const runtime = runner.list().find((item) => item.name === server.name)
              return {
                name: server.name,
                label: server.label,
                enabled: server.enabled !== false,
                state: server.enabled === false ? 'disabled' : (runtime === undefined ? 'not-connected' : 'running'),
                toolCount: runtime === undefined ? 0 : runtime.toolCount,
                tools: runtime === undefined ? [] : runtime.tools,
                command: server.transport === 'stdio' ? [server.command, ...(server.args || [])].join(' ') : server.url,
              }
            }),
          }
        }
        if (action === 'catalog') {
          const needle = String(args.q === undefined ? '' : args.q).toLowerCase()
          const entries = [...hub.catalogIndex().values()].filter((entry) =>
            needle === '' || (entry.name + ' ' + entry.label + ' ' + entry.description + ' ' + (entry.tags || []).join(' ')).toLowerCase().includes(needle))
          return {
            count: entries.length,
            servers: entries.map((entry) => ({
              name: entry.name,
              label: entry.label,
              description: entry.description,
              tags: entry.tags,
              transport: entry.transport,
              command: entry.transport === 'stdio' ? [entry.command, ...(entry.args || [])].join(' ') : entry.url,
              requires: entry.requires || [],
              installed: hub.state.servers.some((server) => server.name === entry.name),
            })),
          }
        }
        if (action === 'search') {
          const query = String(args.q !== undefined && args.q !== '' ? args.q : (args.name || '')).trim()
          if (query === '') throw new Error('search 需要 q（关键词）')
          const sources = Array.isArray(args.sources) && args.sources.length > 0 ? args.sources.map((item) => String(item)) : ['registry', 'npm']
          const out = await searchAll(query, { limit: 10, sources })
          return { action, ...out, githubToken: githubTokenConfigured() }
        }
        if (action === 'describe') {
          const id = String(args.name !== undefined && args.name !== '' ? args.name : (args.q || '')).trim()
          if (id === '') throw new Error('describe 需要 name（候选 ID）')
          return { action, ...(await describeCandidate(id)) }
        }
        if (action === 'test') {
          if (typeof args.name !== 'string' || args.name === '') throw new Error('test 需要 name')
          return probeServer(args.name)
        }
        if (action === 'doctor') {
          return { action, ...(await httpApi.doctor()) }
        }
        if (action === 'permission') {
          if (typeof args.name !== 'string' || args.name === '') throw new Error('permission 需要 name')
          if (typeof args.permission !== 'string' || args.permission === '') throw new Error('permission 需要 permission 字段')
          const result = await setPermission(args.name, args.permission)
          return { action, ...result, permissionStats: permission.snapshot() }
        }
        if (action === 'reload') {
          const result = await hub.applyMutation({ action: 'reload', payload: {} })
          return { action, ...result, running: runner.list() }
        }
        if (action === 'add') {
          if (typeof args.name !== 'string' || args.name === '') throw new Error('add 需要 name')
          let base = args.install !== null && typeof args.install === 'object' ? args.install : {}
          // 没给 install 但给了 fromCatalog/在线来源时，先解析出配置。
          const fromCatalog = typeof args.fromCatalog === 'string' && args.fromCatalog !== ''
            ? args.fromCatalog
            : (typeof args.name === 'string' && hub.catalogIndex().has(args.name) ? args.name : undefined)
          if (base.transport === undefined && base.command === undefined && base.url === undefined && fromCatalog === undefined) {
            const online = await describeOfficial(args.name)
            if (online !== null) {
              const suggestion = candidateToServer(online, suggestName(online.name || online.id), {})
              base = {
                transport: suggestion.transport,
                command: suggestion.command,
                args: suggestion.args,
                env: suggestion.env,
                url: suggestion.url,
                headers: suggestion.headers,
                label: args.description === undefined ? suggestion.label : undefined,
                description: args.description === undefined ? suggestion.description : undefined,
              }
            }
          }
          const payload = {
            name: args.name,
            fromCatalog,
            transport: args.transport !== undefined ? args.transport : base.transport,
            command: args.command !== undefined ? args.command : base.command,
            args: args.args !== undefined ? args.args : base.args,
            env: args.env !== undefined ? args.env : base.env,
            url: args.url !== undefined ? args.url : base.url,
            headers: args.headers !== undefined ? args.headers : base.headers,
            description: args.description !== undefined ? args.description : base.description,
            tags: args.tags !== undefined ? args.tags : base.tags,
            enabled: args.enabled !== false,
          }
          const result = await hub.applyMutation({ action: 'add', payload })
          return { action, ...result, running: runner.list() }
        }
        if (['enable', 'disable', 'remove'].includes(action)) {
          if (typeof args.name !== 'string' || args.name === '') throw new Error(action + ' 需要 name')
          const result = await hub.applyMutation({ action, payload: { name: args.name } })
          return { action, ...result, running: runner.list() }
        }
        throw new Error('未知 action：' + action)
      },
    })
    log('已注册 mcp_hub 工具')
  }

  function statusReport() {
    const tools_ = runner.list()
    return {
      plugin: PACKAGE_ROOT,
      builtinServers: BUILTIN_NAMES,
      builtinTools: BUILTIN_NAMES.length > 0 ? countBuiltinTools() : 0,
      dataDir: config.dataDir,
      registryFile: config.registryFile,
      catalogFile: config.catalogFile,
      logFile: config.logFile,
      enabled: config.enabled,
      registered: hub.state.servers.length,
      running: tools_.map((item) => ({ name: item.name, toolCount: item.toolCount, startedAt: item.startedAt })),
      runningToolCount: tools_.reduce((sum, item) => sum + item.toolCount, 0),
      results: Object.fromEntries(hub.state.results),
      reconciles: state.reconciles,
      mutations: state.mutations,
      failures: state.failures,
      lastError: state.lastError,
      startedAt: new Date(startedAt).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      runtimeEnv: runtimeEnv(config),
      log: logLines.slice(-20),
    }
  }

  function countBuiltinTools() {
    // 只做静态统计，不启动子进程：内置服务的工具数记录在目录条目里。
    try {
      return Number(process.env.DSHA_MCP_HUB_BUILTIN_TOOLS || 0) || null
    } catch {
      return null
    }
  }

  /** describe：先查注册表/目录，再查在线 Registry；返回「这是什么 + 怎么装」。 */
  async function describeCandidate(id) {
    const registered = hub.state.servers.find((item) => item.name === id)
    if (registered !== undefined) return { found: true, kind: 'registered', server: registered }
    const inCatalog = hub.catalogIndex().get(id)
    if (inCatalog !== undefined) return { found: true, kind: 'catalog', server: inCatalog }
    let online = null
    try {
      online = await describeOfficial(id)
    } catch (error) {
      return { found: false, kind: 'online', error: describeError(error), hint: '在线 Registry 不可达；可先用 search 或直接手写 command 安装' }
    }
    if (online === null) return { found: false, kind: 'online', hint: '在线 Registry 里没有这个 ID' }
    const suggestion = candidateToServer(online, suggestName(online.name || online.id), {})
    return { found: true, kind: 'online', candidate: online, installSuggestion: suggestion }
  }

  function suggestName(id) {
    const base = String(id).replace(/^[^/]*\//, '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 28)
    const safe = base === '' ? 'mcp' : base
    if (!hub.state.servers.some((item) => item.name === safe)) return safe
    for (let index = 2; index < 100; index += 1) {
      const candidate = (safe.slice(0, 26) + '-' + index).slice(0, 32)
      if (!hub.state.servers.some((item) => item.name === candidate)) return candidate
    }
    return safe.slice(0, 30) + '-x'
  }

  /** 改某个服务的调用权限（模型侧与 /mcp 命令共用）。 */
  async function setPermission(name, mode) {
    const allowed = ['always', 'session', 'ask', 'disabled']
    if (!allowed.includes(String(mode))) throw new Error('权限只能是 ' + allowed.join(' / '))
    const server = hub.state.servers.find((item) => item.name === name)
    if (server === undefined) throw new Error('注册表里没有服务：' + name)
    server.permission = String(mode)
    await hub.saveRegistry()
    if (mode === 'ask' || mode === 'disabled') permission.revoke(name)
    log('权限变更：' + name + ' → ' + mode)
    return { name, permission: server.permission }
  }

  async function probeServer(name) {
    const server = hub.state.servers.find((item) => item.name === name)
    const base = server !== undefined ? server : hub.catalogIndex().get(name)
    if (base === undefined) throw new Error('注册表和目录里都没有：' + name)
    const probeConfig = server !== undefined
      ? server
      : { ...base, name: base.name, toolCallTimeoutMs: config.toolCallTimeoutMs }
    const result = await runner.probe(probeConfig, config.toolCallTimeoutMs)
    return { name, ok: true, ...result }
  }

  // ── 变更队列与周期同步 ──────────────────────────────────────────────────
  let mutationOffset = 0

  async function applyPendingMutations() {
    let text
    try {
      const stat = await fs.stat(config.mutationFile)
      if (stat.size <= mutationOffset) return 0
      const handle = await fs.open(config.mutationFile, 'r')
      try {
        const length = stat.size - mutationOffset
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, mutationOffset)
        text = buffer.toString('utf8')
        mutationOffset = stat.size
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') return 0
      throw error
    }
    let applied = 0
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let mutation
      try {
        mutation = JSON.parse(trimmed)
      } catch {
        log('忽略无法解析的变更记录：' + trimmed.slice(0, 120))
        continue
      }
      if (mutation !== null && typeof mutation === 'object') {
        if (mutation.id !== undefined && mutation.id === state.lastMutationId) continue
        state.lastMutationId = mutation.id === undefined ? state.lastMutationId : mutation.id
      }
      try {
        const result = await hub.applyMutation(mutation)
        applied += 1
        state.mutations += 1
        log('应用变更 ' + String(mutation && mutation.action) + ' ' + JSON.stringify(mutation && mutation.payload) + ' → ' + JSON.stringify({
          started: result.started, stopped: result.stopped, failed: result.failed,
        }))
      } catch (error) {
        state.failures += 1
        state.lastError = describeError(error)
        log('变更失败 ' + String(mutation && mutation.action) + '：' + state.lastError)
      }
    }
    return applied
  }

  // ── 查询队列：让内置 hub 服务也能「按需搜索」在线 MCP 服务 ──────────────
  let queryOffset = 0
  let queryResponses = {}

  async function loadQueryResponses() {
    try {
      const document = JSON.parse(await fs.readFile(config.queryResponseFile, 'utf8'))
      if (document !== null && typeof document === 'object' && document.responses !== undefined) queryResponses = document.responses
    } catch { /* 首次还没有响应文件 */ }
  }

  async function writeQueryResponses() {
    const ids = Object.keys(queryResponses)
    if (ids.length > 200) {
      for (const id of ids.slice(0, ids.length - 200)) delete queryResponses[id]
    }
    await fs.mkdir(path.dirname(config.queryResponseFile), { recursive: true })
    await fs.writeFile(config.queryResponseFile + '.tmp', JSON.stringify({ responses: queryResponses }, null, 2), 'utf8')
    await fs.rename(config.queryResponseFile + '.tmp', config.queryResponseFile)
  }

  async function handleQuery(record) {
    const kind = String(record && record.kind)
    if (kind === 'search') {
      const sources = Array.isArray(record.sources) && record.sources.length > 0 ? record.sources.map((item) => String(item)) : ['registry', 'npm']
      return searchAll(String(record.q || ''), { limit: Math.max(1, Math.min(30, Number(record.limit || 10) || 10)), sources })
    }
    if (kind === 'describe') return describeCandidate(String(record.id || ''))
    throw new Error('未知查询类型：' + kind)
  }

  async function applyPendingQueries() {
    let text
    try {
      const stat = await fs.stat(config.queryFile)
      if (stat.size <= queryOffset) return 0
      const handle = await fs.open(config.queryFile, 'r')
      try {
        const length = stat.size - queryOffset
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, queryOffset)
        text = buffer.toString('utf8')
        queryOffset = stat.size
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') return 0
      throw error
    }
    await loadQueryResponses()
    let handled = 0
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let record
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue
      }
      // 信封 id：新协议用 requestId，旧队列记录仍然只有 id。
      // 不能直接读 record.id —— describe 的 payload 自己就带 id，会撞名。
      const id = queryEnvelopeId(record)
      if (id === '') continue
      try {
        const value = await handleQuery(record)
        queryResponses[id] = { ok: true, at: new Date().toISOString(), value }
      } catch (error) {
        queryResponses[id] = { ok: false, at: new Date().toISOString(), error: describeError(error) }
      }
      handled += 1
    }
    if (handled > 0) await writeQueryResponses()
    return handled
  }

  async function tick() {
    if (state.disposed) return
    try {
      const applied = await applyPendingMutations()
      await applyPendingQueries()
      if (applied === 0) {
        state.reconciles += 1
        await hub.reconcile()
      }
    } catch (error) {
      state.failures += 1
      state.lastError = describeError(error)
      log('周期同步失败：' + state.lastError)
    }
  }

  install().catch((error) => {
    state.lastError = describeError(error)
    log('初始化失败：' + state.lastError)
  })

  // 关停：停掉全部 MCP 子进程，避免留下孤儿进程。
  ctx.on('dispose', () => {
    state.disposed = true
    if (state.timer !== null) clearInterval(state.timer)
    void runner.stopAll().catch((error) => log('关闭 MCP 连接失败：' + describeError(error)))
    try { terminal.dispose() } catch (error) { log('关闭终端失败：' + describeError(error)) }
    log('已卸载')
  })
  // 关闭 start：此处之后仍是插件 apply 作用域（dispose 监听挂在插件自己的 ctx 上）。
  }
}

/** 补桥令牌：设备服务要用，DSH 的桥令牌默认写在 ~/.dsh/.bridge_token。 */
async function ensureBridgeToken() {
  if (process.env.DSH_BRIDGE_TOKEN) return
  // os.homedir() 在 Windows 上是 %USERPROFILE%，process.env.HOME 常常没有定义。
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const candidates = [
    path.join(home, '.bridge_token'),
    path.join(os.homedir(), '.dsh', '.bridge_token'),
  ]
  for (const file of candidates) {
    try {
      const text = await fs.readFile(file, 'utf8')
      if (text.trim() !== '') {
        process.env.DSH_BRIDGE_TOKEN = text.trim()
        return
      }
    } catch { /* 试下一个 */ }
  }
}

export { SERVER_ENTRY }

