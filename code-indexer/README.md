# code-indexer

Vue3 仓库静态索引器：扫描目标仓生成 ProjectMap（路由表 / 业务模块 / API 域 / 组件图 / 静态告警），供 Claude Code 或其它 Agent 以 MCP 工具或 CLI 的方式消费。

npm 依赖仅 typescript、@vue/compiler-sfc、@vue/compiler-dom（peerDependencies）。

## CLI

```bash
node bin/cli.mjs <cmd> <repo> [...args]
# 或全局链接后: xiaoyou-index <cmd> <repo>
```

| 命令                                     | 说明                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `scan <repo>`                            | 完整 ProjectMap JSON（体积大，谨慎直接喂模型）                          |
| `map <repo>`                             | 项目全貌摘要（路由/模块/API 域/store/事件/权限/存储/告警）              |
| `trace <repo> <route\|module>`           | 追一条业务链路：路由 → 组件树 → API → store/事件/权限/存储              |
| `trace-event <repo> <component> <event>` | 谁 emit → 谁接 → handler 里干了什么（子→父反向通道）                    |
| `trace-state <repo> <store>[.<field>]`   | 谁读、谁写某个 store 字段（不传字段则列全部）                           |
| `channels <repo> [--kind K]`             | 状态与事件通道总览。K = store\|event\|permission\|guard\|storage\|ws    |
| `modules <repo> [<module>]`              | 模块间关系：模块→模块 / →共享层 / 共享 store / 共用 API 域 / 跨模块事件 |
| `warnings <repo> [--kind K] [--limit N]` | 静态告警列表                                                            |
| `search <repo> <keyword>`                | 按关键词查路由/模块/端点                                                |
| `stats <repo>`                           | 扫描规模与耗时（探活）                                                  |
| `rescan <repo>`                          | 清缓存重扫                                                              |
| `serve <repo>`                           | 启动 stdio MCP server                                                   |

全部输出 JSON；加 `--compact` 输出紧凑单行。

### 覆盖范围（v2）

除路由 / 组件图 / API 域外，还抽 **状态与事件链路**：

- **Pinia store** —— 对象式 / setup 式 / 模块级 `reactive` 单例；谁读谁写每个字段
- **组件 emit** —— 四种声明形态（`defineEmits<T>()` / `defineEmits([...])` / Options API `emits` 选项 /
  `setup(props,{emit})` 解构）；模板 `v-on` 与 `v-model` 展开；子→父反向边
- **权限码台账** —— 路由 meta / 模板指令 / inline `hasPermission("code")` 三种引用；
  并标注判定实现在**本仓**还是 **qiankun 宿主仓**
- **存储通道** —— `localStorage` / `sessionStorage` / cookie 的 key 台账（含封装层与 store↔storage 桥）
- **WebSocket / SSE** —— 连接点定位与消息分发字段（实测极少，只做定位）
- **模块间关系** —— 组件引用汇总成模块级；**模块→模块** 与 **模块→共享层**（`src/components` 之类）
  分开列，因为实测后者能占近半；另含共享 store / 共用 API 域 / 跨模块事件

> 模块清单有两个形态：`ModuleInfo.components` 是**扁平清单**（模块目录下全部 SFC），
> `ModuleInfo.tree` 是**渲染树**（从入口组件展开）。跨模块关系走 `moduleGraph`。
>
> `pageDirs` 会收集**所有**存在的页面目录（`page`/`pages`/`view`/`views`）——
> 有的仓同时有 `src/page` 与 `src/view`，只取第一个会让后者整片页面不属于任何模块。

### 「说不清」的出口

解析不出的一律**带原因 + evidence** 输出，不静默丢弃：
`unresolvedFns[].reason`（端点）、`eventEdges[].unmatched` / `passthrough`（事件）、
`dynamic-routes` / `dynamic-storage-key` / `dynamic-children`（告警）、`alias.unresolved`（别名求值）。

注意：Git Bash 下传 `/route-path` 会被 MSYS 转成 Windows 路径，加 `MSYS_NO_PATHCONV=1` 前缀。

## MCP server 接入（Claude Code）

在目标项目的 `.mcp.json` 中加入：

```json
{
  "mcpServers": {
    "xiaoyou-indexer": {
      "command": "node",
      "args": [
        "<仓库根>/code-indexer/bin/cli.mjs",
        "serve",
        "<repoRoot>/<vue3-repo>"
      ]
    }
  }
}
```

工具清单：

- `get_project_map` — 项目全貌（讲解/定位前先调它）
- `trace_flow(target)` — 追业务链路，返回组件树、后端端点、store/事件/权限/存储
- `trace_event(component, event)` — 谁 emit → 谁接 → handler 干了什么
- `trace_state(target)` — 谁读谁写某个 store 字段
- `list_channels(kind?)` — 状态与事件通道总览
- `list_module_graph(module?)` — 模块间关系
- `list_warnings(kind?, limit?)` — 静态告警
- `search_index(keyword)` — 关键词检索
- `rescan` — 清缓存重扫（目标仓变更后用）

### 缓存

扫描结果按仓路径进程内缓存，默认 TTL 300 秒；`XIAOYOU_TTL_MS=0` 禁用缓存，`rescan` 工具可强制重扫。v1 约定单 server 单仓：多仓 = 在 `.mcp.json` 注册多个 server。

## 作为 npm 包（bundler 场景）

```ts
import { scanRepo, getScan } from "code-indexer";
import { projectOverview, traceFlow } from "code-indexer/query";
import type { ProjectMap } from "code-indexer/types";
```

exports 白名单只暴露 `. / ./types / ./endpoint-types / ./via-label / ./query`；产物为 ESM + 独立 `dist/types` 声明，供 Next/webpack 等 bundler 消费。CLI 与 MCP 入口走 tsx 直跑 TS 源，无需构建即可使用。

## 开发

```bash
yarn install
yarn typecheck   # tsc --noEmit
yarn build       # 产出 dist/（消费方经 file:/npm 链接后需重装依赖同步拷贝）
```

## 消费方（file: 依赖）注意事项

yarn v1 的 `file:` 是整目录拷贝（含该包自身 node_modules）。消费方在改完本包后需 `rm -rf node_modules/<pkg> && yarn install --check-files` 强制同步。本包以 peerDependencies 声明 typescript/@vue/compiler-\*，消费方需自备这些依赖。
