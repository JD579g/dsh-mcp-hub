/**
 * dsh-mcp-hub · 内置 MCP 服务：hub
 *
 * MCP 控制面。它由 dsh-mcp-hub 宿主插件注入到子进程，自身不直接改配置：
 *   - 查询类（status / catalog / list）读注册表与目录，立即返回；
 *   - 变更类（enable / disable / add / remove）把请求写进 MCP_HUB_MUTATION 文件，
 *     由宿主插件在下一次检查时应用（通常 1~2 秒内生效）。
 *
 * 这样模型可以“一键部署”MCP 服务，而真正的加载/卸载仍由宿主侧的安全实现负责。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { str, num, bool, describeError } from './util.js'

function hubFile(name) {
  return process.env[name] || ''
}

async function readJson(file, fallback) {
  if (file === '') return fallback
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw new Error('读取 ' + file + ' 失败：' + describeError(error))
  }
}

/** 文件在不在（registryExists 要回答的是这个，不是「环境变量有没有配」）。 */
async function fileExists(file) {
  if (file === '') return false
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function writeMutation(action, payload) {
  const file = hubFile('MCP_HUB_MUTATION')
  if (file === '') throw new Error('宿主没有提供 MCP_HUB_MUTATION，无法提交变更；请在 DSH 里直接修改 MCP Hub 配置')
  const record = { id: randomBytes(6).toString('hex'), at: new Date().toISOString(), action, payload }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8')
  return record
}

/**
 * 把一次查询请求写进队列，并等宿主写回响应。
 * 宿主插件在处理 queries.jsonl 时把结果按请求 id 写进 query-responses.json。
 */
async function query(request, timeoutMs) {
  const file = hubFile('MCP_HUB_QUERY')
  const responseFile = hubFile('MCP_HUB_QUERY_RESPONSE')
  if (file === '' || responseFile === '') {
    throw new Error('宿主没有提供查询队列（MCP_HUB_QUERY），无法在线检索；请直接用 mcp_hub 宿主工具或在 /mcp 命令里搜')
  }
  // 信封 id 绝不能和 payload 平铺在同一个对象里：describe 的 payload 自己就带一个
  // id（要查的候选/服务名），\`{ id, ...request }\` 会把信封 id 覆盖成目标名，
  // 宿主便按错误的 key 写回响应，调用方只能干等到 60 秒超时。信封字段单独叫 requestId。
  const id = randomBytes(6).toString('hex')
  const record = { requestId: id, at: new Date().toISOString(), ...request }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8')
  const deadline = Date.now() + Math.max(2000, Number(timeoutMs || 30000) || 30000)
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    let document = null
    try {
      document = JSON.parse(await fs.readFile(responseFile, 'utf8'))
    } catch {
      document = null
    }
    const entry = document !== null && typeof document === 'object' && document.responses !== undefined ? document.responses[id] : undefined
    if (entry !== undefined) {
      if (entry.ok === true) return entry.value
      throw new Error(String(entry.error || '查询失败'))
    }
    if (Date.now() > deadline) throw new Error('在线检索超时（宿主可能未运行或网络不可达）')
  }
}

function summarize(server) {
  return {
    name: server.name,
    label: server.label || server.name,
    enabled: server.enabled !== false,
    transport: server.transport,
    command: server.transport === 'stdio' ? [server.command, ...(server.args || [])].join(' ') : undefined,
    url: server.url,
    args: server.args,
    envKeys: server.env === undefined ? [] : Object.keys(server.env),
    source: server.source || 'user',
    description: server.description || '',
    tags: server.tags || [],
  }
}

