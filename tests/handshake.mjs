/**
 * 用真实 MCP 客户端（官方 SDK）握手测试内置服务。
 * 覆盖：初始化握手、tools/list、tools/call、错误路径。
 * 用法：node tests/handshake.mjs [serverName ...]
 */
import os from 'node:os'
import path from 'node:path'
import { loadSdk, SERVER_ENTRY } from './helpers.mjs'

// SDK 用插件自己的解析器找（找不到会抛出可读错误），路径不写死。
const { Client, StdioClientTransport } = await loadSdk()
const ENTRY = SERVER_ENTRY
const targets = process.argv.slice(2)
const servers = targets.length > 0 ? targets : ['files', 'exec', 'net', 'kb', 'util', 'device', 'hub']

const calls = {
  files: [{ name: 'write', arguments: { path: path.join(os.tmpdir(), 'mcp-handshake.txt'), content: 'hello mcp' } }, { name: 'read', arguments: { path: path.join(os.tmpdir(), 'mcp-handshake.txt') } }],
  exec: [{ name: 'which', arguments: { names: ['node', 'sh'] } }, { name: 'run', arguments: { command: 'echo hi', description: 'echo' } }],
  net: [{ name: 'url', arguments: { url: 'https://example.com/a?b=1&c=2' } }],
  kb: [{ name: 'remember', arguments: { text: 'DSH MCP Hub 握手测试', namespace: 'smoke', tags: ['test'] } }, { name: 'recall', arguments: { query: '握手', namespace: 'smoke' } }],
  util: [{ name: 'calc', arguments: { expression: '(1+2)*3^2' } }, { name: 'hash', arguments: { text: 'abc' } }],
  device: [{ name: 'ping', arguments: {} }],
  hub: [{ name: 'catalog', arguments: { limit: 3 } }],
}

const summary = []
for (const server of servers) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY, server], stderr: 'pipe' })
  const client = new Client({ name: 'dsh-mcp-hub-test', version: '1.0.0' })
  const row = { server, ok: false }
  try {
    await client.connect(transport)
    row.serverInfo = client.getServerVersion()
    const listed = await client.listTools()
    row.tools = listed.tools.length
    row.toolNames = listed.tools.map((tool) => tool.name)
    row.calls = []
    for (const call of calls[server] || []) {
      try {
        const result = await client.callTool(call)
        const text = (result.content || []).map((item) => (item.type === 'text' ? item.text : '[' + item.type + ']')).join('\n')
        row.calls.push({ tool: call.name, isError: result.isError === true, text: text.slice(0, 160) })
      } catch (error) {
        row.calls.push({ tool: call.name, failed: String(error && error.message ? error.message : error) })
      }
    }
    // 错误路径：未知工具必须可见地失败
    try {
      await client.callTool({ name: 'definitely_not_a_tool', arguments: {} })
      row.unknownTool = 'no-error'
    } catch (error) {
      row.unknownTool = 'rejected: ' + String(error && error.message ? error.message : error).slice(0, 80)
    }
    row.ok = true
  } catch (error) {
    row.error = String(error && error.stack ? error.stack : error).slice(0, 600)
  } finally {
    try { await client.close() } catch { /* 忽略 */ }
  }
  summary.push(row)
}

console.log(JSON.stringify(summary, null, 2))
const failed = summary.filter((row) => row.ok !== true)
process.exitCode = failed.length === 0 ? 0 : 1

