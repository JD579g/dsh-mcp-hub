/**
 * dsh-mcp-hub · 平台适配层
 *
 * 这个插件面向**桌面开发者（Windows 优先）**，所以所有平台相关的东西都集中在这里，
 * 而且都是**纯函数**：第一个参数是 platform 字符串（默认 process.platform）。
 * 好处是「Windows 分支」可以在 Linux/macOS 上被单测覆盖，而不是靠猜测。
 *
 * 覆盖的内容：
 *   - 默认允许访问的文件根目录（家目录 + 临时目录，不默认放开整个盘）；
 *   - 硬禁止 / 仅禁止写入 的路径前缀；
 *   - 一次性命令如何交给 shell 执行；
 *   - 交互式终端用哪个 shell、怎么让它从 stdin 读命令；
 *   - 危险命令拒绝清单（POSIX 与 Windows 两套）；
 *   - PATH/PATHEXT 下的可执行文件解析（用来判断 npx / uvx 在不在）。
 */

import path from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'

const WINDOWS = 'win32'
const POSIX = 'posix'

/**
 * 平台对应的 path 实现。
 * 关键：不要用当前进程的 path 去推理别的平台 —— 在 Linux 上 path.resolve("D:\x")
 * 会得到一个 POSIX 形式的假路径，Windows 分支的判定就全错了。
 */
export function pathApi(platform = process.platform) {
  return familyOf(platform) === WINDOWS ? path.win32 : path.posix
}

/** 平台族群：除 win32 之外都按 POSIX 处理（macOS / Linux / BSD）。 */
export function familyOf(platform = process.platform) {
  return platform === WINDOWS ? WINDOWS : POSIX
}

export function isWindows(platform = process.platform) {
  return familyOf(platform) === WINDOWS
}

/** 人读的平台标签，用于界面与状态输出。 */
export function platformLabel(platform = process.platform, release = os.release()) {
  if (platform === WINDOWS) return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return platform
}

/**
 * DSH 的「命令执行」原生工具叫什么。
 * 这是平台事实：Windows 上的 DSH 注册的是 pwsh（PowerShell），
 * 其余平台注册的是 bash。能力去重与界面文案都必须按它来说话，
 * 否则 Windows 开发者会看到一句「你已经有了 bash」而完全不成立。
 */
export function shellToolName(platform = process.platform) {
  return platform === WINDOWS ? 'pwsh' : 'bash'
}

/** 命令执行工具在界面上的完整文案（按平台）。 */
export function shellToolInfo(platform = process.platform) {
  if (platform === WINDOWS) {
    return {
      tool: 'pwsh',
      label: '命令执行（PowerShell）',
      description: '在宿主里跑 PowerShell 命令，支持后台任务与沙箱升级审批。',
      tags: ['pwsh', 'powershell', 'shell', 'command', 'terminal', '执行'],
      permissionable: true,
    }
  }
  return {
    tool: 'bash',
    label: '命令执行',
    description: '在宿主里跑 shell 命令，支持后台任务与沙箱升级审批。',
    tags: ['bash', 'shell', 'command', 'terminal', '执行'],
    permissionable: true,
  }
}

/** 是不是 DSHA（Android 上的 DSH App）。手机侧的 device 服务只在这上面有意义。 */
export function isDshaAndroid(platform = process.platform, env = process.env, exists = existsSync) {
  if (platform !== 'linux') return false
  if (env.DSHA_BRIDGE_BASE !== undefined || env.DSHA_STARTUP_PROFILE !== undefined || env.DSHA_WEB_GENERATION !== undefined) return true
  try {
    return exists('/root/.dsh/.bridge_token') || exists('/sdcard')
  } catch {
    return false
  }
}

function dedupe(list, platform) {
  const api = pathApi(platform)
  const out = []
  for (const item of list) {
    if (typeof item !== 'string' || item === '') continue
    let normalised = item
    try {
      normalised = api.resolve(item)
    } catch {
      normalised = item
    }
    const key = familyOf(platform) === WINDOWS ? normalised.toLowerCase() : normalised
    if (!out.some((existing) => (familyOf(platform) === WINDOWS ? existing.toLowerCase() : existing) === key)) out.push(normalised)
  }
  return out
}

