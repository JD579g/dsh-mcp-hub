/**
 * dsh-mcp-hub · 宿主侧查询队列端到端测试（假 cordis 上下文）
 *
 * 与 hub-query.test.mjs 互补：那一个验证「hub 子进程发出去的信封」，
 * 这一个验证「宿主真的按信封 id 写回」—— 用插件真正的 apply() 跑起来，
 * 往 queries.jsonl 里塞一条新协议记录，断言 applyPendingQueries 把结果
 * 写进 query-responses.json 的 requestId 键（而不是 payload 的 id 键）。
 *
 * 修复前：宿主读 record.id（被 describe 的目标名覆盖），结果写在目标名键下，
 *        调用方等自己那个随机 id → 干满 60 秒超时。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA_DIR = path.join(os.tmpdir(), 'mcp-hub-hostquery')
await fs.rm(DATA_DIR, { recursive: true, force: true })
const QUERY = path.join(DATA_DIR, 'queries.jsonl')
const RESPONSE = path.join(DATA_DIR, 'query-responses.json')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const registered = new Map()
const listeners = new Map()
const fakeCtx = {
  get(service) {
    if (service === 'tools') {
      return {
        register(definition) {
          registered.set(definition.name, definition)
          return () => registered.delete(definition.name)
        },
      }
    }
    if (service === 'commands') return { register() { return () => {} } }
    return undefined
  },
  on(event, handler) {
    const list = listeners.get(event) || []
    list.push(handler)
    listeners.set(event, list)
    return () => {}
  },
}

const { sdkOrSkip } = await import('./helpers.mjs')
await sdkOrSkip('宿主查询队列端到端测试')
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)
apply(fakeCtx, {
  dataDir: DATA_DIR,
  reconcileIntervalMs: 2000,
  bootstrapServers: ['hub', 'files'],
})

const failures = []
const check = (ok, label) => { if (!ok) failures.push(label) }
const report = {}

// 等宿主初始化完成
for (let i = 0; i < 40; i += 1) {
  await sleep(500)
  if (registered.has('mcp_hub') && registered.has('mcp__files__read')) break
}
report.readyTools = [...registered.keys()].filter((n) => n.indexOf('mcp') === 0).length

// 塞一条新协议记录：信封 id = requestId，payload 目标 id = files
const envelope = 'hostenv' + Date.now().toString(36)
await fs.appendFile(QUERY, JSON.stringify({ requestId: envelope, at: new Date().toISOString(), kind: 'describe', id: 'files' }) + '\n', 'utf8')

let responses = null
for (let i = 0; i < 40 && responses === null; i += 1) {
  await sleep(500)
  try {
    const doc = JSON.parse(await fs.readFile(RESPONSE, 'utf8'))
    if (doc.responses !== undefined && doc.responses[envelope] !== undefined) responses = doc.responses
  } catch { /* 还没写出来 */ }
}

report.envelope = envelope
report.respondedUnderEnvelope = responses !== null
report.respondedUnderPayloadId = responses !== null && responses['files'] !== undefined
if (responses !== null) {
  report.value = JSON.stringify(responses[envelope]).slice(0, 200)
}
check(responses !== null, '宿主必须在 requestId 键下写回结果（修复前写在 payload id 键下，调用方只能超时）')
check(report.respondedUnderPayloadId !== true, '结果不应写在 payload id（files）键下')
if (responses !== null) {
  check(responses[envelope].ok === true, '响应必须是 ok:true')
  check(responses[envelope].value && responses[envelope].value.found === true, 'describe files 必须命中已注册服务')
}

// 收尾：触发 dispose，停掉 MCP 子进程后退出
for (const handler of listeners.get('dispose') || []) {
  try { await handler() } catch { /* 忽略 */ }
}
await sleep(1200)

console.log(JSON.stringify(report, null, 1))
if (failures.length > 0) {
  console.log('宿主查询队列端到端测试失败 ❌')
  for (const item of failures) console.log(' - ' + item)
  process.exit(1)
}
console.log('宿主查询队列端到端测试通过 ✅ 真正的 applyPendingQueries 按 requestId 写回，describe 通路闭合')
process.exit(0)
