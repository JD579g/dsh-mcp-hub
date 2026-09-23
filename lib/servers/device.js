/**
 * dsh-mcp-hub · 内置 MCP 服务：device
 *
 * 通过本机 DSHA 桥（默认 http://127.0.0.1:3090/app/*）操作 Android 设备：
 * 读屏、点按、输入、滑动、截屏、应用启停、通知、剪贴板、位置、传感器等。
 * 令牌自动从 DSH_BRIDGE_TOKEN 环境变量或 ~/.dsh/.bridge_token 读取。
 *
 * 端点清单永远以桥自身的 /app/help 为准；generic 工具可以调用任何端点。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { str, num, bool, describeError } from './util.js'

function bridgeBase() {
  return (process.env.DSHA_BRIDGE_BASE || 'http://127.0.0.1:3090').replace(/\/+$/, '')
}

async function bridgeToken() {
  if (process.env.DSH_BRIDGE_TOKEN) return process.env.DSH_BRIDGE_TOKEN.trim()
  const candidates = [
    process.env.DSHA_BRIDGE_TOKEN_FILE,
    path.join(os.homedir(), '.dsh', '.bridge_token'),
    '/root/.dsh/.bridge_token',
  ].filter((item) => typeof item === 'string' && item !== '')
  for (const file of candidates) {
    try {
      const text = await fs.readFile(file, 'utf8')
      if (text.trim() !== '') return text.trim()
    } catch { /* 试下一个 */ }
  }
  return null
}

/** 调用桥上的一个 /app/* 端点。 */
async function callBridge(endpoint, params = {}, options = {}) {
  const token = await bridgeToken()
  const url = new URL(bridgeBase() + (endpoint.startsWith('/') ? endpoint : '/' + endpoint))
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === false) continue
    url.searchParams.set(key, String(value))
  }
  if (token !== null && !url.searchParams.has('token')) url.searchParams.set('token', token)
  const timeoutMs = Math.max(1000, Math.min(300000, Number(options.timeoutMs || 30000) || 30000))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, method: options.method || 'GET' })
    const contentType = response.headers.get('content-type') || ''
    const text = await response.text()
    if (!response.ok) {
      throw new Error('桥返回 HTTP ' + response.status + '：' + text.slice(0, 600) + '\n（若为 404/权限错误，请确认 DSHA App 在运行、设备能力已在设置中授权）')
    }
    if (contentType.includes('json')) {
      try {
        return { status: response.status, json: JSON.parse(text), body: text }
      } catch {
        return { status: response.status, body: text }
      }
    }
    return { status: response.status, body: text, contentType }
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('桥调用超时（' + timeoutMs + 'ms）：' + endpoint)
    throw new Error('无法连接 DSHA 桥 ' + bridgeBase() + '：' + describeError(error))
  } finally {
    clearTimeout(timer)
  }
}

function valueOf(result) {
  return result.json === undefined ? { status: result.status, body: truncateBody(result.body) } : { status: result.status, ...result.json }
}

function truncateBody(body) {
  if (typeof body !== 'string') return body
  return body.length > 20000 ? body.slice(0, 20000) + '\n…（截断）' : body
}