/**
 * 默认允许读写的根目录。
 * Windows：家目录 + %TEMP%（**不**默认放开 C:\，免得一个工具就有整盘权限）。
 * POSIX：家目录 + 临时目录。
 */
export function defaultFsRoots(platform = process.platform, home = os.homedir(), tmp = os.tmpdir()) {
  return dedupe([home, tmp], platform)
}

export const POSIX_BLOCKED = ['/dev', '/proc', '/sys']
export const POSIX_WRITE_BLOCKED = ['/boot', '/run', '/etc', '/usr', '/var']
export const WINDOWS_BLOCKED = ['\\\\?\\', '\\\\.\\']
export const WINDOWS_WRITE_BLOCKED = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\$Recycle.Bin']

/**
 * 路径策略：hardBlocked 读写都拒；writeBlocked 允许读、禁止改/删。
 * Windows 的 writeBlocked 会按 %SystemRoot% / %ProgramFiles% 等环境变量还原真实盘符与目录。
 */
export function pathPolicy(platform = process.platform, env = process.env) {
  if (familyOf(platform) === WINDOWS) {
    const windir = env.SystemRoot || env.windir || 'C:\\Windows'
    const programFiles = env.ProgramFiles || 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const programData = env.ProgramData || 'C:\\ProgramData'
    return {
      hardBlocked: [...WINDOWS_BLOCKED],
      writeBlocked: dedupe([windir, programFiles, programFilesX86, programData], 'win32').concat(['C:\\$Recycle.Bin']),
    }
  }
  const extra = typeof env.MCP_FS_WRITE_BLOCKED === 'string' && env.MCP_FS_WRITE_BLOCKED !== '' ? env.MCP_FS_WRITE_BLOCKED.split(path.delimiter) : []
  return {
    hardBlocked: [...POSIX_BLOCKED],
    writeBlocked: dedupe([...POSIX_WRITE_BLOCKED, ...extra], 'linux'),
  }
}

