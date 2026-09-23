/**
 * dsh-mcp-hub · 内置 MCP 服务：files
 *
 * 在**受限根目录**内读写文件。根目录与路径策略按平台决定：
 *   桌面（Windows 优先）：家目录 + %TEMP%；系统目录（%SystemRoot%、Program Files、
 *     ProgramData）只读；\\?\ 与 \\.\ 这类设备命名空间一律拒绝。
 *   Linux/macOS：家目录 + 临时目录；/proc、/sys、/dev 一律拒绝；/usr、/etc、/var、/boot、/run 只读。
 * 所有路径先 realpath 再校验，指向根外的符号链接同样被拒。
 *
 * 环境变量：
 *   MCP_FS_ROOTS    允许的根目录，用系统路径分隔符分隔（Windows ";"，POSIX ":"）
 *   MCP_FS_MAX_READ 单次读取上限字节数（默认 2 MiB）
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { str, num, bool } from './util.js'
import { defaultFsRoots, pathPolicy, isTempPath, underPrefix } from '../platform.js'

function roots() {
  const raw = process.env.MCP_FS_ROOTS
  if (raw === undefined || raw.trim() === '') return defaultFsRoots()
  const list = raw
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => path.resolve(item))
  return list.length > 0 ? list : defaultFsRoots()
}

function maxRead() {
  const value = Number(process.env.MCP_FS_MAX_READ || 2097152)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 2097152
}

function inside(candidate, root) {
  return underPrefix(candidate, root)
}

/**
 * 把允许根目录也做一次 realpath（并缓存）。
 *
 * 为什么必须做：macOS 上 /var 是指向 /private/var 的符号链接，os.tmpdir() 返回
 * /var/folders/...，而 fs.realpath() 会把目标解析成 /private/var/folders/...。
 * 只对目标做 realpath、不对根目录做，就会得出"解析后越界"的假阳性 ——
 * 在真 macOS runner 上就是这么炸的。
 */
const realRootCache = new Map()

async function realRoots(allowed) {
  const key = allowed.join('\u0000')
  const cached = realRootCache.get(key)
  if (cached !== undefined) return cached
  const out = []
  for (const root of allowed) {
    let value = root
    try {
      value = await fs.realpath(root)
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
      // 根目录还不存在（例如全新环境）：退化成"最近存在的祖先 + 剩余路径"
      let probe = root
      for (;;) {
        const parent = path.dirname(probe)
        if (parent === probe) break
        probe = parent
        try {
          const ancestor = await fs.realpath(probe)
          value = path.join(ancestor, path.relative(probe, root))
          break
        } catch (inner) {
          if (!inner || inner.code !== 'ENOENT') throw inner
        }
      }
    }
    if (!out.includes(value)) out.push(value)
  }
  realRootCache.set(key, out)
  return out
}

function policy() {
  return pathPolicy(process.platform, process.env)
}

/** 解析并校验路径，越界即抛错。options.write=true 时额外拒绝只读系统目录。 */
export async function resolveSandboxPath(input, options = {}) {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('path 必须是非空字符串')
  const absolute = path.resolve(input)
  const rules = policy()
  const hard = rules.hardBlocked.find((prefix) => underPrefix(absolute, prefix))
  if (hard !== undefined) throw new Error('路径被策略禁止（设备命名空间/伪文件系统）：' + absolute)
  // 临时目录永远可写：POSIX 的写禁用清单里有 /var，而 macOS 的用户临时目录
  // 恰好是 /var/folders/...，不开口子的话 macOS 上连自己的临时目录都写不了。
  const inTemp = isTempPath(absolute)
  const readOnly = inTemp ? undefined : rules.writeBlocked.find((prefix) => underPrefix(absolute, prefix))
  if (readOnly !== undefined && options.write === true) throw new Error('该目录只读（系统目录）：' + absolute)
  const allowed = roots()
  if (!allowed.some((root) => inside(absolute, root))) {
    throw new Error('路径越界：' + absolute + ' 不在允许根目录 ' + allowed.join('、') + ' 之内')
  }
  let resolved = absolute
  try {
    resolved = await fs.realpath(absolute)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      let probe = path.dirname(absolute)
      for (;;) {
        try {
          const ancestor = await fs.realpath(probe)
          resolved = path.join(ancestor, path.relative(probe, absolute))
          break
        } catch (inner) {
          if (!inner || inner.code !== 'ENOENT') throw inner
          const parent = path.dirname(probe)
          if (parent === probe) break
          probe = parent
        }
      }
    } else {
      throw error
    }
  }
  // 两边都 realpath 之后再比：否则符号链接（macOS 的 /var → /private/var）会造成假阳性。
  const resolvedRoots = await realRoots(allowed)
  if (!resolvedRoots.some((root) => inside(resolved, root))) {
    throw new Error('路径越界（解析后）：' + resolved + ' 不在允许根目录 ' + resolvedRoots.join('、') + ' 之内')
  }
  if (options.mustExist === true) await fs.stat(resolved)
  return resolved
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KiB'
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MiB'
  return (bytes / 1073741824).toFixed(2) + ' GiB'
}

