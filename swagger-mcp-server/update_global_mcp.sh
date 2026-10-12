#!/usr/bin/env bash
set -e

# 把本仓的 swagger-mcp-server 注册成用户级 MCP 服务（名字固定 swagger-multi）。
#
# 服务清单从 swagger-mcp-server/services.conf 读（一行一条 `服务名=api-docs 地址`，
# `#` 开头是注释）。该文件不入库，由 `yarn setup` 从 example/swagger-services.conf 生成后自行填写。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_CMD="${NODE_CMD:-node}"
SERVER_PATH="$SCRIPT_DIR/node_modules/@aike1202/swagger-mcp-server/build/index.js"
SERVICES_FILE="${SWAGGER_SERVICES_FILE:-$SCRIPT_DIR/services.conf}"

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

claude mcp remove --scope user swagger-multi >/dev/null 2>&1 || true
claude mcp add --scope user swagger-multi -- "$NODE_CMD" "$SERVER_PATH" "${args[@]}"

echo "已注册 ${#args[@]} 个 swagger 服务到 swagger-multi（重启 Claude Code 生效）"
