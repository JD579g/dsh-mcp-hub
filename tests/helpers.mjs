/**
 * dsh-mcp-hub · 测试公共工具
 *
 * 所有测试都必须**从仓库自身位置**解析路径：写死 /root/dsha-mcp-hub 会让
 * clone 到别处的开发者（以及 GitHub Actions 上的 Windows/macOS runner）
 * 直接跑不起来。这里统一提供：
 *   - ROOT / libPath / libUrl / importLib：仓库内的路径与动态 import；
 *   - resolveSdkDir / importSdk：官方 MCP SDK（复用插件自己的解析器）；
 *   - importDshPackage：@deepseek-ai/dsh-* 这类宿主包（本地 DSH 安装树里找，
 *     找不到就返回 null，让调用方明确跳过而不是假失败）。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

/** 仓库根目录。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 仓库内某个文件的绝对路径。 */
export function libPath(...segments) {
  return path.join(ROOT, 'lib', ...segments)
}

/** 仓库内某个文件的 file:// URL（给动态 import 用）。 */
export function libUrl(...segments) {
  return pathToFileURL(libPath(...segments)).href
}

/** 动态 import 仓库内的模块。 */
export function importLib(...segments) {
  return import(libUrl(...segments))
}

/** 内置 MCP 服务的入口文件。 */
export const SERVER_ENTRY = libPath('servers', 'main.js')

/** 判定当前平台能否跑某个命令。 */
export function hasCommand(command) {
  const probe = process.platform === 'win32' ? 'where' : 'command'
  const args = process.platform === 'win32' ? [command] : ['-v', command]
  if (probe === 'command') return spawnSync('/bin/sh', ['-c', 'command -v ' + command + ' >/dev/null 2>&1']).status === 0
  return spawnSync(probe, args, { encoding: 'utf8' }).status === 0
}

/** 官方 MCP SDK 的目录（复用插件自己的解析器，找不到返回 null）。 */
export async function resolveSdkDir() {
  const { resolveSdkDir: resolve } = await importLib('host', 'sdk.js')
  return resolve()
}

/** 载入 SDK 的客户端入口；找不到 SDK 时抛错（调用方决定跳过还是失败）。 */
export async function loadSdk() {
  const { loadSdk: load } = await importLib('host', 'sdk.js')
  return load()
}

/** 找 @deepseek-ai/dsh-* 这类宿主包：先裸包解析，再翻本地 DSH 安装树。 */
export function dshPackageDir(name) {
  const candidates = []
  const push = (dir) => { if (typeof dir === 'string' && dir !== '' && !candidates.includes(dir)) candidates.push(dir) }
  push(process.env.DSH_NODE_MODULES)
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  push(path.join(dshHome, 'profiles', 'node_modules'))
  push(path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  push(path.join(ROOT, 'node_modules'))
  // 全局安装目录（含 Windows 的 %APPDATA%\npm）
  const npmRoot = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
    encoding: 'utf8', shell: process.platform === 'win32',
  })
  if (npmRoot.status === 0) push((npmRoot.stdout || '').trim())
  push('/usr/local/lib/node_modules')
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, 'npm', 'node_modules'))

  for (const root of candidates) {
    const dir = path.join(root, ...name.split('/'))
    try {
      const manifest = path.join(dir, 'package.json')
      // 同步探测：调用方都在顶层 await 之前用
      if (spawnSync(process.execPath, ['-e', 'require("fs").accessSync(process.argv[1])', manifest]).status === 0) return dir
    } catch { /* 试下一个 */ }
  }
  return null
}

/** 动态 import 一个宿主包；找不到返回 null（调用方明确跳过）。 */
export async function importDshPackage(name) {
  try {
    return await import(name)
  } catch { /* 裸包解析失败，翻安装树 */ }
  const dir = dshPackageDir(name)
  if (dir === null) return null
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'))
    const entry = typeof manifest.exports === 'string'
      ? manifest.exports
      : (manifest.exports && manifest.exports['.'] && manifest.exports['.'].import) || manifest.main || 'lib/index.js'
    return await import(pathToFileURL(path.join(dir, entry)).href)
  } catch {
    return null
  }
}