export const hubServer = {
  name: 'hub',
  version: '1.0.0',
  title: 'MCP 控制台',
  instructions: '查看/管理 dsh-mcp-hub 注册表中的 MCP 服务与内置目录；变更会在 1~2 秒内由宿主应用。',
  tools: [
    {
      name: 'status',
      description: '查看 MCP Hub 总体状态：注册表路径、启用的服务、目录规模、动态行数量、最近日志。',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        const registry = await readJson(hubFile('MCP_HUB_REGISTRY'), { servers: [] })
        const catalog = await readJson(hubFile('MCP_HUB_CATALOG'), { servers: [] })
        const stats = await readJson(hubFile('MCP_HUB_STATS'), {})
        return {
          registryPath: hubFile('MCP_HUB_REGISTRY'),
          catalogPath: hubFile('MCP_HUB_CATALOG'),
          registryExists: await fileExists(hubFile('MCP_HUB_REGISTRY')),
          enabled: (registry.servers || []).filter((item) => item.enabled !== false).map((item) => item.name),
          disabled: (registry.servers || []).filter((item) => item.enabled === false).map((item) => item.name),
          catalogSize: (catalog.servers || []).length,
          runtime: stats,
        }
      },
    },
    {
      name: 'list',
      description: '列出注册表中的 MCP 服务（含启用状态与启动命令），以及它们当前发布的工具名。',
      inputSchema: {
        type: 'object',
        properties: {
          includeTools: bool('是否附带每个服务已注册的工具名，默认 true'),
        },
      },
      async handler(args) {
        const registry = await readJson(hubFile('MCP_HUB_REGISTRY'), { servers: [] })
        const toolsByServer = await readJson(hubFile('MCP_HUB_TOOLS'), {})
        const servers = (registry.servers || []).map((server) => {
          const item = summarize(server)
          if (args.includeTools !== false) item.tools = toolsByServer[server.name] || []
          return item
        })
        return { count: servers.length, servers }
      },
    },
    {
      name: 'catalog',
      description: '浏览可一键部署的 MCP 服务目录（内置零依赖服务 + 常见官方/社区服务预设）。',
      inputSchema: {
        type: 'object',
        properties: {
          q: str('关键词过滤（名称、描述、标签）'),
          tag: str('按标签过滤，例如 files / memory / search / device'),
          limit: num('最多返回条数，默认 100'),
        },
      },
      async handler(args) {
        const catalog = await readJson(hubFile('MCP_HUB_CATALOG'), { servers: [] })
        const limit = Math.max(1, Math.min(500, Number(args.limit || 100) || 100))
        const needle = typeof args.q === 'string' && args.q !== '' ? args.q.toLowerCase() : ''
        const tag = typeof args.tag === 'string' && args.tag !== '' ? args.tag : ''
        const rows = (catalog.servers || []).filter((entry) => {
          if (tag !== '' && !(entry.tags || []).includes(tag)) return false
          if (needle === '') return true
          return (entry.name + ' ' + (entry.description || '') + ' ' + (entry.tags || []).join(' ')).toLowerCase().includes(needle)
        })
        return {
          count: rows.length,
          servers: rows.slice(0, limit).map((entry) => ({
            name: entry.name,
            label: entry.label,
            description: entry.description,
            tags: entry.tags,
            transport: entry.transport,
            command: entry.transport === 'stdio' ? [entry.command, ...(entry.args || [])].join(' ') : entry.url,
            requires: entry.requires || [],
            installed: entry.installed === true,
          })),
        }
      },
    },
    {
      name: 'search',
      description: '按需搜索在线 MCP 服务（官方 MCP Registry + npm），返回候选与其启动方式。搜到之后用 describe 看细节、再用 add 安装。',
      inputSchema: {
        type: 'object',
        properties: {
          q: str('关键词，例如 postgres、github、browser'),
          sources: { type: 'array', items: { type: 'string', enum: ['registry', 'npm', 'github'] }, description: '检索来源，默认 registry 与 npm' },
          limit: num('最多返回条数，默认 10，上限 30'),
        },
        required: ['q'],
      },
      async handler(args) {
        return query({ kind: 'search', q: String(args.q === undefined ? '' : args.q), sources: args.sources, limit: args.limit }, 60000)
      },
    },
    {
      name: 'describe',
      description: '查看一个候选/已注册服务的细节与安装建议（包名、环境变量、远程地址）。',
      inputSchema: {
        type: 'object',
        properties: { id: str('候选 ID（来自 search）或服务名') },
        required: ['id'],
      },
      async handler(args) {
        const id = String(args.id === undefined ? '' : args.id).trim()
        // 空目标没有可查的东西：立刻报错，而不是排进查询队列干等 60 秒超时。
        if (id === '') throw new Error('describe 需要 id（候选 ID 来自 search，或已注册服务名来自 list）')
        return query({ kind: 'describe', id }, 60000)
      },
    },
    {
      name: 'enable',
      description: '启用注册表里的一个 MCP 服务（按名字），宿主会在 1~2 秒内把它挂上并发布工具。',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('服务名（见 list）'),
          tools: bool('是否同时返回该服务发布后的工具名（默认 false，稍后再查更准）'),
        },
        required: ['name'],
      },
      async handler(args) {
        const record = await writeMutation('enable', { name: String(args.name === undefined ? '' : args.name) })
        return { submitted: record, note: '已提交启用请求；1~2 秒后可用 list 查看工具是否就绪' }
      },
    },
    {
      name: 'disable',
      description: '停用一个 MCP 服务（卸载其发布的工具，但保留注册表条目与配置）。',
      inputSchema: {
        type: 'object',
        properties: { name: str('服务名') },
        required: ['name'],
      },
      async handler(args) {
        const record = await writeMutation('disable', { name: String(args.name === undefined ? '' : args.name) })
        return { submitted: record, note: '已提交停用请求' }
      },
    },
    {
      name: 'add',
      description: '新增（或覆盖）一个 MCP 服务并启用：内置服务给 catalog 名；外部服务给 transport/command/url。',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('服务名（作为工具命名空间 mcp__<name>__*，只允许字母数字 _ -，最多 32 字符）'),
          fromCatalog: str('目录里的服务名；给定时自动填充 command/args/env'),
          transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: '传输方式' },
          command: str('stdio：可执行文件（如 node、npx、python3）'),
          args: { type: 'array', items: { type: 'string' }, description: 'stdio：参数数组' },
          env: { type: 'object', description: 'stdio：额外环境变量' },
          url: str('streamable-http：服务地址'),
          headers: { type: 'object', description: 'streamable-http：附加请求头' },
          label: str('展示名'),
          description: str('一句话说明'),
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
          enabled: bool('是否立即启用，默认 true'),
        },
        required: ['name'],
      },
      async handler(args) {
        const record = await writeMutation('add', {
          name: String(args.name === undefined ? '' : args.name),
          fromCatalog: args.fromCatalog === undefined ? undefined : String(args.fromCatalog),
          transport: args.transport,
          command: args.command,
          args: args.args,
          env: args.env,
          url: args.url,
          headers: args.headers,
          label: args.label,
          description: args.description,
          tags: args.tags,
          enabled: args.enabled !== false,
        })
        return { submitted: record, note: '已提交新增请求；1~2 秒后生效' }
      },
    },
    {
      name: 'remove',
      description: '删除注册表里的一个 MCP 服务（同时卸载）。',
      inputSchema: {
        type: 'object',
        properties: { name: str('服务名') },
        required: ['name'],
      },
      async handler(args) {
        const record = await writeMutation('remove', { name: String(args.name === undefined ? '' : args.name) })
        return { submitted: record, note: '已提交删除请求' }
      },
    },
    {
      name: 'reload',
      description: '让宿主重新同步全部服务（配置改坏、服务崩溃、或外部改了注册表时用）。',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        const record = await writeMutation('reload', {})
        return { submitted: record, note: '已提交全量重同步请求' }
      },
    },
  ],
}