/** 判断绝对路径是否落在某个前缀里（Windows 下大小写不敏感）。 */
export function underPrefix(absolute, prefix, platform = process.platform) {
  if (typeof absolute !== 'string' || typeof prefix !== 'string') return false
  const win = familyOf(platform) === WINDOWS
  const separator = win ? '\\' : '/'
  // Windows 上把正斜杠统一成反斜杠再比，避免 C:/Windows 与 C:\Windows 互不认账。
  let target = win ? absolute.replace(/\//g, '\\') : absolute
  let base = win ? prefix.replace(/\//g, '\\') : prefix
  if (win) {
    target = target.toLowerCase()
    base = base.toLowerCase()
  }
  const floor = win ? 3 : 1
  while (base.length > floor && base.endsWith(separator)) base = base.slice(0, -1)
  return target === base || target.startsWith(base.endsWith(separator) ? base : base + separator)
}

/** 把拒绝清单拼成正则（供 fs / exec / 终端共用）。 */
export function pathDenyList(platform = process.platform, env = process.env) {
  const policy = pathPolicy(platform, env)
  const extra = typeof env.MCP_FS_DENY === 'string' && env.MCP_FS_DENY !== '' ? env.MCP_FS_DENY.split(';') : []
  return { hardBlocked: [...policy.hardBlocked, ...extra], writeBlocked: policy.writeBlocked }
}


/**
 * 一次性命令怎么交给 shell。
 * Windows 用 cmd.exe /d /s /c（对 dir、&&、%VAR% 这些最稳）；
 * POSIX 用 /bin/sh -c。
 */
export function commandShell(platform = process.platform, env = process.env) {
  if (familyOf(platform) === WINDOWS) {
    return { command: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], join: true }
  }
  return { command: '/bin/sh', args: ['-c'], join: true }
}

/**
 * 交互式终端的候选 shell（按优先级）。
 * Windows：pwsh（PowerShell 7）→ Windows PowerShell → cmd.exe；
 * POSIX：$SHELL → /bin/bash → /bin/zsh → /bin/sh。
 * interactiveArgs 让 shell 从 stdin 读命令并保持会话。
 */
export function interactiveShells(platform = process.platform, env = process.env) {
  if (familyOf(platform) === WINDOWS) {
    return [
      { command: 'pwsh.exe', label: 'PowerShell 7', args: ['-NoLogo', '-NoProfile', '-Command', '-'] },
      { command: 'powershell.exe', label: 'Windows PowerShell', args: ['-NoLogo', '-NoProfile', '-Command', '-'] },
      { command: env.ComSpec || 'cmd.exe', label: 'cmd.exe', args: ['/Q', '/K'] },
    ]
  }
  const candidates = []
  if (typeof env.SHELL === 'string' && env.SHELL !== '') candidates.push(env.SHELL)
  candidates.push('/bin/bash', '/bin/zsh', '/bin/sh')
  const seen = new Set()
  const out = []
  for (const command of candidates) {
    if (seen.has(command)) continue
    seen.add(command)
    out.push({ command, label: path.basename(command), args: ['-i'] })
  }
  return out
}

const POSIX_DENY = [
  'mkfs',
  '\\bmkswap\\b',
  '\\bdd\\b.*of=/dev/',
  '\\bfdisk\\b',
  '\\bparted\\b',
  '\\bmount\\b',
  '\\bumount\\b',
  '\\breboot\\b',
  '\\bshutdown\\b',
  '\\bpoweroff\\b',
  '\\bhalt\\b',
  '\\brm\\s+-rf\\s+/(\\s|$)',
  '\\bchmod\\s+-R\\s+777\\s+/',
  '\\bsetenforce\\b',
  '>\\s*/dev/(sd|mmcblk|nvme)',
]

const WINDOWS_DENY = [
  '\\bformat\\b',
  '\\bdiskpart\\b',
  '\\bbcdedit\\b',
  '\\bcipher\\s+/w',
  '\\bvssadmin\\b',
  '\\bwbadmin\\b',
  '\\bRemove-Item\\b[^\\n]*-Recurse[^\\n]*\\s[A-Za-z]:\\\\(\\s|$)',
  '\\brd\\s+/s\\s+/q\\s+[A-Za-z]:\\\\?(\\s|$)',
  '\\bdel\\s+/f\\s+/s\\s+/q\\s+[A-Za-z]:\\\\?(\\s|$)',
  '\\breg\\s+delete\\s+HKLM',
  '\\breg\\s+delete\\s+HKCR',
  '\\bntdsutil\\b',
  '\\bsc\\s+delete\\b',
  '\\btakeown\\b',
  '\\bicacls\\b[^\\n]*/reset',
  '\\bshutdown\\b',
  '\\bfsutil\\b',
  '\\bsfc\\b',
  '\\bwbadmin\\b',
]

/** 危险命令拒绝清单：POSIX 一套、Windows 一套，另外可用 MCP_EXEC_DENY 追加（分号分隔）。 */
export function denyPatterns(platform = process.platform, env = process.env) {
  const base = familyOf(platform) === WINDOWS ? [...WINDOWS_DENY, ...POSIX_DENY.slice(0, 3)] : POSIX_DENY
  const extra = typeof env.MCP_EXEC_DENY === 'string' && env.MCP_EXEC_DENY !== '' ? env.MCP_EXEC_DENY.split(';').map((item) => item.trim()).filter((item) => item !== '') : []
  return [...base, ...extra]
}

/** 命中拒绝清单则返回该正则，否则 null。 */
export function matchDeny(command, platform = process.platform, env = process.env) {
  const text = String(command === undefined || command === null ? '' : command)
  for (const pattern of denyPatterns(platform, env)) {
    let regex
    try {
      regex = new RegExp(pattern, 'i')
    } catch {
      continue
    }
    if (regex.test(text)) return pattern
  }
  return null
}


/**
 * Windows 下的可执行文件解析：命令没写扩展名时按 PATHEXT 逐个尝试。
 * MCP 预设大量使用 npx / uvx，这类 shim 在 Windows 上是 npx.cmd / uvx.exe，
 * 直接 spawn "npx" 会 ENOENT —— 这里负责把它解析成真实路径。
 *
 * @param {string} command 命令名（可带扩展名，也可是绝对路径）
 * @param {object} options platform / env / exists 注入，便于测试
 * @returns {string|null} 解析到的绝对路径，找不到返回 null
 */
export function resolveExecutable(command, options = {}) {
  const platform = options.platform || process.platform
  const env = options.env || process.env
  const exists = options.exists || existsSync
  const name = String(command === undefined || command === null ? '' : command).trim()
  if (name === '') return null

  const api = pathApi(platform)
  const pathLike = name.includes('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)
  if (pathLike) {
    for (const candidate of executableCandidates(name, platform, env)) {
      if (safeExists(exists, candidate)) return candidate
    }
    return null
  }

  const delimiter = familyOf(platform) === WINDOWS ? ';' : ':'
  const dirs = String(env.PATH || '').split(delimiter).filter((item) => item !== '')
  for (const dir of dirs) {
    for (const candidate of executableCandidates(name, platform, env)) {
      const full = api.join(dir, candidate)
      if (safeExists(exists, full)) return full
    }
  }
  return null
}

function executableCandidates(name, platform, env) {
  if (familyOf(platform) !== WINDOWS) return [name]
  if (/\.[A-Za-z0-9]+$/.test(name)) return [name]
  const pathext = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter((item) => item !== '')
  return [name, ...pathext.map((ext) => name + ext.toLowerCase()), ...pathext.map((ext) => name + ext.toUpperCase())]
}

function safeExists(exists, target) {
  try {
    return exists(target) === true
  } catch {
    return false
  }
}

/** 桌面开发者常用的运行器：装了没有、装在哪、没装该怎么装。 */
export function runnerStatus(options = {}) {
  const platform = options.platform || process.platform
  const env = options.env || process.env
  const exists = options.exists || existsSync
  const runners = [
    {
      id: 'node',
      label: 'Node.js',
      commands: ['node'],
      why: '内置工具包与 npm 版 MCP 服务都靠它',
      install: {
        win32: 'winget install OpenJS.NodeJS.LTS',
        darwin: 'brew install node',
        linux: '用发行版包管理器或 https://nodejs.org 安装',
      },
    },
    {
      id: 'npx',
      label: 'npx',
      commands: ['npx'],
      why: '官方 npm 版 MCP 服务（@modelcontextprotocol/* 等）靠它拉起',
      install: {
        win32: '随 Node.js 一起安装（winget install OpenJS.NodeJS.LTS）',
        darwin: 'brew install node',
        linux: '随 Node.js 一起安装',
      },
    },
    {
      id: 'uvx',
      label: 'uv / uvx',
      commands: ['uvx', 'uv'],
      why: '官方 Python 版 MCP 服务（mcp-server-git / fetch / sqlite / time）靠它拉起',
      install: {
        win32: 'winget install astral-sh.uv　或　scoop install uv',
        darwin: 'brew install uv',
        linux: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
      },
    },
    {
      id: 'git',
      label: 'Git',
      commands: ['git'],
      why: 'git 版 MCP 服务与大多数开发流程需要',
      install: {
        win32: 'winget install Git.Git',
        darwin: 'brew install git',
        linux: 'apt install git / dnf install git',
      },
    },
  ]
  const target = platform === WINDOWS ? 'win32' : (platform === 'darwin' ? 'darwin' : 'linux')
  return runners.map((runner) => {
    let resolved = null
    let via = null
    for (const command of runner.commands) {
      const found = resolveExecutable(command, { platform, env, exists })
      if (found !== null) { resolved = found; via = command; break }
    }
    return {
      id: runner.id,
      label: runner.label,
      why: runner.why,
      available: resolved !== null,
      command: via,
      path: resolved,
      installHint: runner.install[target] || runner.install.linux,
    }
  })
}

