/**
 * dsh-mcp-hub · 仓库卫生检查
 *
 * 这三条都是在真 CI（macOS/Windows runner）上被踩过之后补的，专门防「本地绿、CI 炸」：
 *
 *   1. 测试里不许出现硬编码的 POSIX 临时目录 /tmp。
 *      真实事故：tests/plugin-integration.mjs 里写了 { path: '/tmp/mcp-hub-e2e.txt' }。
 *      Linux 上 /tmp 恰好就是临时目录，所以一年都不会出问题；
 *      macOS 上临时目录是 /var/folders/...，Windows 上 '/tmp' 会解析成当前盘符下的 \\tmp，
 *      两者都在文件服务的允许根目录之外 —— CI 一上真机器立刻失败。
 *
 *   2. lib/ 下的每个文件都必须被 package.json 的 files 字段覆盖。
 *      漏一个，用户 npm 装完就是运行期 import 失败。
 *
 *   3. tests/ 下每个测试文件都必须被 npm test 串起来。
 *      否则它就是「写了但永远不跑」，等于没有。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SELF = path.basename(fileURLToPath(import.meta.url))

const results = []
function check(name, detail) {
  results.push({ name, ok: detail === null, detail: detail === null ? '' : detail })
}

async function walk(dir, prefix, out = []) {
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name)
    const key = prefix === '' ? item.name : prefix + '/' + item.name
    if (item.isDirectory()) await walk(full, key, out)
    else out.push(key)
  }
  return out
}

const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))

// ── 1) 不许硬编码 /tmp ────────────────────────────────────────────────────
{
  const offenders = []
  const files = (await fs.readdir(HERE)).filter((name) => name.endsWith('.mjs') && name !== SELF)
  for (const name of files) {
    const text = await fs.readFile(path.join(HERE, name), 'utf8')
    for (const line of text.split('\n')) {
      if (!line.includes("'/tmp/") && !line.includes('"/tmp/')) continue
      // platform.test.mjs 里把 '/tmp' 当参数喂给 defaultFsRoots 是合法的 POSIX 夹具
      if (line.includes("defaultFsRoots('linux'")) continue
      offenders.push(name + ' → ' + line.trim())
    }
  }
  check('测试里没有硬编码的 POSIX 临时目录（要用 os.tmpdir()）',
    offenders.length === 0 ? null : '发现：' + offenders.join(' | '))
}

// ── 2) package.json files 必须覆盖 lib/ 全部文件 ──────────────────────────
{
  const libFiles = await walk(path.join(ROOT, 'lib'), 'lib')
  const covered = manifest.files.some((entry) => entry === 'lib' || entry === 'lib/')
  const missing = covered ? [] : libFiles.filter((file) => !manifest.files.includes(file))
  check('package.json 的 files 覆盖 lib/ 下所有文件（否则用户装完运行期报错）',
    missing.length === 0 ? null : '漏了：' + missing.join(', '))
}

// ── 3) tests/ 下每个测试都要被 npm test 跑到 ──────────────────────────────
{
  const testScript = String(manifest.scripts && manifest.scripts.test ? manifest.scripts.test : '')
  const files = (await fs.readdir(HERE)).filter((name) => (name.endsWith('.mjs') || name.endsWith('.js')) && name !== 'helpers.mjs')
  const unwired = files.filter((name) => !testScript.includes('tests/' + name))
  check('tests/ 下每个测试都被 npm test 串起来了（写了但没人跑 = 没写）',
    unwired.length === 0 ? null : '未接入：' + unwired.join(', '))
}

const failures = results.filter((row) => row.ok !== true)
console.log(JSON.stringify({ total: results.length, failed: failures.length, failures }, null, 1))
if (failures.length === 0) {
  console.log('仓库卫生检查通过 ✅  ' + results.map((row) => row.name).join(' | '))
}
process.exitCode = failures.length === 0 ? 0 : 1
