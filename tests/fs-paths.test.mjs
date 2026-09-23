/**
 * dsh-mcp-hub · 文件沙箱路径解析
 *
 * 这三条都是"本地绿、真 macOS/Windows runner 炸"之后补的回归：
 *
 *   1) 符号链接：macOS 上 /var 是指向 /private/var 的符号链接，os.tmpdir() 给的是
 *      /var/folders/...，而 fs.realpath() 会把目标解析成 /private/var/folders/...。
 *      只对目标做 realpath、不对允许根目录做，就会假报"解析后越界"。
 *      这里用一个自造的 link → real 目录复现同一形状。
 *   2) 临时目录必须可写：POSIX 的写禁用清单里有 /var，而 macOS 的临时目录就在 /var 下。
 *   3) 允许根目录之外的路径必须被拒（沙箱不能因为修上面两条而形同虚设）。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { importLib } from './helpers.mjs'

const results = []
function record(name, ok, detail) {
  results.push({ name, ok: ok === true, detail: detail === undefined ? '' : String(detail) })
}
function equal(actual, expected, label) {
  record(label, actual === expected, 'expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual))
}
async function rejects(promise, needle, label) {
  try {
    await promise
    record(label, false, '本该被拒却通过了')
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    record(label, needle === null || message.includes(needle), message)
  }
}

const { resolveSandboxPath } = await importLib('servers', 'fs.js')
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-hub-fspaths-'))
const realDir = path.join(base, 'real')
const linkDir = path.join(base, 'link')
await fs.mkdir(realDir, { recursive: true })
let linked = false
try {
  await fs.symlink(realDir, linkDir, 'dir')
  linked = true
} catch {
  linked = false
}

// ── 1) 符号链接根目录 ─────────────────────────────────────────────────────
if (linked) {
  process.env.MCP_FS_ROOTS = linkDir
  const target = path.join(linkDir, 'through-link.txt')
  try {
    const resolved = await resolveSandboxPath(target, { write: true })
    record('符号链接根目录：写 link/ 下的文件不被误判越界', true)
    equal(
      resolved.startsWith(await fs.realpath(realDir)),
      true,
      '符号链接根目录：返回的应是解析后的真实路径',
    )
  } catch (error) {
    record('符号链接根目录：写 link/ 下的文件不被误判越界', false, error.message)
  }
} else {
  record('符号链接根目录：跳过（本机/本账户不支持建符号链接）', true, 'skipped')
}

// ── 2) 临时目录可写 ───────────────────────────────────────────────────────
delete process.env.MCP_FS_ROOTS
const inTemp = path.join(os.tmpdir(), 'mcp-hub-fspaths-temp.txt')
try {
  await resolveSandboxPath(inTemp, { write: true })
  record('临时目录：os.tmpdir() 下可写（POSIX 的 /var 只读清单不能连累它）', true)
} catch (error) {
  record('临时目录：os.tmpdir() 下可写（POSIX 的 /var 只读清单不能连累它）', false, error.message)
}

// ── 3) 越界与只读必须仍然拦住 ─────────────────────────────────────────────
process.env.MCP_FS_ROOTS = base
await rejects(
  resolveSandboxPath(path.join(os.tmpdir(), 'outside-roots.txt'), { write: true }),
  '越界',
  '允许根目录之外必须被拒（沙箱没有因为上面的修复而失效）',
)
delete process.env.MCP_FS_ROOTS
if (process.platform !== 'win32') {
  await rejects(
    resolveSandboxPath('/usr/local/bin/definitely-not-allowed', { write: true }),
    '只读',
    'POSIX 系统目录仍然只读',
  )
}

await fs.rm(base, { recursive: true, force: true })

const failures = results.filter((row) => row.ok !== true)
console.log(JSON.stringify({ total: results.length, failed: failures.length, failures }, null, 1))
if (failures.length === 0) {
  console.log('文件沙箱路径测试通过 ✅  ' + results.map((row) => row.name).join(' | '))
}
process.exitCode = failures.length === 0 ? 0 : 1
