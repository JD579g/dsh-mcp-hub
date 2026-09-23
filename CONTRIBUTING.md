# 贡献指南

感谢你有兴趣改进 dsh-mcp-hub。这个插件面向**桌面开发者、Windows 优先**，
所以「在 Windows 上真的能用」是硬指标，而不是加分项。

---

## 快速开始

    git clone https://github.com/<owner>/dsh-mcp-hub.git
    cd dsh-mcp-hub
    node tests/platform.test.mjs      # 不需要装任何依赖，先确认环境
    npm test                          # 全量（约 1~3 分钟）

本插件**没有任何运行时依赖**（只用 Node 内置模块），所以不需要 npm install。
测试也是零依赖的：只有真装配测试会在找不到 DSH 宿主包时明确跳过。

## 测试地图

| 测试 | 覆盖什么 | 需要什么 |
|---|---|---|
| tests/platform.test.mjs | 平台层：路径策略、shell 选择、拒绝清单、PATHEXT、运行器探测、pwsh/bash 命名 | 无 |
| tests/capabilities.test.mjs | DSH 原生工具映射与去重（Windows 必须是 pwsh）、排序 | 无 |
| tests/installer.test.mjs | install.ps1 / install.sh：静态约束 + 真跑安装与卸载 | PowerShell（Windows 自带）/ bash |
| tests/client-smoke.mjs | 浏览器半：注册、三种状态渲染、一键安装、Windows 断言 | 无 |
| tests/handshake.mjs | 用官方 MCP SDK 握手 7 个内置服务并调用代表性工具 | DSH 提供的 @modelcontextprotocol/sdk |
| tests/hub-query.test.mjs | hub 子进程的查询信封 id 回归 | 同上 |
| tests/host-query.test.mjs | 宿主按信封 id 写回（真 apply()） | 无 |
| tests/plugin-integration.mjs | 假 cordis 上下文跑整套插件逻辑（HTTP API / 权限 / 终端） | 无 |
| tests/dsh-wiring.test.mjs | 真 cordis + 真 dsh-tools：服务晚就绪、模型侧工具可见性 | DSH 宿主包，缺则跳过 |
| scripts/pack-check.mjs | 发布包：npm pack 后从**解出来的副本**再跑一遍 | npm |

跑不过先看 /tmp 下的临时数据目录有没有权限问题；Windows 上注意路径里的空格。

## 改代码前先读这一条

**所有平台相关的东西必须放进 lib/platform.js，且写成「第一个参数是 platform」的纯函数。**

    // 对：可以注入，于是 Windows 分支能在 Linux CI 上被断言
    export function commandShell(platform = process.platform, env = process.env) { ... }

    // 错：直接读 process.platform，测试只能靠猜
    if (process.platform === 'win32') { ... }

原因很实际：维护者不一定有 Windows 机器，而 Windows 用户才是主要受众。
能注入，就能在 CI 的 ubuntu runner 上把 Windows 分支跑穿。

配套要求：

- 平台相关的新行为 → 在 tests/platform.test.mjs 里加断言（至少一个 Windows 用例）。
- 「DSH 已经有什么能力」的文案 → 跟着 lib/platform.js 的 shellToolName() / shellToolInfo() 走，
  不要在别处写死 bash。
- 新增文件 → 记得加进 package.json 的 files，否则 npm pack 之后用户那里会少文件；
  npm run pack:check 会直接抓出来。

## 加一个「一键可装」的预设

编辑 lib/host/state.js 的 presetEntries()，一条记录包含：

| 字段 | 说明 |
|---|---|
| name | 服务名（^[A-Za-z0-9_-]{1,32}$） |
| label / description / tags | 界面展示 |
| transport | stdio 或 streamable-http |
| command / args / env | stdio 的启动方式 |
| url / headers | 远程方式 |
| runners | 需要哪些运行器（node / npx / uvx / git），界面据此提示 winget 命令 |
| requires | 额外前置条件（展示用） |

要求：**包必须真实存在**（npm 用 npm view，Python 用 PyPI 核验），并在描述里写清
「与 DSH 内置能力重不重复」。

## 加一个内置 MCP 服务

1. 在 lib/servers/ 下新增模块，用 lib/servers/runtime.js 的零依赖 JSON-RPC 运行时；
2. 在 lib/servers/main.js 的注册表里登记；
3. 在 lib/host/state.js 的 BUILTIN_NAMES 与 builtinEntry() 的 meta 里补名字、说明、平台；
4. 补 tests/handshake.mjs 里的代表性调用（每个工具至少一次成功路径 + 一次错误路径）。

## 提交 PR

- 一个 PR 一件事，说清动机（为什么）与结果（改了什么）。
- 必须：npm test 全绿；动了打包相关再跑 npm run pack:check。
- Windows 相关的改动，请贴一下本地 Windows 上 install.ps1 的输出，或说明为什么没有环境。
- CI 会在 windows-latest / ubuntu-latest / macos-latest × Node 20/22 上跑全套。

## 发布（维护者）

    # 1) 改版本号并同步 README 里出现的版本号
    # 2) npm run pack:check
    # 3) npm test
    npm publish
