/**
 * dsh-mcp-hub · 回归测试：hub 查询队列的信封 id
 *
 * 背景（本次修复的 bug）：
 *   hub 服务的 describe 工具把「要查的候选/服务名」放在 payload 的 id 字段里，
 *   而查询队列的请求信封 id 也叫 id，两者平铺展开时信封 id 被 payload 覆盖。
 *   宿主于是把结果写进 query-responses.json 的<目标名>键，而调用方一直在等
 *   自己那个随机 id —— 只能干满 60 秒再报「在线检索超时」。
 *
 * 这个测试用**真实 MCP 客户端**把 describe 发出去，再用宿主同款函数
 * queryEnvelopeId() 模拟宿主写回，断言：
 *   1) queryEnvelopeId 的取值优先级（requestId 优先，旧记录退回 id）；
 *   2) describe 能在超时前拿到结果（信封 id 真的能对上）；
 *   3) describe 的目标为空时立刻报错，不排队、不干等 60 秒。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSdk, sdkOrSkip, importLib, SERVER_ENTRY } from './helpers.mjs'

// SDK 与插件模块都从仓库自身位置解析，不写死安装路径。
await sdkOrSkip('hub 查询队列回归测试')
const { Client, StdioClientTransport } = await loadSdk()
const { queryEnvelopeId } = await importLib('host', 'state.js')
const ENTRY = SERVER_ENTRY
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-hub-query-'))
const queryFile = path.join(dir, 'queries.jsonl')
const responseFile = path.join(dir, 'query-responses.json')
const failures = []
const check = (ok, label) => { if (!ok) failures.push(label) }

// ── 1) 信封 id 解析：requestId 优先，旧记录退回 id ────────────────────────
check(queryEnvelopeId({ requestId: 'env-1', id: 'files' }) === 'env-1', 'requestId 必须优先于 payload id')
check(queryEnvelopeId({ id: 'legacy' }) === 'legacy', '旧记录（只有 id）仍要能解析')
check(queryEnvelopeId(null) === '' && queryEnvelopeId({}) === '', '空记录解析为空串')
check(queryEnvelopeId({ requestId: 'env-2', kind: 'describe', id: 'files' }) === 'env-2', 'describe 记录信封 id 不被 payload 覆盖')

// ── 2) 真实 MCP 握手 + 模拟宿主 ──────────────────────────────────────────
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [ENTRY, 'hub'],
  env: { ...process.env, MCP_HUB_QUERY: queryFile, MCP_HUB_QUERY_RESPONSE: responseFile },
  stderr: 'pipe',
})
const client = new Client({ name: 'dsh-mcp-hub-query-test', version: '1.0.0' })

/** 宿主同款逻辑：按 queryEnvelopeId 把结果写回。 */
let seenEnvelope = null
let seenPayloadId = null
const responses = {}
async function pumpHost() {
  let text = ''
  try { text = await fs.readFile(queryFile, 'utf8') } catch { return }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let record
    try { record = JSON.parse(trimmed) } catch { continue }
    const id = queryEnvelopeId(record)
    if (id === '' || responses[id] !== undefined) continue
    seenEnvelope = id
    seenPayloadId = record.id
    responses[id] = { ok: true, at: new Date().toISOString(), value: { found: true, echo: { envelope: id, payloadId: record.id } } }
    await fs.writeFile(responseFile, JSON.stringify({ responses }), 'utf8')
  }
}
const timer = setInterval(() => { void pumpHost() }, 100)

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ __timeout: label }), ms)),
  ])
}

const report = {}
try {
  await client.connect(transport)
  const listed = await client.listTools()
  report.tools = listed.tools.length

  const started = Date.now()
  const result = await withTimeout(client.callTool({ name: 'describe', arguments: { id: 'files' } }), 8000, 'describe')
  const elapsed = Date.now() - started
  report.describeMs = elapsed
  const text = (result.content || []).map((item) => (item.type === 'text' ? item.text : '')).join('\n')
  report.describeText = text.slice(0, 220)
  check(result.__timeout === undefined, 'describe 必须在 8 秒内返回（修复前要干等 60 秒）')
  check(elapsed < 8000, 'describe 耗时必须小于 8 秒')
  check(seenEnvelope !== null && seenEnvelope !== seenPayloadId, '队列记录里的信封 id 必须与 payload id 分开')
  check(text.includes('"payloadId": "files"'), '宿主应收到 payload id = files')
  check(text.includes('"envelope": "' + String(seenEnvelope) + '"'), '返回结果里的信封 id 必须就是宿主用来写回的那个')

  // ── 3) 空目标：立刻失败，不排队 ───────────────────────────────────────
  const emptyStarted = Date.now()
  let emptyError = null
  try {
    const empty = await withTimeout(client.callTool({ name: 'describe', arguments: {} }), 5000, 'empty')
    if (empty.__timeout !== undefined) emptyError = 'timeout'
    else emptyError = 'returned:' + JSON.stringify(empty).slice(0, 120)
  } catch (error) {
    emptyError = String(error && error.message ? error.message : error)
  }
  report.emptyIdMs = Date.now() - emptyStarted
  report.emptyIdError = String(emptyError).slice(0, 160)
  check(report.emptyIdMs < 5000, '空目标必须立刻报错（不能排进队列等 60 秒）')
  check(String(emptyError).includes('describe 需要 id'), '空目标应给出可读的「describe 需要 id」')
} catch (error) {
  failures.push('握手/调用异常：' + String(error && error.message ? error.message : error))
} finally {
  clearInterval(timer)
  try { await client.close() } catch { /* 忽略 */ }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log(JSON.stringify(report, null, 1))
if (failures.length > 0) {
  console.log('hub 查询队列回归测试失败 ❌')
  for (const item of failures) console.log(' - ' + item)
  process.exit(1)
}
console.log('hub 查询队列回归测试通过 ✅ 信封 id 与 payload id 不再撞名；describe 秒回；空目标立刻报错')
process.exit(0)
