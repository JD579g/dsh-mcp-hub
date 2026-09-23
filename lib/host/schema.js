/**
 * dsh-mcp-hub · JSON Schema → DSH 工具参数 DSL 转换
 *
 * DSH 的工具 parameters 不是原始 JSON Schema，而是它自己的作者 DSL：
 *   - 隐式根对象（property map）：每个属性就是一段值 schema；
 *   - 必填写成属性上的 required: true，而不是根上的 required 数组；
 *   - object 必须显式写 additionalProperties: true|false；
 *   - 只认 type（string/number/integer/boolean/null/array/object/json）、
 *     enum、const、oneOf、items、properties、additionalProperties 与
 *     description/title/default/examples 这些注解；
 *   - anyOf / allOf / $ref / pattern / minimum … 一律不支持。
 *
 * MCP 服务返回的是标准 JSON Schema，直接用会让 DSH 在渲染工具 schema 的那一刻
 * 抛错（而且是在每次模型请求时）。所以这里做一次保守转换：认识的保留，
 * 不认识的丢掉（宁可少校验，不可炸请求）。
 */

const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json'])

function copyAnnotations(source, target) {
  for (const key of ['description', 'title', 'default', 'examples']) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) target[key] = source[key]
  }
}

function safeEnum(values) {
  const list = []
  for (const value of Array.isArray(values) ? values : []) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) list.push(value)
  }
  return list.length >= 1 ? list : null
}


/**
 * 转换一段值 schema；失败时退化成任意 JSON 而不是抛错。
 * @param {any} schema 标准 JSON Schema 片段
 * @param {boolean} required 是否在父对象里必填
 */
function convertNode(schema, required) {
  const out = {}
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    out.type = 'json'
    if (required === true) out.required = true
    return out
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length >= 2) {
    out.oneOf = schema.oneOf.map((branch) => convertNode(branch, false))
    copyAnnotations(schema, out)
    if (required === true) out.required = true
    return out
  }

  const declared = Array.isArray(schema.type) ? schema.type.find((item) => item !== 'null') : schema.type
  let type = typeof declared === 'string' && ALLOWED_TYPES.has(declared) ? declared : undefined
  if (type === undefined) type = schema.properties !== undefined ? 'object' : (schema.items !== undefined ? 'array' : 'json')

  out.type = type
  copyAnnotations(schema, out)

  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean' || type === 'null') {
    const values = safeEnum(schema.enum)
    if (values !== null) out.enum = values
    else if (schema.const !== undefined && (schema.const === null || ['string', 'number', 'boolean'].includes(typeof schema.const))) out.const = schema.const
  } else if (type === 'array') {
    out.items = schema.items !== undefined ? convertNode(schema.items, false) : { type: 'json' }
  } else if (type === 'object') {
    const properties = {}
    const requiredNames = new Set(Array.isArray(schema.required) ? schema.required.map((item) => String(item)) : [])
    const source = schema.properties !== null && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {}
    for (const [key, value] of Object.entries(source)) properties[key] = convertNode(value, requiredNames.has(key))
    out.properties = properties
    out.additionalProperties = typeof schema.additionalProperties === 'boolean' ? schema.additionalProperties : true
  }

  if (required === true) out.required = true
  return out
}


/**
 * 把 MCP 工具的 inputSchema 转成 DSH 的 parameters property map。
 * @param {any} inputSchema MCP 服务声明的输入 schema
 * @returns {Record<string, any>} 可直接交给 ctx.tools.register 的 parameters
 */
export function toAuthorParameters(inputSchema) {
  if (inputSchema === null || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return {}
  const root = inputSchema
  const source = root.properties !== null && typeof root.properties === 'object' && !Array.isArray(root.properties) ? root.properties : {}
  const requiredNames = new Set(Array.isArray(root.required) ? root.required.map((item) => String(item)) : [])
  const out = {}
  for (const [key, value] of Object.entries(source)) out[key] = convertNode(value, requiredNames.has(key))
  return out
}

