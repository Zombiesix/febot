# swagger-multi MCP 全局配置说明

本文档记录将 `swagger-multi` MCP 从项目级配置迁移为**用户全局配置**的完整过程，以及期间发现并修复的包 bug、最终配置结构和使用方法。

---

## 1. 背景与目标

- swagger 网关通常要求带 `group` 参数，例如 `/v2/api-docs?group=defaultGroup`、`/v2/api-docs?group=1-第一组`；不带 `group` 的 `/v2/api-docs` 多数会 404。
- 目标：把本仓安装的 `swagger-mcp-server` 注册成当前电脑用户的**全局 MCP**，按分组配好你要用的服务。

## 2. 怎么配（一条命令）

1. `yarn setup` 会在 `swagger-mcp-server/` 下生成 `services.conf`（来自 `example/swagger-services.conf`）。
2. 按注释填服务清单，一行一条 `服务名=api-docs 地址`。
3. 跑 `bash swagger-mcp-server/update_global_mcp.sh`，它会 `claude mcp remove` 再 `claude mcp add --scope user swagger-multi`，服务名与地址全部取自 `services.conf`。

最终写入的是用户级配置文件 `%USERPROFILE%\.claude.json`（Windows）/ `~/.claude.json`，结构如下：

```json
{
  "mcpServers": {
    "swagger-multi": {
      "command": "node",
      "args": [
        "<仓库根>/swagger-mcp-server/node_modules/@aike1202/swagger-mcp-server/build/index.js",
        "example-a=http://your-swagger-host:9080/aswagger/v2/api-docs?group=defaultGroup",
        "example-b=http://your-swagger-host:9080/bswagger/v2/api-docs?group=1-第一组"
      ]
    }
  }
}
```

- **command**：`node`
- **第一个 arg**：补丁版 MCP 服务器入口（本目录下安装的包）
- **其余 arg**：`服务名=swagger文档URL`，数量与你 `services.conf` 的行数一致

> 注意：不用 `npx -y @aike1202/swagger-mcp-server`，因为官方包存在解析 bug（见第 4 节），必须运行本地的补丁版。

## 3. 服务清单

服务名和分组完全由你团队的 swagger 网关决定，写在 `swagger-mcp-server/services.conf` 里（该文件不入库）。两个常见坑：

- **必须带 `group`**：先从网关的 `swagger-resources` 端点（如 `http://<host>:<port>/<app>swagger/swagger-resources`）拿到分组名，再拼 `/v2/api-docs?group=<分组名>`。
- **地址里可能有中文**：`services.conf` 里写原文即可，脚本原样透传；URL 编码由 swagger 服务端处理。

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
  `icis-default=http://.../v2/api-docs?group=defaultGroup` → URL 变成 `http://.../v2/api-docs?group`（丢了 `=defaultGroup`），请求返回 404。
- **修复**：改为只按第一个 `=` 切分，完整保留 URL：
  ```js
  const eqIdx = arg.indexOf("=");
  const name = arg.slice(0, eqIdx);
  const url = arg.slice(eqIdx + 1);
  ```

### Bug 2：非法 JSON 文档解析失败（icis 服务）

- **现象**：`icis` 的 swagger 文档含有单引号数组，例如 `"example":['2024-10-16','2024-10-17']`，不是合法 JSON。axios 的 `JSON.parse` 失败，返回原始字符串，导致 `list_endpoints` 等工具抛 "Cannot convert undefined or null to object"。
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

- **补丁位于 `node_modules` 内**，若对该目录执行 `yarn`/`npm install` 重新安装 `@aike1202/swagger-mcp-server`，loader.js 的补丁会被覆盖，需要重新应用。可用 `patch-package` 固化补丁（`postinstall` 自动恢复）。
- 官方包更新到修复该 bug 的新版本后，可改回 `npx -y @aike1202/swagger-mcp-server` 并删除本地补丁目录。
- `update_global_mcp.sh` 可重复执行：它按 `services.conf` 重建全局 MCP 配置。
- swagger 地址/分组可能随后端变更，变更后改 `services.conf` 再跑一次脚本即可。
