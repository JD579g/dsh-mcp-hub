/**
 * dsh-mcp-hub · 内置 MCP 服务：net
 *
 * 网络面：HTTP 请求、下载文件、抓取后按 JSONPath 取值、解析 URL。
 * 只做普通出网请求；不绕过任何宿主网络策略。注意：Node 的 fetch 不读
 * HTTP_PROXY / HTTPS_PROXY，需要代理时要显式传 proxy 参数。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { str, num, bool, getPath, truncate, describeError } from './util.js'
import { resolveSandboxPath } from './fs.js'

const strArr = (description) => ({ type: 'array', items: { type: 'string' }, description })

function headersFrom(input) {
  const headers = {}
  if (Array.isArray(input)) {
    for (const item of input) {
      const text = String(item)
      const index = text.indexOf(':')
      if (index > 0) headers[text.slice(0, index).trim()] = text.slice(index + 1).trim()
    }
  } else if (input !== null && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) headers[String(key)] = String(value)
  }
  return headers
}

/** 统一的可达性检查：非 2xx/3xx 一律当作失败，但把状态码带回去。 */
function assertOk(response, url) {
  if (response.status >= 400) {
    const error = new Error('HTTP ' + response.status + ' ' + response.statusText + '：' + url)
    error.status = response.status
    throw error
  }
}

async function readBody(response, maxBytes) {
  const reader = response.body === null ? null : response.body.getReader()
  if (reader === null) return { text: '', bytes: 0, truncated: false }
  const chunks = []
  let bytes = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done === true) break
    bytes += value.byteLength
    if (bytes > maxBytes) {
      chunks.push(value.subarray(0, Math.max(0, value.byteLength - (bytes - maxBytes))))
      truncated = true
      try { await reader.cancel() } catch { /* 已结束 */ }
      break
    }
    chunks.push(value)
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated }
}

