/**
 * dsh-mcp-hub · 注册表状态、内置目录与配置校验
 *
 * 注册表是一个 JSON 文件（默认 ~/.dsh/mcp-hub/servers.json），人类可读、可手改；
 * 内置目录（catalog）描述「一键可装」的服务：桌面零依赖工具包 + 官方/社区预设
 * （npm 的 npx 系列与 Python 的 uvx 系列）。
 *
 * 面向桌面开发者（Windows 优先）：默认根目录、默认启用的服务、预设里的路径
 * 都按当前平台计算；手机侧（DSHA）的 device 服务只在安卓上进入默认值。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { describeError } from '../servers/util.js'
import { defaultFsRoots, isDshaAndroid, platformLabel } from '../platform.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB_DIR = path.resolve(HERE, '..')
const SERVERS_DIR = path.join(LIB_DIR, 'servers')
export const SERVER_ENTRY = path.join(SERVERS_DIR, 'main.js')

export const BUILTIN_NAMES = ['hub', 'files', 'exec', 'net', 'kb', 'util', 'device']

/**
 * 解析查询队列记录的信封 id（宿主据此把结果写回 query-responses.json）。
 *
 * 必须和 payload 分开看：describe 的 payload 自带一个 id（要查的候选/服务名），
 * 早期协议把两者平铺在同一个对象里，信封 id 会被 payload 覆盖，宿主按错误的 key
 * 写回、调用方只能等到超时。新记录用 requestId，旧记录（以及变更记录）仍然只有 id。
 */
export function queryEnvelopeId(record) {
  if (record === null || typeof record !== 'object') return ''
  const raw = record.requestId !== undefined ? record.requestId : record.id
  if (raw === undefined || raw === null) return ''
  const text = String(raw)
  return text
}

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const home = os.homedir()
  const dataDir = typeof config.dataDir === 'string' && config.dataDir !== ''
    ? config.dataDir
    : path.join(process.env.DSH_HOME || path.join(home, '.dsh'), 'mcp-hub')
  const defaultRoots = Array.isArray(config.defaultFsRoots) && config.defaultFsRoots.length > 0
    ? config.defaultFsRoots.map((item) => String(item))
    : defaultFsRoots()
  const bootstrap = Array.isArray(config.bootstrapServers) ? config.bootstrapServers.map((item) => String(item)) : null
  return {
    enabled: config.enabled !== false,
    dataDir,
    registryFile: typeof config.registryFile === 'string' && config.registryFile !== '' ? config.registryFile : path.join(dataDir, 'servers.json'),
    catalogFile: path.join(dataDir, 'catalog.json'),
    mutationFile: path.join(dataDir, 'mutations.jsonl'),
    queryFile: path.join(dataDir, 'queries.jsonl'),
    queryResponseFile: path.join(dataDir, 'query-responses.json'),
    toolsFile: path.join(dataDir, 'tools.json'),
    statsFile: path.join(dataDir, 'stats.json'),
    logFile: path.join(dataDir, 'hub.log'),
    bootstrapServers: bootstrap,
    reconcileIntervalMs: Math.max(2000, Number(config.reconcileIntervalMs || 5000) || 5000),
    toolCallTimeoutMs: Math.max(1000, Number(config.toolCallTimeoutMs || 120000) || 120000),
    fsRoots: defaultRoots,
    kbDir: typeof config.kbDir === 'string' && config.kbDir !== '' ? config.kbDir : path.join(dataDir, 'kb'),
    logLimit: Math.max(20, Number(config.logLimit || 200) || 200),
    platform: process.platform,
    osLabel: platformLabel(),
    // 可显式覆盖：桌面上永远为 false；手机上用户也能强制关掉手机专属能力。
    isMobileDsha: config.isMobileDsha === undefined ? isDshaAndroid() : config.isMobileDsha === true,
  }
}

