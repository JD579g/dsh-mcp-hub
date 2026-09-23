/**
 * dsh-mcp-hub · 宿主侧 MCP 运行器（直连模式）
 *
 * 用官方 MCP 客户端 SDK 直接在宿主进程里连接 MCP 服务、把工具注册进
 * ctx.tools。与 @deepseek-ai/dsh-mcp-client 的命名契约保持一致：
 * 工具名 = mcp__<serverName>__<rawName>（超长/含非法字符时追加 12 位哈希）。
 *
 * 直连模式的好处：加/卸服务是纯运行时操作，不写 cordis.yml、不需要重启。
 */

import { createHash } from 'node:crypto'
import { loadSdk } from './sdk.js'
import { toAuthorParameters } from './schema.js'

const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

export function publicToolName(serverName, rawName) {
  const prefix = 'mcp__' + serverName + '__'
  const clean = rawName.replace(INVALID_NAME_CHARS, '_')
  const candidate = prefix + clean
  if (candidate === 'mcp__' + serverName + '__' + rawName && candidate.length <= MAX_PUBLIC_NAME_LENGTH) return candidate
  const hash = createHash('sha256').update(serverName + '|' + rawName).digest('hex').slice(0, 12)
  const budget = Math.max(1, MAX_PUBLIC_NAME_LENGTH - hash.length - 1)
  const truncated = (candidate.length > budget ? candidate.slice(0, budget) : candidate).replace(/_+$/, '')
  return truncated + '_' + hash
}

/** 把 MCP 的 inputSchema 转成 DSH 工具声明能接受的 JSON Schema。 */
function normalizeSchema(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: { }, additionalProperties: true }
  }
  const out = { ...schema }
  if (out.type === undefined) out.type = 'object'
  if (out.properties === undefined && out.type === 'object') out.properties = { }
  return out
}

/** 把 MCP 的 content 投影成 DSH 工具结果文本。 */
function projectContent(result, limit) {
  const blocks = Array.isArray(result && result.content) ? result.content : []
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text') parts.push(String(block.text === undefined ? '' : block.text))
    else if (block.type === 'image') parts.push('[image ' + String(block.mimeType || 'unknown') + ', base64 ' + String((block.data || '').length) + ' 字符]')
    else if (block.type === 'audio') parts.push('[audio ' + String(block.mimeType || 'unknown') + ']')
    else if (block.type === 'resource') parts.push('[resource ' + String((block.resource && block.resource.uri) || '') + ']')
    else if (block.type === 'resource_link') parts.push('[resource_link ' + String(block.uri || '') + ']')
    else parts.push('[' + String(block.type) + ']')
  }
  let text = parts.join('\n')
  if (text === '') text = '(MCP 服务未返回内容)'
  if (text.length > limit) text = text.slice(0, limit) + '\n…（已截断）'
  return text
}

const STDIO_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM',
  'TZ', 'TMPDIR', 'TEMP', 'TMP', 'PWD', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', 'PYTHONUNBUFFERED',
]

/** 给 stdio 子进程准备环境：白名单继承 + 显式覆盖（值为 null 表示删除）。 */
export function childEnvironment(extra) {
  const env = {}
  for (const key of STDIO_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key]
  env.PYTHONUNBUFFERED = '1'
  if (extra !== null && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      if (value === null || value === undefined) delete env[key]
      else env[key] = String(value)
    }
  }
  return env
}

/**
 * 运行器：管理若干 MCP 客户端连接。
 * @param {object} options
 * @param {object} options.ctx cordis 上下文（只用 ctx.logger，可选）
 * @param {object} options.tools ctx.tools 服务（register 返回 disposer）
 * @param {(line:string)=>void} options.log 日志
 */
