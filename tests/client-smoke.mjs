/**
 * dsh-mcp-hub · 浏览器半冒烟测试（极简 React 垫片，不需要真实 React）
 *
 * 验证：模块工厂可执行并导出 apply/inject → apply 向 settings.section 注册 →
 * 组件在「初始态 / 有数据态 / 搜索态」都能完整执行 → 一键安装会发出 POST。
 */
import { readFileSync } from 'node:fs'

let lastFetch = null

function createShim() {
  let cursor = 0
  let states = []
  let effects = []
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) {
      const index = cursor++
      if (states.length <= index) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
    },
    useCallback(fn) { cursor++; return fn },
    useEffect(fn) { effects.push(fn) },
    useRef(initial) { cursor++; return { current: initial } },
    __reset() { cursor = 0; states = []; effects = [] },
    __seed(values) { states = values.slice(); while (states.length < 32) states.push(undefined) },
    __effects() { return effects },
  }
  return react
}

const react = createShim()
let moduleExports = null
let loaderId = null
const loader = {
  load(entry) {
    loaderId = entry.id
    const exportsObject = entry.factory((name) => {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
      throw new Error('unexpected require: ' + name)
    })
    moduleExports = exportsObject
    return exportsObject
  },
}
const fakeWindow = { __ModuleLoader__: loader }
const fakeDocument = {
  head: { appendChild() {} },
  createElement() { return { setAttribute() {}, textContent: '', remove() {} } },
}

const overview = {
  ok: true,
  plugin: { registryFile: '/root/.dsh/mcp-hub/servers.json' },
  installed: [
    { name: 'kb', label: '长期知识库', description: '记忆', enabled: true, state: 'running', toolCount: 9, tools: ['mcp__kb__remember', 'mcp__kb__recall'], command: 'node main.js kb', builtin: true, overlap: { level: 'none', hits: [], summary: '' } },
    { name: 'broken', label: '坏服务', enabled: true, state: 'failed', toolCount: 0, tools: [], command: 'npx nope', result: 'failed', overlap: { level: 'high', hits: [{ capability: 'bash', risk: 'high', advice: '重复' }], summary: '与 DSH 内置能力高度重叠：bash' } },
  ],
  catalog: [
    { name: 'files', label: '文件系统', description: '读文件', builtin: true, installed: true, command: 'node main.js files', requires: [] },
    { name: 'mcp-memory', label: 'Memory', description: '记忆', builtin: false, installed: false, command: 'npx -y @modelcontextprotocol/server-memory', requires: [] },
  ],
  counts: { installed: 2, running: 1, tools: 9, catalog: 2 },
  log: ['[dsh-mcp-hub] 已加载'],
}
/** 带平台与运行器信息的 overview：模拟 Windows 桌面。 */
const overviewWithPlatform = {
  ...overview,
  platform: { id: 'win32', label: 'Windows', mobileDsha: false, home: 'C:/Users/dev', fsRoots: ['C:/Users/dev', 'C:/Users/dev/AppData/Local/Temp'], dataDir: 'C:/Users/dev/.dsh/mcp-hub', pathSeparator: ';', shells: [{ command: 'pwsh.exe', label: 'PowerShell 7' }] },
  runners: [
    { id: 'node', label: 'Node.js', why: '内置工具包与 npm 版 MCP 服务都靠它', available: true, command: 'node', path: 'C:/Program Files/nodejs/node.exe', installHint: 'winget install OpenJS.NodeJS.LTS' },
    { id: 'npx', label: 'npx', why: '官方 npm 版 MCP 服务靠它拉起', available: false, command: 'npx', path: null, installHint: '随 Node.js 一起安装（winget install OpenJS.NodeJS.LTS）' },
    { id: 'uvx', label: 'uv / uvx', why: '官方 Python 版 MCP 服务靠它拉起', available: false, command: 'uvx', path: null, installHint: 'winget install astral-sh.uv　或　scoop install uv' },
    { id: 'git', label: 'Git', why: 'git 版 MCP 服务需要', available: true, command: 'git', path: 'C:/Program Files/Git/cmd/git.exe', installHint: 'winget install Git.Git' },
  ],
  nativeTools: overview.nativeTools,
  catalog: [
    { name: 'files', label: '文件系统', description: '读文件', builtin: true, installed: true, command: 'node main.js files', requires: [], runners: [], runnerMissing: [], mobileOnly: false, supported: true },
    { name: 'mcp-memory', label: 'Memory', description: '记忆', builtin: false, installed: false, command: 'npx -y @modelcontextprotocol/server-memory', requires: [], runners: ['npx'], runnerMissing: [{ id: 'npx', label: 'npx', installHint: '随 Node.js 一起安装' }], mobileOnly: false, supported: true },
    { name: 'device', label: 'Android 设备', description: '手机专属', builtin: true, installed: false, command: 'node main.js device', requires: [], runners: [], runnerMissing: [], mobileOnly: true, supported: false },
  ],
  counts: { installed: 2, running: 1, tools: 9, catalog: 3, native: 16 },
}
const doctorPayload = {
  ok: false,
  platform: { id: 'win32', label: 'Windows', mobileDsha: false, home: 'C:/Users/dev', temp: 'C:/Users/dev/AppData/Local/Temp' },
  summary: '有 2 个问题需要先解决',
  counts: { errors: 2, warns: 1, ok: 8 },
  items: [
    { level: 'ok', id: 'platform', title: '运行平台', detail: 'Windows · Node v24', fix: null },
    { level: 'error', id: 'runner-npx', title: 'npx 没找到', detail: '官方 npm 版 MCP 服务靠它拉起', fix: 'winget install OpenJS.NodeJS.LTS' },
    { level: 'error', id: 'runner-uvx', title: 'uv / uvx 没找到', detail: '官方 Python 版 MCP 服务靠它拉起', fix: 'winget install astral-sh.uv' },
    { level: 'warn', id: 'failed-servers', title: '1 个服务启动失败', detail: 'mcp-memory', fix: '点对应服务的「测试」看具体报错' },
  ],
  runners: [],
}
const searchPayload = {
  ok: true, query: 'sqlite', count: 1, notes: ['npm 检索成功'],
  results: [{
    id: 'io.github.x/sqlite', name: 'io.github.x/sqlite', title: 'SQLite', description: '查询 sqlite', source: 'registry', installable: true, installed: false,
    packages: [{ registryType: 'npm', identifier: '@database-mcp/sqlite', version: '1.0.0', runtimeHint: 'npx' }], remotes: [],
    overlap: { level: 'none', hits: [], summary: '与 DSH 内置能力不重叠' },
    verification: { exists: true, identifier: '@database-mcp/sqlite', latest: '1.0.0', downloadsLastMonth: 1234 },
  }],
}
const fakeFetch = async (url, options) => {
  lastFetch = { url: String(url), options }
  const body = String(url).includes('/overview') ? overview
    : (String(url).includes('/search') ? searchPayload
      : (String(url).includes('/install') ? { ok: true, target: 'files', installed: overview.installed, failed: [] }
        : { ok: true, name: 'kb', probe: { toolCount: 3, tools: [{ rawName: 'remember' }] }, installed: overview.installed }))
  return { status: 200, async text() { return JSON.stringify(body) } }
}