export const deviceServer = {
  name: 'device',
  version: '1.0.0',
  title: 'Android 设备',
  instructions: '通过本机 DSHA 桥（/app/*）操作这台 Android 设备。端点清单以 bridge_help 返回的 /app/help 为准。',
  tools: [
    {
      name: 'ping',
      description: '连通性检查：桥地址、令牌是否可读、DEVELOP 元信息。',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        const token = await bridgeToken()
        const info = { base: bridgeBase(), tokenFound: token !== null, tokenLength: token === null ? 0 : token.length }
        try {
          const result = await callBridge('/app/version', {}, { timeoutMs: 8000 })
          info.reachable = true
          info.response = valueOf(result)
        } catch (error) {
          info.reachable = false
          info.error = describeError(error)
        }
        return info
      },
    },
    {
      name: 'bridge_help',
      description: '返回 DSHA 桥的完整端点清单（每个端点的参数与写法）。要用设备能力时先查它。',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        const result = await callBridge('/app/help')
        return { status: result.status, body: result.body }
      },
    },
    {
      name: 'call',
      description: '调用任意 /app/* 端点（参数以键值对传入）。用于 bridge_help 里列出的、这里没有封装的能力。',
      inputSchema: {
        type: 'object',
        properties: {
          endpoint: str('端点路径，例如 /app/ui/dump 或 /app/toast'),
          params: { type: 'object', description: '查询参数对象（值会被转成字符串）' },
          timeoutMs: num('超时毫秒数，默认 30000'),
        },
        required: ['endpoint'],
      },
      async handler(args) {
        const endpoint = String(args.endpoint === undefined ? '' : args.endpoint)
        if (!endpoint.startsWith('/app/')) throw new Error('endpoint 必须以 /app/ 开头')
        const result = await callBridge(endpoint, args.params !== null && typeof args.params === 'object' ? args.params : {}, { timeoutMs: args.timeoutMs })
        return valueOf(result)
      },
    },
    {
      name: 'device_info',
      description: '设备与桥的状态信息（型号、电量、网络、屏幕等，取决于 App 版本）。',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        return valueOf(await callBridge('/app/device'))
      },
    },
    {
      name: 'ui_dump',
      description: '读取当前屏幕的无障碍节点树（用于决定下一步点在哪里）。返回节点与文本。',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        return valueOf(await callBridge('/app/ui/dump'))
      },
    },
    {
      name: 'ui_tap',
      description: '按文字（或坐标）点按。优先 text，找不到再给 x/y。',
      inputSchema: {
        type: 'object',
        properties: {
          text: str('要点击的控件文字'),
          x: num('横坐标（像素）'),
          y: num('纵坐标（像素）'),
        },
      },
      async handler(args) {
        if (typeof args.text === 'string' && args.text !== '') return valueOf(await callBridge('/app/ui/tap', { text: args.text }))
        if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) return valueOf(await callBridge('/app/ui/tap', { x: Number(args.x), y: Number(args.y) }))
        throw new Error('需要 text，或同时提供 x 与 y')
      },
    },
    {
      name: 'ui_input',
      description: '向当前焦点输入文本。',
      inputSchema: {
        type: 'object',
        properties: { text: str('要输入的文本') },
        required: ['text'],
      },
      async handler(args) {
        return valueOf(await callBridge('/app/ui/input', { text: String(args.text === undefined ? '' : args.text) }))
      },
    },
    {
      name: 'ui_swipe',
      description: '滑动屏幕（可传方向，或起止坐标）。',
      inputSchema: {
        type: 'object',
        properties: {
          x1: num('起点 X'), y1: num('起点 Y'), x2: num('终点 X'), y2: num('终点 Y'),
          ms: num('滑动时长毫秒，默认 300'),
        },
      },
      async handler(args) {
        const params = {}
        for (const key of ['x1', 'y1', 'x2', 'y2', 'ms']) if (Number.isFinite(Number(args[key]))) params[key] = Number(args[key])
        if (Object.keys(params).length < 4) throw new Error('需要 x1/y1/x2/y2（可加 ms）')
        return valueOf(await callBridge('/app/ui/swipe', params))
      },
    },
    {
      name: 'screenshot',
      description: '截屏。默认保存到沙箱内文件并返回路径与大小；save=false 时返回原始响应（可能很大）。',
      inputSchema: {
        type: 'object',
        properties: {
          path: str('保存路径，默认 /tmp/dsha-screenshot.png'),
          save: bool('是否落盘，默认 true'),
        },
      },
      async handler(args) {
        const result = await callBridge('/app/ui/screenshot', {}, { timeoutMs: 60000 })
        const save = args.save !== false
        if (!save) return { status: result.status, body: truncateBody(result.body) }
        const target = typeof args.path === 'string' && args.path !== '' ? args.path : '/tmp/dsha-screenshot.png'
        const { resolveSandboxPath } = await import('./fs.js')
        const resolved = await resolveSandboxPath(target)
        await fs.mkdir(path.dirname(resolved), { recursive: true })
        const body = result.body || ''
        const base64 = body.startsWith('data:') ? body.slice(body.indexOf(',') + 1) : body.replace(/^\s+|\s+$/g, '')
        if (/^[A-Za-z0-9+/=\s]+$/.test(base64) && base64.length > 100) {
          await fs.writeFile(resolved, Buffer.from(base64, 'base64'))
          const stat = await fs.stat(resolved)
          return { path: resolved, bytes: stat.size, note: '已把 base64 截图解码写入该路径' }
        }
        await fs.writeFile(resolved, body, 'utf8')
        return { path: resolved, bytes: Buffer.byteLength(body, 'utf8'), note: '桥返回的不是 base64，已按文本原样保存' }
      },
    },
    {
      name: 'ui_key',
      description: '发送按键。桥支持的名字：back / home / recents / notifications / quicksettings / lock。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: ['back', 'home', 'recents', 'notifications', 'quicksettings', 'lock'], description: '按键名' },
        },
        required: ['name'],
      },
      async handler(args) {
        return valueOf(await callBridge('/app/ui/key', { name: String(args.name === undefined ? '' : args.name) }))
      },
    },
    {
      name: 'apps',
      description: '列出已安装应用，可用 q 关键字过滤。',
      inputSchema: {
        type: 'object',
        properties: { q: str('过滤关键字（包名或应用名）') },
      },
      async handler(args) {
        return valueOf(await callBridge('/app/apps', typeof args.q === 'string' && args.q !== '' ? { q: args.q } : {}))
      },
    },
    {
      name: 'launch',
      description: '启动应用（传包名）。',
      inputSchema: {
        type: 'object',
        properties: { pkg: str('应用包名，例如 com.tencent.mm') },
        required: ['pkg'],
      },
      async handler(args) {
        return valueOf(await callBridge('/app/launch', { pkg: String(args.pkg === undefined ? '' : args.pkg) }))
      },
    },
    {
      name: 'notify',
      description: '在本机弹一条通知（标题 + 正文）。',
      inputSchema: {
        type: 'object',
        properties: {
          title: str('通知标题'),
          text: str('通知正文'),
        },
        required: ['text'],
      },
      async handler(args) {
        return valueOf(await callBridge('/app/notify', { title: args.title === undefined ? 'DSH MCP' : String(args.title), text: String(args.text === undefined ? '' : args.text) }))
      },
    },
    {
      name: 'clipboard',
      description: '读剪贴板；传 text 则写入剪贴板。',
      inputSchema: {
        type: 'object',
        properties: { text: str('要写入剪贴板的文本；省略则读取') },
      },
      async handler(args) {
        return valueOf(await callBridge('/app/clip', typeof args.text === 'string' ? { text: args.text } : {}))
      },
    },
    {
      name: 'location',
      description: '读取当前定位（需要 App 已授权定位）。',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        return valueOf(await callBridge('/app/location'))
      },
    },
    {
      name: 'open_url',
      description: '用系统打开一个链接或 URI。',
      inputSchema: {
        type: 'object',
        properties: { url: str('要打开的 http(s) 链接或系统 URI') },
        required: ['url'],
      },
      async handler(args) {
        return valueOf(await callBridge('/app/open', { url: String(args.url === undefined ? '' : args.url) }))
      },
    },
    {
      name: 'ask',
      description: '在设备上向用户弹一个问题并拿到选择结果（阻塞直到用户作答或超时）。',
      inputSchema: {
        type: 'object',
        properties: {
          q: str('问题文本'),
          options: str('选项，用竖线分隔，例如 "是|否|稍后"'),
        },
        required: ['q'],
      },
      async handler(args) {
        return valueOf(await callBridge('/app/ask', { q: String(args.q === undefined ? '' : args.q), options: args.options === undefined ? undefined : String(args.options) }, { timeoutMs: 120000 }))
      },
    },
  ],
}

