#!/usr/bin/env bash
set -e

# 把本仓的 swagger-mcp-server 注册成用户级 MCP 服务（名字固定 swagger-multi）。
#
# 服务清单从 swagger-mcp-server/services.conf 读（一行一条 `服务名=api-docs 地址`，
# `#` 开头是注释）。该文件是生成物：由 `yarn swagger` 从 febot.config.json 的
# repositories[].swagger 汇总写入，不要手改（下次同步会被覆盖）。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_CMD="${NODE_CMD:-node}"
CLAUDE_CMD="${CLAUDE_CMD:-claude}"
SERVER_PATH="$SCRIPT_DIR/node_modules/@aike1202/swagger-mcp-server/build/index.js"
SERVICES_FILE="${SWAGGER_SERVICES_FILE:-$SCRIPT_DIR/services.conf}"

# 注册前确保 loader.js 补丁在（URL 截断 / 单引号 example 修复）。
if ! "$NODE_CMD" "$REPO_ROOT/scripts/patch-swagger-mcp.mjs"; then
  echo "loader.js 补丁失败，中止注册" >&2
  exit 1
fi

if [ ! -f "$SERVER_PATH" ]; then
  echo "找不到 $SERVER_PATH —— 请先在 swagger-mcp-server 目录下跑 yarn 装依赖" >&2
  exit 1
fi

if [ ! -f "$SERVICES_FILE" ]; then
  echo "找不到服务清单 $SERVICES_FILE —— 请从 example/swagger-services.conf 复制一份并填写" >&2
  exit 1
fi

args=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"                       # 容忍 CRLF
  case "$line" in ''|'#'*) continue ;; esac
  args+=("$line")
done < "$SERVICES_FILE"

if [ ${#args[@]} -eq 0 ]; then
  echo "$SERVICES_FILE 里没有有效服务（每行一条 服务名=地址）" >&2
  exit 1
fi

case "$CLAUDE_CMD" in
  */*|*\\*)
    if [ ! -e "$CLAUDE_CMD" ]; then
      echo "找不到 claude 可执行文件：$CLAUDE_CMD" >&2
      exit 1
    fi
    ;;
  *)
    if ! command -v "$CLAUDE_CMD" >/dev/null 2>&1; then
      echo "找不到 claude 命令：$CLAUDE_CMD（请确认 Claude Code CLI 已安装，且在有 PATH 的终端里运行）" >&2
      exit 1
    fi
    ;;
esac

# 先确认 claude 真能启动，避免 remove 成功、add 失败后把已有注册弄丢。
if ! "$CLAUDE_CMD" --version >/dev/null 2>&1; then
  echo "claude 无法执行：$CLAUDE_CMD（请先在普通终端里确认 claude --version 可用）" >&2
  exit 1
fi

"$CLAUDE_CMD" mcp remove --scope user swagger-multi >/dev/null 2>&1 || true
"$CLAUDE_CMD" mcp add --scope user swagger-multi -- "$NODE_CMD" "$SERVER_PATH" "${args[@]}"

echo "已注册 ${#args[@]} 个 swagger 服务到 swagger-multi（重启 Claude Code 生效）"
