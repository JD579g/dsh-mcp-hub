/**
 * dsh-mcp-hub · 零依赖 MCP stdio 服务运行时
 *
 * 这是一个只有 Node 内置模块实现的 MCP（Model Context Protocol）服务端。
 * 它刻意不 import @modelcontextprotocol/sdk：内置服务要在手机上离线可用，
 * 也要在任意 MCP 宿主（DSH / Claude Code / Codex / Cursor …）里跑得起来。
 *
 * 协议面（2025-06-18 revision 的保守子集）：
 *   - initialize            → protocolVersion / capabilities / serverInfo
 *   - notifications/initialized（通知，无响应）
 *   - ping                  → {}
 *   - tools/list            → { tools: [...] }，支持 cursor 分页
 *   - tools/call            → { content: [...] , structuredContent?, isError? }
 *   - 其它方法              → JSON-RPC error -32601
 *
 * 传输：stdin 逐行读 JSON-RPC 消息，stdout 逐行写响应；所有日志走 stderr，
 * 因此不会污染协议流。
 */

const PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05'])
const JSONRPC_VERSION = '2.0'

/** JSON-RPC 标准错误码。 */
export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
}

/** 把任意异常压成一行可读文本。 */
export function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (error instanceof Error) return error.message || String(error)
  return typeof error === 'string' ? error : JSON.stringify(error)
}

/** 缺省的工具返回：把 JSON 值渲染成一块 text，同时保留结构化内容。 */
function renderResult(value) {
  if (value !== null && typeof value === 'object' && Array.isArray(value.content)) {
    return value
  }
  let text
  if (typeof value === 'string') text = value
  else text = JSON.stringify(value === undefined ? null : value, null, 2)
  const result = { content: [{ type: 'text', text }] }
  if (value !== null && value !== undefined && typeof value === 'object') {
    result.structuredContent = value
  }
  return result
}

/**
 * 归一化工具声明，剔除宿主不接受的字段并补齐默认值。
 * @param {object} tool 原始声明
 */
function normalizeTool(tool) {
  const out = {
    name: tool.name,
    description: tool.description ?? '',
    handler: tool.handler,
  }
  const schema = tool.inputSchema ?? tool.parameters ?? { type: 'object', properties: {} }
  if (schema !== null && typeof schema === 'object') {
    out.inputSchema = { type: 'object', properties: {}, ...schema }
    if (out.inputSchema.properties === undefined) out.inputSchema.properties = {}
  } else {
    out.inputSchema = { type: 'object', properties: {} }
  }
  if (tool.outputSchema !== undefined && tool.outputSchema !== null) {
    out.outputSchema = tool.outputSchema
  }
  if (Array.isArray(tool.annotations)) out.annotations = tool.annotations
  return out
}

/**
 * 创建一台 MCP 服务：注册工具、跑 stdio 循环。
 *
 * @param {object} options
 * @param {string} options.name 服务名（serverInfo.name）
 * @param {string} [options.version] 版本
 * @param {string} [options.title] 展示标题
 * @param {string} [options.instructions] 给模型的说明
 * @param {Array} options.tools 工具声明数组
 * @param {(line: string) => void} [options.log] 日志输出（默认 stderr）
 */