/** 暴露给内置服务子进程的运行时环境。 */
export function runtimeEnv(config) {
  return {
    MCP_FS_ROOTS: config.fsRoots.join(path.delimiter),
    MCP_KB_DIR: config.kbDir,
    MCP_EXEC_ROOT: process.env.DSH_WORKSPACE || process.cwd(),
    MCP_HUB_REGISTRY: config.registryFile,
    MCP_HUB_CATALOG: config.catalogFile,
    MCP_HUB_MUTATION: config.mutationFile,
    MCP_HUB_TOOLS: config.toolsFile,
    MCP_HUB_STATS: config.statsFile,
    MCP_HUB_QUERY: config.queryFile,
    MCP_HUB_QUERY_RESPONSE: config.queryResponseFile,
  }
}

async function readJsonFile(file, fallback) {
  try {
    const text = await fs.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw new Error('读取 ' + file + ' 失败：' + describeError(error))
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const text = JSON.stringify(value, null, 2) + '\n'
  await fs.writeFile(file + '.tmp', text, 'utf8')
  await fs.rename(file + '.tmp', file)
}

function builtinEntry(name, config) {
  const meta = {
    hub: { label: 'MCP 控制台', description: '查看/管理 MCP 注册表与目录，把变更提交给宿主应用。', tags: ['mcp', 'meta'] },
    files: { label: '文件系统', description: '受限根目录内的读、写、改、搜、查、移。', tags: ['files', 'core'] },
    exec: { label: '命令执行', description: '跑 shell 命令、探测程序、看进程与系统资源。', tags: ['shell', 'core'] },
    net: { label: '网络请求', description: 'HTTP 请求、下载、JSON 抓取、URL 解析。', tags: ['http', 'core'] },
    kb: { label: '长期知识库', description: '跨会话记忆：条目、检索、实体与关系。', tags: ['memory', 'core'] },
    util: { label: '通用工具', description: '时间、随机、哈希、编码、计算、文本统计。', tags: ['utility', 'core'] },
    device: { label: 'Android 设备', description: '通过 DSHA 桥操作这台手机：读屏、点按、输入、截屏。（仅安卓 DSHA 上有意义，桌面环境请忽略）', tags: ['device', 'android'], platforms: ['android'] },
  }
  const info = meta[name] || { label: name, description: '', tags: [], platforms: ['desktop'] }
  const mobile = info.platforms !== undefined && info.platforms.includes('android')
  return {
    name,
    label: info.label,
    description: info.description,
    tags: info.tags,
    transport: 'stdio',
    command: process.execPath,
    args: [SERVER_ENTRY, name],
    env: runtimeEnv(config),
    requires: [],
    runners: [],
    platforms: info.platforms === undefined ? ['desktop'] : info.platforms,
    // 手机专属服务在桌面上标成不支持：仍可手动装，但不进默认、界面会给提示。
    supportsCurrent: mobile ? config.isMobileDsha === true : true,
    builtin: true,
    installed: true,
  }
}

/**
 * 外部预设：npm 包都经过 npm registry 存在性核验，Python 包都经过 PyPI 核验。
 * runners 字段告诉界面「这个预设需要 npx 还是 uvx」，缺哪个就给安装命令。
 */
function presetEntries() {
  const home = os.homedir()
  const dbPath = path.join(home, 'mcp-hub-data.db')
  const npxHint = '需要 npx（随 Node.js 安装）'
  return [
    {
      name: 'mcp-filesystem',
      label: 'Filesystem（官方）',
      description: '官方文件系统服务：在指定目录内读写、检索、编辑文件。',
      tags: ['files', 'official'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', home],
      runners: ['npx'],
      requires: [npxHint, 'args 末尾是允许访问的目录（默认你的家目录），按需改成项目目录'],
    },
    {
      name: 'mcp-memory',
      label: 'Memory（官方）',
      description: '官方知识图谱记忆：实体、关系、观察记录。',
      tags: ['memory', 'official'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      runners: ["npx"],
      requires: ['需要 npx（Node）'],
    },
    {
      name: 'mcp-thinking',
      label: 'Sequential Thinking（官方）',
      description: '结构化多步推理：把思考过程显式化并逐步修订。',
      tags: ['reasoning', 'official'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      runners: ["npx"],
      requires: ['需要 npx（Node）'],
    },
    {
      name: 'mcp-everything',
      label: 'Everything（官方参考实现）',
      description: '官方参考服务：演示 prompt、resource、tool 的完整能力，可用来验证 MCP 通路。',
      tags: ['reference', 'official'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
      runners: ["npx"],
      requires: ['需要 npx（Node）'],
    },
    {
      name: 'mcp-github',
      label: 'GitHub（官方）',
      description: '仓库、Issue、PR、搜索等 GitHub 操作。',
      tags: ['git', 'official'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
      runners: ["npx"],
      requires: ['需要 GitHub PAT：环境变量 GITHUB_PERSONAL_ACCESS_TOKEN'],
    },
    {
      name: 'mcp-gitlab',
      label: 'GitLab（官方）',
      description: 'GitLab 项目、Issue、MR 操作。',
      tags: ['git', 'official'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-gitlab'],
      env: { GITLAB_PERSONAL_ACCESS_TOKEN: '', GITLAB_API_URL: 'https://gitlab.com/api/v4' },
      runners: ["npx"],
      requires: ['需要 GitLab Token：GITLAB_PERSONAL_ACCESS_TOKEN'],
    },
    {
      name: 'mcp-slack',
      label: 'Slack（官方）',
      description: '频道历史、发消息、回复线程。',
      tags: ['chat', 'official'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack'],
      env: { SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' },
      runners: ["npx"],
      requires: ['需要 SLACK_BOT_TOKEN 与 SLACK_TEAM_ID'],
    },
    {
      name: 'mcp-postgres',
      label: 'PostgreSQL（官方）',
      description: '只读 SQL 查询与表结构查看。',
      tags: ['database', 'official'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://user:pass@localhost:5432/db'],
      runners: ["npx"],
      requires: ['把 args 里的连接串改成你的数据库地址'],
    },
    {
      name: 'mcp-sqlite',
      label: 'SQLite（官方）',
      description: '对本地 SQLite 文件做查询与结构查看。',
      tags: ['database', 'official'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sqlite', dbPath],
      runners: ["npx"],
      requires: ['把 args 末尾改成你的 .db 文件路径'],
    },
    {
      name: 'mcp-puppeteer',
      label: 'Puppeteer（官方）',
      description: '无头浏览器：打开页面、截图、执行 JS。',
      tags: ['browser', 'official'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
      runners: ["npx"],
      requires: ['需要下载 Chromium，体积较大'],
    },
    {
      name: 'mcp-brave-search',
      label: 'Brave Search（官方）',
      description: '网页与本地搜索。',
      tags: ['search', 'official'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      env: { BRAVE_API_KEY: '' },
      runners: ["npx"],
      requires: ['需要 BRAVE_API_KEY'],
    },
    {
      name: 'mcp-google-maps',
      label: 'Google Maps（官方）',
      description: '地理编码、路线、地点搜索。',
      tags: ['maps', 'official'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-google-maps'],
      env: { GOOGLE_MAPS_API_KEY: '' },
      runners: ["npx"],
      requires: ['需要 GOOGLE_MAPS_API_KEY'],
    },
    {
      name: 'mcp-playwright',
      label: 'Playwright（微软）',
      description: '浏览器自动化：导航、点击、截图、快照。',
      tags: ['browser'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
      runners: ["npx"],
      requires: ['需要下载浏览器内核'],
    },
    {
      name: 'mcp-chrome-devtools',
      label: 'Chrome DevTools',
      description: '用 DevTools 协议调试页面：性能、网络、DOM。',
      tags: ['browser', 'debug'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@latest'],
      runners: ["npx"],
      requires: ['需要本机有 Chrome/Chromium'],
    },
    {
      name: 'mcp-context7',
      label: 'Context7（文档检索）',
      description: '按库名拉取最新官方文档与代码示例。',
      tags: ['docs', 'search'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      runners: ["npx"],
      requires: ['部分接口需要 CONTEXT7_API_KEY'],
    },
    {
      name: 'mcp-tavily',
      label: 'Tavily（搜索 API）',
      description: '面向 LLM 的网页搜索与内容抽取。',
      tags: ['search'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'tavily-mcp@latest'],
      env: { TAVILY_API_KEY: '' },
      runners: ["npx"],
      requires: ['需要 TAVILY_API_KEY'],
    },
    {
      name: 'mcp-exa',
      label: 'Exa（搜索 API）',
      description: '语义搜索与网页内容抓取。',
      tags: ['search'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'exa-mcp-server'],
      env: { EXA_API_KEY: '' },
      runners: ["npx"],
      requires: ['需要 EXA_API_KEY'],
    },
    {
      name: 'mcp-firecrawl',
      label: 'Firecrawl（爬取）',
      description: '把网站爬成干净的 Markdown/结构化数据。',
      tags: ['crawl'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'firecrawl-mcp'],
      env: { FIRECRAWL_API_KEY: '' },
      runners: ["npx"],
      requires: ['需要 FIRECRAWL_API_KEY'],
    },
    {
      name: 'mcp-figma',
      label: 'Figma Dev Mode',
      description: '读取 Figma 设计稿的结构、样式与代码提示。',
      tags: ['design'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'figma-developer-mcp', '--stdio'],
      env: { FIGMA_API_KEY: '' },
      runners: ["npx"],
      requires: ['需要 FIGMA_API_KEY'],
    },
    {
      name: 'mcp-aws-kb',
      label: 'AWS Knowledge Base（官方）',
      description: '检索 AWS Bedrock Knowledge Base。',
      tags: ['cloud'],
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-aws-kb-retrieval'],
      env: { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_REGION: 'us-east-1' },
      runners: ["npx"],
      requires: ['需要 AWS 凭据与 region'],
    },

    // ── Python 官方服务（uvx 拉起，Windows 上装一次 uv 就能用） ──────────────
    {
      name: 'mcp-fetch-uv',
      label: 'Fetch（官方 · Python）',
      description: '抓取网页并转成 Markdown：给模型读文档、读 issue 用。',
      tags: ['web', 'fetch', 'official'],
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-fetch'],
      runners: ['uvx'],
      requires: ['需要 uv/uvx（Windows: winget install astral-sh.uv）'],
    },
    {
      name: 'mcp-git-uv',
      label: 'Git（官方 · Python）',
      description: '对本地仓库做 status / diff / log / commit 等只读或半写操作。',
      tags: ['git', 'official'],
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-git', '--repository', home],
      runners: ['uvx'],
      requires: ['需要 uv/uvx', 'args 里的 --repository 默认你的家目录，按需改成仓库路径'],
    },
    {
      name: 'mcp-sqlite-uv',
      label: 'SQLite（官方 · Python）',
      description: '把本地 SQLite 文件当数据库查询（官方 Python 实现）。',
      tags: ['database', 'official'],
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-sqlite', '--db-path', dbPath],
      runners: ['uvx'],
      requires: ['需要 uv/uvx', 'args 里的 --db-path 默认家目录下的 mcp-hub-data.db'],
    },
    {
      name: 'mcp-time-uv',
      label: 'Time（官方 · Python）',
      description: '时区换算与当前时间（比自算更靠谱）。',
      tags: ['time', 'official'],
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-time', '--local-timezone', 'Asia/Shanghai'],
      runners: ['uvx'],
      requires: ['需要 uv/uvx', '--local-timezone 可改成你的时区'],
    },
  ]
}

/**
 * 默认首次安装的服务集合 —— **桌面优先**：
 * hub（控制台）+ files/exec/net/util/kb（开发日常够用的零依赖工具）。
 * 手机侧的 device 只在安卓 DSHA 上才默认启用；桌面环境需要时可在目录里手动装。
 */
export function defaultServers(config) {
  const desktop = ['hub', 'files', 'exec', 'net', 'kb', 'util']
  const wanted = config.bootstrapServers === null
    ? (config.isMobileDsha === true ? [...desktop, 'device'] : desktop)
    : config.bootstrapServers
  return wanted.map((name) => {
    const entry = builtinEntry(name, config)
    // 手机专属服务在桌面上即使被显式写进 bootstrap 也标成「当前平台不支持」，避免白装。
    if (entry.supportsCurrent !== true) entry.enabled = false
    return entry
  }).filter((entry) => BUILTIN_NAMES.includes(entry.name))
}

export function builtinCatalog(config) {
  return BUILTIN_NAMES.map((name) => builtinEntry(name, config))
}

export function presetCatalog() {
  return presetEntries()
}

function validateName(name) {
  const value = String(name === undefined || name === null ? '' : name).trim()
  if (!NAME_PATTERN.test(value)) throw new Error('服务名不合法：' + value + '（只允许字母数字 _ -，1~32 字符）')
  return value
}

/** 校验一条服务配置；返回规范化后的对象。 */
export function normalizeServer(input, base) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const name = validateName(source.name)
  const transport = source.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const server = {
    name,
    label: typeof source.label === 'string' && source.label !== '' ? source.label : (base && base.label) || name,
    description: typeof source.description === 'string' ? source.description : (base && base.description) || '',
    tags: Array.isArray(source.tags) ? source.tags.map((item) => String(item)).slice(0, 16) : ((base && base.tags) || []),
    transport,
    enabled: source.enabled !== false,
    permission: ['always', 'session', 'ask', 'disabled'].includes(source.permission) ? source.permission : ((base && base.permission) || 'always'),
    source: source.source !== undefined ? String(source.source) : (base && base.source) || 'user',
    toolCallTimeoutMs: Math.max(1000, Math.min(600000, Number(source.toolCallTimeoutMs || 120000) || 120000)),
  }
  if (transport === 'stdio') {
    const command = String(source.command === undefined || source.command === '' ? (base && base.command) || '' : source.command)
    if (command === '') throw new Error('stdio 服务需要 command：' + name)
    server.command = command
    server.args = Array.isArray(source.args) ? source.args.map((item) => String(item)) : ((base && base.args) || [])
    server.env = source.env !== null && typeof source.env === 'object' ? { ...source.env } : ((base && base.env) || {})
    if (typeof source.cwd === 'string' && source.cwd !== '') server.cwd = source.cwd
  } else {
    const url = String(source.url === undefined || source.url === '' ? (base && base.url) || '' : source.url)
    if (url === '') throw new Error('streamable-http 服务需要 url：' + name)
    server.url = url
    server.headers = source.headers !== null && typeof source.headers === 'object' ? { ...source.headers } : ((base && base.headers) || {})
  }
  return server
}

/** 注册表 + 目录 + 运行态的宿主侧状态机。 */
export function createState(options) {
  const config = options.config
  const runner = options.runner
  const log = options.log

  const state = {
    config,
    servers: [],
    catalog: [],
    results: new Map(),
    lastReconcile: null,
    reconcileFailures: 0,
  }

  const catalogIndex = () => new Map(state.catalog.map((entry) => [entry.name, entry]))

  async function loadRegistry() {
    const document = await readJsonFile(config.registryFile, null)
    if (document === null || typeof document !== 'object' || !Array.isArray(document.servers)) {
      state.servers = defaultServers(config)
      await saveRegistry()
      log('初始化注册表：' + state.servers.map((item) => item.name).join('、'))
      return
    }
    const servers = []
    for (const raw of document.servers) {
      try {
        servers.push(normalizeServer(raw, catalogIndex().get(String(raw && raw.name))))
      } catch (error) {
        log('跳过非法注册项 ' + String(raw && raw.name) + '：' + describeError(error))
      }
    }
    state.servers = servers
  }

  async function saveRegistry() {
    await writeJsonFile(config.registryFile, { version: 1, updatedAt: new Date().toISOString(), servers: state.servers })
  }

  async function buildCatalog() {
    state.catalog = [...builtinCatalog(config), ...presetCatalog()]
    await writeJsonFile(config.catalogFile, { version: 1, updatedAt: new Date().toISOString(), servers: state.catalog })
  }

  async function reconcile() {
    if (!config.enabled) return { disabled: true }
    const wanted = state.servers.filter((server) => server.enabled !== false)
    const started = []
    const stopped = []
    const failed = []
    for (const server of wanted) {
      try {
        if (runner.has(server.name) && state.results.get(server.name) === 'running') {
          if (!sameRuntime(server)) {
            await runner.start(server)
            rememberFingerprint(server)
          }
          continue
        }
        await runner.start(server)
        rememberFingerprint(server)
        state.results.set(server.name, 'running')
        started.push(server.name)
      } catch (error) {
        state.results.set(server.name, 'failed')
        state.reconcileFailures += 1
        failed.push({ name: server.name, error: describeError(error) })
        log('连接失败 ' + server.name + '：' + describeError(error))
      }
    }
    const live = new Set(runner.list().map((item) => item.name))
    for (const name of live) {
      const server = state.servers.find((item) => item.name === name)
      if (server === undefined || server.enabled === false) {
        await runner.stop(name)
        forgetFingerprint(name)
        state.results.set(name, server === undefined ? 'removed' : 'disabled')
        stopped.push(name)
      }
    }
    state.lastReconcile = new Date().toISOString()
    await writeToolsFile()
    await writeStats()
    return { started, stopped, failed }
  }

  const runtimeFingerprints = new Map()
  function fingerprint(server) {
    return JSON.stringify([server.transport, server.command, server.args, server.env, server.url, server.headers, server.cwd])
  }
  function sameRuntime(server) {
    return runtimeFingerprints.get(server.name) === fingerprint(server)
  }
  function rememberFingerprint(server) {
    runtimeFingerprints.set(server.name, fingerprint(server))
  }

  async function writeToolsFile() {
    const toolsByServer = {}
    for (const record of runner.list()) toolsByServer[record.name] = record.tools
    await writeJsonFile(config.toolsFile, toolsByServer)
  }

  async function writeStats() {
    await writeJsonFile(config.statsFile, {
      enabled: config.enabled,
      registryFile: config.registryFile,
      servers: state.servers.length,
      running: runner.list().map((item) => ({ name: item.name, toolCount: item.toolCount, startedAt: item.startedAt })),
      results: Object.fromEntries(state.results),
      reconcileFailures: state.reconcileFailures,
      lastReconcile: state.lastReconcile,
    })
  }

  function forgetFingerprint(name) {
    runtimeFingerprints.delete(name)
  }

  async function applyMutation(mutation) {
    const action = String(mutation && mutation.action)
    const payload = mutation !== null && typeof mutation.payload === 'object' && mutation.payload !== null ? mutation.payload : {}
    if (action === 'reload') {
      for (const server of state.servers) forgetFingerprint(server.name)
      return { action, ...(await reconcile()) }
    }
    if (action === 'enable' || action === 'disable') {
      const name = validateName(payload.name)
      const server = state.servers.find((item) => item.name === name)
      if (server === undefined) throw new Error('注册表里没有服务：' + name)
      server.enabled = action === 'enable'
      await saveRegistry()
      return { action, name, enabled: server.enabled, ...(await reconcile()) }
    }
    if (action === 'remove') {
      const name = validateName(payload.name)
      const before = state.servers.length
      state.servers = state.servers.filter((item) => item.name !== name)
      if (state.servers.length === before) throw new Error('注册表里没有服务：' + name)
      await saveRegistry()
      return { action, name, removed: true, ...(await reconcile()) }
    }
    if (action === 'add' || action === 'upsert') {
      const name = validateName(payload.name)
      let base = null
      const fromCatalog = payload.fromCatalog
      if (typeof fromCatalog === 'string' && fromCatalog !== '') {
        base = catalogIndex().get(fromCatalog)
        if (base === undefined) throw new Error('目录里没有服务：' + fromCatalog)
      }
      const existing = state.servers.find((item) => item.name === name)
      const server = normalizeServer({ ...payload, name, source: base !== null ? 'catalog:' + fromCatalog : 'user', enabled: payload.enabled !== false }, existing !== undefined ? existing : base)
      if (existing === undefined) state.servers.push(server)
      else state.servers[state.servers.indexOf(existing)] = server
      await saveRegistry()
      forgetFingerprint(name)
      return { action, name, created: existing === undefined, ...(await reconcile()) }
    }
    throw new Error('未知的变更动作：' + action)
  }

  return {
    state,
    loadRegistry,
    saveRegistry,
    buildCatalog,
    reconcile,
    applyMutation,
    rememberFingerprint,
    writeToolsFile,
    writeStats,
    catalogIndex,
    stopAll: () => runner.stopAll(),
  }
}

