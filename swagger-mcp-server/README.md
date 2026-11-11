# swagger-multi MCP 项目级配置说明

本文档说明 `swagger-multi` 如何按 **febot 项目级**（仓库根 `.mcp.json`）注册，以及期间发现并修复的包 bug、配置结构和使用方法。

---

## 1. 背景与目标

- swagger 网关通常要求带 `group` 参数，例如 `/v2/api-docs?group=defaultGroup`、`/v2/api-docs?group=1-第一组`；不带 `group` 的 `/v2/api-docs` 多数会 404。
- 目标：让所有**从 febot 根目录启动**的 Claude Code 会话（包括流水线 `claude "/pipeline ..."`）都能用 `mcp__swagger-multi__*`，同时不动用户级全局配置。

## 2. 怎么配（配置驱动）

1. 在仓库根 `febot.config.json` 的 `repositories[].swagger` 里按仓配置服务：
   `{ "name": "服务名", "url": "http://host/appswagger/v2/api-docs?group=分组" }`。
   也可以启动 `xiaoqian-manager`，在「设置 → 仓库」里每行填 `服务名=api-docs 地址`。
2. 跑 `yarn swagger`：读配置 → 校验 → 汇总生成 `swagger-mcp-server/services.conf` → 打 loader 补丁 → 确保仓库根 `.mcp.json` 里 `swagger-multi` 指向 `scripts/swagger-mcp-launcher.mjs`。
3. 重启已打开的 Claude Code 会话，`mcp__swagger-multi__*` 才会生效。

`services.conf` 是**生成物**，不要手改；要增删服务改配置后重新 `yarn swagger`。其它命令：

- `yarn swagger --dry-run`：只打印汇总结果，不落盘；
- `yarn swagger --check`：检查清单、loader 补丁、`.mcp.json` 是否一致（0/1/6）；
- `yarn swagger:patch`：只打 loader 补丁（幂等）；
- `bash swagger-mcp-server/update_global_mcp.sh`：**可选**，额外建一份用户级全局注册（给不在 febot 根目录启动的会话用；需要能执行 `bash` 和 `claude`）。

项目级配置只有一份静态文件 `.mcp.json`，内容固定为：

```json
{
  "mcpServers": {
    "swagger-multi": {
      "type": "stdio",
      "command": "node",
      "args": ["scripts/swagger-mcp-launcher.mjs"],
      "env": {}
    }
  }
}
```

`swagger-mcp-launcher.mjs` 启动时读 `swagger-mcp-server/services.conf`，把每行 `服务名=URL` 转成上游 server 的 argv。因此：

- **改服务不用改 `.mcp.json`，也不用重建 MCP 注册**，只重跑 `yarn swagger`；
- 注册不再经过 Git Bash / `claude mcp`，不会再报「全局 MCP 注册失败」。

### 批准与生效范围

- `.mcp.json` 属于 project scope，Claude Code 首次会要求批准。`yarn swagger` 会把 `swagger-multi` 写进 `.claude/settings.local.json` 的 `enabledMcpjsonServers`，pipeline 这类无人值守会话就不会卡在批准弹窗。
- 只有**从 febot 根目录启动**的会话会加载这份配置；直接在 `gitlab/<仓库>` 里打开 Claude Code 不会加载 febot 的 `.mcp.json`。需要那种用法时，再额外跑一次可选的 `update_global_mcp.sh`。

> 注意：不用 `npx -y @aike1202/swagger-mcp-server`，因为官方包存在解析 bug（见第 4 节），必须运行本地的补丁版。

## 3. 服务清单

服务名和分组完全由你团队的 swagger 网关决定，配置写在 `febot.config.json` 的 `repositories[].swagger`（`services.conf` 只是生成物）。两个常见坑：

- **必须带 `group`**：先从网关的 `swagger-resources` 端点（如 `http://<host>:<port>/<app>swagger/swagger-resources`）拿到分组名，再拼 `/v2/api-docs?group=<分组名>`。
- **地址里可能有中文**：配置里写原文即可；`yarn swagger` 写入 `services.conf` 时会用 `encodeURI()` 转成 ASCII（Node 的 http 客户端拒收含中文的 URL）。
- **服务名跨仓唯一**：全局 MCP 以 `name` 为 key，两个仓配了不同 URL 的同名服务会被 `yarn swagger` 报错拦下。

