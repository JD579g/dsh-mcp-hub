#!/usr/bin/env node
/**
 * dsh-mcp-hub · 内置 MCP 服务统一入口
 *
 * 用法：
 *   node main.js <server> [--transport stdio|http] [--port 3456] [--path /mcp]
 *
 * 服务名：files / exec / net / kb / util / device / hub
 *   node main.js list     列出全部内置服务与工具数
 *
 * 任何宿主都可以直接把它当 stdio MCP 服务启动，例如：
 *   { "command": "node", "args": ["/root/dsha-mcp-hub/lib/servers/main.js", "files"] }
 */

import { runMcpServer, createMcpServer } from './runtime.js'
import { filesServer } from './fs.js'
import { execServer } from './exec.js'
import { netServer } from './net.js'
import { kbServer } from './kb.js'
import { utilServer } from './utilserver.js'
import { deviceServer } from './device.js'
import { hubServer } from './hub.js'

export const SERVERS = {
  files: filesServer,
  exec: execServer,
  net: netServer,
  kb: kbServer,
  util: utilServer,
  device: deviceServer,
  hub: hubServer,
}

export function serverNames() {
  return Object.keys(SERVERS).sort()
}

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item.startsWith('--')) {
      const [key, inline] = item.slice(2).split('=')
      if (inline !== undefined) flags[key] = inline
      else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) { flags[key] = argv[index + 1]; index += 1 }
      else flags[key] = true
    } else positional.push(item)
  }
  return { positional, flags }
}

/** 可选：纯 Node 内置模块实现的 Streamable HTTP 传输（POST /mcp，逐条 JSON 响应）。 */
async function serveHttp(server, port, routePath) {
  const { createServer } = await import('node:http')
  const http = createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(405, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'use POST' }))
      return
    }
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 8 * 1024 * 1024) request.destroy()
    })
    request.on('end', async () => {
      let message
      try {
        message = JSON.parse(body)
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
        return
      }
      const result = await server.handle(message)
      if (result === null || result === undefined) {
        response.writeHead(202)
        response.end()
        return
      }
      const payload = JSON.stringify(result)
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
      response.end(payload)
    })
  })
  await new Promise((resolve) => http.listen(port, '127.0.0.1', resolve))
  server.log('http transport listening on http://127.0.0.1:' + port + (routePath || ''))
  return http
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const requested = positional[0]

  if (requested === undefined || requested === 'list' || requested === '--help') {
    const rows = serverNames().map((key) => ({ server: key, tools: SERVERS[key].tools.length, title: SERVERS[key].title }))
    process.stdout.write(JSON.stringify({ servers: rows, totalTools: rows.reduce((sum, row) => sum + row.tools, 0) }, null, 2) + '\n')
    return
  }

  const definition = SERVERS[requested]
  if (definition === undefined) {
    process.stderr.write('未知服务：' + requested + '\n可选：' + serverNames().join(' / ') + '\n')
    process.exitCode = 2
    return
  }

  const transport = typeof flags.transport === 'string' ? flags.transport : 'stdio'
  if (transport === 'http') {
    const server = createMcpServer(definition)
    const port = Number(flags.port || 3456)
    await serveHttp(server, port, flags.path)
    return
  }

  await runMcpServer(definition)
}

main().catch((error) => {
  try {
    process.stderr.write('[mcp] fatal: ' + (error && error.stack ? error.stack : String(error)) + '\n')
  } catch { /* 忽略 */ }
  process.exit(1)
})

