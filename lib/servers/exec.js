/**
 * dsh-mcp-hub · 内置 MCP 服务：exec
 *
 * 命令执行面：跑 shell 命令、探测程序是否存在、读环境变量、看系统资源。
 * 与 DSH 的设备策略无关 —— 这是宿主进程权限下的普通子进程；只做超时与输出限额，
 * 不做任何提权。危险命令按**平台**拒绝清单拦截：
 *   Windows：format / diskpart / bcdedit / cipher /w / reg delete HKLM / rd /s /q C:\ / Remove-Item -Recurse C:\ …
 *   POSIX  ：mkfs / dd of=/dev / mount / reboot / rm -rf / …
 *
 * 环境变量：
 *   MCP_EXEC_DENY  追加的拒绝正则（分号分隔）
 *   MCP_EXEC_ROOT  命令默认工作目录
 */

import os from 'node:os'
import { str, num, bool, runCommand, commandResult } from './util.js'
import { matchDeny, commandShell, resolveExecutable, platformLabel } from '../platform.js'

/** 命中拒绝清单则抛错，让模型看到明确原因。 */
function guard(command) {
  const pattern = matchDeny(command)
  if (pattern !== null) {
    throw new Error('命令命中拒绝规则 /' + pattern + '/i，已拒绝执行（系统级破坏性操作请由用户手动确认后执行）')
  }
}

const strArr = (description) => ({ type: 'array', items: { type: 'string' }, description })