export function createMcpServer(options) {
  const tools = Array.isArray(options.tools) ? options.tools.map(normalizeTool) : []
  const byName = new Map()
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error('duplicated tool name: ' + tool.name)
    byName.set(tool.name, tool)
  }
  const log = typeof options.log === 'function'
    ? options.log
    : (line) => { try { process.stderr.write('[mcp:' + options.name + '] ' + line + '\n') } catch { /* ignore */ } }

  const serverInfo = {
    name: options.name,
    version: options.version ?? '1.0.0',
  }
  if (options.title !== undefined) serverInfo.title = options.title

  const capabilities = {
    tools: { listChanged: false },
  }
  if (options.resources === true) capabilities.resources = { listChanged: false, subscribe: false }
  if (options.logging === true) capabilities.logging = {}

  const send = (message) => {
    try {
      process.stdout.write(JSON.stringify(message) + '\n')
    } catch (error) {
      log('failed to write response: ' + describeError(error))
    }
  }

  const reply = (id, result) => send({ jsonrpc: JSONRPC_VERSION, id, result })
  const fail = (id, code, message, data) => {
    const error = { code, message }
    if (data !== undefined) error.data = data
    send({ jsonrpc: JSONRPC_VERSION, id, error })
  }

  /** 处理一条请求，返回响应对象或 null（通知）。 */
  const handle = async (message) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return { jsonrpc: JSONRPC_VERSION, id: null, error: { code: RPC_ERRORS.invalidRequest, message: 'invalid request' } }
    }
    const id = message.id === undefined ? null : message.id
    const method = message.method
    const params = message.params !== null && typeof message.params === 'object' ? message.params : {}
    const isNotification = id === null || id === undefined

    if (typeof method !== 'string') {
      return isNotification ? null : { jsonrpc: JSONRPC_VERSION, id, error: { code: RPC_ERRORS.invalidRequest, message: 'missing method' } }
    }

    try {
      switch (method) {
        case 'initialize': {
          const requested = params.protocolVersion
          const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION
          const result = {
            protocolVersion,
            capabilities,
            serverInfo,
          }
          if (typeof options.instructions === 'string' && options.instructions.length > 0) {
            result.instructions = options.instructions
          }
          if (params.clientInfo !== undefined && params.clientInfo !== null) {
            log('client: ' + String(params.clientInfo.name ?? 'unknown') + ' ' + String(params.clientInfo.version ?? ''))
          }
          return { jsonrpc: JSONRPC_VERSION, id, result }
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/roots/list_changed':
          return null
        case 'ping':
          return { jsonrpc: JSONRPC_VERSION, id, result: {} }
        case 'tools/list': {
          return { jsonrpc: JSONRPC_VERSION, id, result: { tools } }
        }
        case 'tools/call': {
          const name = params.name
          if (typeof name !== 'string' || name.length === 0) {
            return { jsonrpc: JSONRPC_VERSION, id, error: { code: RPC_ERRORS.invalidParams, message: 'tools/call requires a tool name' } }
          }
          const tool = byName.get(name)
          if (tool === undefined) {
            return { jsonrpc: JSONRPC_VERSION, id, error: { code: RPC_ERRORS.invalidParams, message: 'unknown tool: ' + name } }
          }
          const args = params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}
          const context = {
            id,
            arguments: args,
            log,
            signal: undefined,
          }
          try {
            const value = await tool.handler(args, context)
            return { jsonrpc: JSONRPC_VERSION, id, result: renderResult(value) }
          } catch (error) {
            // 工具级失败按 MCP 语义回 isError，让宿主看到可见的失败而不是崩溃。
            log('tool ' + name + ' failed: ' + describeError(error))
            return {
              jsonrpc: JSONRPC_VERSION,
              id,
              result: {
                content: [{ type: 'text', text: '工具执行失败：' + describeError(error) }],
                isError: true,
              },
            }
          }
        }
        case 'resources/list':
          return { jsonrpc: JSONRPC_VERSION, id, result: { resources: [] } }
        case 'prompts/list':
          return { jsonrpc: JSONRPC_VERSION, id, result: { prompts: [] } }
        default:
          if (isNotification) return null
          return { jsonrpc: JSONRPC_VERSION, id, error: { code: RPC_ERRORS.methodNotFound, message: 'method not found: ' + method } }
      }
    } catch (error) {
      return { jsonrpc: JSONRPC_VERSION, id, error: { code: RPC_ERRORS.internal, message: describeError(error) } }
    }
  }

  /** 驱动 stdin 行循环；返回 Promise，在 stdin 结束时 resolve。 */
  const serve = () => new Promise((resolve) => {
    let buffer = ''
    let closed = false
    const finish = () => {
      if (closed) return
      closed = true
      resolve()
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (line.trim().length === 0) continue
        let message
        try {
          message = JSON.parse(line)
        } catch (error) {
          fail(null, RPC_ERRORS.parse, 'parse error: ' + describeError(error))
          continue
        }
        Promise.resolve()
          .then(() => handle(message))
          .then((response) => { if (response !== null && response !== undefined) send(response) })
          .catch((error) => fail(message && message.id !== undefined ? message.id : null, RPC_ERRORS.internal, describeError(error)))
      }
    })
    process.stdin.on('end', finish)
    process.stdin.on('close', finish)
    process.stdin.on('error', finish)
    process.on('SIGTERM', finish)
    process.on('SIGINT', finish)
  })

  return { name: serverInfo.name, tools, handle, serve, log }
}

/**
 * 便捷入口：建服务并进入 stdio 循环（未捕获异常写 stderr 后退出）。
 * @param {object} options 同 createMcpServer
 */
export async function runMcpServer(options) {
  const server = createMcpServer(options)
  server.log('ready · ' + server.tools.length + ' tools · protocol ' + PROTOCOL_VERSION)
  await server.serve()
}