export const netServer = {
  name: 'net',
  version: '1.0.0',
  title: '网络请求',
  instructions: 'HTTP 请求、下载与 JSON 抓取工具。响应体有大小上限，大文件请用 download。',
  tools: [
    {
      name: 'http',
      description: '发起一次 HTTP(S) 请求，返回状态码、响应头与响应体（默认上限 512 KiB）。',
      inputSchema: {
        type: 'object',
        properties: {
          url: str('完整 URL，含 http(s)://'),
          method: str('HTTP 方法，默认 GET'),
          headers: strArr('请求头，形如 "Name: value" 的数组'),
          body: str('请求体（字符串）'),
          timeoutMs: num('超时毫秒数，默认 30000'),
          maxBytes: num('响应体上限字节数，默认 524288'),
        },
        required: ['url'],
      },
      async handler(args) {
        const url = String(args.url === undefined ? '' : args.url)
        if (!/^https?:\/\//i.test(url)) throw new Error('url 必须是 http(s):// 开头的完整地址')
        const method = String(args.method === undefined ? 'GET' : args.method).toUpperCase()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(300000, Number(args.timeoutMs || 30000) || 30000)))
        try {
          const response = await fetch(url, {
            method,
            headers: headersFrom(args.headers),
            body: args.body === undefined || method === 'GET' || method === 'HEAD' ? undefined : String(args.body),
            redirect: 'follow',
            signal: controller.signal,
          })
          const headerObject = {}
          response.headers.forEach((value, key) => { headerObject[key] = value })
          const body = await readBody(response, Math.max(1024, Math.min(8 * 1024 * 1024, Number(args.maxBytes || 524288) || 524288)))
          assertOk(response, url)
          return {
            url: response.url,
            status: response.status,
            ok: response.ok,
            headers: headerObject,
            bytes: body.bytes,
            truncated: body.truncated,
            body: body.text,
          }
        } finally {
          clearTimeout(timer)
        }
      },
    },
    {
      name: 'download',
      description: '把 URL 下载到沙箱根目录内的文件（流式写盘），返回路径与大小。',
      inputSchema: {
        type: 'object',
        properties: {
          url: str('下载地址'),
          path: str('保存路径（必须在 /root 或 /tmp 内）'),
          maxBytes: num('最大下载字节数，默认 67108864（64 MiB）'),
          timeoutMs: num('超时毫秒数，默认 120000'),
        },
        required: ['url', 'path'],
      },
      async handler(args) {
        const url = String(args.url === undefined ? '' : args.url)
        if (!/^https?:\/\//i.test(url)) throw new Error('url 必须是 http(s):// 开头的完整地址')
        const target = await resolveSandboxPath(args.path)
        await fs.mkdir(path.dirname(target), { recursive: true })
        const maxBytes = Math.max(1024, Math.min(512 * 1024 * 1024, Number(args.maxBytes || 67108864) || 67108864))
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(600000, Number(args.timeoutMs || 120000) || 120000)))
        let handle
        try {
          const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
          assertOk(response, url)
          if (response.body === null) throw new Error('响应没有正文')
          handle = await fs.open(target, 'w')
          const reader = response.body.getReader()
          let bytes = 0
          for (;;) {
            const { done, value } = await reader.read()
            if (done === true) break
            bytes += value.byteLength
            if (bytes > maxBytes) {
              try { await reader.cancel() } catch { /* 忽略 */ }
              throw new Error('下载超过上限 ' + maxBytes + ' 字节')
            }
            await handle.write(value)
          }
          return { url: response.url, path: target, status: response.status, bytes }
        } catch (error) {
          if (handle !== undefined) await handle.close().catch(() => {})
          await fs.rm(target, { force: true }).catch(() => {})
          throw error
        } finally {
          clearTimeout(timer)
          if (handle !== undefined) await handle.close().catch(() => {})
        }
      },
    },
    {
      name: 'json',
      description: 'GET 一个 JSON 接口并按点号路径取值（支持 a.b[0].c）。query 为空则返回完整 JSON（受大小截断）。',
      inputSchema: {
        type: 'object',
        properties: {
          url: str('JSON 接口地址'),
          query: str('取值路径，例如 data.items[0].name'),
          headers: strArr('请求头数组'),
          maxBytes: num('响应体上限字节数，默认 524288'),
        },
        required: ['url'],
      },
      async handler(args) {
        const url = String(args.url === undefined ? '' : args.url)
        if (!/^https?:\/\//i.test(url)) throw new Error('url 必须是 http(s):// 开头的完整地址')
        const response = await fetch(url, { headers: headersFrom(args.headers), redirect: 'follow' })
        assertOk(response, url)
        const body = await readBody(response, Math.max(1024, Math.min(8 * 1024 * 1024, Number(args.maxBytes || 524288) || 524288)))
        let parsed
        try {
          parsed = JSON.parse(body.text)
        } catch (error) {
          throw new Error('响应不是合法 JSON：' + describeError(error) + '；前 200 字符：' + body.text.slice(0, 200))
        }
        const value = getPath(parsed, typeof args.query === 'string' ? args.query : '')
        return { url, status: response.status, query: args.query || '', value, text: truncate(JSON.stringify(value, null, 2), 60000) }
      },
    },
    {
      name: 'url',
      description: '解析 URL 的组成部分（协议、主机、端口、路径、查询参数），并展示查询参数表。',
      inputSchema: {
        type: 'object',
        properties: { url: str('要解析的 URL') },
        required: ['url'],
      },
      async handler(args) {
        let parsed
        try {
          parsed = new URL(String(args.url))
        } catch (error) {
          throw new Error('URL 不合法：' + describeError(error))
        }
        const params = {}
        for (const [key, value] of parsed.searchParams.entries()) {
          if (params[key] === undefined) params[key] = value
          else params[key] = [].concat(params[key], value)
        }
        return {
          href: parsed.href,
          protocol: parsed.protocol,
          host: parsed.host,
          hostname: parsed.hostname,
          port: parsed.port,
          pathname: parsed.pathname,
          hash: parsed.hash,
          params,
        }
      },
    },
  ],
}

