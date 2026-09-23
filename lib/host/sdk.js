/**
 * dsh-mcp-hub · MCP SDK 解析器
 *
 * 官方 SDK（@modelcontextprotocol/sdk）在 DSH 安装树里一定存在，但插件自身
 * 可能被 link 到别处（/root/dsha-*），Node 的裸包解析未必找得到它。
 * 这里按「自己 → DSH_HOME → dsh 安装树 → NODE_PATH」顺序探测，找到后用
 * 绝对 file URL import，完全绕开裸包解析的脆弱性。
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

function candidateRoots() {
  const roots = []
  const push = (dir) => {
    if (typeof dir === 'string' && dir !== '' && !roots.includes(dir)) roots.push(dir)
  }
  push(process.env.DSH_MCP_SDK_ROOT)
  for (const name of (process.env.NODE_PATH || '').split(path.delimiter)) push(name)
  push(path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'node_modules'))
  // 全局安装的 DSH 自己的依赖树：SDK 通常就在这里面。
  push(path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  push('/usr/local/lib/node_modules')
  push('/usr/lib/node_modules')
  push(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'))
  // Windows 的全局 npm 目录：%APPDATA%\npm\node_modules（还有 node 安装器那份）。
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, 'npm', 'node_modules'))
  if (process.env.ProgramFiles) push(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules'))
  push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'))
  return roots
}

let cached = null

/** 解析 SDK 包目录；失败返回 null（调用方给出可读错误）。 */
export function resolveSdkDir() {
  if (cached !== null) return cached
  for (const root of candidateRoots()) {
    const dir = path.join(root, '@modelcontextprotocol', 'sdk')
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
      if (typeof manifest.exports === 'object' && existsSync(path.join(dir, 'dist', 'esm', 'client', 'index.js'))) {
        cached = dir
        return cached
      }
    } catch { /* 试下一个根 */ }
  }
  cached = null
  return null
}

/**
 * 载入 SDK 的三个客户端入口。所有入口都通过绝对路径导入。
 * @returns {Promise<{Client:any,StdioClientTransport:any,StreamableHTTPClientTransport:any,dir:string}>}
 */
export async function loadSdk() {
  const dir = resolveSdkDir()
  if (dir === null) {
    throw new Error('找不到 @modelcontextprotocol/sdk（已尝试：' + candidateRoots().join('、') +
      '）。请安装 Node 版 DSH，或把 SDK 所在目录写进 DSH_MCP_SDK_ROOT / NODE_PATH。')
  }
  const base = pathToFileURL(path.join(dir, 'dist', 'esm')).href
  const [clientModule, stdioModule, httpModule] = await Promise.all([
    import(base + '/client/index.js'),
    import(base + '/client/stdio.js'),
    import(base + '/client/streamableHttp.js'),
  ])
  return {
    Client: clientModule.Client,
    StdioClientTransport: stdioModule.StdioClientTransport,
    StreamableHTTPClientTransport: httpModule.StreamableHTTPClientTransport,
    dir,
  }
}

export function sdkCandidates() {
  return candidateRoots()
}

