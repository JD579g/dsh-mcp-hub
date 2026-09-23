/**
 * dsh-mcp-hub · 内置 MCP 服务：util
 *
 * 通用工具：时间、随机与 ID、哈希与编码、计算器、文本统计。
 * 全部离线可算，不依赖任何外部程序。
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { str, num, bool } from './util.js'

const strArr = (description) => ({ type: 'array', items: { type: 'string' }, description })

const TIMEZONES = [
  'UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Kolkata', 'Asia/Dubai',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Australia/Sydney', 'Pacific/Auckland', 'Africa/Cairo',
]

function formatIn(date, timeZone) {
  const options = {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
    weekday: 'short',
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', options).formatToParts(date).map((part) => [part.type, part.value]))
  return parts.year + '-' + parts.month + '-' + parts.day + ' ' + parts.hour + ':' + parts.minute + ':' + parts.second + ' ' + parts.weekday
}

/** 安全的算术表达式求值（递归下降，不用 eval）。 */
function evaluateExpression(input) {
  const text = String(input)
  let index = 0
  const skip = () => { while (index < text.length && /\s/.test(text[index])) index += 1 }
  const peek = () => text[index]

  const parseNumber = () => {
    skip()
    let sign = 1
    while (peek() === '+' || peek() === '-') {
      if (peek() === '-') sign = -sign
      index += 1
      skip()
    }
    const start = index
    while (index < text.length && /[0-9._]/.test(text[index])) index += 1
    if (index < text.length && /[eE]/.test(text[index])) {
      index += 1
      if (peek() === '+' || peek() === '-') index += 1
      while (index < text.length && /[0-9]/.test(text[index])) index += 1
    }
    if (start === index) throw new Error('表达式在位置 ' + index + ' 处缺少数字')
    return sign * Number(text.slice(start, index).replace(/_/g, ''))
  }

  const parsePrimary = () => {
    skip()
    if (peek() === '(') {
      index += 1
      const value = parseSum()
      skip()
      if (peek() !== ')') throw new Error('括号不匹配')
      index += 1
      return value
    }
    if (peek() === 'π') { index += 1; return Math.PI }
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index))
    if (nameMatch !== null) {
      const name = nameMatch[0].toLowerCase()
      index += name.length
      skip()
      if (peek() === '(') {
        index += 1
        const first = parseSum()
        const extra = []
        skip()
        while (peek() === ',') {
          index += 1
          extra.push(parseSum())
          skip()
        }
        if (peek() !== ')') throw new Error('函数 ' + name + ' 的括号不匹配')
        index += 1
        return applyFunction(name, [first, ...extra])
      }
      const constants = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 }
      if (constants[name] !== undefined) return constants[name]
      throw new Error('未知标识符：' + name)
    }
    const value = parseNumber()
    skip()
    if (peek() === '%') { index += 1; return value / 100 }
    return value
  }

  const parsePower = () => {
    const base = parsePrimary()
    skip()
    if (peek() === '^' || text.slice(index, index + 2) === '**') {
      index += text.slice(index, index + 2) === '**' ? 2 : 1
      return Math.pow(base, parsePower())
    }
    return base
  }

  const parseProduct = () => {
    let value = parsePower()
    for (;;) {
      skip()
      const char = peek()
      if (char === '*') { index += 1; value *= parsePower(); continue }
      if (char === '/') { index += 1; value /= parsePower(); continue }
      if (char === '%' && !/[0-9.]/.test(text[index + 1] || '')) { index += 1; value %= parsePower(); continue }
      if (char === '(' || /[0-9.]/.test(char || '')) { value *= parsePower(); continue }
      return value
    }
  }

  const parseSum = () => {
    let value = parseProduct()
    for (;;) {
      skip()
      const char = peek()
      if (char === '+') { index += 1; value += parseProduct(); continue }
      if (char === '-') { index += 1; value -= parseProduct(); continue }
      return value
    }
  }

  const result = parseSum()
  skip()
  if (index !== text.length) throw new Error('表达式在位置 ' + index + ' 处无法解析：' + text.slice(index))
  if (!Number.isFinite(result)) throw new Error('结果不是有限数（除零或溢出）')
  return result
}

function applyFunction(name, args) {
  const functions = {
    sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log, log10: Math.log10,
    log2: Math.log2, exp: Math.exp, sign: Math.sign, trunc: Math.trunc,
    min: Math.min, max: Math.max, pow: Math.pow, atan2: Math.atan2,
  }
  if (name === 'mod') return args[0] % args[1]
  const fn = functions[name]
  if (fn === undefined) throw new Error('未知函数：' + name)
  return fn(...args)
}