const runner = new Function('window', 'document', 'fetch', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
runner(fakeWindow, fakeDocument, fakeFetch)

const report = { loaderId, exports: moduleExports === null ? [] : Object.keys(moduleExports), inject: moduleExports === null ? null : moduleExports.inject, registered: [], error: null, renders: [] }
let registeredEntry = null
const fakeCtx = {
  slots: {
    inject(name, factory) { factory(); return () => {} },
    register(entry, component) { registeredEntry = { entry, component }; report.registered.push({ name: entry.name, id: entry.id, order: entry.order, label: entry.label() }); return () => {} },
  },
}
try {
  moduleExports.apply(fakeCtx)
} catch (error) {
  report.error = 'apply failed: ' + String(error && error.stack ? error.stack : error)
}
if (registeredEntry !== null) {
  const Section = registeredEntry.component
  for (const label of ['initial', 'with-overview']) {
    try {
      react.__reset()
      if (label === 'with-overview') {
        react.__seed([
          overviewWithPlatform, '', '', '', '', ['registry', 'npm'], searchPayload.results, true, true,
          { name: '', transport: 'stdio', command: 'npx', args: '', env: '', url: '' },
          searchPayload.results, doctorPayload, 't1', '$ echo hi\nhi\n', '',
        ])
      }
      const tree = Section({ close: () => {} })
      const json = JSON.stringify(tree)
      report.renders.push({
        label,
        ok: true,
        nodes: countNodes(tree),
        containsInstalled: json.includes('长期知识库'),
        containsSearch: json.includes('SQLite'),
        containsError: json.includes('高度重叠'),
        // 桌面（Windows）专属断言：平台标签、缺运行器的安装命令、体检报告、平台不支持提示
        showsPlatform: json.includes('Windows'),
        showsWingetHint: json.includes('winget'),
        showsDoctor: json.includes('体检报告'),
        showsUnsupported: json.includes('手机专属'),
        showsPowerShell: json.includes('PowerShell 7'),
      })
    } catch (error) {
      report.renders.push({ label, ok: false, error: String(error && error.stack ? error.stack : error).slice(0, 400) })
    }
  }
  // 一键安装路径：CatalogCard 与 CandidateCard 都点一次
  try {
    const CatalogCard = moduleExports.CatalogCard
    const CandidateCard = moduleExports.CandidateCard
    const installCalls = []
    const handler = async (body) => { installCalls.push(body) }
    for (const Card of [CatalogCard, CandidateCard]) {
      react.__reset()
      const item = Card === CatalogCard
        ? { name: 'mcp-memory', label: 'Memory', description: '记忆', builtin: false, installed: false, command: 'npx -y @modelcontextprotocol/server-memory', requires: [] }
        : searchPayload.results[0]
      react.__seed([false, null, false, 0])
      const node = Card({ item, busyName: '', onInstall: handler, onDescribe: async () => ({ ok: true }), onAction: () => {}, onPermission: () => {} })
      const buttons = []
      collect(node, buttons)
      const button = buttons.find((entry) => entry.type === 'button' && flatten(entry.children || []).filter((child) => typeof child === 'string').join('').includes('一键安装'))
      if (button !== undefined) await button.props.onClick()
      else installCalls.push({ error: 'no install button on ' + (Card === CatalogCard ? 'CatalogCard' : 'CandidateCard') })
    }
    report.installCalls = installCalls
    report.installCall = installCalls.length > 0 && installCalls[0].mode !== undefined ? { mode: installCalls[0].mode, name: installCalls[0].catalogName || installCalls[0].id } : installCalls
  } catch (error) {
    report.installCall = 'failed: ' + String(error && error.stack ? error.stack : error).slice(0, 300)
  }
}

function flatten(children) {
  const out = []
  const walk = (item) => {
    if (Array.isArray(item)) { for (const child of item) walk(child); return }
    if (item === null || item === undefined) return
    out.push(item)
  }
  walk(children)
  return out
}
function countNodes(node) {
  if (node === null || node === undefined || typeof node !== 'object') return 0
  let total = 1
  for (const child of flatten(node.children || [])) total += countNodes(child)
  return total
}
function collect(node, out) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const child of node) collect(child, out); return }
  out.push(node)
  for (const child of flatten(node.children || [])) collect(child, out)
}

