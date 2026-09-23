/**
 * dsh-mcp-hub · 能力去重（DSH 原生工具）单测
 *
 * 这一组断言回答的是「插件到底有没有真的适配 DSH」：
 *   - Windows 上 DSH 的原生命令执行工具叫 **pwsh**，不是 bash；
 *   - 「你已经有了」的重叠提示必须用同一个名字；
 *   - 手机专属能力（DSHA 设备 shell）只在安卓上出现；
 *   - 重叠排序规则真的会把重复能力往后压。
 */
import { libUrl } from './helpers.mjs'

const {
  nativeToolsFor, nativeToolsList, searchNativeTools, shellToolName,
  builtinCapabilitiesFor, overlapRules, overlapsFor, describeOverlap, rankCandidates,
} = await import(libUrl('host', 'capabilities.js'))

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

const win = nativeToolsFor({ platform: 'win32' })
const posix = nativeToolsFor({ platform: 'linux' })

check('Windows 的原生清单第一条是 pwsh，且不含 bash', () => {
  equal(win[0].tool, 'pwsh')
  equal(win[0].label.includes('PowerShell'), true, 'Windows 文案要点名 PowerShell')
  assert(!win.some((tool) => tool.tool === 'bash'), 'Windows 清单里不该出现 bash')
  return win.map((tool) => tool.tool).join(', ')
})

check('POSIX 的原生清单第一条是 bash，且不含 pwsh', () => {
  equal(posix[0].tool, 'bash')
  assert(!posix.some((tool) => tool.tool === 'pwsh'), 'POSIX 清单里不该出现 pwsh')
  return posix.map((tool) => tool.tool).join(', ')
})

check('DSH 自带能力清单也跟着平台改名', () => {
  const c = builtinCapabilitiesFor({ platform: 'win32' })
  equal(c[0].name, 'pwsh')
  assert(c[0].note.includes('PowerShell'), '说明要点名 PowerShell：' + c[0].note)
  equal(builtinCapabilitiesFor({ platform: 'linux' })[0].name, 'bash')
  return c[0].name + ' / ' + c[0].note
})

check('手机专属能力只在 DSHA 上出现，桌面不展示', () => {
  assert(!posix.some((tool) => tool.tool.includes('DSHA')), '桌面不该有 device shell')
  assert(!win.some((tool) => tool.tool.includes('DSHA')), 'Windows 不该有 device shell')
  const mobile = nativeToolsFor({ mobile: true, platform: 'linux' })
  assert(mobile.some((tool) => tool.tool.includes('DSHA')), '安卓上要有 device shell')
  const mobileCaps = builtinCapabilitiesFor({ mobile: true, platform: 'linux' }).map((item) => item.name)
  assert(mobileCaps.some((name) => name.includes('DSHA')), '安卓能力清单里要有 device shell')
  return 'device shell 只在 mobile:true'
})

check('重叠提示按平台说名字：Windows 说 pwsh，Linux 说 bash', () => {
  const candidate = { name: 'some-shell-server', description: 'run shell command in a terminal' }
  const winHits = overlapsFor(candidate, { platform: 'win32' })
  const posixHits = overlapsFor(candidate, { platform: 'linux' })
  equal(winHits[0].capability, 'pwsh')
  assert(winHits[0].advice.includes('pwsh'), 'Windows 提示要点名 pwsh：' + winHits[0].advice)
  assert(!winHits[0].advice.includes('bash'), 'Windows 提示不该提 bash：' + winHits[0].advice)
  equal(posixHits[0].capability, 'bash')
  return winHits[0].advice
})

check('内置 exec 服务的重叠面也按平台说名字', () => {
  const hits = overlapsFor({ name: 'exec' }, { platform: 'win32' })
  assert(hits.length > 0, 'exec 应该有重叠提示')
  equal(hits[0].capability, 'pwsh')
  assert(hits[0].advice.includes('pwsh'), '提示要点名 pwsh：' + hits[0].advice)
  return hits[0].advice
})

check('陌生能力不误报；文件系统类照样报高重叠', () => {
  equal(describeOverlap({ name: 'weather', description: 'weather forecast' }, { platform: 'win32' }).level, 'none')
  const fs = describeOverlap({ name: 'filesystem', description: 'read write local file' }, { platform: 'win32' })
  equal(fs.level, 'high')
  return fs.summary
})

check('排序：与会话内已有工具/shell 重复的候选被压到后面', () => {
  const duplicate = { name: 'shell-runner', description: 'shell command exec terminal', source: 'npm' }
  const fresh = { name: 'super-weather', description: 'weather forecast api', source: 'npm' }
  const ranked = rankCandidates('shell weather', [duplicate, fresh], new Set(), { platform: 'win32' })
  equal(ranked[0].name, 'super-weather', '不重复的应该排前面：' + ranked.map((row) => row.name).join(', '))
  return ranked.map((row) => row.name).join(' > ')
})

// ── 汇总 ──────────────────────────────────────────────────────────────────
const failures = results.filter((row) => row.ok !== true)
console.log(JSON.stringify({ total: results.length, failed: failures.length, failures }, null, 1))
if (failures.length === 0) {
  console.log('能力去重单测全部通过 ✅  ' + results.map((row) => row.name).join(' | '))
}
process.exitCode = failures.length === 0 ? 0 : 1
