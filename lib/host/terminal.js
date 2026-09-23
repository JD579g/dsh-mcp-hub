/**
 * dsh-mcp-hub · 内置终端（宿主侧）
 *
 * 桌面版的「集成终端」：一个真正的持久 shell 会话 —— cd / export / $env: 都保留状态，
 * 输出以增量块轮询取回，浏览器不需要 WebSocket。
 *
 * 平台差异集中在这里处理：
 *   Windows：优先 pwsh.exe（PowerShell 7）→ powershell.exe → cmd.exe；
 *            cmd 用 /Q /K 保持会话，PowerShell 用 -Command - 从 stdin 读命令。
 *   POSIX  ：$SHELL → /bin/bash → /bin/zsh → /bin/sh，统一 -i。
 *   首选 shell 不存在（ENOENT）时自动回退到下一个候选，而不是直接失败。
 *
 * 安全边界：与 exec 服务共用平台拒绝清单（Windows 的 format/diskpart/…、
 * POSIX 的 mkfs/dd/mount/…），单条输出有上限，会话数量与闲置时间也有上限。
 */

import { spawn } from 'node:child_process'
import os from 'node:os'
import { interactiveShells, matchDeny, isWindows, platformLabel } from '../platform.js'

const MAX_SESSIONS = 8
const MAX_BUFFER_BYTES = 512 * 1024
const IDLE_TIMEOUT_MS = 30 * 60 * 1000

/** 命中拒绝清单返回该正则，否则 null（HTTP API 等地方也会用）。 */
export function guardCommand(command) {
  return matchDeny(command)
}

/**
 * @param {object} options
 * @param {string} [options.cwd] 工作目录
 * @param {(line:string)=>void} options.log
 */
