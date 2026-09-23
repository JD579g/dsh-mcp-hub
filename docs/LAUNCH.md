# 让官方看到：投稿与曝光清单

这个仓库的门票逻辑是：**官方/生态索引通过 GitHub topic `dsh-plugin` 发现插件**，
而事实上的 registry 是 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
（`dsh-market`、`dshfind` 等下游都读它的 `plugins.json`）。

下面按「先满足硬条件 → 再投目录 → 最后社交曝光」的顺序排列。**顺序别反**：
空壳仓库被看到一次，就浪费了第一印象。

## 0. 硬条件自检

| 条件 | 状态 |
|---|---|
| 根 `package.json` 声明 `dsh.bundle.patch` | ✅ |
| 仓库打上 GitHub topic `dsh-plugin` | ✅ |
| LICENSE / README / CHANGELOG / issue 模板 | ✅ |
| CI 在 windows + ubuntu + macos 上真跑（含真跑安装器） | ✅ `windows-latest` 会实际执行 install.ps1 |
| git tag `v<版本>` + GitHub Release | ✅ `v1.2.0` |
| 仓库创建满 24 小时 | ⏳ 创建于 2026-09-23T12:45Z |
| 发布到 npm（建议，非必须） | ⏳ 见 README Roadmap |

## 1. 投目录（仓库满 24 小时后）

条目文件已经写好：`docs/awesome-dsh-plugin-entry.yml`。流程：

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`；
2. 新建 `data/plugins/JD579g__dsh-mcp-hub.yml`，内容就是上面那个文件；
3. 提 PR，标题写 `Add JD579g/dsh-mcp-hub`；
4. CI 会校验 `dsh.bundle`、topic、仓库年龄、描述与代码是否一致 —— 不要夸大数字。

同一个条目还可以投给：`dsh-market`、`LivXue/dsh-plugin-shop`、
`AdamPlatin123/dsh-plugin-radar`、`0xsline/awesome-deepseek-harness`。

## 2. 官方 Discussion 展示帖（英文，发在 deepseek-ai/deepseek-harness 的欢迎帖下）

```text
dsh-mcp-hub — one-click MCP deployment for DSH (Windows-first)

Setting up MCP servers on a Windows dev box is still a fight: `npx` is `npx.cmd`,
`spawn` cannot find it, and you have no idea which registries to trust.

This plugin (host half + browser half, no runtime dependencies) makes it one click:
- curated catalog + on-demand search across the official MCP Registry, npm and GitHub;
- install and it is connected in the running harness — no restart;
- per-server call permissions: always / session / ask / disabled (fails closed without an approval UI);
- environment doctor that prints the exact fix (e.g. `winget install astral-sh.uv`);
- built-in terminal (pwsh → powershell → cmd on Windows, $SHELL on POSIX);
- 7 built-in zero-dependency MCP servers / 61 tools, offline-capable;
- and it de-duplicates against DSH's own tools instead of re-shipping them.

All platform behaviour is pure functions with an injectable platform argument, so the Windows
branch is unit-tested on Linux CI and actually executed on windows-latest.
CI also really runs `install.ps1` (install + uninstall) on the Windows runner.

Repo: https://github.com/JD579g/dsh-mcp-hub
Feedback very welcome — especially from Windows users.
```

## 3. npm 发布（发完把徽章加到 README）

```bash
node scripts/publish-npm.mjs --dry-run        # 先看要发什么
NPM_TOKEN=npm_xxx node scripts/publish-npm.mjs
```

之后在 npmjs.com 的包设置里配置 **Trusted Publishing**：

- Publisher: GitHub Actions · Repository: `JD579g/dsh-mcp-hub` · Workflow: `release.yml`
- 之后打 tag `v1.2.1` 就会由 `.github/workflows/release.yml` 用 OIDC 自动发布（带 provenance），
  不需要任何长期 token。

## 4. 社交曝光（一次高质量，别刷屏）

- **X**：@DeepSeek 官方号与 DSH 团队负责人，带 `#deepseekharness` `#dsh`，附仓库链接与一句话定位；
- **linux.do**：发「Windows 开发者的一键 MCP 部署台」经验帖（中文）；
- **抖音/小红书**：录制 30 秒「搜索 → 一键装 → 立即可用」的短视频。

## 4.5 三条禁忌

1. ❌ **不要发内测 App 的界面截图**（可能受保密承诺约束）——用桌面/通用功能截图或架构图；
2. ❌ 不要承诺没验证过的能力（例如「支持所有客户端一键装」）；
3. ❌ 不要群发式刷屏：一次展示帖 + 一次目录 PR，比十次水帖有效。

## 5. 诚实清单（评审最反感夸大）

README 里已经写了 `Honest status` 一节：CI 覆盖到哪、什么没被人工点过、
哪些功能有前置依赖。**保留它，不要删。**
