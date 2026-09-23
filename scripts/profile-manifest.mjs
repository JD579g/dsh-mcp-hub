#!/usr/bin/env node
/**
 * dsh-mcp-hub · profile 清单助手（跨平台，Windows 也走这一份）
 *
 * DSH 的插件通道是 `dsh plugin --profile <name> add <pkg>`（转发给 pnpm），
 * 它会自己把「声明了 dsh.bundle 的依赖」写进 `dsh.profile.bundles`。
 * 但 Windows 开发者机器上不一定有 pnpm / dsh 在 PATH 里，所以本插件自带
 * 一个**只用 node** 的等价实现：装完（或卸完）之后，改 profile 的 package.json。
 *
 * 为什么不放在 PowerShell 里改 JSON：Windows PowerShell 5.1 的 ConvertTo-Json
 * 会改键序、压掉嵌套深度，中文还可能被编码成 \uXXXX；交给 node 最稳。
 *
 * 用法：
 *   node scripts/profile-manifest.mjs --profile-dir <dir> --mode install   --spec <pnpm/npm spec>
 *   node scripts/profile-manifest.mjs --profile-dir <dir> --mode uninstall
 *   node scripts/profile-manifest.mjs --profile-dir <dir> --mode status
 *
 * 退出码：0 成功（含「本来就没装」），1 失败，2 参数错误。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const NAME = 'dsh-mcp-hub'

function parseArgs(argv) {
  const out = { profileDir: '', mode: 'install', spec: '', name: NAME, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(token + ' 需要一个值')
      index += 1
      return value
    }
    if (token === '--profile-dir') out.profileDir = next()
    else if (token === '--mode') out.mode = next()
    else if (token === '--spec') out.spec = next()
    else if (token === '--name') out.name = next()
    else if (token === '--json') out.json = true
    else if (token === '--help' || token === '-h') out.help = true
    else throw new Error('未知参数：' + token)
  }
  return out
}

const HELP = [
  '用法：node scripts/profile-manifest.mjs --profile-dir <dir> [选项]',
  '',
  '  --mode install|uninstall|status   默认 install',
  '  --spec <spec>                     install 时的依赖取值，例如 file:C:\\x\\dsh-mcp-hub-1.1.0.tgz',
  '  --name <pkg>                      包名，默认 dsh-mcp-hub',
  '  --json                            以 JSON 输出结果',
].join('\n')

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw new Error('读取 ' + file + ' 失败：' + (error && error.message ? error.message : String(error)))
  }
}

/** 装好的包是否声明了 dsh.bundle —— 只有它才会成为 profile 的一层。 */
async function declaresBundle(profileDir, name) {
  const manifest = path.join(profileDir, 'node_modules', name, 'package.json')
  try {
    const doc = JSON.parse(await fs.readFile(manifest, 'utf8'))
    return doc !== null && typeof doc === 'object' && doc.dsh !== null && typeof doc.dsh === 'object' && doc.dsh.bundle !== undefined
  } catch {
    return false
  }
}

async function present(profileDir, name) {
  try {
    await fs.access(path.join(profileDir, 'node_modules', name, 'package.json'))
    return true
  } catch {
    return false
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true) {
    process.stdout.write(HELP + '\n')
    return 0
  }
  if (args.profileDir === '') throw new Error('缺少 --profile-dir')
  const profileDir = path.resolve(args.profileDir)
  const manifestPath = path.join(profileDir, 'package.json')

  try {
    await fs.access(manifestPath)
  } catch {
    throw new Error('这个 profile 还没有 package.json：' + profileDir +
      '\n请先用 DSH 启动一次这个 profile（它会初始化模板），再运行安装器。')
  }

  const doc = await readJson(manifestPath, {})
  const before = {
    bundles: Array.isArray(doc.dsh?.profile?.bundles) ? [...doc.dsh.profile.bundles] : [],
    dependency: doc.dependencies?.[args.name],
  }
  const installed = await present(profileDir, args.name)
  const isBundle = installed ? await declaresBundle(profileDir, args.name) : false

  if (args.mode === 'status') {
    const result = {
      name: args.name,
      profileDir,
      manifest: manifestPath,
      installed,
      declaresBundle: isBundle,
      dependency: before.dependency === undefined ? null : before.dependency,
      inBundles: before.bundles.includes(args.name),
      bundles: before.bundles,
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return 0
  }

  doc.dsh = doc.dsh !== null && typeof doc.dsh === 'object' ? doc.dsh : {}
  doc.dsh.profile = doc.dsh.profile !== null && typeof doc.dsh.profile === 'object' ? doc.dsh.profile : {}
  const bundles = Array.isArray(doc.dsh.profile.bundles) ? [...doc.dsh.profile.bundles] : []
  doc.dependencies = doc.dependencies !== null && typeof doc.dependencies === 'object' ? doc.dependencies : {}

  let changed = false
  const notes = []

  if (args.mode === 'install') {
    // 不传 --spec 时按「从 npm registry 装」处理；安装器一般会显式传 file: 规格。
    const spec = args.spec !== '' ? args.spec : args.name
    if (doc.dependencies[args.name] !== spec) {
      doc.dependencies[args.name] = spec
      changed = true
    }
    if (isBundle) {
      if (!bundles.includes(args.name)) {
        bundles.push(args.name)
        changed = true
        notes.push('已加入 dsh.profile.bundles：' + args.name)
      }
    } else if (!installed) {
      notes.push('node_modules 里还没有 ' + args.name + '：请先安装依赖（安装器会自动做），本次只写了依赖声明')
    } else {
      notes.push(args.name + ' 没有声明 dsh.bundle，作为普通依赖安装，不会成为 profile 的一层')
    }
  } else if (args.mode === 'uninstall') {
    if (Object.hasOwn(doc.dependencies, args.name)) {
      delete doc.dependencies[args.name]
      changed = true
    }
    const at = bundles.indexOf(args.name)
    if (at >= 0) {
      bundles.splice(at, 1)
      changed = true
      notes.push('已从 dsh.profile.bundles 移除：' + args.name)
    }
  } else {
    throw new Error('未知 mode：' + args.mode + '（install / uninstall / status）')
  }

  doc.dsh.profile.bundles = bundles
  if (Object.keys(doc.dependencies).length === 0) delete doc.dependencies

  if (changed) {
    const text = JSON.stringify(doc, null, 2) + '\n'
    await fs.writeFile(manifestPath + '.tmp', text, 'utf8')
    await fs.rename(manifestPath + '.tmp', manifestPath)
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    mode: args.mode,
    name: args.name,
    profileDir,
    manifest: manifestPath,
    changed,
    installed,
    declaresBundle: isBundle,
    bundles,
    notes,
  }, null, 1) + '\n')
  return 0
}

main().then((code) => { process.exitCode = code }).catch((error) => {
  process.stderr.write('profile-manifest: ' + (error && error.message ? error.message : String(error)) + '\n')
  process.exitCode = 1
})
