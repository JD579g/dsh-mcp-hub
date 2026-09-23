/**
 * dsh-mcp-hub · 平台层单测
 *
 * Windows 分支在 Linux/macOS 上也能跑（platform / env / exists 都可注入），
 * 所以「Windows 优先」是有断言兜着的，不是靠嘴说。
 *
 * 书写约定：Windows 路径一律用正斜杠写（C:/Users/dev），比较时用 norm() 归一化，
 * 避免测试夹具自己的反斜杠转义把结论带偏。
 */
import path from 'node:path'
import { libUrl } from './helpers.mjs'

// 从仓库自身位置解析：clone 到任何目录、任何平台都能跑。
const {
  familyOf, isWindows, platformLabel, isDshaAndroid, pathApi,
  defaultFsRoots, pathPolicy, underPrefix,
  commandShell, interactiveShells, denyPatterns, matchDeny,
  resolveExecutable, runnerStatus, shellToolName, shellToolInfo,
  tempRoots, isTempPath,
} = await import(libUrl('platform.js'))

const results = []
function check(name, fn) {
  try {
    results.push({ name, ok: true, detail: fn() })
  } catch (error) {
    results.push({ name, ok: false, detail: String(error && error.message ? error.message : error) })
  }
}
function assert(condition, message) {
  if (condition !== true) throw new Error(message || 'assertion failed')
}
function equal(actual, expected, message) {
  if (actual !== expected) throw new Error((message || 'not equal') + '：expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual))
}
/** 路径归一化：统一分隔符与大小写，便于跨平台断言。 */
function norm(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
function existsIn(list) {
  const set = new Set(list.map((item) => norm(item)))
  return (target) => set.has(norm(target))
}

// ── 平台识别 ──────────────────────────────────────────────────────────────
check('平台识别与标签', () => {
  equal(familyOf('win32'), 'win32')
  equal(familyOf('linux'), 'posix')
  equal(familyOf('darwin'), 'posix')
  equal(isWindows('win32'), true)
  equal(isWindows('darwin'), false)
  equal(platformLabel('win32'), 'Windows')
  equal(platformLabel('darwin'), 'macOS')
  equal(pathApi('win32').sep, '\\')
  return 'win32/posix/darwin 判定正确'
})

check('isDshaAndroid 只在安卓 DSHA 上为真（手机那套不打扰桌面）', () => {
  equal(isDshaAndroid('win32', {}, () => true), false)
  equal(isDshaAndroid('darwin', {}, () => true), false)
  equal(isDshaAndroid('linux', { DSHA_BRIDGE_BASE: 'http://127.0.0.1:3090' }, () => false), true)
  equal(isDshaAndroid('linux', {}, (target) => target === '/root/.dsh/.bridge_token'), true)
  equal(isDshaAndroid('linux', {}, () => false), false)
  return 'win32/darwin 永远为 false'
})

// ── 文件根目录与路径策略 ──────────────────────────────────────────────────
check('默认根目录：Windows 只给家目录与 %TEMP%，不放开盘根', () => {
  const win = defaultFsRoots('win32', 'C:/Users/dev', 'C:/Users/dev/AppData/Local/Temp')
  equal(win.length, 2, 'win 根目录数')
  equal(norm(win[0]), 'c:/users/dev')
  assert(!win.some((item) => /^[A-Za-z]:\/?$/.test(norm(item))), '不应包含盘根：' + win.join(' , '))
  const posix = defaultFsRoots('linux', '/home/dev', '/tmp')
  equal(posix.length, 2)
  equal(norm(posix[0]), '/home/dev')
  return JSON.stringify(win)
})

check('路径策略：Windows 按 %SystemRoot%/%ProgramFiles% 还原；POSIX 用固定表', () => {
  const win = pathPolicy('win32', { SystemRoot: 'D:/Win', ProgramFiles: 'D:/PF', ProgramData: 'D:/PD' })
  assert(win.hardBlocked.some((item) => item.includes('?')), 'Windows 硬禁 \\\\?\\ 设备命名空间')
  assert(win.writeBlocked.some((item) => norm(item).startsWith('d:/win')), '应含 SystemRoot：' + JSON.stringify(win.writeBlocked))
  assert(win.writeBlocked.some((item) => norm(item).startsWith('d:/pf')), '应含 ProgramFiles')
  const posix = pathPolicy('linux', {})
  assert(posix.hardBlocked.includes('/proc') && posix.hardBlocked.includes('/sys'), 'POSIX 硬禁 /proc /sys')
  assert(posix.writeBlocked.includes('/usr'), 'POSIX 禁写 /usr')
  return JSON.stringify(win.writeBlocked)
})

check('underPrefix：Windows 大小写不敏感、反斜杠与正斜杠都要认；前缀边界不能误判', () => {
  const BS = String.fromCharCode(92)
  equal(underPrefix('C:/Windows/System32', 'c:/windows', 'win32'), true)
  equal(underPrefix('C:' + BS + 'Windows' + BS + 'System32', 'C:/Windows', 'win32'), true, '反斜杠输入 + 正斜杠前缀')
  equal(underPrefix('C:/Windows/System32', 'C:' + BS + 'Windows', 'win32'), true, '正斜杠输入 + 反斜杠前缀')
  equal(underPrefix('C:/WindowsApps', 'C:/Windows', 'win32'), false, '同前缀不同目录不应误判')
  equal(underPrefix('/usr/local', '/usr', 'linux'), true)
  equal(underPrefix('/usrlocal', '/usr', 'linux'), false)
  return '前缀边界与大小写都正确'
})

// ── shell 与终端 ──────────────────────────────────────────────────────────
check('一次性命令：Windows 走 cmd /d /s /c，POSIX 走 /bin/sh -c', () => {
  const win = commandShell('win32', {})
  equal(win.command, 'cmd.exe')
  equal(win.args.join(' '), '/d /s /c')
  const posix = commandShell('linux', {})
  equal(posix.command, '/bin/sh')
  equal(posix.args.join(' '), '-c')
  return 'cmd.exe /d /s /c'
})

check('交互终端候选：pwsh → Windows PowerShell → cmd.exe；POSIX 用 $SHELL 优先', () => {
  const win = interactiveShells('win32', {})
  equal(win[0].command, 'pwsh.exe')
  equal(win[1].command, 'powershell.exe')
  equal(win[2].command, 'cmd.exe')
  equal(win[2].args.join(' '), '/Q /K', 'cmd 需要 /Q /K 保持会话')
  const posix = interactiveShells('linux', { SHELL: '/bin/zsh' })
  equal(posix[0].command, '/bin/zsh')
  assert(posix.every((item) => item.args.join(' ') === '-i'), 'POSIX 交互 shell 用 -i')
  return win.map((item) => item.label).join(' → ')
})

check('临时目录识别：macOS 的 /var/folders 与 POSIX 的 /tmp 都算临时（写策略要给它们开口子）', () => {
  const darwinEnv = { TMPDIR: '/var/folders/36/xxxx/T' }
  equal(isTempPath('/var/folders/36/xxxx/T/a.txt', 'darwin', darwinEnv), true, 'macOS 用户临时目录')
  equal(isTempPath('/tmp/a.txt', 'darwin', darwinEnv), true, 'POSIX 惯例 /tmp')
  equal(isTempPath('/etc/passwd', 'darwin', darwinEnv), false, '系统目录不算临时')
  equal(isTempPath('C:/Users/dev/AppData/Local/Temp/a.txt', 'win32', { TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp' }), true, 'Windows %TEMP%')
  equal(isTempPath('C:/Windows/system32/a.dll', 'win32', { TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp' }), false, 'Windows 系统目录不算临时')
  const roots = defaultFsRoots('darwin', '/Users/dev', '/var/folders/36/xxxx/T')
  assert(roots.some((item) => norm(item) === '/tmp'), '默认根目录要含 /tmp：' + roots.join(' , '))
  assert(tempRoots('darwin', darwinEnv).includes('/var/folders/36/xxxx/T'), 'tempRoots 要含注入的 TMPDIR')
  return roots.join(' , ')
})

check('DSH 命令执行工具名按平台：Windows 是 pwsh，其余是 bash', () => {
  equal(shellToolName('win32'), 'pwsh')
  equal(shellToolName('linux'), 'bash')
  equal(shellToolName('darwin'), 'bash')
  const win = shellToolInfo('win32')
  equal(win.tool, 'pwsh')
  assert(win.label.includes('PowerShell'), 'Windows 文案要点名 PowerShell：' + win.label)
  assert(win.tags.includes('powershell'), 'Windows 标签要含 powershell')
  equal(shellToolInfo('linux').tool, 'bash')
  return 'pwsh / bash'
})

// ── 危险命令 ──────────────────────────────────────────────────────────────
const BS = String.fromCharCode(92)
check('拒绝清单：Windows 拦格式化/分区/注册表/递归删盘，放行日常开发命令', () => {
  assert(matchDeny('format C: /q', 'win32') !== null, '应拦 format')
  assert(matchDeny('diskpart', 'win32') !== null, '应拦 diskpart')
  assert(matchDeny('bcdedit /set testsigning on', 'win32') !== null, '应拦 bcdedit')
  assert(matchDeny('reg delete HKLM' + BS + 'Software' + BS + 'Foo /f', 'win32') !== null, '应拦 reg delete HKLM')
  assert(matchDeny('Remove-Item -Recurse -Force C:' + BS, 'win32') !== null, '应拦 PowerShell 递归删盘')
  assert(matchDeny('rd /s /q C:' + BS, 'win32') !== null, '应拦 rd /s /q')
  assert(matchDeny('cipher /w:C:' + BS, 'win32') !== null, '应拦 cipher /w')
  equal(matchDeny('dir C:' + BS + 'Users', 'win32'), null, 'dir 必须放行')
  equal(matchDeny('git status', 'win32'), null, 'git 必须放行')
  equal(matchDeny('npm run build', 'win32'), null, 'npm 必须放行')
  equal(matchDeny('node -v', 'win32'), null, 'node 必须放行')
  return '18 条 Windows 规则 + 放行断言'
})

check('拒绝清单：POSIX 仍拦 mkfs / dd / rm -rf /（手机与服务器那套不变）', () => {
  assert(matchDeny('mkfs.ext4 /dev/sda1', 'linux') !== null)
  assert(matchDeny('dd if=/dev/zero of=/dev/sda', 'linux') !== null)
  assert(matchDeny('rm -rf /', 'linux') !== null)
  equal(matchDeny('ls -la /root', 'linux'), null)
  return 'POSIX 规则保持原样'
})

check('MCP_EXEC_DENY 可追加自定义规则', () => {
  assert(matchDeny('my-dangerous-tool', 'linux', { MCP_EXEC_DENY: 'my-dangerous-tool' }) !== null)
  equal(matchDeny('my-dangerous-tool', 'linux', {}), null)
  return '追加生效'
})

// ── 可执行文件解析（Windows 的 npx.cmd 问题） ─────────────────────────────
check('resolveExecutable：Windows 按 PATHEXT 找到 npx.cmd / node.exe', () => {
  const exists = existsIn(['C:/Program Files/nodejs/npx.cmd', 'C:/Program Files/nodejs/node.exe'])
  const env = { PATH: 'C:/Windows;C:/Program Files/nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  equal(norm(resolveExecutable('npx', { platform: 'win32', env, exists })), 'c:/program files/nodejs/npx.cmd')
  equal(norm(resolveExecutable('node', { platform: 'win32', env, exists })), 'c:/program files/nodejs/node.exe')
  equal(resolveExecutable('uvx', { platform: 'win32', env, exists }), null, '没装就是没装，要给出安装提示')
  equal(norm(resolveExecutable('C:/Program Files/nodejs/node.exe', { platform: 'win32', env, exists })), 'c:/program files/nodejs/node.exe')
  return 'npx → npx.cmd'
})

check('resolveExecutable：POSIX 用冒号分隔 PATH', () => {
  const exists = existsIn(['/usr/local/bin/node', '/usr/bin/git'])
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin' }
  equal(resolveExecutable('node', { platform: 'linux', env, exists }), '/usr/local/bin/node')
  equal(resolveExecutable('git', { platform: 'linux', env, exists }), '/usr/bin/git')
  equal(resolveExecutable('missing', { platform: 'linux', env, exists }), null)
  return 'POSIX 解析正常'
})

check('runnerStatus：缺 uvx 时给出 winget 安装命令（Windows 开发者最需要的一句）', () => {
  const exists = existsIn(['C:/Program Files/nodejs/node.exe', 'C:/Program Files/nodejs/npx.cmd'])
  const env = { PATH: 'C:/Program Files/nodejs', PATHEXT: '.EXE;.CMD' }
  const rows = runnerStatus({ platform: 'win32', env, exists })
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]))
  equal(byId.node.available, true)
  equal(byId.npx.available, true)
  equal(byId.uvx.available, false)
  assert(byId.uvx.installHint.includes('winget'), 'uvx 缺失时应给 winget 提示：' + byId.uvx.installHint)
  assert(norm(byId.npx.path).endsWith('npx.cmd'), 'npx 应解析到 .cmd')
  assert(byId.git.available === false && byId.git.installHint.includes('winget'), 'git 缺失也要给提示')
  return byId.uvx.installHint
})

// ── 汇总 ──────────────────────────────────────────────────────────────────
const failures = results.filter((row) => row.ok !== true)
console.log(JSON.stringify({ total: results.length, failed: failures.length, failures }, null, 1))
if (failures.length === 0) {
  console.log('平台层单测全部通过 ✅  ' + results.map((row) => row.name).join(' | '))
}
process.exitCode = failures.length === 0 ? 0 : 1

