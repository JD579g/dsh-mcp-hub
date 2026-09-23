#!/usr/bin/env bash
# dsh-mcp-hub 安装/卸载脚本（macOS / Linux，幂等）
#
#   ./install.sh                     装到 web profile
#   ./install.sh --profile tui       装到别的 profile
#   ./install.sh --source <spec>     指定来源（包名 / tarball / 目录 / git+https://…）
#   ./install.sh --uninstall         卸载
#
# 与 Windows 的 install.ps1 同一套策略：
#   1) 优先委托 DSH 自己的插件通道：dsh plugin --profile <p> add <spec>
#      （由 DSH 转发 pnpm，并自动把包名对账进 dsh.profile.bundles）；
#   2) 没有 dsh / pnpm 时退回「符号链接 + 清单助手」；
#   3) 两条路最后都用 scripts/profile-manifest.mjs 再对账一次（幂等、跨平台）。
set -euo pipefail

NAME="dsh-mcp-hub"
SRC="$(cd "$(dirname "$0")" && pwd)"
PROFILE="web"
MODE="install"
SOURCE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile 需要参数}"; shift 2 ;;
    --profile=*) PROFILE="${1#*=}"; shift ;;
    --source) SOURCE="${2:?--source 需要参数}"; shift 2 ;;
    --source=*) SOURCE="${1#*=}"; shift ;;
    --uninstall|-u) MODE="uninstall"; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

has() { command -v "$1" >/dev/null 2>&1; }

if ! has node; then
  echo "没找到 node。插件要求 Node.js >= 20；装完再来。" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 版本过低：$NODE_MAJOR（要求 >= 20）" >&2
  exit 1
fi

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
MANIFEST="$PROFILE_DIR/package.json"
HELPER="$SRC/scripts/profile-manifest.mjs"

if [ ! -f "$MANIFEST" ]; then
  echo "这个 profile 还没初始化过：$MANIFEST" >&2
  echo "先启动一次：dsh --profile $PROFILE（或在 DSH 里用一次这个 profile），再重跑本脚本。" >&2
  exit 1
fi
if [ ! -f "$HELPER" ]; then
  echo "找不到清单助手：$HELPER" >&2
  exit 1
fi

# DSH 启动器：PATH 里有就用；否则用全局安装的 bin.js 兜底。
DSH_CMD=()
if has dsh; then
  DSH_CMD=(dsh)
else
  GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
  if [ -n "$GLOBAL_ROOT" ] && [ -f "$GLOBAL_ROOT/@deepseek-ai/dsh/lib/bin.js" ]; then
    DSH_CMD=(node "$GLOBAL_ROOT/@deepseek-ai/dsh/lib/bin.js")
  fi
fi

echo "==> dsh-mcp-hub · profile=$PROFILE · $PROFILE_DIR"

if [ "$MODE" = "uninstall" ]; then
  if [ "${#DSH_CMD[@]}" -gt 0 ] && has pnpm; then
    "${DSH_CMD[@]}" plugin --profile "$PROFILE" remove "$NAME" || \
      echo "  !   dsh plugin remove 失败，继续用清单助手清理" >&2
  fi
  node "$HELPER" --profile-dir "$PROFILE_DIR" --mode uninstall --name "$NAME" >/dev/null
  rm -rf "$PROFILE_DIR/node_modules/$NAME"
  echo "  OK  已从 profile 依赖、dsh.profile.bundles 与 node_modules 中移除"
  echo "卸载完成。重启一次 DSH 后生效。"
  exit 0
fi

SPEC="$SOURCE"
[ -z "$SPEC" ] && SPEC="link:$SRC"

DONE=0
if [ "${#DSH_CMD[@]}" -gt 0 ] && has pnpm; then
  echo "==> ${DSH_CMD[*]} plugin --profile $PROFILE add $SPEC"
  if "${DSH_CMD[@]}" plugin --profile "$PROFILE" add "$SPEC"; then
    DONE=1
    echo "  OK  DSH 插件通道安装完成（bundles 已由 dsh 对账）"
  else
    echo "  !   DSH 插件通道失败，改用兜底安装" >&2
  fi
else
  echo "  !   没有可用的 dsh+pnpm，改用符号链接兜底" >&2
fi

if [ "$DONE" = "0" ]; then
  mkdir -p "$PROFILE_DIR/node_modules"
  ln -sfn "$SRC" "$PROFILE_DIR/node_modules/$NAME"
  SPEC="link:$SRC"
  echo "  OK  已链接：$PROFILE_DIR/node_modules/$NAME → $SRC"
fi

echo "==> 对账 profile 清单（dsh.profile.bundles / dependencies）"
node "$HELPER" --profile-dir "$PROFILE_DIR" --mode install --name "$NAME" --spec "$SPEC" >/dev/null
echo "  OK  清单已对账"

echo "装好了。下一步：重启一次 DSH（dsh web / dsh --profile $PROFILE），"
echo "然后打开 设置 → MCP 工具 → 体检。之后加/卸 MCP 服务都不用重启。"