function countLines(text) {
  if (text === '') return 0
  let lines = 1
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lines += 1
  return lines
}

function numbered(text, offset) {
  return text.split('\n').map((line, index) => String(offset + index) + '\t' + line).join('\n')
}

const S_IFMT = 0o170000

function kindOf(stat) {
  if (stat.isDirectory()) return 'directory'
  if (stat.isSymbolicLink()) return 'symlink'
  if (stat.isFile()) return 'file'
  if ((stat.mode & S_IFMT) === 0o060000) return 'block-device'
  if ((stat.mode & S_IFMT) === 0o020000) return 'char-device'
  if (stat.isFIFO()) return 'fifo'
  if (stat.isSocket()) return 'socket'
  return 'other'
}

async function statOne(target) {
  const stat = await fs.lstat(target)
  const item = {
    path: target,
    kind: kindOf(stat),
    size: stat.size,
    sizeText: formatSize(stat.size),
    mode: '0o' + (stat.mode & 0o7777).toString(8),
    mtime: new Date(stat.mtimeMs).toISOString(),
  }
  if (stat.isSymbolicLink()) {
    try { item.target = await fs.readlink(target) } catch { /* 读链接失败就省略 */ }
  }
  return item
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.java', '.kt', '.go', '.rs', '.rb', '.php', '.pl', '.lua', '.swift',
  '.html', '.htm', '.css', '.scss', '.less', '.xml', '.svg', '.sql', '.graphql', '.proto', '.env', '.log',
  '.csv', '.tsv', '.properties', '.gradle', '.gitignore', '.editorconfig',
])

function looksTextual(target, buffer) {
  if (TEXT_EXTENSIONS.has(path.extname(target).toLowerCase())) return true
  for (let index = 0; index < buffer.length; index += 1) if (buffer[index] === 0) return false
  return true
}

