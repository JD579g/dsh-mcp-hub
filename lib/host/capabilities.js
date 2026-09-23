/**
 * dsh-mcp-hub · 能力去重（DSH 原生工具视角）
 *
 * DSH 自己已经有一批内置工具（命令执行 / read / write / grep / glob / web_search / skill/…）。
 * 再挂一个功能重复的 MCP 只会让模型在同一件事上有两个入口、白白多吃一份 schema。
 * 这个模块负责：
 *   1) 声明 DSH 的内置能力清单（写进 overview，界面直接展示）；
 *   2) 按「工具名/描述关键词」给任意 MCP 候选打重叠标记；
 *   3) 给内置服务也标注它们与 DSH 内置工具的重叠面。
 *
 * 平台差异（面向桌面开发者，Windows 优先）：
 *   - DSH 的命令执行工具在 Windows 上是 **pwsh**（PowerShell），在 macOS/Linux 上是 bash。
 *     所以「你已经有一个 shell 了」这句话必须按平台说，否则 Windows 用户会以为
 *     自己装了 bash 而误判。
 *   - 手机专属能力（DSHA 设备 shell）只在安卓上展示。
 */

// 命令执行工具叫什么，是平台事实 —— 定义在平台层（lib/platform.js），
// 这里只做转发，保证「Windows 是 pwsh」只有一个出处。
import { shellToolName, shellToolInfo } from '../platform.js'

export { shellToolName, shellToolInfo }

/** DSH 自带能力（名称 → 说明）。用于界面上「别装重复的」提示。 */
function capabilitiesFor(platform = process.platform, mobile = false) {
  const shell = shellToolName(platform)
  const list = [
    { name: shell, covers: ['shell', '命令执行', 'command', 'terminal', 'powershell', 'pwsh'], note: platform === 'win32' ? 'PowerShell 命令执行' : '通用命令执行' },
    { name: 'read / write / edit', covers: ['file', '文件', 'filesystem', 'read', 'write', 'editor'], note: '工作区文件读写改' },
    { name: 'glob / grep', covers: ['search file', '文件搜索', 'find files', 'grep', 'glob'], note: '按路径/内容找文件' },
    { name: 'web_search / web_fetch', covers: ['web search', '搜索', 'fetch', 'crawl', 'http', 'browse'], note: '联网检索与抓取' },
    { name: 'skill', covers: ['skill', '技能'], note: '技能包加载' },
    { name: 'todo_write', covers: ['todo', 'task list', 'planning'], note: '任务清单' },
    { name: 'ask_user_question', covers: ['ask user', '提问', 'question'], note: '向用户提问' },
    { name: 'present', covers: ['deliverable', 'artifact', '交付物'], note: '交付物登记' },
    { name: 'subagent / ralph', covers: ['subagent', 'agent', 'worker'], note: '子代理与迭代' },
    { name: 'job / goal / schedule', covers: ['job', 'background', 'schedule', 'cron', 'timer'], note: '后台任务与定时' },
  ]
  if (mobile) {
    list.push({ name: 'device shell（DSHA）', covers: ['android', 'adb', 'device shell', '手机'], note: '设备侧命令（受策略保护）' })
  }
  return list
}

/** POSIX + 手机视角的完整能力清单（保持导出的常量向后兼容）。 */
export const BUILTIN_CAPABILITIES = capabilitiesFor('linux', true)

/** 按平台取 DSH 内置能力清单。 */
export function builtinCapabilitiesFor(options = {}) {
  return capabilitiesFor(options.platform || process.platform, options.mobile === true)
}