export const utilServer = {
  name: 'util',
  version: '1.0.0',
  title: '通用工具',
  instructions: '离线通用工具：时间、随机/ID、哈希与编码、表达式计算、文本统计。',
  tools: [
    {
      name: 'now',
      description: '当前时间：ISO、Unix 秒/毫秒、本地时区，以及常见时区的本地化时间。',
      inputSchema: {
        type: 'object',
        properties: {
          timezone: str('额外要格式化的时区，例如 Asia/Shanghai（可逗号分隔多个）'),
        },
      },
      async handler(args) {
        const date = new Date()
        const zones = typeof args.timezone === 'string' && args.timezone.trim() !== '' ? args.timezone.split(',').map((item) => item.trim()) : []
        const formatted = {}
        for (const zone of [...TIMEZONES, ...zones]) {
          try { formatted[zone] = formatIn(date, zone) } catch { formatted[zone] = 'invalid timezone' }
        }
        return {
          iso: date.toISOString(),
          unixSeconds: Math.floor(date.getTime() / 1000),
          unixMilliseconds: date.getTime(),
          local: date.toString(),
          localTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          localOffsetMinutes: -date.getTimezoneOffset(),
          byTimezone: formatted,
        }
      },
    },
    {
      name: 'convert_time',
      description: '时间换算：把一个时刻在时区间转换，或解析时刻字符串，或做时长加减。',
      inputSchema: {
        type: 'object',
        properties: {
          value: str('时刻字符串（ISO 或可被 Date 解析）或时长表达式（如 3d、12h、90m）'),
          from: str('源时区（缺失时按本地/UTC 解析）'),
          to: str('目标时区，默认 Asia/Shanghai'),
          add: str('要加到 value 上的时长，例如 2d、3h、30m、45s'),
        },
      },
      async handler(args) {
        const target = typeof args.to === 'string' && args.to !== '' ? args.to : 'Asia/Shanghai'
        let base
        const raw = typeof args.value === 'string' && args.value !== '' ? args.value : String(Date.now())
        const durationMatch = /^(-?\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/.exec(raw.trim())
        if (durationMatch !== null && args.from === undefined) {
          base = new Date(Date.now() + durationToMs(raw))
        } else {
          base = new Date(raw)
        }
        if (Number.isNaN(base.getTime())) throw new Error('无法解析时刻：' + raw)
        if (typeof args.add === 'string' && args.add !== '') base = new Date(base.getTime() + durationToMs(args.add))
        const formatted = formatIn(base, target)
        return { input: raw, iso: base.toISOString(), timezone: target, formatted, unixSeconds: Math.floor(base.getTime() / 1000) }
      },
    },
    {
      name: 'random',
      description: '生成随机数、随机字节、随机字符串或 UUID（加密安全随机源）。',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['uuid', 'bytes', 'int', 'string', 'pick'], description: '生成类型，默认 uuid' },
          min: num('kind=int 时的最小值（含），默认 0'),
          max: num('kind=int 时的最大值（不含），默认 1000000'),
          length: num('kind=string/bytes 时的长度，字符串默认 16，字节默认 16'),
          alphabet: str('kind=string 的字符集，默认 0-9a-zA-Z'),
          count: num('生成个数，默认 1，上限 100'),
          items: strArr('kind=pick 时的候选列表'),
        },
      },
      async handler(args) {
        const kind = typeof args.kind === 'string' ? args.kind : 'uuid'
        const count = Math.max(1, Math.min(100, Number(args.count || 1) || 1))
        const values = []
        for (let index = 0; index < count; index += 1) {
          if (kind === 'uuid') values.push(randomUUID())
          else if (kind === 'bytes') values.push(randomBytes(Math.max(1, Math.min(4096, Number(args.length || 16) || 16))).toString('hex'))
          else if (kind === 'int') {
            const min = Number.isFinite(Number(args.min)) ? Math.floor(Number(args.min)) : 0
            const max = Number.isFinite(Number(args.max)) ? Math.floor(Number(args.max)) : 1000000
            if (max <= min) throw new Error('max 必须大于 min')
            const span = max - min
            const limit = Math.floor(0xffffffff / span) * span
            let value
            do { value = randomBytes(4).readUInt32BE(0) } while (value >= limit)
            values.push(min + (value % span))
          } else if (kind === 'string') {
            const alphabet = typeof args.alphabet === 'string' && args.alphabet !== '' ? args.alphabet : '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
            const length = Math.max(1, Math.min(4096, Number(args.length || 16) || 16))
            let text = ''
            const bytes = randomBytes(length * 2)
            for (let cursor = 0; text.length < length && cursor < bytes.length; cursor += 1) text += alphabet[bytes[cursor] % alphabet.length]
            values.push(text)
          } else if (kind === 'pick') {
            const items = Array.isArray(args.items) ? args.items : []
            if (items.length === 0) throw new Error('kind=pick 需要 items')
            values.push(items[randomBytes(4).readUInt32BE(0) % items.length])
          } else throw new Error('未知 kind：' + kind)
        }
        return { kind, count, values }
      },
    },
    {
      name: 'hash',
      description: '对文本做哈希或 HMAC：md5 / sha1 / sha256 / sha512 / hmac-sha256。',
      inputSchema: {
        type: 'object',
        properties: {
          text: str('要处理的文本'),
          algorithm: { type: 'string', enum: ['md5', 'sha1', 'sha256', 'sha512', 'hmac-sha256'], description: '算法，默认 sha256' },
          key: str('HMAC 密钥（algorithm=hmac-sha256 时必填）'),
          encoding: { type: 'string', enum: ['hex', 'base64'], description: '输出编码，默认 hex' },
        },
        required: ['text'],
      },
      async handler(args) {
        const algorithm = typeof args.algorithm === 'string' ? args.algorithm : 'sha256'
        const encoding = args.encoding === 'base64' ? 'base64' : 'hex'
        const text = String(args.text === undefined ? '' : args.text)
        if (algorithm === 'hmac-sha256') {
          if (typeof args.key !== 'string' || args.key === '') throw new Error('hmac-sha256 需要 key')
          return { algorithm, encoding, digest: createHmac('sha256', args.key).update(text, 'utf8').digest(encoding) }
        }
        if (!['md5', 'sha1', 'sha256', 'sha512'].includes(algorithm)) throw new Error('不支持的算法：' + algorithm)
        return { algorithm, encoding, digest: createHash(algorithm).update(text, 'utf8').digest(encoding) }
      },
    },
    {
      name: 'codec',
      description: '编码转换：base64、base64url、hex、url 组件、JSON 美化/压缩。',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['base64-encode', 'base64-decode', 'base64url-encode', 'base64url-decode', 'hex-encode', 'hex-decode', 'url-encode', 'url-decode', 'json-format', 'json-minify', 'json-validate'], description: '转换模式' },
          text: str('要转换的文本'),
        },
        required: ['mode', 'text'],
      },
      async handler(args) {
        const text = String(args.text === undefined ? '' : args.text)
        const mode = String(args.mode)
        switch (mode) {
          case 'base64-encode': return { mode, result: Buffer.from(text, 'utf8').toString('base64') }
          case 'base64-decode': return { mode, result: Buffer.from(text, 'base64').toString('utf8') }
          case 'base64url-encode': return { mode, result: Buffer.from(text, 'utf8').toString('base64url') }
          case 'base64url-decode': return { mode, result: Buffer.from(text, 'base64url').toString('utf8') }
          case 'hex-encode': return { mode, result: Buffer.from(text, 'utf8').toString('hex') }
          case 'hex-decode': return { mode, result: Buffer.from(text.replace(/\s+/g, ''), 'hex').toString('utf8') }
          case 'url-encode': return { mode, result: encodeURIComponent(text) }
          case 'url-decode': return { mode, result: decodeURIComponent(text) }
          case 'json-format': return { mode, result: JSON.stringify(JSON.parse(text), null, 2) }
          case 'json-minify': return { mode, result: JSON.stringify(JSON.parse(text)) }
          case 'json-validate': {
            try {
              const value = JSON.parse(text)
              return { mode, valid: true, type: Array.isArray(value) ? 'array' : typeof value, keys: value !== null && typeof value === 'object' ? Object.keys(value).slice(0, 50) : [] }
            } catch (error) {
              return { mode, valid: false, error: String(error && error.message ? error.message : error) }
            }
          }
          default: throw new Error('未知 mode：' + mode)
        }
      },
    },
    {
      name: 'calc',
      description: '计算算术表达式：+ - * / % ^、括号、函数（sqrt/log/sin/min/max/mod/round…）、常量 pi/e。',
      inputSchema: {
        type: 'object',
        properties: { expression: str('表达式，例如 (1+2)*3^2、sqrt(2)、sin(pi/6)') },
        required: ['expression'],
      },
      async handler(args) {
        const expression = String(args.expression === undefined ? '' : args.expression)
        const value = evaluateExpression(expression)
        return { expression, value, text: expression + ' = ' + value }
      },
    },
    {
      name: 'text_stats',
      description: '文本统计：字符数、行数、词数、字节数、各字符出现频次 Top N。',
      inputSchema: {
        type: 'object',
        properties: {
          text: str('要统计的文本'),
          top: num('返回出现频次最高的字符数，默认 10'),
        },
        required: ['text'],
      },
      async handler(args) {
        const text = String(args.text === undefined ? '' : args.text)
        const top = Math.max(1, Math.min(100, Number(args.top || 10) || 10))
        const frequency = new Map()
        for (const char of text) frequency.set(char, (frequency.get(char) || 0) + 1)
        const ranked = [...frequency.entries()].sort((left, right) => right[1] - left[1]).slice(0, top)
        const words = text.split(/\s+/).filter((item) => item !== '')
        const han = (text.match(/[\u4e00-\u9fff]/g) || []).length
        return {
          characters: [...text].length,
          bytes: Buffer.byteLength(text, 'utf8'),
          lines: text === '' ? 0 : text.split('\n').length,
          words: words.length,
          hanCharacters: han,
          sha256: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
          topCharacters: ranked.map(([char, count]) => ({ char, count, codePoint: 'U+' + char.codePointAt(0).toString(16).toUpperCase() })),
        }
      },
    },
  ],
}

function durationToMs(input) {
  const match = /^(-?\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/.exec(String(input).trim())
  if (match === null) throw new Error('无法解析时长：' + input)
  const value = Number(match[1])
  const unit = match[2] || 'ms'
  const scale = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit]
  return value * scale
}

