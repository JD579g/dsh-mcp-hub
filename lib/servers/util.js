/**
 * dsh-mcp-hub · 工具函数：参数校验、结果渲染、shell 执行、JSON 取值
 */

import { spawn } from 'node:child_process'
import { commandShell, pathApi } from '../platform.js'

export const str = (description) => ({ type: 'string', description })
export const num = (description) => ({ type: 'number', description })
export const bool = (description) => ({ type: 'boolean', description })
export const strArray = (description) => ({ type: 'array', items: { type: 'string' }, description })

export function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (error instanceof Error) return error.message || String(error)
  return typeof error === 'string' ? error : JSON.stringify(error)
}

export function truncate(text, limit) {
  if (typeof text !== 'string') return ''
  if (text.length <= limit) return text
  return text.slice(0, limit) + '\n…（已截断，共 ' + text.length + ' 字符）'
}

/**
 * 执行一个外部命令，收集 stdout/stderr，带超时与输出上限。
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean, durationMs:number}>}
 */
export function runCommand(command, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 30000)
  const maxBytes = Math.max(1024, Number(options.maxBytes) || 262144)
  // 平台壳：Windows 用 cmd /d /s /c，POSIX 用 /bin/sh -c（都可被 options.shell 覆盖）。
  const spec = options.shell !== undefined && options.shell !== ''
    ? { command: options.shell, args: ['-c'] }
    : commandShell()
  const started = Date.now()
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(spec.command, [...spec.args, command], {
        cwd: options.cwd || process.cwd(),
        env: options.env === undefined ? process.env : options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: describeError(error), timedOut: false, durationMs: 0 })
      return
    }
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBytes) stdout = Buffer.concat([stdout, chunk])
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxBytes) stderr = Buffer.concat([stderr, chunk])
    })
    const finish = (code, signal) => {
      clearTimeout(timer)
      resolve({
        code,
        signal: signal || null,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
        durationMs: Date.now() - started,
      })
    }
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, signal: null, stdout: stdout.toString('utf8'), stderr: describeError(error), timedOut, durationMs: Date.now() - started })
    })
    child.on('close', finish)
  })
}

/** 把命令结果渲染成模型友好的一段文本 + 结构化字段。 */
export function commandResult(result, options = {}) {
  const maxChars = Math.max(1000, Number(options.maxChars) || 60000)
  let text = ''
  if (result.stdout) text += truncate(result.stdout, maxChars)
  if (result.stderr) text += (text ? '\n' : '') + '[stderr]\n' + truncate(result.stderr, maxChars)
  if (result.timedOut) text += (text ? '\n' : '') + '[超时] 命令在超时后被 SIGKILL 终止'
  if (text === '') text = '(无输出)'
  const marker = result.timedOut ? '(超时)' : String(result.code)
  return {
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: truncate(result.stdout, maxChars),
    stderr: truncate(result.stderr, maxChars),
    text: '[exit code: ' + marker + ']\n' + text,
  }
}

/**
 * 极简 JSONPath 取值：支持 a.b[0].c 与可选通配 *。
 * 找不到时抛错（便于模型发现路径写错）。
 */
export function getPath(value, expression) {
  if (typeof expression !== 'string' || expression.trim() === '') return value
  const parts = expression
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  let current = value
  for (const part of parts) {
    if (current === null || current === undefined) throw new Error('路径 ' + expression + ' 在 ' + part + ' 处为空')
    if (Array.isArray(current)) {
      if (part === '*') continue
      const index = Number(part)
      if (!Number.isInteger(index)) throw new Error('数组下标非法：' + part)
      current = current[index]
      continue
    }
    if (typeof current !== 'object') throw new Error('路径 ' + expression + ' 在 ' + part + ' 处不是对象')
    if (part === '*') continue
    if (!(part in current)) throw new Error('路径 ' + expression + ' 中不存在字段 ' + part)
    current = current[part]
  }
  return current
}

/** 把任意值渲染成受控的文本 + 结构化内容。 */
export function textResult(value, text) {
  return { content: [{ type: 'text', text: text === undefined ? JSON.stringify(value, null, 2) : text }], structuredContent: value }
}