/** 与平台无关的原生工具（命令执行单独按平台拼）。 */
const COMMON_NATIVE_TOOLS = [
  { tool: 'read', label: '读文件', description: '按行读文本文件（带行号、分段读取）。', tags: ['file', 'filesystem', 'read'], permissionable: true },
  { tool: 'write', label: '写文件', description: '创建或整体替换文件（需先读过）。', tags: ['file', 'filesystem', 'write'], permissionable: true },
  { tool: 'edit', label: '改文件', description: '精确文本替换，要求唯一命中。', tags: ['file', 'edit', 'filesystem'], permissionable: true },
  { tool: 'glob', label: '找文件', description: '按路径模式匹配文件。', tags: ['file', 'search', 'glob'], permissionable: true },
  { tool: 'grep', label: '搜内容', description: '按正则搜索文件内容。', tags: ['grep', 'search'], permissionable: true },
  { tool: 'web_search', label: '联网搜索', description: '检索网页并返回来源链接。', tags: ['web', 'search'], permissionable: true },
  { tool: 'web_fetch', label: '抓网页', description: '抓取指定 URL 的正文。', tags: ['web', 'fetch', 'http'], permissionable: true },
  { tool: 'skill', label: '加载技能', description: '按名字加载会话技能包。', tags: ['skill'], permissionable: true },
  { tool: 'todo_write', label: '任务清单', description: '维护当前工作的待办列表。', tags: ['todo', 'plan'], permissionable: true },
  { tool: 'ask_user_question', label: '向用户提问', description: '需要用户拍板时抛出选择题。', tags: ['question', 'human', '提问'], permissionable: true },
  { tool: 'present', label: '交付物登记', description: '把产出登记为可下载的交付物。', tags: ['deliverable', 'artifact'], permissionable: true },
  { tool: 'subagent', label: '子代理', description: '把独立任务交给子代理执行。', tags: ['subagent', 'agent'], permissionable: true },
  { tool: 'ralph', label: 'Ralph 迭代', description: 'fresh-agent 迭代执行长任务。', tags: ['ralph', 'agent'], permissionable: true },
  { tool: 'jobs', label: '后台任务', description: '查看与管理后台作业。', tags: ['job', 'background'], permissionable: true },
  { tool: 'goal', label: '长期目标', description: '跨轮次持续推进同一目标。', tags: ['goal', 'plan'], permissionable: true },
]

/** 只在手机（DSHA 安卓）上有意义的原生能力。桌面上不展示，免得误导。 */
const DEVICE_SHELL_TOOL = { tool: 'device shell（DSHA）', label: '设备 shell', description: '受保护的 Android 设备命令通道（root/Shizuku/ADB）。', tags: ['android', 'device', 'adb'], permissionable: true }
const MOBILE_ONLY_TOOLS = new Set([DEVICE_SHELL_TOOL.tool])

/**
 * 某个平台上的 DSH 原生工具清单（命令执行排第一）。
 * @param {string} [platform]
 */
export function nativeToolsList(platform = process.platform) {
  return [shellToolInfo(platform), ...COMMON_NATIVE_TOOLS]
}

/** 向后兼容：默认按 POSIX 视角导出的原生工具清单。 */
export const NATIVE_TOOLS = nativeToolsList('linux')

/**
 * 当前平台该展示的原生工具清单。
 * @param {object} [options]
 * @param {boolean} [options.mobile] 是否安卓 DSHA
 * @param {string} [options.platform] process.platform 覆盖（测试用）
 */
export function nativeToolsFor(options = {}) {
  const mobile = options.mobile === true
  const list = nativeToolsList(options.platform || process.platform)
  if (mobile) list.push(DEVICE_SHELL_TOOL)
  return list.filter((tool) => (mobile ? true : !MOBILE_ONLY_TOOLS.has(tool.tool)))
}

/** 原生工具里与关键词匹配的那些（用于搜索结果的「原生」分组）。 */
export function searchNativeTools(query, options = {}) {
  const needle = String(query || '').toLowerCase().trim()
  const parts = needle.split(/\s+/).filter((item) => item !== '')
  return nativeToolsFor(options).filter((tool) => {
    if (parts.length === 0) return false
    const haystack = (tool.tool + ' ' + tool.label + ' ' + tool.description + ' ' + tool.tags.join(' ')).toLowerCase()
    return parts.every((part) => haystack.includes(part)) || haystack.includes(needle)
  })
}