console.log(JSON.stringify(report, null, 2))
// 目录卡片单独渲染：平台不支持 / 缺运行器时按钮必须禁用，并给出安装命令
try {
  const CatalogCard = moduleExports.CatalogCard
  const textOf = (node) => flatten(node.children || []).filter((child) => typeof child === 'string').join('')
  react.__reset()
  react.__seed([false])
  const blockedCard = CatalogCard({
    item: { name: 'device', label: 'Android 设备', description: '手机专属能力', builtin: true, installed: false, supported: false, mobileOnly: true, command: 'node main.js device', requires: [], runnerMissing: [] },
    busyName: '',
    onInstall: () => {},
  })
  const missingCard = CatalogCard({
    item: { name: 'mcp-memory', label: 'Memory', description: '记忆', builtin: false, installed: false, supported: true, command: 'npx -y @modelcontextprotocol/server-memory', requires: [], runnerMissing: [{ id: 'npx', label: 'npx', installHint: 'winget install OpenJS.NodeJS.LTS' }] },
    busyName: '',
    onInstall: () => {},
  })
  const buttons = []
  collect(blockedCard, buttons)
  const blockedButton = buttons.find((node) => node.type === 'button')
  const missingButtons = []
  collect(missingCard, buttons)
  collect(missingCard, missingButtons)
  report.catalogGating = {
    blockedLabel: textOf(blockedButton),
    blockedDisabled: blockedButton.props.disabled === true,
    missingLabel: textOf(missingButtons.find((node) => node.type === 'button')),
    missingDisabled: missingButtons.find((node) => node.type === 'button').props.disabled === true,
    missingHint: JSON.stringify(missingCard).includes('winget install OpenJS.NodeJS.LTS'),
  }
} catch (error) {
  report.catalogGating = { error: String(error && error.stack ? error.stack : error).slice(0, 300) }
}

// Windows 桌面场景必须真的渲染出平台信息、安装命令、体检与手机专属提示
const windows = report.renders.find((item) => item.label === 'with-overview')
const gating = report.catalogGating || {}
const desktopOk = windows !== undefined && windows.showsPlatform === true && windows.showsWingetHint === true &&
  windows.showsDoctor === true && windows.showsUnsupported === true && windows.showsPowerShell === true &&
  gating.blockedDisabled === true && gating.missingDisabled === true && gating.missingHint === true
report.desktopAssertions = { ok: desktopOk, windows, gating }
const ok = report.error === null && report.registered.length === 1 &&
  report.renders.every((item) => item.ok === true) &&
  typeof report.installCall === 'object' && report.installCall !== null && desktopOk
console.log('桌面（Windows）界面断言：' + (desktopOk ? '通过 ✅（平台标签 / winget 安装命令 / 体检报告 / 平台不支持 / PowerShell 终端）' : '失败 ❌'))
process.exitCode = ok ? 0 : 1

