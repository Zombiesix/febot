# 参与贡献

感谢你有兴趣参与 febot。这个项目还处在早期，**一个可复现的 Issue 和一段诚实的反馈**和代码一样有价值。

参与前请先读 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)；安全问题请走私密渠道（[SECURITY.md](SECURITY.md)），不要开公开 Issue。

## 先读什么

| 想做的事 | 先看 |
| --- | --- |
| 搞清楚它是什么、边界在哪 | [README.md](README.md)、[README.en.md](README.en.md) |
| 知道接下来要做什么 | [ROADMAP.md](ROADMAP.md) |
| 从简单的地方入手 | 带 `good first issue` 标签的 Issue |
| 改流水线行为 | [.claude/commands/pipeline.md](.claude/commands/pipeline.md)、[.claude/agents/](.claude/agents/) |
| 改工作台 | [xiaoqian-manager/README.md](xiaoqian-manager/README.md) |
| 改索引器 | [code-indexer/README.md](code-indexer/README.md) |
| 改桌面端 | [desktop/README.md](desktop/README.md) |

## 环境搭建

**前置**：Node ≥ 22.22、yarn 1.22.19、Python 3.x（脚本只用标准库）、Git。Windows 上请用 **Git Bash** 跑 shell 脚本。Docker 仅 Hindsight 需要，可不装。

```bash
git clone https://github.com/<your-fork>/febot.git
cd febot
yarn setup
```

`yarn setup` 会从 `example/` 复制配置模板，并安装 `code-indexer` / `xiaoqian-manager` / `swagger-mcp-server` / `desktop` 的依赖。**目标文件已存在时跳过，不会覆盖**，重复执行是安全的。

swagger 服务不在 `swagger-mcp-server/services.conf` 手填，而是配置在 `febot.config.json` 的 `repositories[].swagger`（`{ name, url }`），再用 `yarn swagger` 汇总生成 `services.conf`、打 MCP 补丁，并维护项目级 `.mcp.json`（launcher 启动时读 `services.conf`）。

> 仓库约定：**不要改 node / npm / yarn 版本**，也不要提交 `.nvmrc` / `engines` 之类的版本锁定。涉及 `node_modules` 的安装请说明原因。

## 常用命令

```bash
yarn dev                 # 工作台 + runner，http://localhost:3010
yarn xiaoqian            # 只起工作台
yarn runner              # 只起流水线 runner（127.0.0.1:3011）
yarn desktop:dev         # 桌面端开发模式

yarn recon <别名>         # 生成需求的事实底稿
yarn locate <别名>        # 确定性定位候选文件
yarn feed --plan <文件>   # 接入一条需求
yarn swagger             # 按 febot.config.json 汇总并维护项目级 swagger-multi MCP
yarn index:query <cmd> <repo>   # 查询代码索引
yarn assistant:probe     # 助手侧端到端探针
```

## 提交 PR 前跑什么

在仓库根依次执行，**全部通过再提 PR**（CI 跑的是同一组命令）：

```bash
yarn --cwd xiaoqian-manager lint
yarn --cwd code-indexer typecheck
yarn --cwd desktop typecheck
yarn --cwd desktop test
```

说明：

- `xiaoqian-manager` 用 ESLint；`code-indexer` 与 `desktop` 用 `tsc --noEmit`；单测目前只在 `desktop/tests/unit/`（Vitest）。
- 现有代码里可能存在个别 warning，**不要为了追求 0 warning 顺带改无关文件**。
- 没有统一的格式化工具，**跟随所在文件的现有风格**（缩进、引号、命名、注释密度）。

## 分支与 PR

1. Fork 仓库，从 `dev` 切出特性分支：`feat/<简短描述>`、`fix/<简短描述>`、`docs/<简短描述>`。
2. 保持 PR 聚焦：一个 PR 只做一件事；避免顺带重构无关代码。
3. PR 描述里写清：**动机 / 改了什么 / 怎么验证**。涉及 UI 的附截图或 GIF。
4. Commit message 用 `type: 摘要` 的形式（`feat` / `fix` / `docs` / `refactor` / `test` / `chore`），与现有历史保持一致。
5. PR 目标分支是 `dev`（`master` 只用于发布）。合并前 CI 必须全绿。
6. 大改动先开 Issue 对齐方案，别直接写几千行。