/** 重叠规则（平台相关的那条在 overlapRules 里补齐）。 */
const BASE_OVERLAP_RULES = [
  {
    id: 'files',
    capability: 'read / write / edit',
    risk: 'high',
    match: /(?:\bfilesystem\b|file\s*system|file-|files-|read[_ -]?file|write[_ -]?file|file[_ -]?reader|editor?[_ -]?file|local[_ -]?file|directory|\bfs\b)/i,
    advice: 'DSH 已有 read/write/edit/glob/grep；只有在需要「沙箱外的其它根目录」或用别的宿主时才值得装',
  },
  {
    id: 'shell',
    capability: 'bash',
    risk: 'high',
    match: /(?:shell|command|terminal|exec(?:ute|utor)?\b|\bbash\b|\bpty\b|process[_ -]?run|run[_ -]?command)/i,
    advice: 'DSH 已有 bash；重复安装只会多一份工具 schema',
  },
  {
    id: 'web',
    capability: 'web_search / web_fetch',
    risk: 'medium',
    match: /(?:web[_ -]?(?:search|fetch|crawl)|fetch[_ -]?(?:url|page|web)|scrape|crawler|\bbrowse\b|search[_ -]?engine|tavily|brave[_ -]?search|exa\b|firecrawl|serp)/i,
    advice: 'DSH 已有 web_search/web_fetch；若只是想抓网页，先用内置的',
  },
  {
    id: 'search',
    capability: 'glob / grep',
    risk: 'high',
    match: /(?:grep|glob|ripgrep|code[_ -]?search|file[_ -]?search|find[_ -]?files)/i,
    advice: 'DSH 已有 grep/glob',
  },
  {
    id: 'todo',
    capability: 'todo_write',
    risk: 'medium',
    match: /(?:todo|task[_ -]?(?:list|manager)|checklist|kanban)/i,
    advice: 'DSH 已有 todo_write；除非你要跨会话的持久看板',
  },
  {
    id: 'agent',
    capability: 'subagent / ralph',
    risk: 'high',
    match: /(?:sub[_ -]?agent|agent[_ -]?(?:orchestrat|swarm)|multi[_ -]?agent|workflow)/i,
    advice: 'DSH 已有 subagent/ralph/workflow',
  },
  {
    id: 'schedule',
    capability: 'job / goal / schedule',
    risk: 'medium',
    match: /(?:scheduler?|cron|timer|reminder|background[_ -]?job)/i,
    advice: 'DSH 已有 schedule/jobs/goal',
  },
  {
    id: 'ask',
    capability: 'ask_user_question',
    risk: 'low',
    match: /(?:human[_ -]?in[_ -]?the[_ -]?loop|ask[_ -]?user|user[_ -]?(?:input|prompt))/i,
    advice: 'DSH 已有 ask_user_question',
  },
  {
    id: 'device',
    capability: 'device shell（DSHA）',
    risk: 'medium',
    match: /(?:android|\badb\b|device[_ -]?(?:shell|control)|termux|shizuku)/i,
    advice: 'DSHA 已有受保护的设备 shell 与 /app/* 桥；桌面上这一条不适用',
  },
]

/**
 * 按平台生成重叠规则：Windows 上「命令执行」叫 pwsh，
 * 文案里就不能再写 bash（否则 Windows 用户会把这条提示当噪音）。
 */
export function overlapRules(platform = process.platform) {
  const shell = shellToolName(platform)
  return BASE_OVERLAP_RULES.map((rule) => {
    if (rule.id !== 'shell') return rule
    return {
      ...rule,
      capability: shell,
      advice: platform === 'win32'
        ? 'DSH 已有 pwsh（PowerShell 命令执行）；重复安装只会多一份工具 schema'
        : 'DSH 已有 bash；重复安装只会多一份工具 schema',
    }
  })
}

/** 向后兼容的常量（POSIX 视角）。 */
export const TOOL_OVERLAP_RULES = overlapRules('linux')

/** 我们自己的内置服务与 DSH 内置能力的重叠面（用于界面提示）。 */
function builtinServerOverlap(platform = process.platform) {
  const shell = shellToolName(platform)
  return {
    files: [{ capability: 'read / write / edit', risk: 'high', advice: '与 DSH 内置文件工具重叠；价值在于「沙箱外指定根目录 + 独立给别的 MCP 宿主用」' }],
    exec: [{ capability: shell, risk: 'high', advice: '与 DSH 的 ' + shell + ' 重叠；价值在于可作为独立 MCP 服务给别的宿主用' }],
    net: [{ capability: 'web_search / web_fetch', risk: 'medium', advice: '与 DSH web 工具部分重叠；价值在于可编程的 http/download（含大文件流式落盘）' }],
    kb: [{ capability: 'todo_write', risk: 'low', advice: 'DSH 没有跨会话长期记忆，这一个不重复' }],
    util: [],
    hub: [],
    device: [],
  }
}