export const execServer = {
  name: 'exec',
  version: '1.0.0',
  title: '命令执行',
  instructions: '在宿主权限下执行 shell 命令、探测程序与查看系统资源。危险命令被拒绝清单拦截。',
  tools: [
    {
      name: 'run',
      description: '执行一条 shell 命令（Windows 走 cmd /d /s /c，macOS/Linux 走 /bin/sh -c），返回退出码、stdout、stderr、耗时。默认 30 秒超时、256 KiB 输出上限。',
      inputSchema: {
        type: 'object',
        properties: {
          command: str('要执行的命令'),
          cwd: str('工作目录，默认当前目录或 MCP_EXEC_ROOT'),
          timeoutMs: num('超时毫秒数，默认 30000，上限 600000'),
          maxBytes: num('stdout/stderr 各自的最大采集字节数，默认 262144'),
          description: str('一句话说明这条命令在做什么（便于日志与审计）'),
        },
        required: ['command'],
      },
      async handler(args) {
        const command = String(args.command === undefined ? '' : args.command)
        if (command.trim() === '') throw new Error('command 不能为空')
        guard(command)
        const timeoutMs = Math.max(1000, Math.min(600000, Number(args.timeoutMs || 30000) || 30000))
        const result = await runCommand(command, {
          timeoutMs,
          maxBytes: Math.max(1024, Math.min(4 * 1024 * 1024, Number(args.maxBytes || 262144) || 262144)),
          cwd: typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : (process.env.MCP_EXEC_ROOT || process.cwd()),
        })
        return commandResult(result)
      },
    },
    {
      name: 'which',
      description: '检查一个或多个可执行程序是否存在，返回解析到的绝对路径（基于 PATH，Windows 会按 PATHEXT 解析 npx.cmd 这类 shim）。',
      inputSchema: {
        type: 'object',
        properties: { names: strArr('程序名列表，例如 ["node","npx","uvx","git"]') },
        required: ['names'],
      },
      async handler(args) {
        const names = Array.isArray(args.names) ? args.names : []
        if (names.length === 0) throw new Error('names 不能为空')
        const found = {}
        for (const name of names.slice(0, 100)) {
          found[String(name)] = resolveExecutable(name)
        }
        return { shell: commandShell().command, pathSeparator: process.platform === 'win32' ? ';' : ':', path: process.env.PATH || '', found }
      },
    },
    {
      name: 'env',
      description: '查看环境变量。不带 name 时只返回键名列表（避免默认泄露密钥）；带 name 时返回指定变量值。',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('变量名，可传逗号分隔的多个名字'),
          prefix: str('按前缀过滤键名，例如 DSH_'),
        },
      },
      async handler(args) {
        const entries = Object.entries(process.env).map(([key, value]) => [key, value === undefined ? '' : String(value)])
        if (typeof args.name === 'string' && args.name.trim() !== '') {
          const wanted = args.name.split(',').map((item) => item.trim()).filter((item) => item !== '')
          const values = {}
          for (const key of wanted) values[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? String(process.env[key]) : null
          return { requested: wanted, values }
        }
        const prefix = typeof args.prefix === 'string' && args.prefix !== '' ? args.prefix : ''
        const keys = entries.map(([key]) => key).filter((key) => key.startsWith(prefix)).sort()
        return { prefix, count: keys.length, keys: keys.slice(0, 500) }
      },
    },
    {
      name: 'sysinfo',
      description: '系统概览：平台、架构、内核、CPU、内存、运行时间、磁盘占用（df 优先，不可用则退化为 os 信息）。',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        const info = {
          platform: process.platform,
          osLabel: platformLabel(),
          shell: commandShell().command,
          arch: process.arch,
          node: process.version,
          release: os.release(),
          hostname: os.hostname(),
          uptimeSeconds: Math.floor(os.uptime()),
          loadAverage: os.loadavg(),
          cpu: { model: (os.cpus()[0] || {}).model || 'unknown', count: os.cpus().length },
          memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
          home: os.homedir(),
          tmpdir: os.tmpdir(),
          cwd: process.cwd(),
          pid: process.pid,
          user: safeUser(),
        }
        // 磁盘占用：Windows 与 POSIX 的命令不同，各自尽力而为。
        const diskCommand = process.platform === 'win32'
          ? 'wmic logicaldisk get DeviceID,Size,FreeSpace /format:csv'
          : 'df -k / 2>/dev/null | tail -n +2'
        const disk = await runCommand(diskCommand, { timeoutMs: 8000 })
        if (disk.code === 0 && disk.stdout.trim() !== '') {
          if (process.platform === 'win32') {
            info.disks = disk.stdout.split('\n').map((line) => line.trim()).filter((line) => /^[A-Za-z]:/.test(line)).map((line) => {
              const parts = line.split(',')
              return { drive: parts[1], sizeBytes: Number(parts[2]), freeBytes: Number(parts[3]) }
            }).filter((item) => Number.isFinite(item.sizeBytes))
          } else {
            const parts = disk.stdout.trim().split(/\s+/)
            info.rootDisk = { filesystem: parts[0], sizeKiB: Number(parts[1]), usedKiB: Number(parts[2]), availableKiB: Number(parts[3]), usePercent: parts[4] }
          }
        }
        return info
      },
    },
    {
      name: 'procs',
      description: '列出进程（Windows 用 tasklist，POSIX 用 ps），可按关键字过滤。',
      inputSchema: {
        type: 'object',
        properties: {
          filter: str('按命令行关键字过滤，不区分大小写'),
          limit: num('最多返回条数，默认 50'),
        },
      },
      async handler(args) {
        const listCommand = process.platform === 'win32'
          ? 'tasklist /fo csv /nh'
          : 'ps -eo pid,ppid,etime,rss,comm,args --no-headers 2>/dev/null || ps -ef'
        const result = await runCommand(listCommand, { timeoutMs: 8000, maxBytes: 1024 * 1024 })
        if (result.code !== 0 && result.stdout.trim() === '') throw new Error('ps 不可用：' + result.stderr.trim())
        const limit = Math.max(1, Math.min(500, Number(args.limit || 50) || 50))
        const needle = typeof args.filter === 'string' && args.filter !== '' ? args.filter.toLowerCase() : ''
        const lines = result.stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line !== '')
        const filtered = needle === '' ? lines : lines.filter((line) => line.toLowerCase().includes(needle))
        return { total: lines.length, matched: filtered.length, truncated: filtered.length > limit, lines: filtered.slice(0, limit) }
      },
    },
  ],
}

function safeUser() {
  try {
    return os.userInfo().username
  } catch {
    return null
  }
}