## 怎么加一个任务来源

任务来源有两个层次，**大多数情况下不需要改代码**。

### 1. 自定义脚本来源（推荐，零代码改动）

按 [README §9.2](README.md#92-自定义任务来源脚本) 的格式准备一个文件夹：

```text
my-source/
  febot.source.json
  fetch-tasks.mjs       # stdin / FEBOT_INPUT 收参数，stdout 输出 { "tasks": [...] }
  complete-task.mjs     # 可选：远程标记完成
```

然后在「设置 → 任务来源」上传，或手工放到 `xiaoqian-manager/data/task-sources/<sourceId>/current/`。
字段白名单、退出码、超时与输出上限见 README §9.2；**不认识的字段会被丢弃**，完成脚本必须幂等。

### 2. 内置来源（需要改代码）

1. 在 `xiaoqian-manager/lib/domain/task-source.ts` 确认 `TaskSource` 接口。
2. 新增 `xiaoqian-manager/lib/server/task-sources/<name>.ts`，实现 `fetchTasks()`（以及可选的完成逻辑）。
3. 在 `xiaoqian-manager/lib/server/task-sources/registry.ts` 的 `listTaskSources()`、`getTaskSource()`、`listTaskSourceSummaries()` 三处登记。
4. 给 `lib/server/task-sources/` 下的映射补单测（如涉及解析），并在设置页/README 补说明。

> 同步是**本地全量合并**：只新增和更新，不删除本地任务，也不覆盖人工填写的字段。接入时请保持这个语义。

## 怎么加一个 subagent

流水线的角色都在 `.claude/agents/` 下，每个是一个带 frontmatter 的 Markdown：

```markdown
---
name: my-agent
description: 一句话说明它干什么、什么时候该被调用。
tools: Read, Glob, Grep
permission: acceptEdits
maxTurns: 20
background: false
---

<系统提示：输入是什么、输出什么、边界在哪>
```

接入步骤：

1. 新建 `.claude/agents/my-agent.md`，frontmatter 与正文都按现有 agent 的风格写。
2. 在 `.claude/commands/pipeline.md` 增加委派模板和阶段流向（说明输入文件、输出文件、失败时怎么分流）。
3. 如果引入了新的阶段或状态迁移，同步修改 `scripts/advance.mjs` 的状态机，并补对应文档（README §2、§11）。
4. **输出契约**：subagent 最后一条消息必须是**恰好一行 JSON**（无代码围栏），字段与现有 `planner` / `coder` / `reviewer` 保持一致，方便 orchestrator 解析。
5. **权限最小化**：reviewer 只读、不给 Bash；需要跑命令的只有 coder。不要给 subagent 写远程的权限。

改完先在本地跑一条真实需求（或 `demo` 数据）走完整流程，确认断点续跑与 blocker 回路没坏。

## 怎么给 code-indexer 加能力

- 解析逻辑在 `code-indexer/src/`（如 `events.ts`、`stores.ts`、`permissions.ts`、`storage.ts`），查询层在 `src/query/`，CLI 在 `bin/cli.mjs`。
- 新能力要**带 evidence 与「说不清」的出口**：解析不出的东西输出 `reason` / `unresolved*` / warning，不静默丢弃。
- 改动后至少跑 `yarn --cwd code-indexer typecheck`，并用 `node bin/cli.mjs stats <repo>` 与 `warnings <repo>` 在一个真实 Vue3 仓上核对。
- 不要为了「看起来完整」输出猜测结果——索引器的错误会直接变成 Agent 的错误结论。

## Issue 规范

提 Issue 前先搜索是否已有同类问题。请使用对应模板：

- **Bug**：环境（OS / Node / yarn / 目标仓框架）、复现步骤、期望 vs 实际、日志或截图。
- **Feature**：要解决的问题、你的使用场景、可选方案；不要只写「加个 XX 功能」。
- **Usage question**：贴出 `febot.config.json` 的**脱敏**片段和报错原文；**不要贴 cookie / 密码 / API key**。

## 行为边界

- 不要提交任何真实业务名、内部域名、账号、cookie、token、API key。
- 不要把 `node_modules`、`.next`、`dist`、`data/` 或个人配置文件加进提交。
- 不要用 AI 生成大量低质量 PR 刷贡献；每个 PR 需要能解释设计意图。