const BUILTIN_SERVER_OVERLAP = builtinServerOverlap('linux')

/** 按名字/描述/包名判断一个候选与 DSH 内置能力重叠多少。 */
export function overlapsFor(candidate, options = {}) {
  const server = candidate !== null && typeof candidate === 'object' ? candidate : {}
  const name = String(server.name || '')
  const haystack = [
    name,
    server.label,
    server.description,
    Array.isArray(server.args) ? server.args.join(' ') : '',
    Array.isArray(server.tags) ? server.tags.join(' ') : '',
    Array.isArray(server.packages) ? server.packages.map((pkg) => String(pkg.identifier || '')).join(' ') : '',
  ].filter((item) => item !== undefined && item !== null).join(' ')

  if (BUILTIN_SERVER_OVERLAP[name] !== undefined) {
    const custom = builtinServerOverlap(options.platform || process.platform)[name]
    if (custom !== undefined) return custom
  }

  const hits = []
  for (const rule of overlapRules(options.platform || process.platform)) {
    if (rule.match.test(haystack)) hits.push({ capability: rule.capability, risk: rule.risk, advice: rule.advice })
  }
  // 去重并按风险排序
  const order = { high: 0, medium: 1, low: 2 }
  const seen = new Set()
  return hits
    .filter((hit) => {
      if (seen.has(hit.capability)) return false
      seen.add(hit.capability)
      return true
    })
    .sort((left, right) => order[left.risk] - order[right.risk])
}

/** 一句话总结重叠情况，给界面上色用。 */
export function describeOverlap(candidate, options = {}) {
  const hits = overlapsFor(candidate, options)
  if (hits.length === 0) return { level: 'none', hits: [], summary: '与 DSH 内置能力不重叠' }
  const level = hits.some((hit) => hit.risk === 'high') ? 'high' : (hits.some((hit) => hit.risk === 'medium') ? 'medium' : 'low')
  const summary = (level === 'high' ? '与 DSH 内置能力高度重叠：' : (level === 'medium' ? '与 DSH 内置能力部分重叠：' : '轻微重叠：')) +
    hits.map((hit) => hit.capability).join('、')
  return { level, hits, summary }
}

/**
 * 按关键词给候选排序：不重复的优先，名称/描述精确的其次。
 * 「智能搜索」的核心：让用户先看到不重复、最相关的那些。
 */
export function rankCandidates(query, candidates, installedKeys = new Set(), options = {}) {
  const needle = String(query || '').toLowerCase().trim()
  const needleParts = needle.split(/\s+/).filter((item) => item !== '')
  return [...candidates].sort((left, right) => score(right, needle, needleParts, installedKeys, options) - score(left, needle, needleParts, installedKeys, options))
}

function score(row, needle, parts, installedKeys, options) {
  const name = String(row.name || '').toLowerCase()
  const title = String(row.title || '').toLowerCase()
  const description = String(row.description || '').toLowerCase()
  const packages = Array.isArray(row.packages) ? row.packages.map((pkg) => String(pkg.identifier || '').toLowerCase()) : []
  let value = 0
  if (name === needle || title === needle) value += 6
  if (name.includes(needle) && needle !== '') value += 3
  if (title.includes(needle) && needle !== '') value += 2
  for (const part of parts) {
    if (name.includes(part)) value += 1.5
    else if (description.includes(part)) value += 0.6
    if (packages.some((pkg) => pkg.includes(part))) value += 1
  }
  if (row.source === 'registry') value += 1.2
  if (row.official === true) value += 0.8
  if (row.installable === false) value -= 2
  const overlap = describeOverlap(row, options)
  if (overlap.level === 'high') value -= 3
  else if (overlap.level === 'medium') value -= 1.2
  else if (overlap.level === 'low') value -= 0.3
  if (packages.some((pkg) => installedKeys.has(pkg))) value -= 2
  if (typeof row.stars === 'number' && row.stars > 0) value += Math.min(1.5, Math.log10(row.stars + 1))
  if (typeof row.downloads === 'number' && row.downloads > 0) value += Math.min(1, Math.log10(row.downloads + 1) / 3)
  return value
}
