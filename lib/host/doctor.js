/**
 * dsh-mcp-hub · 体检（doctor）
 *
 * 一次调用回答桌面开发者最关心的问题：环境对不对、缺什么、怎么修。
 * 每条都给 level（ok / warn / error）、人类可读的说明，以及**可直接复制**的修复命令。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { platformLabel, runnerStatus, defaultFsRoots, pathPolicy, isWindows } from '../platform.js'

/**
 * @param {object} deps
 * @param {object} deps.config 解析后的插件配置
 * @param {object} deps.state  createState 实例（读注册表与目录）
 * @param {object} deps.runner MCP 运行器（读运行态）
 * @param {(line:string)=>void} [deps.log]
 */
export function buildDoctor(deps) {
  const { config, state, runner, log } = deps
  return async function doctor() {
    const items = []
    const add = (level, id, title, detail, fix) => items.push({ level, id, title, detail, fix: fix === undefined ? null : fix })

    // 1) 运行时与平台
    add('ok', 'platform', '运行平台', platformLabel() + ' · Node ' + process.version + ' · ' + process.arch,
      null)

    // 2) 运行器（npx / uvx / git）—— 预设能不能起来全看这个
    const runners = runnerStatus()
    // 手机（DSHA 安卓）不需要 uvx / git：那里只当提醒，不算错误，免得吓人。
    const optionalRunners = config.isMobileDsha === true ? new Set(['uvx', 'git']) : new Set(['git'])
    for (const row of runners) {
      if (row.available === true) {
        add('ok', 'runner-' + row.id, row.label + ' 可用', row.path, null)
      } else if (optionalRunners.has(row.id)) {
        add('warn', 'runner-' + row.id, row.label + ' 没找到（可选）', row.why, row.installHint)
      } else {
        add('error', 'runner-' + row.id, row.label + ' 没找到', row.why, row.installHint)
      }
    }

    // 3) 数据目录可写
    try {
      await fs.mkdir(config.dataDir, { recursive: true })
      const probe = path.join(config.dataDir, '.doctor-probe')
      await fs.writeFile(probe, 'ok', 'utf8')
      await fs.rm(probe, { force: true })
      add('ok', 'data-dir', '数据目录可写', config.dataDir, null)
    } catch (error) {
      add('error', 'data-dir', '数据目录不可写', config.dataDir + ' :: ' + String(error && error.message ? error.message : error),
        '检查目录权限，或在插件配置里指定 dataDir')
    }

    // 4) 注册表 / 目录文件
    try {
      const registry = await fs.readFile(config.registryFile, 'utf8')
      const parsed = JSON.parse(registry)
      const count = Array.isArray(parsed.servers) ? parsed.servers.length : 0
      add('ok', 'registry', '注册表可读', count + ' 个服务 · ' + config.registryFile, null)
    } catch (error) {
      add('warn', 'registry', '注册表还没生成或不可读', String(error && error.message ? error.message : error),
        '首次启动会自动生成；若持续失败请检查数据目录权限')
    }

    // 5) 运行态：谁在跑、谁挂了
    const running = runner.list()
    const results = state !== undefined ? Object.fromEntries(state.state.results) : {}
    add(running.length > 0 ? 'ok' : 'warn', 'running', '已连接 ' + running.length + ' 个 MCP 服务',
      running.length > 0 ? running.map((item) => item.name + '(' + item.toolCount + ')').join('、') : '当前没有任何服务在跑',
      running.length > 0 ? null : '在「MCP 工具」里点一个常用场景，或 /mcp add files')
    const failed = Object.entries(results).filter(([, value]) => value === 'failed').map(([name]) => name)
    if (failed.length > 0) {
      add('error', 'failed-servers', failed.length + ' 个服务启动失败', failed.join('、'),
        '点对应服务的「测试」看具体报错；npx/uvx 类服务多半是缺运行器或首次下载超时')
    }

    // 6) 路径策略（桌面重点：家目录可写、系统目录只读）
    const roots = config.fsRoots
    const policy = pathPolicy(config.platform, process.env)
    add('ok', 'fs-roots', '内置文件服务可访问的根目录', roots.join('  |  '), null)
    const outside = roots.filter((item) => !defaultFsRoots(config.platform).some((home) => path.resolve(home) === path.resolve(item)))
    if (outside.length > 0) {
      add('warn', 'fs-roots-custom', '有自定义根目录', outside.join('、'),
        '自定义目录会被读写；只把确实需要的项目目录加进来')
    }
    if (isWindows() === true) {
      add('ok', 'fs-readonly', '系统目录只读', policy.writeBlocked.slice(0, 4).join('、') + ' …', null)
    }

    // 7) 终端
    const shells = deps.terminal !== undefined && deps.terminal !== null ? deps.terminal.shells : []
    if (shells.length > 0) {
      add('ok', 'terminal', '内置终端可用', shells.map((item) => item.label).join(' → '), null)
    } else {
      add('warn', 'terminal', '内置终端不可用', '没有找到可用的 shell', null)
    }

    // 8) 汇总
    const errors = items.filter((item) => item.level === 'error').length
    const warns = items.filter((item) => item.level === 'warn').length
    const report = {
      ok: errors === 0,
      platform: { id: config.platform, label: config.osLabel, mobileDsha: config.isMobileDsha === true, home: os.homedir(), temp: os.tmpdir() },
      summary: errors === 0 ? (warns === 0 ? '环境完整，可以直接用' : '可用，但有 ' + warns + ' 条提醒') : '有 ' + errors + ' 个问题需要先解决',
      counts: { errors, warns, ok: items.filter((item) => item.level === 'ok').length },
      items,
      runners,
    }
    if (typeof log === 'function') log('doctor：' + report.summary)
    return report
  }
}