export function createMcpRunner(options) {
  const log = options.log
  /** @type {Map<string, object>} serverName → 运行态 */
  const running = new Map()
  let sdk = null

  const ensureSdk = async () => {
    if (sdk !== null) return sdk
    sdk = await loadSdk()
    log('MCP SDK 位置：' + sdk.dir)
    return sdk
  }

  async function connect(config) {
    const { Client, StdioClientTransport, StreamableHTTPClientTransport } = await ensureSdk()
    const client = new Client({ name: 'dsh-mcp-hub', version: '1.0.0' }, { capabilities: {} })
    let transport
    if (config.transport === 'streamable-http') {
      const headers = config.headers !== null && typeof config.headers === 'object' ? config.headers : {}
      transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } })
    } else {
      transport = new StdioClientTransport({
        command: config.command,
        args: Array.isArray(config.args) ? config.args.map((item) => String(item)) : [],
        env: childEnvironment(config.env),
        cwd: typeof config.cwd === 'string' && config.cwd !== '' ? config.cwd : undefined,
        stderr: 'pipe',
      })
    }
    await client.connect(transport)
    return { client, transport }
  }

  /** 连接并注册一个服务；已运行时先卸下旧的。 */
  async function start(config) {
    await stop(config.name)
    const { client, transport } = await connect(config)
    const listed = await client.listTools()
    const toolList = Array.isArray(listed && listed.tools) ? listed.tools : []
    /** @type {Map<string,()=>void>} */
    const disposers = new Map()
    const published = []
    const conflict = []
    try {
      for (const tool of toolList) {
        const publicName = publicToolName(config.name, tool.name)
        if (published.some((item) => item.publicName === publicName)) {
          throw new Error('工具名冲突：' + publicName)
        }
        const definition = {
          name: publicName,
          description: '[' + config.name + '] ' + String(tool.description || tool.title || tool.name),
          parameters: toAuthorParameters(tool.inputSchema),
          output: {
            // 必须是原始 JSON Schema 认得的类型（object），不能用 type: 'json'（那是作者 DSL）。
            schema: { type: 'object', properties: {}, additionalProperties: true },
            render(_args, value) {
              const text = value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : JSON.stringify(value, null, 2)
              return [{ type: 'text', text }]
            },
          },
          execute: async (args, exec) => {
            // 调用前先过权限闸门：always 放行；session/ask 走 DSH 审批；disabled 直接拒绝。
            if (typeof options.permissionGate === 'function') {
              const decision = await options.permissionGate(config.name, exec)
              if (decision !== undefined && decision !== null && decision.allowed !== true) {
                throw new Error(decision.reason || ('MCP 服务 ' + config.name + ' 当前权限不允许调用'))
              }
            }
            const timeoutMs = Math.max(1000, Math.min(600000, Number(config.toolCallTimeoutMs || 120000) || 120000))
            const result = await client.callTool(
              { name: tool.name, arguments: args !== null && typeof args !== 'object' ? {} : args },
              undefined,
              { timeout: timeoutMs, signal: exec === undefined || exec === null ? undefined : exec.signal },
            )
            const text = projectContent(result, 200000)
            if (result !== null && typeof result === 'object' && result.isError === true) {
              throw new Error(text)
            }
            return { text }
          },
        }
        const dispose = options.tools.register(definition)
        if (typeof dispose === 'function') disposers.set(publicName, dispose)
        published.push({ rawName: tool.name, publicName })
      }
    } catch (error) {
      for (const dispose of disposers.values()) {
        try { dispose() } catch { /* 卸载失败不掩盖原始错误 */ }
      }
      try { await client.close() } catch { /* 忽略 */ }
      throw error
    }
    if (conflict.length > 0) log('警告：' + config.name + ' 有 ' + conflict.length + ' 个重名工具未注册')
    const record = {
      name: config.name,
      transport: config.transport,
      client,
      transportHandle: transport,
      disposers,
      tools: published,
      config,
      toolCount: published.length,
      startedAt: new Date().toISOString(),
    }
    running.set(config.name, record)
    log('已连接 ' + config.name + '（' + published.length + ' 个工具）')
    return { toolCount: published.length, tools: published.map((item) => item.publicName) }
  }

  /** 断开一个服务并卸下它的全部工具。 */
  async function stop(name) {
    const record = running.get(name)
    if (record === undefined) return { removed: false }
    running.delete(name)
    for (const dispose of record.disposers.values()) {
      try { dispose() } catch (error) { log('卸下工具失败：' + String(error && error.message ? error.message : error)) }
    }
    try { await record.client.close() } catch (error) { log(name + ' 关闭连接失败：' + String(error && error.message ? error.message : error)) }
    log('已停用 ' + name)
    return { removed: true, toolCount: record.toolCount }
  }

  /** 一次性探测：连接、列工具、关闭。不注册任何东西。 */
  async function probe(config, timeoutMs) {
    const { client } = await connect(config)
    try {
      const listed = await client.listTools()
      const toolList = Array.isArray(listed && listed.tools) ? listed.tools : []
      return {
        ok: true,
        serverInfo: client.getServerVersion ? client.getServerVersion() : null,
        toolCount: toolList.length,
        tools: toolList.map((tool) => ({ rawName: tool.name, publicName: publicToolName(config.name || 'probe', tool.name), description: String(tool.description || '').slice(0, 200) })),
      }
    } finally {
      try { await client.close() } catch { /* 忽略 */ }
    }
  }

  async function stopAll() {
    const names = [...running.keys()]
    for (const name of names) await stop(name)
    return names
  }

  function list() {
    return [...running.values()].map((record) => ({
      name: record.name,
      transport: record.transport,
      toolCount: record.toolCount,
      startedAt: record.startedAt,
      tools: record.tools.map((item) => item.publicName),
    }))
  }

  function has(name) {
    return running.has(name)
  }

  return { start, stop, stopAll, probe, list, has }
}

