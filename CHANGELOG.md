# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.2.0] - 2026-09-23

首个公开版本。面向**桌面开发者、Windows 优先**的 DSH MCP 与工具部署中枢。

### 新增

- **设置页「MCP 工具」**：一键部署常用 MCP 服务、在线搜索（官方 MCP Registry / npm / GitHub）、
  已装服务的运行状态与工具清单、环境体检、内置终端、运行日志。
- **7 个零依赖内置 MCP 服务**（61 个工具）：`files` / `exec` / `net` / `kb` / `util` / `hub` / `device`。
  它们本身就是标准 stdio MCP 服务，任何 MCP 宿主都能直接启动。
- **四级调用权限**：永久启用 / 本会话启用 / 使用时询问 / 禁用；无审批通道时**失败关闭**。
- **DSH 原生工具去重**：搜索结果的排序与提示会指出「DSH 已经有了什么」。
- **内置持久终端**：宿主侧维护会话，浏览器增量拉取输出。
- **安装器**：`install.ps1`（Windows）与 `install.sh`（macOS/Linux），幂等，支持 `-Uninstall`；
  优先走 DSH 自己的插件通道，没有 pnpm/dsh 时自动兜底。
- **发布脚本**：`scripts/publish-github.mjs`、`scripts/publish-npm.mjs`。

### Windows 适配

- 平台层（`lib/platform.js`）集中处理：路径策略、`cmd.exe` 一次性命令、`pwsh → powershell → cmd`
  交互终端回退、按 `PATHEXT` 解析 `npx.cmd`、平台化危险命令拒绝清单、运行器缺失时的 `winget` 提示。
- **命令执行工具名按平台区分**：Windows 上的 DSH 注册的是 `pwsh`，其余平台是 `bash`；
  能力去重、界面文案、搜索提示全部跟着平台走。
- 所有平台相关逻辑都是「可注入 platform 的纯函数」，因此 Windows 分支在 Linux/macOS 上也被单测覆盖。

### 测试与 CI

- 10 个测试套件，零额外依赖（仅一个 devDependency：官方 MCP SDK）。
- CI 矩阵 **windows-latest / ubuntu-latest / macos-latest × Node 20/22**，
  其中 Windows runner 会**真的执行 `install.ps1`**（安装 + 卸载），
  macOS runner 会真的执行 `install.sh`（顺带守住 macOS 自带 bash 3.2 的行为差异）。

[Unreleased]: https://github.com/JD579g/dsh-mcp-hub/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/JD579g/dsh-mcp-hub/releases/tag/v1.2.0
