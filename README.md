# dsh-mcp-hub —— DSH 的 MCP 与工具一键部署中枢

一个 **DSH 插件**（宿主 + 浏览器两半），面向**桌面开发者，Windows 优先**：
把「个人 MCP 服务」变成**设置页里点一下**的事，装完立刻挂载，**不用重启**。

- **一键部署 GUI**：设置 → **MCP 工具**，常用场景点一下即装；搜索结果点「一键安装」。
- **DSH 原生工具去重**：Windows 上 DSH 的命令执行工具叫 **pwsh**、其他平台叫 **bash**，
  插件按平台识别，重叠的候选会被压后并明确写「DSH 已有 pwsh」——不让你重复装一个 shell。
- **内置一整套零依赖 MCP 工具包**（7 个服务、61 个工具）：不联网、不装 npx 包也能直接用。
- **智能搜索**：官方 MCP Registry + npm + GitHub 按需检索，**不预先全量拉取**。
- **权限分级**：永久启用 / 本会话启用（问一次）/ 使用时询问 / 禁用，询问直接复用 DSH 的审批弹窗。
- **环境体检（doctor）**：一条命令回答「环境对不对、缺什么、怎么修」，缺 uvx 就给
  winget install astral-sh.uv。
- **内置终端**：Windows 上优先 PowerShell 7（pwsh），退到 Windows PowerShell，再退到 cmd.exe；
  危险命令被拒。

---

## 目录