## 4. 修复的 Bug（`@aike1202/swagger-mcp-server@1.2.0`）

本地补丁安装在：

```
<仓库根>/swagger-mcp-server/node_modules/@aike1202/swagger-mcp-server/build/services/loader.js
```

### Bug 1：URL 解析截断（group 参数丢失）

- **位置**：`loader.js` 的 `parseArgs()`
- **原代码**：
  ```js
  const [name, url] = arg.split("=", 2);
  ```
  `split("=", 2)` 只保留前两段，URL 中第二个 `=` 之后的内容被丢弃。例如：
  `demo-default=http://.../v2/api-docs?group=defaultGroup` → URL 变成 `http://.../v2/api-docs?group`（丢了 `=defaultGroup`），请求返回 404。
- **修复**：改为只按第一个 `=` 切分，完整保留 URL：
  ```js
  const eqIdx = arg.indexOf("=");
  const name = arg.slice(0, eqIdx);
  const url = arg.slice(eqIdx + 1);
  ```

### Bug 2：非法 JSON 文档解析失败（demo 服务）

- **现象**：`demo` 的 swagger 文档含有单引号数组，例如 `"example":['2024-10-16','2024-10-17']`，不是合法 JSON。axios 的 `JSON.parse` 失败，返回原始字符串，导致 `list_endpoints` 等工具抛 "Cannot convert undefined or null to object"。
- **修复**：在 `getDoc()` 抓取后，若返回的是字符串则修复单引号 example 数组再解析：
  ```js
  doc = response.data;
  if (typeof doc === "string") {
    const repaired = doc.replace(/"example"\s*:\s*\[[^\]]*?\]/g, (m) =>
      m.replace(/'/g, '"'),
    );
    doc = JSON.parse(repaired);
  }
  ```

### 已验证

- 多数服务的文档是合法 JSON，无需 Bug 2 修复。
- 少数服务（返回单引号数组 `example` 的那种）会踩 Bug 2，修复后 `list_services` / `list_endpoints` / `get_endpoint_details` 均正常。

## 5. 使用说明

重启 Claude Code（或重新加载 MCP）后生效。可用工具：

| 工具                               | 说明                                    |
| ---------------------------------- | --------------------------------------- |
| `list_services`                    | 列出所有服务                            |
| `list_endpoints`                   | 列出某服务全部接口（需 `service_name`） |
| `search_apis`                      | 按关键字搜索接口                        |
| `get_endpoint_details`             | 获取接口完整定义（参数、响应 schema）   |
| `get_schema` / `list_schemas`      | 获取/列出 schema                        |
| `debug_endpoint` / `generate_curl` | 调试请求 / 生成 curl                    |

服务名就是你写在 `services.conf` 里的那个名字（`=` 左边的内容）。

## 6. 接口示例

以某服务 `example-a`（分组 `defaultGroup`）下的 `POST /example/module/import` 为例：

| 项       | 值                                                                               |
| -------- | -------------------------------------------------------------------------------- |
| 路径     | `/example/module/import`                                                         |
| 方法     | POST                                                                             |
| 接口名   | 模块导入                                                                         |
| 请求格式 | `multipart/form-data`                                                            |
| 参数     | `file`（formData，文件类型，swagger 标注非必填）                                 |
| 返回     | HTTP 200，`通用返回结果«object»`（含 code/data/msg/success/errorData/subErrors） |

同分组相关路径（`/example/module/*`）：`add`、`update`、`delete/{id}`、`list`、`searchPageByName`、`export`、`import`。

## 7. 维护注意事项

- **补丁位于 `node_modules` 内**，若重新安装 `@aike1202/swagger-mcp-server`，loader.js 的补丁会被覆盖。四层自动恢复：该包 `postinstall`、根 `yarn setup` 末尾、`yarn swagger` 注册前、`update_global_mcp.sh` 注册前，都会运行 `node ../scripts/patch-swagger-mcp.mjs`（幂等）。
- 官方包更新到修复该 bug 的新版本后，可改回 `npx -y @aike1202/swagger-mcp-server` 并删除本地补丁；届时补丁脚本会以 exit 6 报「代码模式失配」，不会静默跳过。
- `yarn swagger` 可重复执行：它按配置重建 `services.conf`，并确保项目级 `.mcp.json` 指向 launcher。
- swagger 地址/分组可能随后端变更，变更后改 `febot.config.json` 再跑一次 `yarn swagger` 即可。
