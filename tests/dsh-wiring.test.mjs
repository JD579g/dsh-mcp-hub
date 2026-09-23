/**
 * dsh-mcp-hub · 真实 DSH 装配测试
 *
 * 用**真实** cordis + 真实 dsh-tools + 真实 dsh-system-prompt 装配。
 * 关键顺序：**先挂本插件，后挂 tools** —— 复现加载器并行启动时 apply 拿不到
 * tools 服务的真实场景（这正是重启后暴露过的降级 bug）。
 *
 * 本测试回答的那个高优先级问题是：**模型到底看不看得见 MCP 工具**。
 * 判据必须走生产同一条路 —— ctx.systemPrompt.tools() 回调里的
 * wireSchemas(context.scope) —— 而不是自己扫对象。所以这里：
 *   1) 读 wireSchemas(undefined).schemas（全局视图），
 *   2) 用 @deepseek-ai/dsh-scope 的 createScope 造一个**模拟 agent 作用域**，
 *      再读 wireSchemas(agentScope)（生产里模型看到的就是这一份），
 *   3) 两边都必须完整包含每个 mcp__ / mcp_hub 工具，且 schema 合法。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { importDshPackage, importLib } from './helpers.mjs'

// 真装配需要宿主自己的包（cordis / dsh-tools / dsh-system-prompt / dsh-scope）。
// 它们只存在于装了 DSH 的机器上：找不到就**明确跳过**，而不是假失败 ——
// 这样 clone 到任意机器（含 GitHub Actions）都能安全地跑这个测试。
const [cordis, toolsModule, promptModule, scopeModule] = await Promise.all([
  importDshPackage('@deepseek-ai/cordis'),
  importDshPackage('@deepseek-ai/dsh-tools'),
  importDshPackage('@deepseek-ai/dsh-system-prompt'),
  importDshPackage('@deepseek-ai/dsh-scope'),
])
const missing = [
  cordis === null ? '@deepseek-ai/cordis' : null,
  toolsModule === null ? '@deepseek-ai/dsh-tools' : null,
  promptModule === null ? '@deepseek-ai/dsh-system-prompt' : null,
  scopeModule === null ? '@deepseek-ai/dsh-scope' : null,
].filter((item) => item !== null)

if (missing.length > 0) {
  console.log(JSON.stringify({
    skipped: true,
    reason: '本机没有可解析的 DSH 宿主包',
    missing,
    hint: '装一个 DSH，或在 DSH_HOME 指向的 profile 里装上这些依赖，再跑本测试。',
  }, null, 1))
  console.log('真实装配测试跳过（没有 DSH 宿主包）⏭')
  process.exit(0)
}

const { Context } = cordis
const ToolRuntime = toolsModule.default
const SystemPrompt = promptModule.default
const { createScope, scopeOf } = scopeModule
const { apply: applyHub } = await importLib('index.js')

const DATA_DIR = path.join(os.tmpdir(), 'mcp-hub-wiring')
await fs.rm(DATA_DIR, { recursive: true, force: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ctx = new Context()
const registeredCommands = []
const registeredRoutes = []
const routeHandlers = []

// ── 消费者先上：本插件（此时 tools 还不存在）──────────────────────────────
const hubFiber = ctx.plugin({
  name: 'dsh-mcp-hub-test',
  apply(pluginCtx) {
    applyHub(pluginCtx, {
      dataDir: DATA_DIR,
      reconcileIntervalMs: 1000,
      bootstrapServers: ['hub', 'files', 'util'],
    })
  },
})
await sleep(60)

// ── 提供者后上：真实 system-prompt + 真实 tools，然后 commands / webServer ──
ctx.plugin(SystemPrompt)
await sleep(30)
ctx.plugin(ToolRuntime)
ctx.plugin({
  name: 'fake-commands',
  apply(commandsCtx) {
    commandsCtx.provide('commands', {
      register(definition) {
        registeredCommands.push(definition.name)
        return () => {}
      },
    })
  },
})
ctx.plugin({
  name: 'fake-webserver',
  apply(webCtx) {
    webCtx.provide('webServer', {
      register(route) {
        registeredRoutes.push(route.path)
        routeHandlers.push(route)
        return () => {}
      },
    })
  },
})

// ── 等全部内置服务连上（hub/files/util），工具名进入视图 ──────────────────
const EXPECT = ['mcp_hub', 'mcp__hub__status', 'mcp__files__read', 'mcp__util__calc']
const tools = () => ctx.get('tools')
let ready = false
for (let attempt = 0; attempt < 80 && !ready; attempt += 1) {
  await sleep(500)
  const service = tools()
  if (service === undefined) continue
  if (registeredCommands.length === 0) continue
  if (registeredRoutes.length === 0) continue
  const names = new Set([...service.view(undefined).visible.keys()])
  if (!EXPECT.every((name) => names.has(name))) continue
  ready = true
}

// ── 判据一：生产同款读取方式（wireSchemas）────────────────────────────────
function schemaNames(scope) {
  const result = tools().wireSchemas(scope)
  if (result === null || typeof result !== 'object' || !Array.isArray(result.schemas)) {
    throw new Error('wireSchemas 返回形状不是 { schemas, knownNames }')
  }
  return result
}

const report = {
  toolsServiceMounted: tools() !== undefined,
  registeredCommands: registeredCommands,
  registeredRoutes: registeredRoutes,
  ready: ready,
}

const globalWire = schemaNames(undefined)
const globalNames = globalWire.schemas.map((schema) => schema.name)
report.wireShapeOk = true
report.globalSchemaCount = globalNames.length
report.globalMcpTools = globalNames.filter((name) => name.indexOf('mcp') === 0).sort()

// ── 判据二：模拟 agent 作用域（模型实际看到的视图）─────────────────────────
const agent = createScope(ctx, Symbol('test-agent'))
try {
  const agentScope = scopeOf(agent.ctx)
  report.agentScopeResolved = agentScope !== undefined
  const agentWire = schemaNames(agentScope)
  const agentNames = agentWire.schemas.map((schema) => schema.name)
  report.agentSchemaCount = agentNames.length
  report.agentMcpTools = agentNames.filter((name) => name.indexOf('mcp') === 0).sort()
  report.agentKnownNames = agentWire.knownNames.filter((name) => name.indexOf('mcp') === 0).length

  // 全局视图里每一个 mcp 工具，模型侧都要看得到。
  report.missingInAgent = report.globalMcpTools.filter((name) => agentNames.indexOf(name) < 0)
  // schema 必须能被模型 API 接受：有 name、有对象型 input schema。
  const bad = agentWire.schemas.filter((schema) =>
    schema === null || typeof schema !== 'object' || typeof schema.name !== 'string' || schema.name === '' ||
    schema.parameters === null || typeof schema.parameters !== 'object')
  report.badSchemas = bad.length
  report.agentHasMcpHub = agentNames.indexOf('mcp_hub') >= 0
  report.agentHasMcpFiles = agentNames.some((name) => name.indexOf('mcp__files__') === 0)
  report.agentHasMcpUtil = agentNames.some((name) => name.indexOf('mcp__util__') === 0)
} finally {
  await agent.dispose()
}

// ── 真实 schema 编译：模型每次请求都会走这条路，炸了就全炸 ────────────────
try {
  schemaNames(undefined)
  report.schemaOk = true
} catch (error) {
  report.schemaOk = false
  report.schemaError = String(error && error.message ? error.message : error).slice(0, 400)
}

// ── 直接调用已注册的 HTTP 路由 ───────────────────────────────────────────
async function callRoute(path) {
  const route = routeHandlers.find((item) => item.path === '/mcp-hub/api')
  if (route === undefined) return null
  const request = { method: 'GET', url: path, async *[Symbol.asyncIterator]() {} }
  let captured = null
  const response = {
    writeHead() {},
    end(text) {
      try { captured = JSON.parse(text) } catch { captured = null }
    },
  }
  await route.handler(request, response)
  return captured
}

const overview = await callRoute('/mcp-hub/api/overview')
report.api = overview === null ? null : {
  ok: overview.ok,
  installed: overview.installed.length,
  platform: overview.platform.label,
  mobileDsha: overview.platform.mobileDsha,
  runners: overview.runners.map((row) => row.id + (row.available ? '+' : '-')),
  nativeTools: overview.nativeTools.length,
}
const doctor = await callRoute('/mcp-hub/api/doctor')
report.doctor = doctor === null ? null : { summary: doctor.summary, errors: doctor.counts.errors, warns: doctor.counts.warns }

console.log(JSON.stringify(report, null, 1))

const pass = report.toolsServiceMounted === true &&
  report.registeredCommands.indexOf('mcp') >= 0 &&
  report.registeredRoutes.indexOf('/mcp-hub/api') >= 0 &&
  report.schemaOk === true &&
  report.ready === true &&
  // 全局装配：mcp_hub 与每个内置服务的工具都在
  EXPECT.every((name) => report.globalMcpTools.indexOf(name) >= 0) &&
  // 模型侧（agent scope）看得见，且一个都不少
  report.agentScopeResolved === true &&
  report.agentHasMcpHub === true &&
  report.agentHasMcpFiles === true &&
  report.agentHasMcpUtil === true &&
  report.missingInAgent.length === 0 &&
  report.badSchemas === 0 &&
  report.api !== null && report.api.ok === true

console.log(pass
  ? '真实装配测试通过 ✅ 服务晚就绪也能启动；工具/命令/路由都注册成功；schema 编译通过；' +
    '模型侧（agent scope）可见 ' + report.agentMcpTools.length + ' 个 MCP 工具且无缺失'
  : '真实装配测试失败 ❌')

// 收尾：必须显式卸载插件。它会 stopAll() 掉自己拉起的 MCP stdio 子进程；
// 不卸载的话这些子进程会让 node 的事件循环一直活着 —— 断言早就通过了，
// 进程却永远不退出（以前只能靠外层 timeout 杀掉，退出码也就没法用）。
try { await hubFiber.dispose() } catch { /* 卸载失败不掩盖测试结论 */ }
// 插件卸载时是 fire-and-forget 地关 MCP 子进程，这里留一点时间让它收干净，
// 免得测试进程退出后留下孤儿 MCP 服务。
await sleep(1500)
process.exit(pass ? 0 : 1)