- [一分钟上手（Windows）](#一分钟上手windows)
- [一分钟上手（macOS / Linux）](#一分钟上手macos--linux)
- [设置页「MCP 工具」](#设置页mcp-工具)
- [Windows 适配了什么](#windows-适配了什么)
- [权限分级](#权限分级)
- [内置终端](#内置终端)
- [内置 MCP 工具包（零依赖，61 个工具）](#内置-mcp-工具包零依赖61-个工具)
- [架构与数据](#架构与数据)
- [开发与测试](#开发与测试)
- [常见问题](#常见问题)
- [反馈与贡献](#反馈与贡献)
- [手机端（DSHA，可选）](#手机端dsha可选)

---

## 一分钟上手（Windows）

**前置**：Node.js >= 20（插件与内置工具包都靠它）。

    winget install OpenJS.NodeJS.LTS

    # 可选：官方 Python 版 MCP 服务（fetch / git / sqlite / time）靠 uvx
    winget install astral-sh.uv

**安装**（在解压/克隆出来的插件目录里）：

    # PowerShell（推荐；-Verify 会顺手跑一遍 Windows 平台分支的单测）
    .\install.ps1 -Verify

    # 如果被执行策略挡住：
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Verify

安装器做四件事，全程幂等：

1. 检查 Node >= 20；
2. 优先走 **DSH 自己的插件通道** dsh plugin --profile <名> add <spec>（这一步由 DSH
   转发给 pnpm，并自动把包名对账进 dsh.profile.bundles）；
3. 没有 pnpm / 没有 dsh 时**自动兜底**：npm pack → 解包复制进 profile 的 node_modules
   → 由 scripts/profile-manifest.mjs 改写 profile 清单（JSON 交给 node，不用
   PowerShell 5.1 的 ConvertTo-Json）；
4. -Verify 自检：平台层单测 + 内置 MCP 服务清单。

**重启一次 DSH**，然后：**设置 → MCP 工具 → 体检**。

    # 卸载
    .\install.ps1 -Uninstall

> 重启为什么必须？插件是在 DSH 启动时装配的，正在跑的进程不会热加载新插件。
> 之后在设置页里加/卸 MCP 服务**都不再需要重启**。

### 用 DSH 原生通道装（等价写法）

    dsh plugin --profile web add dsh-mcp-hub                          # 从 npm registry
    dsh plugin --profile web add file:C:/path/dsh-mcp-hub-1.2.0.tgz    # 从 tarball

需要 pnpm（corepack enable pnpm 或 npm i -g pnpm）。安装器会自己判断该不该走这条路。

---

## 一分钟上手（macOS / Linux）

    ./install.sh                 # 幂等；内部同样优先走 dsh plugin，再兜底
    ./install.sh --uninstall

只想手工做：把仓库链接进 profile 的 node_modules，再把 dsh-mcp-hub 加进 profile 的
dsh.profile.bundles 与 dependencies（DSH_HOME 不是默认值时记得换路径）。

---

## 设置页「MCP 工具」

宿主路由挂在 /mcp-hub/api/\*，页面本身只依赖 React + fetch：

| 区 | 作用 |
|---|---|
| 状态条 | 平台标签（Windows/macOS/Linux）、已装 / 运行中 / 工具数 / 目录数；「重新同步」「刷新」 |
| 环境体检 | 平台与 Node 版本、node/npx/uvx/git 探测（每条带可复制安装命令）、数据目录可写、注册表可读、失败服务清单、路径策略、终端可用性 |
| 常用场景 | 一键模板（内置工具包、记忆、结构化思考、浏览器、数据库、库文档）+ **高级：自定义 MCP** |
| 智能搜索 | 输入关键词 → 勾选来源（官方 Registry / npm / GitHub）→ 搜索；结果按「相关性 + 不重复 DSH 内置能力」排序 |
| 已装服务 | 运行状态点、工具数（可展开工具名）、测试 / 启用 / 停用 / 卸载、**调用权限下拉** |
| DSH 原生工具 | 当前平台的原生能力清单（Windows 第一条是 **pwsh**，不是 bash）；装 MCP 前先看这里 |
| 可装目录 | 内置 7 个（离线可用）+ 官方/社区预设；缺运行器或平台不支持时置灰并给出修复命令 |
| 自定义 MCP | 服务名、stdio 命令 / 参数 / 环境变量，或 streamable-http 地址 |
| 内置终端 | 持久会话（Windows：pwsh → powershell → cmd） |
| 运行日志 | 最近若干行宿主日志 |

斜杠命令与模型工具等价：

    /mcp doctor                  # 环境体检
    /mcp list                    # 已注册服务与运行状态
    /mcp catalog files           # 浏览可装目录
    /mcp search sqlite           # 在线检索
    /mcp add mcp-sqlite          # 一键安装
    /mcp permission kb ask       # 调用权限：always / session / ask / disabled
    /mcp reload                  # 全量重新同步

---

## Windows 适配了什么

平台相关的东西全部集中在 lib/platform.js，而且都是**可注入 platform 的纯函数**——
所以「Windows 分支」在 Linux/macOS 上也被单测覆盖，不是靠猜。

| 能力 | Windows 行为 |
|---|---|
| DSH 原生命令执行工具名 | pwsh（不是 bash）；能力去重、界面文案、搜索提示统一用它 |
| 默认文件根目录 | 家目录 + %TEMP%（**不**默认放开整个盘） |
| 路径策略 | 硬禁 逐字设备命名空间（反斜杠问号 / 点号前缀）；%SystemRoot%、Program Files (x86)、ProgramData、$Recycle.Bin 只读（按环境变量还原真实盘符） |
| 路径比较 | 大小写不敏感，正斜杠与反斜杠混写都认，前缀边界不误判（C:\WindowsApps 不算 C:\Windows） |
| 一次性命令 | cmd.exe /d /s /c（对 dir、&&、%VAR% 最稳） |
| 交互终端 | pwsh.exe → powershell.exe → cmd.exe /Q /K；ENOENT 自动回退下一个候选 |
| 可执行文件解析 | 按 PATHEXT 解析 npx.cmd / node.exe——解决 Windows 上 spawn npx 必 ENOENT 的经典坑 |
| 运行器探测 | node / npx / uvx / git，缺哪个给对应的 **winget** 安装命令 |
| 危险命令拒绝清单 | format / diskpart / bcdedit / cipher /w / reg delete HKLM / rd /s /q 盘 / Remove-Item -Recurse 盘 / shutdown… 共 18 条，且**放行** dir / git / npm / node |
| 安装器 | install.ps1：UTF-8 带 BOM（PowerShell 5.1 读中文的前提）、全程 Join-Path、file: 规格统一成正斜杠 |

---

## 权限分级

每个服务（以及每个原生工具对应的能力）可选：

| 模式 | 行为 |
|---|---|
| 永久启用 | 不再询问，直接调用 |
| 本会话启用（问一次） | 本会话第一次调用时弹审批，同意后本会话内不再问 |
| 使用时询问 | 每次调用都走 DSH 审批弹窗 |
| 禁用（直接拒绝） | 调用一律被拒，连询问都不发 |

询问复用 DSH 的审批通道（ctx.approval），因此有统一的弹窗、审计日志与 /permission
会话策略；**没有审批通道时按失败关闭**（拒绝并说明原因），绝不放行。口径：

- 运行时开关 enabled：服务是否连接、工具是否发布。
- 调用权限 permission：工具被调用时是否放行。
- 会话级沙箱权限：仍由 DSH 自带的 /permission 预设统一管理。

---

## 内置终端

- 宿主侧维护最多 8 个持久会话，闲置 30 分钟回收；插件卸载时全部收掉。
- 输出按序分块，浏览器每 700ms 拉一次增量（不需要 WebSocket）。
- 拒绝清单与内置 exec 服务共用同一套平台化规则（Windows 一套、POSIX 一套）。
- 单条输出有 512 KiB 上限，超出的旧块会被丢弃并计数。

---

## 内置 MCP 工具包（零依赖，61 个工具）

这些服务本身就是标准 MCP stdio 服务；**任何** MCP 宿主都能直接启动（Windows 同样）：

    { "command": "node", "args": ["C:/path/dsh-mcp-hub/lib/servers/main.js", "files"] }

| 服务 | 工具数 | 能做什么 | 与 DSH 内置的关系 |
|---|---|---|---|
| files | 9 | 受限根目录内 read / write / edit / list / stat / search / find / mutate / roots | 与 read/write/edit/grep/glob 重叠；价值在指定根目录 + 给别的宿主用 |
| exec | 5 | run 命令、which、env、sysinfo、procs | 与 DSH 的 pwsh/bash 重叠；价值同上 |
| net | 4 | http 请求、download 流式下载、json 抓取取值、url 解析 | 与 web_search/web_fetch 部分重叠 |
| kb | 9 | remember / recall / get / forget / entity / relate / graph / namespaces / export | 不重复：DSH 没有跨会话长期记忆 |
| util | 7 | now / convert_time / random / hash / codec / calc / text_stats | 不重复 |
| hub | 10 | status / list / catalog / search / describe / enable / disable / add / remove / reload | MCP 控制面 |
| device | 17 | 通过 DSHA 桥操作 Android：读屏、点按、输入、滑屏、截屏、按键、通知、剪贴板、位置… | **仅手机有意义**，桌面上不展示、不进默认值 |

### 安全边界（写死在代码里）

- files：默认只允许家目录与临时目录；realpath 之后仍要落在允许根内；删除/覆盖必须
  destructive: true。
- exec / 终端：平台化危险命令拒绝清单 + 超时 + 输出上限。
- device：完全走 App 自己的 /app/\* 桥，受 Android 权限与 DSHA 能力开关约束；
  DISABLED / NO_PERMISSION 如实返回，不重试、不绕过。
- 内置服务子进程继承插件进程权限，不做任何提权。

---

## 架构与数据

    lib/index.js                  宿主插件：ctx.inject(['tools']) 引导 → 装配 runner/state/permission/terminal/http-api
    lib/platform.js               平台层：Windows/macOS/Linux 的路径、shell、拒绝清单、PATHEXT、运行器探测、原生工具名
    lib/host/runner.js            直连运行器：SDK 连 MCP 服务 → ctx.tools.register(mcp__X__Y)，执行前过权限闸门
    lib/host/sdk.js               SDK 解析器：自己 → DSH_HOME → dsh 安装树 → NODE_PATH，绝对路径 import
    lib/host/state.js             注册表、目录、变更队列、周期对账
    lib/host/capabilities.js      DSH 原生工具清单（按平台）、重叠判定、候选排序
    lib/host/doctor.js            环境体检：一条命令回答「缺什么、怎么修」
    lib/host/registry.js          在线检索：官方 MCP Registry + npm + GitHub，含重试与包存在性核验
    lib/host/permission.js        调用权限闸门（走 ctx.approval）
    lib/host/terminal.js          持久终端会话（平台 shell + ENOENT 回退）
    lib/host/http-api.js          /mcp-hub/api/*（界面数据源）
    lib/servers/*.js              7 个内置 MCP 服务 + 零依赖 JSON-RPC 运行时
    lib/client.js                 浏览器半：设置页「MCP 工具」
    install.ps1 / install.sh      Windows / POSIX 安装器
    scripts/profile-manifest.mjs  profile 清单对账（只用 node，跨平台）
    scripts/pack-check.mjs        发布包自检

运行数据都在 %USERPROFILE%\.dsh\mcp-hub\（macOS/Linux 是 ~/.dsh/mcp-hub/）：

| 文件 | 作用 |
|---|---|
| servers.json | 服务注册表（含 permission 字段，可直接编辑） |
| catalog.json | 每次启动重新生成的可装目录 |
| mutations.jsonl | 模型侧 hub 服务写的变更请求，宿主按行应用 |
| queries.jsonl / query-responses.json | 模型侧在线检索的请求与响应 |
| tools.json / stats.json | 工具快照与运行态快照 |
| hub.log | 运行日志 |
| kb/ | 长期知识库的 JSONL 存储 |
| dist/ | 安装器留档的 tarball（便于回滚） |

设计取舍：DSH 自带的 @deepseek-ai/mcp-client 一行配置一个服务、重启才生效；本插件改为
在宿主进程里直接持有 MCP 连接（连接即注册、断开即卸载），命名规则保持一致，两者可共存。

---

## 开发与测试

    node scripts/pack-check.mjs            # 发布包自检：npm pack → 校验内容 → 从解出来的副本跑一遍
    node tests/platform.test.mjs           # 平台层（Windows 分支在 Linux 上也被覆盖）
    node tests/capabilities.test.mjs       # DSH 原生工具映射与去重（pwsh vs bash、手机专属能力）
    node tests/installer.test.mjs          # install.ps1：静态约束 + 有 PowerShell 时真跑安装/卸载
    node tests/client-smoke.mjs            # 极简 React 垫片跑浏览器半（含 6 项 Windows 断言）
    node tests/handshake.mjs               # 用官方 SDK 握手全部内置服务
    node tests/hub-query.test.mjs          # hub 查询信封 id 回归（真 MCP 客户端）
    node tests/host-query.test.mjs         # 宿主按信封 id 写回（真 apply）
    node tests/plugin-integration.mjs      # 假 cordis 上下文跑整套插件逻辑
    node tests/dsh-wiring.test.mjs         # 真 cordis + 真 dsh-tools：服务晚就绪、模型侧工具可见性

    npm test                               # 上面全部（不含 pack-check）
    npm run pack:check                     # 发布前必跑

发布：

    npm pack                               # 产出 dsh-mcp-hub-<版本>.tgz
    npm publish                            # 发布后可用 dsh plugin add dsh-mcp-hub

---

## 常见问题

**设置页里没有「MCP 工具」？** 确认 profile 的 dsh.profile.bundles 里有 dsh-mcp-hub
并**重启过** DSH；浏览器半由 package.json 的 dsh.client 声明，缺失时只影响界面，
模型侧工具仍然可用。

**.\install.ps1 报「无法加载文件，因为在此系统上禁止运行脚本」？** PowerShell 执行策略。
用 powershell -ExecutionPolicy Bypass -File .\install.ps1，或
Set-ExecutionPolicy -Scope Process Bypass。

**安装器说没有 pnpm？** 它不会失败——会退回「npm pack + 复制 + 清单对账」。
想用 DSH 官方通道就 corepack enable pnpm 或 npm i -g pnpm。

**安装器说 profile 没有 package.json？** 那个 profile 还没初始化。先 dsh --profile web
（或 dsh web）启动一次，再重跑安装器。

**装了但工具没出现？** mcp_hub(action="status") 看 running / failures / lastError；
工具数为 0 说明该服务 tools/list 为空或报错（日志里有原文）。

**缺 npx / uvx？** 设置页顶栏会直接给出命令：winget install OpenJS.NodeJS.LTS /
winget install astral-sh.uv；也可以 /mcp doctor 看全量体检。

**权限选了「使用时询问」但没有任何弹窗？** 说明当前会话没有审批界面（无人值守/无 GUI），
按失败关闭处理；改成「永久启用」即可。

---

## 反馈与贡献

**遇到问题就开 issue，带全信息基本能一次定位。**

提 bug 请附：

1. 插件版本 + 操作系统 + node -v + dsh --version；
2. 「设置 → MCP 工具 → 体检」的报告（或 /mcp doctor）；
3. 宿主日志 ~/.dsh/mcp-hub/hub.log（Windows：%USERPROFILE%\.dsh\mcp-hub\hub.log）
   里带 [dsh-mcp-hub] 的相关片段；
4. 复现步骤与期望行为。

仓库里已经准备好结构化模板：.github/ISSUE_TEMPLATE/bug_report.yml 会把上面这些逐项问一遍。

- Bug 反馈 / 功能建议：直接在本仓库开 issue（模板会自动引导）
- 安全问题：**不要开公开 issue**，见 [SECURITY.md](./SECURITY.md)
- 想改代码：[CONTRIBUTING.md](./CONTRIBUTING.md)（含测试地图与「平台层必须可注入」的硬规矩）

## 手机端（DSHA，可选）

这个插件跑在 DSHA（Android 上的 DSH App）里同样可用，且会自动切换成手机视角：

- 内置 **device** 服务（17 个工具）只在安卓上进入默认值，走 App 的 /app/\* 桥；
- 原生工具清单会多出「设备 shell（DSHA）」；
- present / export 的产物会导出到 Download。

桌面用户完全不需要关心这一节：isDshaAndroid() 在 Windows/macOS/Linux 上恒为 false。
