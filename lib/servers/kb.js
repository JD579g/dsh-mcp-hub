/**
 * dsh-mcp-hub · 内置 MCP 服务：kb（长期知识库 / 记忆）
 *
 * 跨会话、跨宿主的持久记忆：按命名空间保存条目（事实、决策、偏好、片段），
 * 支持关键词检索、标签过滤、实体与关系图，以及导出/导入。
 *
 * 存储位置：MCP_KB_DIR（默认 ~/.dsh/mcp-hub/kb），纯 JSONL，一行一条，
 * 追加写、并发安全；不依赖任何数据库。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { str, num, bool } from './util.js'

function kbDir() {
  return process.env.MCP_KB_DIR || path.join(os.homedir(), '.dsh', 'mcp-hub', 'kb')
}

const strArr = (description) => ({ type: 'array', items: { type: 'string' }, description })

const SAFE_NAME = /^[A-Za-z0-9._-]{1,64}$/

function safeName(value, fallback) {
  const name = value === undefined || value === null || String(value).trim() === '' ? fallback : String(value).trim()
  if (!SAFE_NAME.test(name)) throw new Error('命名不合法（只允许字母数字 . _ -，最多 64 字符）：' + name)
  return name
}

function fileFor(kind, namespace) {
  return path.join(kbDir(), kind + '-' + namespace + '.jsonl')
}

async function readJsonl(file) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch { /* 跳过损坏行，不让一行毁掉整个库 */ }
  }
  return rows
}

async function appendJsonl(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8')
}