export const filesServer = {
  name: 'files',
  version: '1.0.0',
  title: '文件系统',
  instructions: '受限根目录内的文件读写与检索。所有路径都会做 realpath 越界校验；默认只允许 /root 与 /tmp。',
  tools: [
    {
      name: 'read',
      description: '读取文本文件（带行号，默认最多 2000 行）。支持 offset/limit 分段读取大文件。',
      inputSchema: {
        type: 'object',
        properties: {
          path: str('文件路径（必须位于允许根目录内）'),
          offset: num('起始行号，从 1 开始，默认 1'),
          limit: num('最多返回行数，默认 2000'),
        },
        required: ['path'],
      },
      async handler(args) {
        const target = await resolveSandboxPath(args.path, { mustExist: true })
        const stat = await fs.stat(target)
        if (stat.isDirectory()) throw new Error('目标是目录，请用 list 或 find')
        if (stat.size > maxRead()) throw new Error('文件超过读取上限 ' + formatSize(maxRead()) + '：' + formatSize(stat.size))
        const buffer = await fs.readFile(target)
        if (buffer.includes(0)) throw new Error('看起来是二进制文件（含 NUL 字节），已拒绝按文本读取')
        const text = buffer.toString('utf8')
        const totalLines = countLines(text)
        const offset = Math.max(1, Math.floor(Number(args.offset || 1)) || 1)
        const limit = Math.max(1, Math.min(20000, Math.floor(Number(args.limit || 2000)) || 2000))
        const slice = text.split('\n').slice(offset - 1, offset - 1 + limit).join('\n')
        return {
          path: target,
          totalLines,
          offset,
          returned: Math.min(limit, Math.max(0, totalLines - offset + 1)),
          truncated: offset - 1 + limit < totalLines,
          content: numbered(slice, offset),
        }
      },
    },
    {
      name: 'write',
      description: '写入（覆盖或追加）文本文件，自动创建父目录。返回写入字节数与行数。',
      inputSchema: {
        type: 'object',
        properties: {
          path: str('目标文件路径'),
          content: str('要写入的文本内容'),
          append: bool('true = 追加到文件末尾，默认 false（覆盖）'),
        },
        required: ['path', 'content'],
      },
      async handler(args) {
        if (typeof args.content !== 'string') throw new Error('content 必须是字符串')
        const target = await resolveSandboxPath(args.path, { write: true })
        await fs.mkdir(path.dirname(target), { recursive: true })
        if (args.append === true) await fs.appendFile(target, args.content, 'utf8')
        else await fs.writeFile(target, args.content, 'utf8')
        const stat = await fs.stat(target)
        return {
          path: target,
          bytes: Buffer.byteLength(args.content, 'utf8'),
          lines: countLines(args.content),
          size: stat.size,
          sizeText: formatSize(stat.size),
          appended: args.append === true,
        }
      },
    },
    {
      name: 'edit',
      description: '在文件中做精确文本替换。oldText 必须唯一命中（除非 replaceAll=true），用于安全的局部修改。',
      inputSchema: {
        type: 'object',
        properties: {
          path: str('文件路径'),
          oldText: str('要被替换的原文（必须精确匹配）'),
          newText: str('替换后的文本；空串表示删除'),
          replaceAll: bool('true = 替换全部命中，默认 false（要求唯一命中）'),
        },
        required: ['path', 'oldText', 'newText'],
      },
      async handler(args) {
        const target = await resolveSandboxPath(args.path, { mustExist: true, write: true })
        const text = await fs.readFile(target, 'utf8')
        const needle = String(args.oldText === undefined ? '' : args.oldText)
        if (needle === '') throw new Error('oldText 不能为空')
        const parts = text.split(needle)
        const hits = parts.length - 1
        if (hits === 0) throw new Error('未找到 oldText（大小写与缩进必须完全一致）')
        if (hits > 1 && args.replaceAll !== true) throw new Error('oldText 命中 ' + hits + ' 处，不唯一；请给出更长的上下文或设置 replaceAll=true')
        const replacement = String(args.newText === undefined ? '' : args.newText)
        const next = args.replaceAll === true ? parts.join(replacement) : text.replace(needle, replacement)
        await fs.writeFile(target, next, 'utf8')
        return {
          path: target,
          replacements: args.replaceAll === true ? hits : 1,
          bytesBefore: Buffer.byteLength(text, 'utf8'),
          bytesAfter: Buffer.byteLength(next, 'utf8'),
        }
      },
    },
    {
      name: 'list',
      description: '列出目录内容（名称、类型、大小、修改时间），默认不递归、最多 500 项。',
      inputSchema: {
        type: 'object',
        properties: {
          path: str('目录路径，默认家目录'),
          recursive: bool('true = 递归列出后代，默认 false'),
          maxDepth: num('递归深度上限，默认 3'),
          limit: num('最多返回条目数，默认 500'),
        },
      },
      async handler(args) {
        const target = await resolveSandboxPath(args.path || os.homedir(), { mustExist: true })
        const limit = Math.max(1, Math.min(5000, Math.floor(Number(args.limit || 500)) || 500))
        const maxDepth = Math.max(1, Math.min(12, Math.floor(Number(args.maxDepth || 3)) || 3))
        const items = []
        const walk = async (dir, depth) => {
          if (items.length >= limit) return
          const entries = await fs.readdir(dir, { withFileTypes: true })
          entries.sort((left, right) => (right.isDirectory() ? 1 : 0) - (left.isDirectory() ? 1 : 0) || left.name.localeCompare(right.name))
          for (const entry of entries) {
            if (items.length >= limit) return
            const child = path.join(dir, entry.name)
            try {
              items.push(await statOne(child))
              if (args.recursive === true && entry.isDirectory() && depth < maxDepth) await walk(child, depth + 1)
            } catch (error) {
              items.push({ path: child, kind: 'error', error: String(error && error.message ? error.message : error) })
            }
          }
        }
        await walk(target, 1)
        return { path: target, count: items.length, truncated: items.length >= limit, entries: items }
      },
    },
    {
      name: 'stat',
      description: '查看文件或目录的元信息（类型、大小、权限、修改时间、符号链接目标）。',
      inputSchema: {
        type: 'object',
        properties: { path: str('文件或目录路径') },
        required: ['path'],
      },
      async handler(args) {
        return statOne(await resolveSandboxPath(args.path, { mustExist: true }))
      },
    },
    {
      name: 'search',
      description: '在目录树中按正则或纯文本检索文件内容，返回「路径 / 行号 / 行内容」，并限制命中数与扫描文件数。',
      inputSchema: {
        type: 'object',
        properties: {
          path: str('检索起点目录，默认家目录'),
          pattern: str('正则表达式；literal=true 时按纯文本包含匹配'),
          literal: bool('true = 把 pattern 当纯文本，默认 false'),
          maxResults: num('最多命中行数，默认 100，上限 1000'),
          maxFiles: num('最多扫描文件数，默认 2000'),
          caseSensitive: bool('true = 区分大小写，默认 false'),
        },
        required: ['pattern'],
      },
      async handler(args) {
        const root = await resolveSandboxPath(args.path || os.homedir(), { mustExist: true })
        const rawPattern = String(args.pattern === undefined ? '' : args.pattern)
        if (rawPattern === '') throw new Error('pattern 不能为空')
        const maxResults = Math.max(1, Math.min(1000, Math.floor(Number(args.maxResults || 100)) || 100))
        const maxFiles = Math.max(1, Math.min(20000, Math.floor(Number(args.maxFiles || 2000)) || 2000))
        let test
        if (args.literal === true) {
          const needle = args.caseSensitive === true ? rawPattern : rawPattern.toLowerCase()
          test = (line) => (args.caseSensitive === true ? line.includes(needle) : line.toLowerCase().includes(needle))
        } else {
          const flags = args.caseSensitive === true ? 'g' : 'gi'
          test = (line) => new RegExp(rawPattern, flags).test(line)
        }
        const matches = []
        let scanned = 0
        let truncated = false
        const stack = [root]
        while (stack.length > 0 && matches.length < maxResults && scanned < maxFiles) {
          const dir = stack.pop()
          let entries
          try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
          for (const entry of entries) {
            if (matches.length >= maxResults || scanned >= maxFiles) { truncated = true; break }
            const child = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              if (['node_modules', '.git', '__pycache__', '.cache'].includes(entry.name)) continue
              stack.push(child)
              continue
            }
            if (!entry.isFile()) continue
            let stat
            try { stat = await fs.stat(child) } catch { continue }
            if (stat.size > maxRead()) continue
            let buffer
            try { buffer = await fs.readFile(child) } catch { continue }
            if (!looksTextual(child, buffer)) continue
            scanned += 1
            const lines = buffer.toString('utf8').split('\n')
            for (let index = 0; index < lines.length; index += 1) {
              if (test(lines[index])) {
                matches.push({ path: child, line: index + 1, text: lines[index].slice(0, 400) })
                if (matches.length >= maxResults) { truncated = true; break }
              }
            }
          }
        }
        return { root, pattern: rawPattern, scannedFiles: scanned, count: matches.length, truncated, matches }
      },
    },
    {
      name: 'find',
      description: '按文件名 glob（支持 * 与 ?）在目录树中查找文件，返回路径与元信息。',
      inputSchema: {
        type: 'object',
        properties: {
          path: str('检索起点目录，默认家目录'),
          pattern: str('文件名匹配式，例如 *.md、config*.json；默认 *'),
          maxResults: num('最多返回条数，默认 200'),
          maxDepth: num('递归深度上限，默认 8'),
        },
      },
      async handler(args) {
        const root = await resolveSandboxPath(args.path || os.homedir(), { mustExist: true })
        const rawPattern = String(args.pattern === undefined ? '*' : args.pattern)
        const escaped = rawPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
        const regex = new RegExp('^' + escaped + '$', 'i')
        const maxResults = Math.max(1, Math.min(2000, Math.floor(Number(args.maxResults || 200)) || 200))
        const maxDepth = Math.max(1, Math.min(20, Math.floor(Number(args.maxDepth || 8)) || 8))
        const found = []
        const walk = async (dir, depth) => {
          if (found.length >= maxResults || depth > maxDepth) return
          let entries
          try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
          for (const entry of entries) {
            if (found.length >= maxResults) return
            if (['node_modules', '.git', '__pycache__', '.cache'].includes(entry.name)) continue
            const child = path.join(dir, entry.name)
            if (entry.isDirectory()) { await walk(child, depth + 1); continue }
            if (regex.test(entry.name)) {
              try { found.push(await statOne(child)) } catch { /* 单个条目失败就跳过 */ }
            }
          }
        }
        await walk(root, 1)
        return { root, pattern: rawPattern, count: found.length, truncated: found.length >= maxResults, files: found }
      },
    },
    {
      name: 'mutate',
      description: '移动/复制/删除文件与目录。删除属破坏性操作，必须显式传 destructive: true。',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['move', 'copy', 'delete'], description: '操作类型' },
          from: str('源路径'),
          to: str('目标路径（delete 时忽略）'),
          recursive: bool('删除目录时是否递归，默认 false'),
          destructive: bool('破坏性操作确认，必须显式传 true'),
        },
        required: ['action', 'from'],
      },
      async handler(args) {
        if (args.destructive !== true) throw new Error('破坏性操作需要显式 destructive: true 确认')
        const source = await resolveSandboxPath(args.from, { mustExist: true, write: true })
        const allowed = roots()
        if (allowed.includes(source)) throw new Error('拒绝操作根目录本身：' + source)
        const action = String(args.action)
        if (action === 'delete') {
          const stat = await fs.lstat(source)
          if (stat.isDirectory()) {
            if (args.recursive !== true) throw new Error('目标是目录，需要 recursive: true')
            await fs.rm(source, { recursive: true, force: false })
          } else {
            await fs.unlink(source)
          }
          return { action, from: source, removed: true }
        }
        if (action !== 'move' && action !== 'copy') throw new Error('action 只能是 move / copy / delete')
        if (typeof args.to !== 'string' || args.to.trim() === '') throw new Error('to 不能为空')
        const destination = await resolveSandboxPath(args.to, { write: true })
        await fs.mkdir(path.dirname(destination), { recursive: true })
        if (action === 'move') await fs.rename(source, destination)
        else await fs.cp(source, destination, { recursive: true, errorOnExist: false, force: true })
        return { action, from: source, to: destination }
      },
    },
    {
      name: 'roots',
      description: '返回本服务允许访问的根目录、读取上限与运行平台信息。',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        const rules = policy()
        return {
          roots: roots(),
          platform: process.platform,
          arch: process.arch,
          cwd: process.cwd(),
          home: os.homedir(),
          tempDir: os.tmpdir(),
          maxReadBytes: maxRead(),
          hardBlocked: rules.hardBlocked,
          readOnly: rules.writeBlocked,
        }
      },
    },
  ],
}