export function createTerminalService(options = {}) {
  const log = options.log || (() => {})
  const candidates = interactiveShells()
  /** @type {Map<string, object>} */
  const sessions = new Map()
  let counter = 0
  let disposed = false

  function reap() {
    const now = Date.now()
    for (const session of [...sessions.values()]) {
      if (now - session.usedAt > IDLE_TIMEOUT_MS) close(session.id, 'idle-timeout')
    }
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((left, right) => left.usedAt - right.usedAt)[0]
      if (oldest === undefined) break
      close(oldest.id, 'too-many-sessions')
    }
  }

  /** 追加一块输出。chunks[i].index 就是它递增的序号，客户端按序号取增量。 */
  function push(session, text) {
    if (typeof text !== 'string' || text === '') return
    session.chunks.push({ index: session.seq, text })
    session.seq += 1
    session.pendingBytes += Buffer.byteLength(text, 'utf8')
    while (session.pendingBytes > MAX_BUFFER_BYTES && session.chunks.length > 1) {
      const dropped = session.chunks.shift()
      session.pendingBytes -= Buffer.byteLength(dropped.text, 'utf8')
      session.dropped += 1
      if (session.firstIndex <= dropped.index) session.firstIndex = dropped.index + 1
    }
    session.usedAt = Date.now()
  }

  /** 终端子进程的环境：POSIX 去掉提示符装饰，Windows 关掉交互回显干扰。 */
  function childEnv() {
    const env = { ...process.env }
    if (isWindows()) {
      env.PROMPT = ''
      env.PSModuleAutoLoadingPreference = 'None'
    } else {
      env.PS1 = ''
      env.TERM = 'dumb'
      env.PROMPT_COMMAND = ''
    }
    return env
  }

  /**
   * 起一个 shell 会话。首选不存在时自动回退下一个候选。
   * @param {string} id 会话 id
   * @param {number} candidateIndex 当前候选下标
   */
  function spawnSession(id, candidateIndex = 0) {
    const candidate = candidates[Math.min(candidateIndex, candidates.length - 1)]
    const child = spawn(candidate.command, candidate.args, {
      cwd: options.cwd || os.homedir(),
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    })
    const session = {
      id,
      child,
      chunks: [],
      seq: 0,
      firstIndex: 0,
      pendingBytes: 0,
      dropped: 0,
      runs: 0,
      createdAt: Date.now(),
      usedAt: Date.now(),
      lastExit: null,
      alive: true,
      buffer: '',
      shell: candidate.command,
      shellLabel: candidate.label,
      candidateIndex,
    }
    const onData = (chunk) => {
      session.buffer += chunk.toString('utf8')
      let index = session.buffer.indexOf('\n')
      while (index >= 0) {
        push(session, session.buffer.slice(0, index + 1))
        session.buffer = session.buffer.slice(index + 1)
        index = session.buffer.indexOf('\n')
      }
      // 没有换行的提示符也先给出去，交互感更好
      if (session.buffer.length > 0 && session.buffer.length < 4096 && !session.buffer.includes('\r')) {
        push(session, session.buffer)
        session.buffer = ''
      }
      if (session.buffer.length > 8192) {
        push(session, session.buffer)
        session.buffer = ''
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (error) => {
      const missing = error !== null && error !== undefined && error.code === 'ENOENT'
      if (missing && candidateIndex + 1 < candidates.length) {
        push(session, '[终端] 找不到 ' + candidate.command + '，改用 ' + candidates[candidateIndex + 1].command + '\n')
        const retry = spawnSession(id, candidateIndex + 1)
        retry.chunks = session.chunks
        retry.seq = session.seq
        retry.firstIndex = session.firstIndex
        retry.pendingBytes = session.pendingBytes
        retry.dropped = session.dropped
        retry.runs = session.runs
        retry.createdAt = session.createdAt
        sessions.set(id, retry)
        return
      }
      push(session, '[终端错误] ' + String(error && error.message ? error.message : error) + '\n')
    })
    child.on('exit', (code, signal) => {
      session.alive = false
      session.lastExit = { code, signal: signal || null, at: new Date().toISOString() }
      push(session, '\n[会话结束 exit=' + String(code) + (signal ? ' signal=' + signal : '') + ']\n')
    })
    return session
  }


  function ensure(id) {
    if (disposed) throw new Error('终端服务已关闭')
    const wanted = id === undefined || id === null || id === '' ? null : String(id)
    if (wanted !== null) {
      const existing = sessions.get(wanted)
      if (existing !== undefined) return existing
    }
    reap()
    counter += 1
    const newId = wanted !== null ? wanted : 't' + counter
    const session = spawnSession(newId, 0)
    sessions.set(newId, session)
    log('终端会话已创建：' + newId + '（' + session.shell + '）')
    return session
  }

  function close(id, reason) {
    const session = sessions.get(String(id))
    if (session === undefined) return false
    sessions.delete(String(id))
    try {
      session.child.kill('SIGTERM')
      setTimeout(() => { try { session.child.kill('SIGKILL') } catch { /* 已退出 */ } }, 1500).unref?.()
    } catch { /* 已退出 */ }
    log('终端会话已关闭：' + id + (reason ? '（' + reason + '）' : ''))
    return true
  }

  /** 执行一条命令（写入交互式 shell 的 stdin）。 */
  function run(id, command) {
    const text = String(command === undefined ? '' : command)
    if (text.trim() === '') return { ok: false, error: '命令为空' }
    const blocked = guardCommand(text)
    if (blocked !== null) {
      return { ok: false, error: '命令命中拒绝规则 /' + blocked + '/i，已在终端层拦下（系统级破坏性操作请手动执行）' }
    }
    const session = ensure(id)
    session.runs += 1
    session.usedAt = Date.now()
    try {
      session.child.stdin.write(text + '\n')
    } catch (error) {
      return { ok: false, error: '写入终端失败：' + String(error && error.message ? error.message : error) }
    }
    return { ok: true, id: session.id, cursor: session.seq, shell: session.shell }
  }

  /**
   * 取增量输出：返回序号 >= cursor 的所有块，并给出下一次该带的 cursor。
   * @param {string} id 会话 id
   * @param {number} cursor 客户端已读到的序号
   */
  function poll(id, cursor) {
    const session = sessions.get(String(id))
    if (session === undefined) return { ok: false, id: String(id), error: '会话不存在（可能已超时回收）' }
    const wanted = Math.max(0, Math.floor(Number(cursor || 0) || 0))
    const chunks = session.chunks.filter((chunk) => chunk.index >= wanted)
    session.usedAt = Date.now()
    return {
      ok: true,
      id: session.id,
      alive: session.alive,
      cursor: session.seq,
      earliest: session.firstIndex,
      dropped: session.dropped,
      output: chunks.map((chunk) => chunk.text).join(''),
      shell: session.shell,
      shellLabel: session.shellLabel,
      lastExit: session.lastExit,
    }
  }

  function stat(id) {
    const session = sessions.get(String(id))
    if (session === undefined) return null
    return {
      id: session.id,
      alive: session.alive,
      shell: session.shell,
      shellLabel: session.shellLabel,
      runs: session.runs,
      createdAt: new Date(session.createdAt).toISOString(),
      pendingBytes: session.pendingBytes,
      dropped: session.dropped,
      lastExit: session.lastExit,
    }
  }

  /** 终端能力自述：给界面显示「Win · PowerShell 7」这类信息用。 */
  function describe() {
    return {
      platform: process.platform,
      osLabel: platformLabel(),
      candidates: candidates.map((item) => ({ command: item.command, label: item.label })),
      active: [...sessions.values()].map((session) => ({ id: session.id, shell: session.shell, alive: session.alive })),
    }
  }

  function closeAll() {
    for (const id of [...sessions.keys()]) close(id, 'dispose')
  }

  function dispose() {
    disposed = true
    closeAll()
  }

  return { run, poll, close, closeAll, dispose, stat, describe, list: () => [...sessions.keys()], shells: candidates }
}

