/**
 * dsh-mcp-hub · 工具调用权限闸门
 *
 * 每个 MCP 服务可以单独设权限：
 *   always   永久启用：不再询问
 *   session  本会话启用：本会话第一次调用时询问一次，同意后本会话内不再问
 *   ask      使用时询问：每次调用都走 DSH 的审批弹窗
 *   disabled 禁用：直接拒绝，不询问
 *
 * 询问走 DSH 自己的审批通道（ctx.approval.request），因此复用了 Web GUI 的
 * 审批弹窗与审计日志；没有审批通道时按「失败关闭」处理（拒绝执行并给出原因），
 * 绝不放行。
 */

const PERMISSION_MODES = ['always', 'session', 'ask', 'disabled']
const MODE_LABELS = {
  always: '永久启用（不再询问）',
  session: '本会话启用（问一次）',
  ask: '使用时询问',
  disabled: '禁用',
}

export function permissionModes() {
  return PERMISSION_MODES.map((mode) => ({ mode, label: MODE_LABELS[mode] }))
}

/** 从 exec 里尽力取出会话标识；取不到就用全局键（等价于「本次运行内已同意」）。 */
function sessionKeyOf(exec) {
  const agent = exec === undefined || exec === null ? null : exec.agent
  if (agent === null || agent === undefined) return 'global'
  const session = agent.session
  if (session !== null && session !== undefined) {
    if (typeof session.id === 'string' && session.id !== '') return session.id
    if (typeof session.sessionId === 'string' && session.sessionId !== '') return session.sessionId
    if (session.id !== undefined && session.id !== null) return String(session.id)
  }
  if (typeof agent.id === 'string' && agent.id !== '') return agent.id
  return 'global'
}

/**
 * @param {object} deps
 * @param {() => object|undefined} deps.approver 取审批服务（ctx.get('approval')）
 * @param {(server:string) => object} deps.permissionOf 取某服务的权限配置
 * @param {(line:string)=>void} deps.log
 */
export function createPermissionGate(deps) {
  const { approver, permissionOf, log } = deps
  /** sessionKey|serverName → true：本会话已同意 */
  const granted = new Map()
  /** 统计：便于状态页展示 */
  const stats = { asked: 0, granted: 0, denied: 0 }

  function keyFor(sessionKey, server) {
    return sessionKey + '|' + server
  }

  /** 在服务运行期间权限被改过：立刻生效（每次调用都重新读）。 */
  async function check(server, exec) {
    const config = permissionOf(server) || {}
    const mode = PERMISSION_MODES.includes(config.permission) ? config.permission : 'always'
    if (mode === 'always') return { allowed: true, mode }
    const sessionKey = sessionKeyOf(exec)
    const key = keyFor(sessionKey, server)
    if (mode === 'disabled') {
      stats.denied += 1
      return { allowed: false, mode, reason: 'MCP 服务「' + server + '」已被设为禁用；在设置 → MCP 工具里切换权限后再调用。' }
    }
    if (mode === 'session' && granted.get(key) === true) return { allowed: true, mode, cached: true }

    const asker = approver()
    const agent = exec === undefined || exec === null ? undefined : exec.agent
    if (asker === undefined || asker === null || typeof asker.request !== 'function' || agent === undefined || agent === null) {
      stats.denied += 1
      return {
        allowed: false,
        mode,
        reason: 'MCP 服务「' + server + '」当前权限为「' + MODE_LABELS[mode] + '」，但这里没有可用的审批通道' +
          '（无人值守/无 GUI 时属预期）。请在设置 → MCP 工具里把它改成「永久启用」，或在本会话里先授权。',
      }
    }
    stats.asked += 1
    let outcome
    try {
      outcome = await asker.request({
        agent,
        toolName: 'mcp__' + server + '__*',
        callId: exec.callId,
        reason: 'MCP 服务「' + server + '」的权限是「' + MODE_LABELS[mode] + '」：' +
          (mode === 'session' ? '本会话第一次使用，需要你确认一次。' : '每次使用都需要你确认。') +
          '同意后它就能调用该服务的工具。',
        signal: exec.signal,
      })
    } catch (error) {
      stats.denied += 1
      return { allowed: false, mode, reason: '审批通道报错，按拒绝处理：' + String(error && error.message ? error.message : error) }
    }
    if (outcome === 'allowed-once') {
      stats.granted += 1
      if (mode === 'session') granted.set(key, true)
      return { allowed: true, mode, approved: true }
    }
    stats.denied += 1
    const why = outcome === 'cancelled' ? '用户取消了授权请求' : (outcome === 'unavailable' ? '当前没有可用的审批界面' : '用户拒绝了授权')
    return { allowed: false, mode, reason: why + '，因此没有调用该 MCP 工具。' }
  }

  /** 清掉「本会话已同意」的记录（权限被改回 ask/disabled、或服务被卸载时调用）。 */
  function revoke(server) {
    if (server === undefined) {
      granted.clear()
      return
    }
    for (const key of [...granted.keys()]) {
      if (key.endsWith('|' + server)) granted.delete(key)
    }
  }

  function snapshot() {
    return { asked: stats.asked, granted: stats.granted, denied: stats.denied, sessions: [...granted.keys()].length }
  }

  return { check, revoke, snapshot, modes: permissionModes, labels: MODE_LABELS }
}