async function listNamespaces() {
  let entries
  try {
    entries = await fs.readdir(kbDir())
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const names = new Set()
  for (const entry of entries) {
    const match = /^(?:entry|entity|relation)-(.+)\.jsonl$/.exec(entry)
    if (match !== null) names.add(match[1])
  }
  return [...names].sort()
}

const STOP_WORDS = new Set(['的', '了', '是', '在', '和', '与', 'the', 'a', 'an', 'of', 'to', 'is', 'are', 'and', 'or', 'in', 'on', 'for'])

/** 极简分词：英文按词、中文按双字滑窗，过滤停用词。 */
function tokenize(text) {
  const lowered = String(text).toLowerCase()
  const tokens = []
  for (const match of lowered.matchAll(/[a-z0-9_]{2,}/g)) tokens.push(match[0])
  const han = lowered.replace(/[^\u4e00-\u9fff]/g, '')
  for (let index = 0; index + 1 < han.length; index += 1) tokens.push(han.slice(index, index + 2))
  return tokens.filter((token) => !STOP_WORDS.has(token))
}

function scoreRecord(record, queryTokens) {
  const haystack = (String(record.text || '') + ' ' + (record.tags || []).join(' ') + ' ' + String(record.key || '')).toLowerCase()
  const bodyTokens = tokenize(haystack)
  const counts = new Map()
  for (const token of bodyTokens) counts.set(token, (counts.get(token) || 0) + 1)
  let score = 0
  let hits = 0
  for (const token of queryTokens) {
    const count = counts.get(token)
    if (count === undefined) continue
    hits += 1
    score += 1 + Math.log(1 + count)
    if (haystack.includes(token)) score += 0.5
  }
  if (hits === 0) return 0
  // 命中覆盖率与短文本优先，让最相关的条目排在前面。
  return score * (hits / queryTokens.length) + 1 / (1 + String(record.text || '').length / 500)
}

function idFor(kind, namespace, text) {
  return createHash('sha1').update(kind + '|' + namespace + '|' + text + '|' + Date.now() + '|' + Math.random()).digest('hex').slice(0, 16)
}

export const kbServer = {
  name: 'kb',
  version: '1.0.0',
  title: '长期知识库',
  instructions: '跨会话持久记忆：写事实、按关键词检索、维护实体与关系。默认命名空间 default。',
  tools: [
    {
      name: 'remember',
      description: '写入一条记忆（事实/决策/偏好/代码片段）。同 key 重复写入时保留历史，检索会返回最新一条。',
      inputSchema: {
        type: 'object',
        properties: {
          text: str('要记住的内容（自然语言或代码片段）'),
          namespace: str('命名空间，默认 default；例如 project-x、user-prefs'),
          key: str('稳定键名（可选），用于后续按 key 取回最新值'),
          tags: strArr('标签数组，便于过滤'),
          source: str('来源说明（可选），例如会话 ID、文件路径、URL'),
        },
        required: ['text'],
      },
      async handler(args) {
        const text = String(args.text === undefined ? '' : args.text).trim()
        if (text === '') throw new Error('text 不能为空')
        const namespace = safeName(args.namespace, 'default')
        const record = {
          id: idFor('entry', namespace, text),
          at: new Date().toISOString(),
          namespace,
          text,
          key: args.key === undefined || args.key === null ? null : String(args.key),
          tags: Array.isArray(args.tags) ? args.tags.map((item) => String(item)).slice(0, 32) : [],
          source: args.source === undefined || args.source === null ? null : String(args.source),
        }
        await appendJsonl(fileFor('entry', namespace), record)
        return { stored: true, id: record.id, namespace, key: record.key, tags: record.tags, at: record.at }
      },
    },
    {
      name: 'recall',
      description: '按关键词检索记忆（中英文混合分词、标签加权），返回最相关的前 N 条。',
      inputSchema: {
        type: 'object',
        properties: {
          query: str('检索关键词'),
          namespace: str('命名空间，默认 default；传 * 表示全部命名空间'),
          tags: strArr('必须同时命中的标签'),
          limit: num('最多返回条数，默认 10'),
          since: str('只返回该 ISO 时间之后的条目'),
        },
        required: ['query'],
      },
      async handler(args) {
        const query = String(args.query === undefined ? '' : args.query)
        if (query.trim() === '') throw new Error('query 不能为空')
        const wanted = safeName(args.namespace, 'default')
        const namespaces = wanted === '*' ? await listNamespaces() : [wanted]
        const tags = Array.isArray(args.tags) ? args.tags.map((item) => String(item)) : []
        const limit = Math.max(1, Math.min(100, Number(args.limit || 10) || 10))
        const since = typeof args.since === 'string' && args.since !== '' ? Date.parse(args.since) : null
        const queryTokens = tokenize(query)
        const scored = []
        for (const namespace of namespaces) {
          const rows = await readJsonl(fileFor('entry', namespace))
          for (const row of rows) {
            if (since !== null && Number.isFinite(since) && Date.parse(row.at || '') < since) continue
            if (tags.length > 0) {
              const rowTags = Array.isArray(row.tags) ? row.tags : []
              if (!tags.every((tag) => rowTags.includes(tag))) continue
            }
            const score = scoreRecord(row, queryTokens)
            if (score > 0) scored.push({ ...row, score: Math.round(score * 1000) / 1000 })
          }
        }
        scored.sort((left, right) => right.score - left.score || String(right.at).localeCompare(String(left.at)))
        return { query, namespaces, scanned: scored.length, count: Math.min(limit, scored.length), results: scored.slice(0, limit) }
      },
    },
    {
      name: 'get',
      description: '按 key 取回某个命名空间里该 key 的最新一条记忆；没有则返回 found: false。',
      inputSchema: {
        type: 'object',
        properties: {
          key: str('键名'),
          namespace: str('命名空间，默认 default'),
        },
        required: ['key'],
      },
      async handler(args) {
        const key = String(args.key === undefined ? '' : args.key)
        if (key === '') throw new Error('key 不能为空')
        const namespace = safeName(args.namespace, 'default')
        const rows = await readJsonl(fileFor('entry', namespace))
        let latest = null
        for (const row of rows) if (row.key === key) latest = row
        return latest === null ? { found: false, key, namespace } : { found: true, ...latest }
      },
    },
    {
      name: 'forget',
      description: '删除记忆：按 id 精确删除，或按命名空间整体清空（必须 destructive: true）。删除后返回剩余条数。',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('要删除的条目 id'),
          namespace: str('命名空间，默认 default'),
          all: bool('true = 清空该命名空间全部条目'),
          destructive: bool('破坏性确认，必须显式传 true'),
        },
      },
      async handler(args) {
        if (args.destructive !== true) throw new Error('删除需要显式 destructive: true 确认')
        const namespace = safeName(args.namespace, 'default')
        const file = fileFor('entry', namespace)
        const rows = await readJsonl(file)
        let next
        if (args.all === true) next = []
        else {
          const id = String(args.id === undefined ? '' : args.id)
          if (id === '') throw new Error('需要 id，或传 all: true')
          next = rows.filter((row) => row.id !== id)
          if (next.length === rows.length) throw new Error('没有找到 id：' + id)
        }
        await fs.mkdir(kbDir(), { recursive: true })
        await fs.writeFile(file, next.map((row) => JSON.stringify(row)).join('\n') + (next.length > 0 ? '\n' : ''), 'utf8')
        return { namespace, removed: rows.length - next.length, remaining: next.length }
      },
    },
    {
      name: 'entity',
      description: '记录/更新一个实体（人、项目、服务、文件）及其属性；同名同命名空间视为同一条。',
      inputSchema: {
        type: 'object',
        properties: {
          name: str('实体名'),
          type: str('实体类型，例如 person / project / service / file'),
          attributes: { type: 'object', description: '属性表（任意 JSON 对象）' },
          namespace: str('命名空间，默认 default'),
        },
        required: ['name'],
      },
      async handler(args) {
        const name = String(args.name === undefined ? '' : args.name).trim()
        if (name === '') throw new Error('name 不能为空')
        const namespace = safeName(args.namespace, 'default')
        const record = {
          id: idFor('entity', namespace, name),
          at: new Date().toISOString(),
          namespace,
          name,
          type: args.type === undefined || args.type === null ? 'unknown' : String(args.type),
          attributes: args.attributes !== null && typeof args.attributes === 'object' ? args.attributes : {},
        }
        await appendJsonl(fileFor('entity', namespace), record)
        return { saved: true, ...record }
      },
    },
    {
      name: 'relate',
      description: '记录两个实体之间的关系（from -[relation]-> to）。',
      inputSchema: {
        type: 'object',
        properties: {
          from: str('起点实体名'),
          relation: str('关系名，例如 depends_on / owns / uses'),
          to: str('终点实体名'),
          note: str('备注（可选）'),
          namespace: str('命名空间，默认 default'),
        },
        required: ['from', 'relation', 'to'],
      },
      async handler(args) {
        const from = String(args.from === undefined ? '' : args.from)
        const relation = String(args.relation === undefined ? '' : args.relation)
        const to = String(args.to === undefined ? '' : args.to)
        if (from === '' || relation === '' || to === '') throw new Error('from / relation / to 都不能为空')
        const namespace = safeName(args.namespace, 'default')
        const record = {
          id: idFor('relation', namespace, from + relation + to),
          at: new Date().toISOString(),
          namespace,
          from,
          relation,
          to,
          note: args.note === undefined || args.note === null ? null : String(args.note),
        }
        await appendJsonl(fileFor('relation', namespace), record)
        return { saved: true, ...record }
      },
    },
    {
      name: 'graph',
      description: '导出某个命名空间的实体与关系图（实体按名字去重保留最新，关系全量）。',
      inputSchema: {
        type: 'object',
        properties: { namespace: str('命名空间，默认 default') },
      },
      async handler(args) {
        const namespace = safeName(args.namespace, 'default')
        const entities = new Map()
        for (const row of await readJsonl(fileFor('entity', namespace))) entities.set(row.name, row)
        const relations = await readJsonl(fileFor('relation', namespace))
        return { namespace, entities: [...entities.values()], relations, entityCount: entities.size, relationCount: relations.length }
      },
    },
    {
      name: 'namespaces',
      description: '列出所有命名空间及各自的条目数（entries / entities / relations）。',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        const names = await listNamespaces()
        const result = []
        for (const namespace of names) {
          const [entries, entities, relations] = await Promise.all([
            readJsonl(fileFor('entry', namespace)),
            readJsonl(fileFor('entity', namespace)),
            readJsonl(fileFor('relation', namespace)),
          ])
          result.push({ namespace, entries: entries.length, entities: entities.length, relations: relations.length })
        }
        return { dir: kbDir(), count: result.length, namespaces: result }
      },
    },
    {
      name: 'export',
      description: '导出某个命名空间的全部原始数据（条目/实体/关系），便于备份或迁移。',
      inputSchema: {
        type: 'object',
        properties: {
          namespace: str('命名空间，默认 default'),
          path: str('可选的落盘路径（必须位于 /root 或 /tmp），省略则直接返回数据'),
        },
      },
      async handler(args) {
        const namespace = safeName(args.namespace, 'default')
        const payload = {
          namespace,
          exportedAt: new Date().toISOString(),
          entries: await readJsonl(fileFor('entry', namespace)),
          entities: await readJsonl(fileFor('entity', namespace)),
          relations: await readJsonl(fileFor('relation', namespace)),
        }
        if (typeof args.path === 'string' && args.path !== '') {
          const { resolveSandboxPath } = await import('./fs.js')
          const target = await resolveSandboxPath(args.path)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, JSON.stringify(payload, null, 2), 'utf8')
          return { path: target, entries: payload.entries.length, entities: payload.entities.length, relations: payload.relations.length }
        }
        return payload
      },
    },
  ],
}

