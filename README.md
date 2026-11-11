<div align="center">

# febot

**多 Agent 前端研发工作台** —— 需求排成队，人只负责梳理需求和拍板方案；编码、审查、修复交给 SubAgent 团队，多仓库可同时推进。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.22-339933)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[中文](README.md) · [English](README.en.md) · [快速开始](#快速开始) · [架构](#架构) · [路线图](ROADMAP.md) · [更新日志](CHANGELOG.md) · [参与贡献](CONTRIBUTING.md)

</div>

<p align="center"><img src="docs/assets/demo-60s.gif" alt="60 秒演示：需求排队 → 拍板计划 → 待审队列 → diff 审阅" width="740"></p>

## 三个关键点

|                         | 常见做法                                 | febot                                                                               |
| ----------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| **需求不再散**          | 十条需求十条消息，最后不知道谁在改哪个仓 | 需求队列 + 状态机 + `tasks.md`；跨仓并行、同仓串行，一眼看清每个需求的落点           |
| **人只做决策**          | 边聊边改，改完才发现方向错了             | 人只卡门禁：计划、文件白名单、diff；每次拍板落进 `decisions.md`，留完整审计链        |
| **Agent 团队分工**      | 一个 Agent 又写又审，等于自己批自己      | planner / coder / reviewer 分离：reviewer 只读 diff，有 blocker 必须回改（≤ 2 轮）   |

## 界面

截图来自 `yarn demo` 的零配置演示数据（`example/demo/`）。

<p align="center">
  <img src="docs/assets/ui-queue.png" alt="需求队列：状态、进度、待处理提醒" width="49%">
  <img src="docs/assets/ui-plan.png" alt="计划拍板：人确认 AI 整理出的计划描述" width="49%">
</p>
<p align="center">
  <img src="docs/assets/ui-review.png" alt="diff 审阅：按文件看改动，逐项接受或打回" width="100%">
</p>

## 快速开始

**前置**：Node ≥ 22.22、yarn 1.22.19、Git。Windows 上用 Git Bash 跑 shell 脚本。

```bash
git clone https://github.com/Zombiesix/febot.git
cd febot
yarn setup     # 从 example/ 生成配置模板，并安装四个子项目的依赖
yarn dev       # 起工作台，浏览器打开 http://localhost:3010
```

首次启动会弹出可视化设置：扫描仓库根目录、登记目标仓与分支、填任务来源。**配置留空也能启动并看到设置向导；配好一个仓库即可跑通第一条需求。**
完整步骤（配置项逐条解释、Hindsight 记忆层、常见报错）见下方 [第〇部分](#第〇部分快速开始新环境从零跑起来)。

## 架构

![febot 架构：人卡门禁 / 工作台 / AgentTeam / 事实层与记忆层](docs/assets/architecture.png)

- **工作台** `xiaoqian-manager`：需求队列、计划拍板、审阅提交、工时回填（①④⑤ 步）。
- **AgentTeam**：`/pipeline` 剧本 + planner / coder / reviewer 三个 subagent（②③ 步）。**文件即接口**——交接靠 `state.json` / `plan.md` / `decisions.md` 落盘，不靠对话历史。
- **事实层**：`code-indexer` 现算前端代码事实（路由 / 组件树 / API 域 / store / 权限 / 存储）；`swagger-mcp-server` 提供实时 API 文档。
- **记忆层**：Hindsight 按 bank 隔离——流水线存研发经验，业务助手存业务知识，互不污染。

**和「直接用 Claude Code」的流程差异**：差别不在模型，而在交付结构——谁卡门禁、上下文放在哪、谁审谁写。

![直接用 Claude Code vs. febot 的流程差异](docs/assets/comparison.png)

**能力边界（诚实版）**：跨仓并行、**同仓串行**（共用主仓工作区，为的是随时能起 dev server 验收）；Agent 永远不 push，远程写操作留给人；当前只支持 Vue3 仓库，runner 目前只有 Claude Code。设计权衡见下方第一部分，后续方向见 [ROADMAP.md](ROADMAP.md)。

---

## 目录

- 第〇部分：快速开始（新环境从零跑起来）
- 第一部分：研发流水线（①）
- 第二部分：业务助手 assistant（②）
- 第三部分：底座与周边
- 第四部分：Hindsight 记忆系统
- 第五部分：全景与定制

---

`febot`（**fe** 前端 + **bot** 自动化代理）是一个**前端研发工作区**，里面有两条**互相独立**的主线，共用一个「看代码 + 记知识」的底座：

| 主线                         | 干什么                                                   | 入口                                                       | 谁在用           |
| ---------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- | ---------------- |
| **① 研发流水线**（5 步闭环） | 获取需求 → 规划 → AI 编码/审查/修复 → 提交合并 → 填工时  | [xiaoqian-manager](xiaoqian-manager/)（宿主）+ `/pipeline` | 小前端           |
| **② 业务助手 assistant**     | 随时问业务：这个模块干嘛的、这个字段谁改的、权限在哪判的 | Claude Code 内 `/assistant`                                | 任何要懂业务的人 |

两条线**不互调、不共享 bank**，但都站在同一层底座上：

- **事实层**：`code-indexer` 静态索引器 —— 路由 / 组件树 / API 域 / store / 事件 / 权限 / 存储。
- **记忆层**：本机 Docker 里的 Hindsight（见第四部分 §12–§15）—— 流水线存「研发流程经验」，助手存「业务知识」，**两套 bank 分开**。

其余：`swagger-mcp-server`（实时 API 文档）供流水线用；[desktop/](desktop/) 是可选的 Windows 桌面壳，把宿主和 runner 装成双击即用的应用（见 §16）。

---

# 第〇部分：快速开始（新环境从零跑起来）

## 0.1 前置

| 依赖        | 版本 / 说明                                                                |
| ----------- | -------------------------------------------------------------------------- |
| **Node.js** | **22.22+**（实测 25.x 可用；`xiaoqian-manager` 依赖的 `chokidar@6` 要求 22.22 起） |
| **yarn**    | **1.22.19**（v1，全仓库统一；`package.json` 已写 `packageManager`）        |
| **Python**  | 3.x（脚本只用标准库，**不需要 pip 安装任何东西**）                         |
| **Git**     | 需要能 clone 你的目标仓；Windows 上建议用 **Git Bash** 跑 shell 脚本       |
| **Docker**  | **仅 Hindsight 需要**（可选）。不装则记忆层降级，其余功能照常              |

> 仓库自带铁律：**禁止更改 node / npm / yarn 版本**。本 README 只说明要求，不提供 `.nvmrc` / `engines` 强制。

## 0.2 安装

```bash
git clone <本仓库地址> febot
cd febot
yarn setup
```

`yarn setup` 会做两件事：

1. **从 [example/](example/) 下的模板生成一批本地文件**（已存在则跳过，**绝不覆盖**你填过的内容）：

   | 模板（`example/`）       | 生成物                             | 用途                                             |
   | ------------------------ | ---------------------------------- | ------------------------------------------------ |
   | `febot.config.json`      | `febot.config.json`                | **主配置**：仓库根 / 仓库登记表（仓库·项目·分支·Jenkins）/ 协作平台（含账号密码） |
   | `hindsight.env`          | `scripts/hindsight.env`            | Hindsight 的 LLM / embedding key                 |
   | `tasks.md`               | `tasks.md`                         | 需求元信息表（流水线会往里追加行）               |
   | `file-lock.md`           | `file-lock.md`                     | 并行冲突仲裁表                                   |
   | `claude-settings.json`   | `.claude/settings.json`            | Claude Code 权限规则（含 `archive/` 禁区 deny）  |
   | `swagger-services.conf`  | `swagger-mcp-server/services.conf` | swagger-multi 服务清单（**生成物**，真源是 `febot.config.json` 的 `repositories[].swagger`） |

   生成物**全部 gitignore**，每个团队各填各的；`example/` 下的模板是入库的公共样板，**不要直接改**。
   `services.conf` 由 `yarn swagger` 从 `febot.config.json` 汇总生成，**不要手改**（下次同步会被覆盖）。

2. 安装四个子项目的依赖：`code-indexer` / `xiaoqian-manager` / `swagger-mcp-server` / `desktop`。不需要桌面端时可单独执行 `yarn --cwd desktop install`，或从根 `setup` 里去掉 `desktop`。

### 先看效果：`yarn demo`（不需要任何配置）

装完依赖后，不用填 `febot.config.json`、不用启动 runner，直接：

```bash
yarn demo
```

打开 `http://localhost:3010` 就能看到（3010 被占用时会自动顺延到 3011、3012……，也可以用
`FEBOT_PORT=3050 yarn demo` 指定；演示使用独立的 `.next-demo` 构建目录，可以和你正在跑的 `yarn dev` 并存）：

- **任务队列**：5 个不同阶段的任务，点开「计划」节点可看计划描述与阶段编辑；
- **待审队列**（`/review`）：1 个已完成、带 3 个文件 diff 的会话，可查看 diff、接受/驳回；
- **会话面板**：右侧终端是静态快照，能看 planner / coder 的输出与等待点；
- **已完成任务**：把状态筛选切到「已完成」可看到带代码提交记录的任务。

演示数据来自 [example/demo/](example/demo/)，运行时只写 `.febot/demo-workspace/`（已 gitignore），**不会读写你的
`febot.config.json`、`tasks.json` 或业务仓库**。演示里的「启动流水线 / 提交代码」等动作会明确提示不可用。

> 没有自己的仓库也可以先看：`yarn demo` 会自动把 [example/demo-repo/](example/demo-repo/) 复制成
> `.febot/demo-repo` 并初始化 git（`dev` 分支）；单独重建用 `yarn demo:repo --reset`。

## 0.3 填配置（`febot.config.json`）

这是唯一必填的配置文件，`repoRoot` 相对**本文件所在目录**解析：

```jsonc
{
  "repoRoot": "./gitlab",                    // 目标仓 clone 到哪
  "jenkinsBase": "https://jenkins.example.com/jenkins/job",
  "defaults": {
    "devBranch": "dev-feature",                  // 全局开发基准分支
    "mergeBranch": "dev"                     // 全局合并目标分支（代码提交 cherry-pick 到它）
  },
  "repositories": [                          // 唯一的仓库登记表，其余映射全部派生
    {
      "name": "example-repo-mobile",         // repoRoot 下的仓库目录名
      "devBranch": "dev-feature",                // 可选：覆盖 defaults.devBranch
      "mergeBranch": "dev",                  // 可选：覆盖 defaults.mergeBranch
      "jenkinsJob": "example-job-mobile",    // 可选：URL = jenkinsBase/<job>/build?delay=0sec
      "swagger": [                           // 可选：本仓可用的 swagger 服务（流水线先查代码、再查这里）
        { "name": "example-mobile-default", "url": "http://your-swagger-host:9080/exampleSwagger/v2/api-docs?group=defaultGroup" }
      ],
      "projects": [                          // 一个仓库可对应多个项目名
        { "name": "示例产品 A", "keywords": ["移动端"] }
      ]
    },
    { "name": "example-repo", "projects": [{ "name": "示例产品 A" }] },
    { "name": "example-repo-b", "devBranch": "release", "projects": [{ "name": "示例产品 B" }] }
  ],
  "teamwork": {
    "base": "https://teamwork.example.com",  // 协作平台 origin，也是登录接口的 host
    "username": "你的协作平台用户名",          // 默认过滤人
    "loginName": "你的登录账号",              // cookie 为空时用这对账号密码自动登录
    "password": "前端加密后的密文",            // 原样透传，别换成明文（会累计失败次数）
    "userTag": "",
    "tableId": "",
    "autograph": "",
    "cookie": "",                            // 可选：粘 cookie 可跳过登录
    "users": ["负责人甲", "负责人乙"]          // 团队负责人列表
  },
  "nextDevOrigins": ["192.168.1.100"]         // 局域网用手机访问 dev server 时填
}
```

- **`teamwork` 段留空 = 功能软降级**：不报错、不猜地址，「同步 / 一键更新」不可用，其余照常。
- **`febot.config.json` 是敏感文件**：`cookie` / `password` 都在这，别提交、别贴给别人（它已 gitignore）。

### 接口契约（swagger）

`repositories[].swagger` 配的是**这个仓里能查到的 swagger 服务**，格式 `{ "name": "服务名", "url": "api-docs 地址" }`：

- `name` 是 Agent 调 MCP 时传的 `service_name`，**跨仓全局唯一**；建议带业务前缀（如 `cssd-default`），不同系统重名会报错。
- `url` 必须是 swagger v2 的 `.../v2/api-docs?group=<分组>`；不带 `group=` 多数网关会 404。中文分组名会由脚本自动 URL 编码。
- 配完运行 `yarn swagger`：汇总所有仓库的服务 → 写 `swagger-mcp-server/services.conf` → 打 loader 补丁 → 确保仓库根 `.mcp.json` 的 `swagger-multi` 指向 `scripts/swagger-mcp-launcher.mjs`。服务清单在 MCP 启动时由 launcher 读取，所以**改服务只重跑 `yarn swagger`，不用改 `.mcp.json`、不用重建注册**；已开的 Claude 会话要重启才生效。
- 每次流水线跑 planning/coding 会用 `node scripts/swagger.mjs <别名>` 生成本仓的 `docs/requirements/<别名>/swagger.md`，Agent 按「**先项目源码 → 缺契约再查本仓 swagger → 仍无写 Q**」的顺序工作。仓库没配 swagger 时该文件写「未配置」，流水线照常继续。
- 可以用 `yarn swagger:check` 检查配置生成的清单与 loader 补丁是否一致；`yarn swagger --dry-run` 只打印不落盘。
- `.mcp.json` 是 project scope，只对**从 febot 根目录启动**的会话生效（流水线 runner 的 cwd 就是 febot 根，所以自动可用）；直接在 `gitlab/<仓库>` 里打开 Claude Code 不会加载它。`yarn swagger` 会同时把 `swagger-multi` 加进 `.claude/settings.local.json` 的 `enabledMcpjsonServers`，避免 pipeline 弹批准。想全局可用，可额外跑 `bash swagger-mcp-server/update_global_mcp.sh`。

## 0.4 准备目标仓

把你要改的前端仓 clone 到 `repoRoot` 下，每个仓停在其开发基准分支（`defaults.devBranch`；仓库条目有 `devBranch` 时按覆盖值）：

```bash
cd gitlab
git clone <你的仓库地址> example-repo
cd example-repo && git checkout dev
```

> **基准分支由配置决定**，按优先级取值：`repositories[].devBranch` > `defaults.devBranch`。开工门禁校验主仓 `HEAD ==` 解析出的开发分支。

再填 `repositories[].projects[]`（哪个项目落到哪个仓）—— 它是喂食时唯一的仓库判断依据。解析规则确定、无歧义：项目名精确匹配 → 标题命中该条目 `keywords` 用该条 → 都不命中用该项目下无 `keywords` 的兜底条目；兜底不唯一或没有命中就停下问负责人，不许猜。

以上配置也可以不手改：首次启动 `xiaoqian-manager` 会弹出可视化设置，扫描 `repoRoot` 后逐项填写，保存仍写回 `febot.config.json`（详见 §9.1）。自定义任务来源脚本的格式见 §9.2。

## 0.5 跑起来

```bash
yarn demo         # 演示模式：不填配置、不起 runner，直接看队列/计划/审阅
yarn dev          # 起 xiaoqian-manager :3010
yarn runner       # 流水线 runner（独立进程，启动/读取会话必需）
yarn desktop:dev  # 桌面端窗口（Electron 内拉起 Next + runner，见 §16）
yarn recon <别名>  # 生成某需求的事实底稿 docs/requirements/<别名>/recon.md
yarn feed --plan <计划文件> [--alias R-xxxxxx] [--json] [--dry-run]  # 接入需求（解析/定仓/门禁/脚手架）
```

安装耗时：Windows 11 + 预热 yarn 缓存实测 `yarn setup` 约 64 秒、`yarn demo` 约 5 秒启动
（步骤与环境见 [docs/install-timing.md](docs/install-timing.md)）。3010 被占用时 `yarn demo`
会自动顺延端口，也可用 `FEBOT_PORT=3050 yarn demo` 指定。

浏览器打开 `http://localhost:3010`，右上角「同步」拉需求。

> 桌面端与 `yarn dev` 不能同时运行：Next 16 会检测同目录的已有 dev server。要同时验证，用 `FEBOT_DESKTOP_USE_RESOURCES=1 yarn desktop:dev` 走 `resources/` 生产布局。

## 0.6 可选：Hindsight 记忆层

**推荐：compose 一条命令**（镜像、端口、env-file、数据卷都写在 [docker-compose.yml](docker-compose.yml)）：

```bash
yarn setup                 # 生成 scripts/hindsight.env（已存在则跳过）
# 填 scripts/hindsight.env 里的模型 key
docker compose up -d       # API :8888 / UI :9999
python scripts/ensure-banks.py   # 建 bank + 预填流水线静态规矩
```

**备选：手写 docker run**（不想装 compose 时）：

```bash
# 1) 填 scripts/hindsight.env（模板里有每个变量的来源说明）
# 2) 拉镜像（ghcr.io 在国内被墙，用南大镜像）
docker pull ghcr.nju.edu.cn/vectorize-io/hindsight:latest-slim
# 3) 起容器（与 compose 共用 hindsight-data 卷，可随时切换）
docker run -d --name hindsight --restart unless-stopped \
  -p 8888:8888 -p 9999:9999 \
  --env-file scripts/hindsight.env \
  -v hindsight-data:/home/hindsight/.pg0 hindsight:slim
# 4) 建 bank + 预填流水线静态规矩
python scripts/ensure-banks.py
```

不装也不影响主流程：流水线侧对 Hindsight 是**软降级**（连不上就跳过），助手侧是**硬报错**（怕「以为存了」）。详见第四部分。

## 0.7 常见问题

| 现象 | 原因 / 怎么办 |
| ---- | ------------- |
| 仓库 / 分支下拉是空的 | `febot.config.json` 没填或 `repoRoot` 指向的目录不存在。控制台会打一行 `[config] 未找到 febot.config.json...`。下一步：跑 `yarn setup` 后填写，或在「设置」里初始化；只想看界面就先 `yarn demo` |
| 启动流水线提示 `runner 未启动` | 会话、diff、历史都由独立 runner 提供。下一步：项目根目录另开终端执行 `yarn runner` |
| `yarn demo` 起不来 | 依赖没装（`xiaoqian-manager/node_modules/next` 不存在）。下一步：先 `yarn setup` |
| `yarn recon` 报「tasks.md 不存在」 | 没跑 `yarn setup`，或手工删掉了。从 `example/tasks.md` 复制一份即可 |
| `recon` 报「repo dir not found」 | `repoRoot/<仓库目录名>` 不存在。先 clone，且目录名要和 `tasks.md` 第 5 列一致 |
| 同步报「未配置协作平台账号」 | `teamwork` 段的 `loginName` / `password` / `cookie` 都没填。到设置→任务来源或 `febot.config.json` 补上；用自定义来源时改传该来源 |
| 上传自定义来源报 `febot.source.json 缺少合法 entry` | manifest 缺 `entry`、入口文件不在文件夹里，或路径越界（绝对路径 / `..`） |
| 「一键更新」报 502 | 没配 `teamwork.cookie`，也没填 `teamwork.loginName` / `teamwork.password`。在 `febot.config.json` 的 `teamwork` 段补上账号密码即可自动登录 |
| Git Bash 下 `/xxx` 参数被转成 Windows 路径 | 加 `MSYS_NO_PATHCONV=1` 前缀 |

---

# 第一部分：研发流水线（①）

## 1. 总流程：一条 5 步流水线（宿主 = xiaoqian-manager）

> 所有流程围绕 `xiaoqian-manager` 这个 Web 项目展开。`小前端` = 用这套系统的研发人（同时是协作平台的 `username` 过滤条件）。

```text
 ① 获取需求            ② 规划                ③ 编码+审查+修复(AI)     ④ 提交合并          ⑤ 填写工时
 小前端 点同步         小前端 整理描述         AgentTeam 全自动          小前端 手动         小前端 触发
 ─────────┼─────────────┼─────────────────────┼────────────────────────┼───────────────────┼──────────
           │  协作平台    │  AI 出计划/人工拍板  │  写码 → 审查 → 修复      │  提交/推送/合并     │  回写工时
   xiaoqian │ fetch       │                     │  (blocker ≤2 轮)         │  点完成             │
   -manager │ synced →    │                     │                          │                     │
            │ tasks.json  │                     │                          │                     │
            └────────────┴─────────────────────┴──────────────────────────┴─────────────────────┴──────────
```

| 步骤                                      | 做什么                                                       | 在哪执行                      | 由谁操作          | 说明                                                       |
| ----------------------------------------- | ------------------------------------------------------------ | ----------------------------- | ----------------- | ---------------------------------------------------------- |
| **① 获取需求**                            | 从任务来源（内置协作平台 / 自定义脚本）拉取需求列表/详情入库 | xiaoqian-manager              | 小前端 点击同步   | 按来源参数过滤，落盘 `tasks.json`；只增改、不删本地任务    |
| **② 规划**                                | 小前端整理/修改需求描述 → AI 出实现计划 → 人工拍板           | xiaoqian-manager + `/pipeline` | 小前端 + AI       | `plannedDescription` **必填**；为空时「写代码」▶ 禁用，接口返回 422 |
| **③ 编码+审查+修复**                      | AI 写代码 → 审查 → 修复 blocker                              | febot 家 `/pipeline` 剧本     | AI 全自动         | **只用 code-indexer、swagger-mcp-server 洞察代码**；入口是「写代码」节点的 ▶ |
| **④ 提交合并**                            | 确认 diff 后手工把代码提交、合并到远程                       | xiaoqian-manager 审阅页       | 小前端 点「代码提交」 | 目标仓库/分支由 `repositories[]` 派生；pull → commit → push → cherry-pick → push |
| **⑤ 填写工时**                            | 把本次研发工时写回协作平台                                   | xiaoqian-manager 工时         | 小前端 触发       | 复用协作平台登录态                                         |

> **▶ 在「写代码」节点上**：点击后 `/pipeline` 会话内先产出 AI 计划并等待人工拍板，再进入编码；文档上把计划产物归入第 ② 步。

### 一个重要的边界（③ vs ④）

**AgentTeam（②③）直接在主仓基准分支的工作区里改代码，改动以「未提交」形式留下，绝不做 add / commit / push 远程**：

- 它改的就是 `<repoRoot>/<仓>` 这个**主仓工作区**（停在解析出的基准分支，默认 `dev`，非 master），**不建 worktree、不切分支、不提交**。
- 好处是**人工验收就在这个工作区上跑 dev server**，依赖、`.env`、后端代理、登录态全都现成（人工验收不再单列步骤）。
- **远程提交、push、合并到目标分支**是 ④ 步，由 `小前端` 在 xiaoqian-manager 的**独立审阅页**点「代码提交」完成（含 cherry-pick）。提交基于主仓工作区，且会拒绝分离头指针状态，与这套模型天然一致。
- **「标记完成」（✓）只同步远程任务状态**（内置来源走协作平台、自定义来源走完成脚本），不碰仓库代码；代码提交与标记完成已彻底拆开，互不依赖。
- 这样 AI 永远接触不到远程写操作，出问题也是"本地可回滚、远程有人把关"。

> **隔离靠什么（2026-10-12 起弃用 worktree）**：① **开工门禁**——init 阶段校验主仓在基准分支且 `git status --porcelain` 为空，脏就停下来等人工提交；② **改动白名单**——coder/reviewer 只认 `plan.files.json` 内的文件，收尾由 `advance check` 校验。
> 代价是**同一仓库同一时间只能跑一个需求**（并行只在不同仓之间成立）。换来的正是上面那条：随时能起服务看效果。

---

## 2. AgentTeam 是什么（②③ 步的核心）

| 角色         | 文件                                                                  | 干什么                                          |
| ------------ | --------------------------------------------------------------------- | ----------------------------------------------- |
| orchestrator | 主对话 + [.claude/commands/pipeline.md](.claude/commands/pipeline.md) | 控流程、读 state、委派、汇总;**不住任何上下文** |
| planner      | [.claude/agents/planner.md](.claude/agents/planner.md)                | 只规划,出 `plan.md` + 编号问题                  |
| coder        | [.claude/agents/coder.md](.claude/agents/coder.md)                    | 写代码,跑 lint/test（full/express 两模式）      |
| reviewer     | [.claude/agents/reviewer.md](.claude/agents/reviewer.md)              | 只读 `review-input.txt`,出 blocker/suggestion/nit |

核心不变式:

- **文件即接口** —— 不靠对话历史,靠落盘。
- **流程分级** —— `tier: full | express`，由 locate 的确定性定位结果决定，小改动不进昂贵环节。
- **人工只卡门禁** —— 全部拍板进 `decisions.md`,留审计链。

### 喂食一个需求（PM 任务 / 口头需求 → 流水线输入）

> 由 **`scripts/feed.mjs`** 确定性完成：解析计划文件、定仓库与基准分支、跑开工门禁、拷模板、写 context、upsert `tasks.md`，**最后**写 `state.json`（固定 `tier=full, phase=init`）。tier 不由 feed 判定——进入 `locating` 后由 `scripts/locate.mjs` 的确定性定位结果决定，再由 `advance set-tier` 落盘。

**入口一：任务ID流程**（xiaoqian-manager 的「写代码」▶ 自动生成计划文件）

计划文件格式（首行标题 + 元信息 + 两个正文小节）：

```markdown
# <需求标题>

任务ID: <id>
查询ID: <demandId>
别名: R-xxxxxx
产品/模块: <module>
版本: <version>
状态: <status>
难度: <demandLevel>
任务类型: <taskType>
最大工时: <maxHour>
执行人: <assignee>
创建人: <createdName>

## 问题描述

<plannedDescription 原文；必填，不能是「（空）」>

## 分配任务说明

<assignDescription 原文>
```

**入口二：口头流程**（`/pipeline` 后直接给需求）。必须显式给出标题与产品/模块：

```text
/pipeline # <标题>
产品/模块: <module>
<需求描述（可多行）>
```

- 首个非空行不是 `# <标题>`、缺 `产品/模块:` 行、或去掉这两行后正文为空 → **立即报错返回**，不创建临时文件、不调用 feed。
- 通过后 orchestrator 落盘 `xiaoqian-manager/data/temp/R-oral-<MMDDHHmm>.md`（标题 + 模块 + `## 问题描述`），别名取自文件名。

**feed 做什么**

1. **解析与校验**：标题、元信息白名单、`## 问题描述` / `## 分配任务说明`；描述为空或等于 `（空）` → exit 5。别名取 `--alias` > `别名` > `R-oral-*` 文件名 > `任务ID` 后 6 位。
2. **定仓**：`repositories[].projects[]` 项目名精确匹配 → 标题关键词 → 无关键词兜底；未命中 exit 2，兜底不唯一 exit 6。
3. **定开发基准分支**：`repositories[].devBranch` > `defaults.devBranch`。
4. **开工门禁**：`HEAD == 基准分支` 且 `git status --porcelain` 为空；否则 exit 3。
5. **脚手架**：复制 `_template/`，替换 `{REQUIREMENT_ID}`，重写 `context.md`（标题/全文/附件/目标仓库/基准分支），upsert `tasks.md`，**最后**写 `state.json`（`tier=full, phase=init`，含 `taskId/demandId/repo/baseBranch/gate`）。
6. **tier 判定（locating 阶段）**：`node scripts/locate.mjs <别名> --json` 产出 `locate.md/json/selected-files.json`；
   `recommendedTier=express`（`confidence=high` + 候选 ≤5 + 无敏感文件）时由负责人确认后执行
   `node scripts/advance.mjs set-tier --tier express`（写 `plan.files.json`，直接进 coding）；
   medium/low 或负责人选全轨 → `advance set-tier --tier full --reason-file <理由>`（进 planning）。
7. **幂等**：`state.json` 已存在 → exit 0 + `already:true`，不重复写；别名被其它任务占用 → exit 6。`--dry-run` 只输出将要执行的动作，不落任何文件。

退出码：`0` 成功/已接入，`1` 未预期异常，`2` 映射未命中，`3` 门禁失败，`5` 输入/格式不符，`6` 配置/环境错误。

> **开工门禁（feed 阶段前置校验）**：主仓 `<repoRoot>/<仓库>` 必须 `HEAD ==` 解析出的基准分支且 `git status --porcelain` 为空；不满足就停下来让负责人先在 ④ 步提交，绝不允许带着脏工作区开工。这是替代 worktree 的隔离手段。

### AgentTeam 内部流程（full）

```text
> /pipeline R-16931            # 已喂食：直接跑
> /pipeline resume R-16931     # 中断：从 state.json + orchestrator-log.md 重建
```

主对话读 state → feed(如需，含开工门禁)→ recon 事实底稿(`node scripts/recon.mjs <ID>`，确定性、覆盖式)→ @planner 出计划(可能的 Q 等答) → 人工确认拍板 `decisions.md` → @coder 编码跑测 → @reviewer 审查 → blocker 回 @coder 修(≤2轮)→ verify → done（**改动留在主仓基准分支工作区，不 add/commit/push**）。

### express 快轨

```text
> /pipeline R-16931        # locate 判为 high/express 时，负责人确认后走快轨
```

`locating` 先跑确定性定位（`scripts/locate.mjs`），候选 ≤5、置信度高、无敏感文件时由负责人确认，随后 `advance set-tier --tier express`：直接 coding → verify → done，跳过 planning / plan_confirm / reviewer。verify 未全绿自动回 coding，最多 2 轮。候选不够用要写 `locate-gap.md` 停下，禁止静默扩大改动面。

---

# 第二部分：业务助手 assistant（②）

## 3. 它是什么

在 Claude Code 里随时叫起来的**业务助手**：**问什么答什么、说存才存、答不上就说答不上**。
给人（懂技术但不懂公司业务）解答业务，**不做任何主动行为**。

| 职责           | 怎么用                                       | 行为                                                        |
| -------------- | -------------------------------------------- | ----------------------------------------------------------- |
| **① 答业务**   | `/assistant 示例模块是干嘛的`                | 先查已存结论(recall)，未命中走索引器**现算** → 用人话直接答 |
| **② 存文档**   | 明说「把这条存进 example-repo」              | 才落进 Hindsight，带溯源元数据(evidence/repo/module/date)   |
| **③ 查看清理** | `/assistant status` / `list` / `delete <id>` | 一眼看出「到底存没存进去」                                  |

**它不做**：不主动讲解、不追问、不做考试式提问、不自动入库、不改目标仓源码、不起 Web UI。

入口 skill：[.claude/skills/assistant/SKILL.md](.claude/skills/assistant/SKILL.md)；
配套 subagent（答案会很长时隔离上下文用）：[.claude/agents/assistant-qa.md](.claude/agents/assistant-qa.md)。

### 两条铁律

- **铁律一 · 事实现算**：路由表 / 组件树 / API 清单 / 端点会随代码变 → **一律现算、不入库**。
  只有「为什么这么设计 / 字段的业务含义 / 命名背后的黑话 / 历史决策与坑」才值得存。
- **铁律二 · 只说人话**：答的是**业务答案**，不是代码导读。不贴大段代码、不用执行顺序组织答案、不堆变量名。
  代码出处（`文件:行`）只作依据，**附在末尾**，不挡正文。

## 4. 三层粒度 → 三种手段

| 粒度       | 手段                                                                        | 产物                                                                   |
| ---------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **项目**   | `yarn assistant:map <repoRoot>/<仓>`（等价 `/assistant init <仓>`）         | `docs/assistant/<仓>/map.md`（**时点快照**，可能过期，权威以现算为准） |
| **模块**   | `trace` / `trace-state` / `trace-event` / `channels` / `modules` / `search` | 不落盘，当场答                                                         |
| **文件夹** | 助手**按需 `Read`** 少量源码（必要时先 `trace` 缩小范围）                   | **不产出任何持久文档**；值得留的由你说 `store`                         |

## 5. 命令速查

```bash
# 事实层（现算，不落盘）—— 复用 .febot/index 的 ProjectMap 缓存（与 recon/locate 共用）
node scripts/index-query.mjs map    <repoRoot>/<仓>              # 项目全貌
node scripts/index-query.mjs trace  <repoRoot>/<仓> <模块|路由>    # 业务链路:路由→组件树→API→store/事件/权限/存储
node scripts/index-query.mjs trace-state <repoRoot>/<仓> <store>[.<字段>]
node scripts/index-query.mjs trace-event <repoRoot>/<仓> <组件> <事件>
node scripts/index-query.mjs channels <repoRoot>/<仓> --kind permission|storage
node scripts/index-query.mjs modules <repoRoot>/<仓> [<模块>]
node scripts/index-query.mjs search  <repoRoot>/<仓> <词>
node scripts/index-query.mjs stats   <repoRoot>/<仓>              # 探活
# 缓存键 = HEAD + git status 哈希 + 索引器版本；需要最新数据时加 --refresh（重扫一次）

# 文档层（Hindsight 记忆）
yarn assistant:memo status --all
yarn assistant:memo recall --bank assistant-example-repo --query "示例模块 命名"
yarn assistant:memo retain --bank assistant-example-repo --content "<结论>" \
     --repo example-repo --module conduit-manage --evidence src/x.ts:6 --date 2026-10-10
yarn assistant:memo list   --bank assistant-example-repo --repo example-repo --days 7
yarn assistant:memo patch  --bank <bank> --id <id> --text "<改后的结论>"
yarn assistant:memo delete --bank <bank> --id <id>     # 软退休(可逆，仍可 restore)
yarn assistant:memo restore --bank <bank> --id <id>
yarn assistant:memo clear  --bank <bank> --yes         # ⚠️ 清空整个 bank

# 自检
yarn assistant:probe        # 端到端探针(可加 --reset)
yarn assistant:map <repoRoot>/<仓>
```

> Git Bash 下以 `/` 开头的参数会被 MSYS 转成 Windows 路径，需要时加 `MSYS_NO_PATHCONV=1` 前缀。

## 6. 边界（硬规矩）

- **只读目标仓**，产物只写 `docs/assistant/`；不 push、不改目标仓源码。
- 不把源码批量喂 LLM；对话中只按需 `Read` 少量文件补行号。
- 不读敏感文件：`.env*`、`token.temp`、`~/.ssh/*`、`~/.aws/*`。
- **不与流水线 bank 混用**：`demo-expertise` / `febot-project` 是研发流程记忆，业务知识写 `assistant-*`。
- 事实每次现算，`docs/assistant/` 下的地图只是快照。
- **文档层挂掉时不许静默**：Hindsight 不可达 → CLI 硬报错（非 0 退出）；此时仍要答题（事实层不依赖 Hindsight），但必须显式说明「文档层不可用，以下结论没有引用已存记忆」。

## 7. 排错与注意

| 现象                         | 原因 / 怎么办                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `✗ Hindsight 不可达`         | 容器没起。`docker ps --filter name=hindsight`；此时**存不进也查不到**，别当成「本来就没结论」                         |
| 存完立刻 `list` 只见 1 条    | 派生条(observation)是**异步**的，稍等再看；`status` 的「待整理」数字会告诉你还有多少在排队                            |
| 答案里没有 `文件:行`         | 该条是**没带 evidence 的旧数据**；`list` 翻到它补 `--evidence`，或用 `patch` 补                                       |
| 索引器对某仓返回 0 路由/端点 | **先别接助手**。跑 `stats` + `warnings` 核对，为 0 且无解释时先补索引器（否则助手会说「这个模块没有接口」= 静默撒谎） |
| 目标仓是 Vue2                | 索引器目前只支持 Vue3，需另做适配器                                                                                   |

---

# 第三部分：底座与周边

## 8. 周边工具（喂给两条主线的"眼睛"）

| 工具                   | 干什么                                                                                                                            | 谁用                   | 怎么跑                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------- |
| **code-indexer**       | Vue3 仓库静态索引器：扫目标仓生成 ProjectMap（路由/模块/API 域/组件图/告警），CLI 或 stdio MCP 供 Agent 消费                       | 流水线 ②③ + 助手事实层 | `node bin/cli.mjs <cmd> <repo>`             |
| **swagger-mcp-server** | swagger-multi MCP **补丁版**服务器（修复 URL 解析截断、非法 JSON 两个 bug），按 `febot.config.json` 的 `repositories[].swagger` 给 Agent 喂实时 API 文档 | 流水线 ②③ 仅           | `yarn swagger` 维护项目级 `.mcp.json`（launcher 启动时读 services.conf），重启会话生效 |
| **Hindsight**          | 本机 Docker 记忆系统（API :8888 / UI :9999），两条主线共用实例、**bank 分开**                                                     | 流水线 + 助手          | 见第四部分 §12–§15                          |

> 现在只有 code-indexer 是**两条线共用**的；索引器属于「只读、纯静态」，谁查都不落盘。

## 9. xiaoqian-manager 各项功能对应的代码位置

| 总流程步骤             | 触发点                             | 实现位置                                                                                 |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| ① 获取需求             | 同步按钮(Sync) / 设置→任务来源     | `lib/server/task-sources/`（内置 teamwork + 自定义脚本）→ `lib/server/tasks/sync-service.ts` → `data/tasks.json`；本地全量合并，不删本地任务 |
| ② 规划                 | 「计划」节点 → 弹框修改描述并保存   | `components/task/StageDialog.tsx`(planer stage) → `plannedDescription`                    |
| ③ 编码+审查+修复       | 「写代码」节点 ▶ → 拉起 `claude /pipeline <任务ID>` | 见 §2；`/pipeline` 剧本 + 4 subagent（xiaoqian 只传**任务ID** + 临时计划 md，不传路径） |
| ④ 提交合并             | 审阅页「代码提交」                 | `app/api/runs/[id]/submit-code` → `lib/server/git/deploy.ts`(pull→commit→push→cherry-pick→push) |
| ⑤ 填写工时             | 工时入口                           | `lib/server/teamwork/client.ts` 的 `saveWorkHours`                                       |
| 标记完成（远程状态）   | 任务行 ✓ / 阶段弹框                | `lib/server/stages/registry.ts` 的 `remote-complete`（按任务来源分发，不碰仓库代码）      |

### 9.1 可视化设置

首次启动若配置未初始化（缺 `repoRoot`、仓库、项目名，或开发/合并分支都没填），工作台会自动弹出设置；之后点右上角齿轮随时打开。三个 Tab：

| Tab        | 内容                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| 仓库与分支 | 扫描 `repoRoot` 列出仓库；每个仓库可配多个项目名（+ 标题关键词）、开发分支、合并分支、Jenkins job                |
| 任务来源   | 内置协作平台的账号/过滤人，以及上传的自定义脚本来源；可试运行、单独上传/替换完成脚本、查看上次运行结果           |
| 开发环境   | `nextDevOrigins`（保存后需重启 dev server）、Hindsight 开关                                                      |

- 保存直接写回 `febot.config.json`（临时文件 + rename 原子替换），**不落数据库**；主应用与 `scripts/` 下次读取即生效（按 mtime 失效缓存）。
- 配置只有一套 `repositories[]`；`repos` / `projectMap` / `branches.*` / `jenkins.jobs` 都是派生结果，不再单独出现。
- 写接口只允许**本机回环**（Host 为 localhost / 127.0.0.1 / ::1，且 Origin 与 Host 同源），局域网访问时返回 403。
- `teamwork.password` / `cookie` / `autograph` **只写不读**：读取接口只返回 `hasCredentials`，不回显。

### 9.2 自定义任务来源脚本

设置 → 任务来源 → 上传脚本文件夹（也可手工放到 `xiaoqian-manager/data/task-sources/<sourceId>/current/`）：

```text
data/task-sources/<sourceId>/
  current/                 # 当前启用版本
    febot.source.json
    fetch-tasks.mjs
    complete-task.mjs      # 可选：远程标记完成
  versions/<时间戳>/       # 历史上传版本，便于回滚
  last-run.json            # 最近一次运行摘要
```

`febot.source.json`：

```json
{
  "name": "我的任务平台",
  "runtime": "node",
  "entry": "fetch-tasks.mjs",
  "timeoutMs": 60000,
  "maxOutputBytes": 2097152,
  "input": ["user", "statuses", "module"],
  "complete": {
    "entry": "complete-task.mjs",
    "timeoutMs": 60000,
    "mode": "optional",
    "input": ["taskId", "externalId", "title", "module", "plannedDescription"]
  }
}
```

- 拉取脚本：参数以 JSON 同时从 **stdin** 与环境变量 `FEBOT_INPUT` 传入；stdout 输出 `{ "tasks": [...] }`（允许前面有日志，取最后一行 JSON）。
- 字段白名单：`externalId`（必填）、`title`（必填）、`module`、`assignee`、`customerName`、`twStatus`、`demandId`、`demandLevel`、`description`、`assignDescription`、`attachments`、`handlers`、`trajectory`、`createdName`、`createdTime`；未知字段丢弃。
- 任务 id = `src-<sourceId>-<externalId>`，避免与协作平台 id 冲突。
- 完成脚本（`complete.entry`）：stdin 收到 `{ action: "complete", taskId, externalId, title, module, plannedDescription, completedAt }`；输出 `{ "ok": true, "message": "...", "remoteStatus": "..." }`（可省略）。退出码 0 且 `ok !== false` 即成功，必须幂等。
- `complete.mode`：`optional`（默认，未配置时二次确认后仅本地完成）/ `required`（未配置或执行失败禁止标记完成）/ `none`（无远程完成概念，内部用）。
- 执行边界：`runtime` 只支持 `node`；`shell: false` 独立子进程，环境变量只保留 `PATH` / `SystemRoot` / `FEBOT_INPUT`；超时与输出上限见 manifest；失败不动旧任务。
- 同步是**本地全量合并**：只新增/更新，从不删除本地任务，也不改本地人工填写的字段。

## 10. 目录约定

分两处：**febot 家**（本目录，AgentTeam / assistant 会话都开在这）与 **产品仓工作区**（`<repoRoot>/<仓>`，AgentTeam 唯一动代码的地方）。

**febot 家（本仓库根）**

```text
febot.config.json         主配置(本地生成，不入库)
.claude/
  commands/pipeline.md      流水线剧本（②③步）
  agents/{planner,coder,reviewer}.md    流水线 subagent
  agents/assistant-qa.md                助手问答 subagent（答案长时用）
  skills/pipeline-feed/                 喂食 skill
  skills/assistant/                     助手入口 skill + references/{service-protocol,what-to-store}.md
tasks.md                  需求元信息表(含 tier、**仓库**列——recon 靠它定位仓)
file-lock.md              并行冲突仲裁表
package.json              工作区脚本(`yarn dev` / `assistant:*` 等)
docs/requirements/
  _template/              10+ 个空白模板,喂食从这里复制
  <R-xxxxx>/              context.md questions.md answers.md plan.md
                          decisions.md progress.md review.md review-fix.md
                          test-report.md worklog.md orchestrator-log.md
                          state.json
docs/assistant/<仓>/map.md   助手项目地图（生成物，时点快照）
docs/assistant-*.md          助手的设计计划 / 实施步骤 / 使用说明
docs/hindsight-*.md          Hindsight 方案与接入
scripts/recon.mjs            流水线事实底稿（复用仓索引缓存）
scripts/locate.mjs           确定性定位（locate.md/json、selected-files.json）
scripts/advance.mjs          状态机唯一写入器（status/gate/set-phase/set-tier/check/review-input/done）
scripts/feed.mjs             需求接入（解析/定仓/门禁/脚手架，固定 tier=full/phase=init）
scripts/lib/febot.mjs        共享底座：配置/原子读写/git/门禁/白名单
scripts/lib/requirement.mjs  需求/仓库/分支解析
scripts/lib/repo-index.mjs   仓索引缓存（.febot/index，按 HEAD+status 命中）
scripts/index-query.mjs      复用索引缓存的查询入口（assistant 事实层；trace/search/modules…）
scripts/hindsight-memo.py    流水线侧记忆 CLI
scripts/assistant-{memo,map,probe}.mjs   助手侧记忆 CLI / 地图 / 探针
xiaoqian-manager/        小千管理(Next.js) —— 全部流程的宿主(①④⑤)
desktop/                 桌面端 Electron 壳(把宿主+runner 装成 Windows 应用,见 §16)
code-indexer/            Vue3 仓库静态索引器(CLI + MCP),两条线共用
swagger-mcp-server/      swagger-multi MCP 补丁版服务器,②③步用
```

**产品仓工作区（`<repoRoot>/<仓>`，AgentTeam 动代码的唯一地方）**

- `repoRoot`（默认 `./gitlab`）下，每个仓一份**主仓 checkout**，不建 worktree、不切分支。
- **开发基准分支**：按 `repositories[].devBranch` > `defaults.devBranch` 解析，主仓**常驻**该分支。
- coder 直接改这里的工作区文件，改动以**未提交**形式留下（**不 add/commit/push，见 §1 边界**）；人工验收也在这里跑 dev server（不再单列步骤）。
- **开工前必须干净**：init 阶段校验 `git status --porcelain` 为空，脏就停（见 §11 门禁）。**同仓同时只能跑一个需求。**
- 助手**只读** `<repoRoot>/<仓>`：不写任何文件、不建 worktree。

**archive/（历史归档,禁区）**

- 存放已废弃的设计草稿。**仅供人工翻阅,禁止任何 agent 读/写,或作为当前需求依据。**
- 三道防线：`.gitignore` 排除 + `.claude/settings.json` deny 规则(拦 Read/Write/Edit/Glob) + agent prompt 明令不读。改动 archive 需先临时调整 `settings.json` deny 再改。
- 若要给 archive 加说明文档，放本 README 或 `docs/` 下。

## 11. 门禁清单 + 全局约束（流水线适用）

### 门禁清单（每次跑都要盯）

1. full/express 在 `locating` 定（locate 结果 + 负责人确认），写 `decisions.md`
2. plan 未确认不得编码(full)
3. reviewer 有 blocker 必须回 coder 修(full)
4. 修复 ≤ 2 轮,超了转人工
5. 每步产物必须落盘
6. **开工门禁：主仓在解析出的基准分支 + 工作区干净**，不干净不开工（替代 worktree 的隔离手段）
7. **同仓串行**：一个仓库同一时间只跑一个需求；并行只在不同仓之间
8. 每需求独立会话（上下文隔离，与 worktree 无关）
9. coder/reviewer 只认 `plan.files.json`（机器唯一白名单；plan.md 清单只供人读），不越界、不动清单外的改动
10. subagent 只收摘要,不接完整代码/推理
11. 敏感文件(.env\*、febot.config.json、hindsight.env)必须人工审批
12. 人工验收后才提交合并——**AgentTeam 只留未提交改动，提交/推送是 ④ 步，由人做**

### 全局约束（对流水线主对话与所有 subagent 生效）

- **禁止更改 node / npm / yarn 版本**——不执行 `nvm use`、全局切换或 `engines`/`.nvmrc`/package.json 里的版本改动。版本锁定为现状。
- **涉及 `node_modules` 数据修改时,必须先严格提示**——改动前打出「**因为 <原因> 需要进行 node_modules 修改**」并征得同意后才执行;不得静默 install / 改依赖 / 动 link。
- **禁止 add / commit / push / stash**——改动一律以未提交形式留在主仓工作区；工作区里出现清单外的改动要停下来报告，不擅自清理。

### 并行与秘密

- **同仓串行（硬规则）**：共用主仓工作区，同仓两需求会互相污染——比 file-lock 更硬，开工门禁会自动拦住第二个。
- 不同仓可以并行；并行前先查 `file-lock.md`，planner 的 plan.md「将改动文件清单」是锁依据。
- 改动触及 `.env*` 等敏感文件 → planner 升级成 Q → 你 `decisions.md` 审批。

---

# 第四部分：Hindsight 记忆系统

> 两条主线共用同一个 Hindsight 实例，**按 bank 分开**，互不污染检索。
> 给流水线加"学习型记忆"：人工的拍板、纠正、否决理由沉淀为 Agent 可检索记忆，让第 N+1 个需求吃到前 N 个的人工经验。
> 方案文档见 [docs/hindsight-实施方案.md](docs/hindsight-实施方案.md) / [docs/hindsight-接入方案.md](docs/hindsight-接入方案.md)。

## 12. 架构（本机 Docker 一容器搞定）

```text
┌─ Docker 容器 hindsight:slim（API :8888 / UI :9999，--restart unless-stopped）┐
│   内置 PostgreSQL + pgvector（卷 hindsight-data）                              │
│   LLM 抽取 = 火山方舟 deepseek-v4.1-flash（Agent Plan Key）                   │
│   Embedding  = 硅基流动 BAAI/bge-m3 1024维（免费）                            │
│   Reranker = rrf（纯算法，零外部依赖）                                        │
└──────────┬───────────────────────────────────────────────────────────────────┘
           │ REST :8888
  ┌────────┴──────────────────────────────────────────────────────┐
  │ 流水线侧: scripts/hindsight-memo.py（软降级，绝不拦流程）      │
  │          xiaoqian-manager/lib/server/hindsight/client.ts       │
  │ 助手侧:   scripts/assistant-memo.mjs（硬报错，怕"以为存了"）   │
  └───────────────────────────────────────────────────────────────┘
```

### Bank 划分（两套，勿混）

| bank                          | 属于   | 存什么                                                |
| ----------------------------- | ------ | ----------------------------------------------------- |
| `demo-expertise` / `febot-project` | 流水线 | 人工评审口味、流水线静态规矩（约束/分支/提交规范）    |
| `<产品线>` 等产品线 bank      | 流水线 | 产品线维度经验（跑 `ensure-banks.py --product <名>` 时建） |
| `assistant-<repo>`            | 助手   | 该仓的业务知识、模块职责、术语、坑、历史决策          |
| `assistant-shared`            | 助手   | 跨仓通用：业务黑话/缩写、组织与角色含义、通用架构约定 |

> 助手**绝不往流水线 bank 写业务知识**，反之亦然——混在一起会互相污染检索。

## 13. 部署步骤

1. `yarn setup` —— 自动生成 `scripts/hindsight.env`（从 [example/hindsight.env](example/hindsight.env) 复制，模板已入库），填入你的 Ark Plan Key + SiliconFlow Key
2. `docker compose up -d` —— 从 [docker-compose.yml](docker-compose.yml) 启动（镜像 `ghcr.nju.edu.cn/vectorize-io/hindsight:latest-slim`、端口 8888/9999、`hindsight-data` 卷都已写好）
3. 不想用 compose 时退回 `docker pull ghcr.nju.edu.cn/vectorize-io/hindsight:latest-slim` + `docker run -d --name hindsight --restart unless-stopped -p 8888:8888 -p 9999:9999 --env-file scripts/hindsight.env -v hindsight-data:/home/hindsight/.pg0 hindsight:slim`；两种方式共用同一个卷
4. `python scripts/ensure-banks.py [--product <你的产品线名>]`（建 demo-expertise / febot-project / <产品线> 3 库 + 预填 6 条静态规矩）

> 模板里每个变量都有注释说明来源和注意事项；key 只留本地 `hindsight.env`，已被 gitignore。
> 助手侧的 `assistant-<repo>` / `assistant-shared` bank 按需建立，不用预先跑脚本。
> **流水线静态规矩改过文案后**要跑 `python scripts/ensure-banks.py --reseed`，否则 planner/orchestrator 会 recall 到新旧两套规矩。

重启电脑后 Docker Desktop 自启 → 容器自动拉起，无需人工干预。

### 踩过的坑（都排掉了）

| 坑                                            | 解法                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| npm 全局装过同名 `docker` 文档生成器，抢 PATH | 管理员 PowerShell 删 shim                                                                                          |
| ghcr.io 国内被墙                              | `ghcr.nju.edu.cn` 南大镜像                                                                                         |
| 完整版镜像 9GB                                | slim 版 1.88GB + 外部 embedding 服务                                                                               |
| 方舟 Plan Key 路径隔离                        | 只在 `/api/plan/v1` 有效，标准 `/api/v3` 一律 401                                                                  |
| 方舟 embedding 全不能用                       | 250515 即将下线；vision-251215 是多模态专用 API 格式不兼容；Plan Key 调不了 embeddings → **换 SiliconFlow bge-m3** |
| pgvector HNSW 索引上限 2000 维                | bge-m3 原生 1024 维，天然合规                                                                                      |
| `RERANKER_PROVIDER=none` 启动报错             | 合法值没有 none，用 `rrf`                                                                                          |
| recall/reflect 的 `budget` 传数字报 422       | 是枚举：`low` / `mid` / `high`                                                                                     |
| 三处调用方端点全是文档假设                    | 已对照 OpenAPI 实测修正（见下方真实端点）                                                                          |

### 真实 API 端点（OpenAPI 实测验证）

| 操作    | 端点                                               | 请求体                                          |
| ------- | -------------------------------------------------- | ----------------------------------------------- |
| 建库    | `PUT /v1/default/banks/{bank_id}`                  | `{}`                                            |
| retain  | `POST /v1/default/banks/{bank_id}/memories`        | `{"items":[{"content":"...","context":"..."}]}` |
| recall  | `POST /v1/default/banks/{bank_id}/memories/recall` | `{"query":"...","budget":"low"}`                |
| reflect | `POST /v1/default/banks/{bank_id}/reflect`         | `{"query":"..."}`                               |

> 助手侧实测补充（2026-10-10，详见 [scripts/assistant-probe.mjs](scripts/assistant-probe.mjs) 头注释）：
> 一条 retain 落 **2 条**（world + 派生 observation），`metadata` 只在 world 上、派生条为空，`tags` 两条都在；
> `tags_match` 默认 `any` 会捞出无标签条目，要「只要该 tag」必须显式传 `all_strict`；
> `delete` 单条 = `PATCH {"state":"invalidated"}`（可逆），**`DELETE {bank}/memories` 是清空整库**。

## 14. 接入点（已接线）

**流水线侧**

- **pipeline.md**：init recall / decisions retain / done reflect 人工门禁 / fixing retain / reviewer 画像
- **planner.md**：记忆冲突 → 升级为 M1/M2 编号问题
- **reviewer.md**：口味符合度 + 重复问题标记
- **xiaoqian-manager 侧目前只有开关**：`lib/server/hindsight/client.ts` 提供了 recall / retain / reflect 封装，设置页可写 `features.hindsight`，但 ④ 步（代码提交 / 标记完成）**尚未调用** Hindsight。旧的「deploy 成功 → retain 已部署」已随阶段改造移除；要接线就放在阶段处理器的 `afterComplete`（`lib/server/stages/registry.ts`）或 `submit-code/route.ts` 的成功分支里。
- 全程**软降级**：Hindsight 没起 → 返回空/跳过，绝不拦流水线

**助手侧**

- **assistant skill**：答题前 recall 已存结论 → 未命中走索引器现算；`store` 才 retain；`status`/`list`/`delete` 做查看与清理
- `scripts/assistant-{memo,map,probe}.mjs` 三个 CLI 承载全部读写
- 刻意**硬报错**：怕「以为在存其实没存」，不可达就非 0 退出 + 明说文档层不可用

## 15. 下一步

### Phase 2（流水线）

1. 跑一个真实需求走完整流水线，验证各阶段 recall/retain 是否按预期触发
2. 观察 recall 命中率，必要时调 budget 档位
3. 拍板 retain 积累 ≥10 条后，评估是否开 ◇ 线（①④⑤ 可选阶段）

### 助手层

P0–P4 已实施完毕（记忆 CLI / 项目地图 / 答题 skill / 按需存 / 端到端验收）。
设计原因见 [docs/assistant-agent-建设计划.md](docs/assistant-agent-建设计划.md)，分步做法见 [docs/assistant-agent-实施步骤.md](docs/assistant-agent-实施步骤.md)，
给同事看的操作手册见 [docs/assistant-使用说明.md](docs/assistant-使用说明.md)。对外窗口本期不做，只留口子。

---

# 第五部分：全景与定制

## 16. 项目全景

### 流程链（协作）

`xiaoqian-manager`(宿主) ↔ `AgentTeam`(`/pipeline` 剧本 + 4 subagent + pipeline-feed skill) ↔ `code-indexer` / `swagger-mcp-server`(②③步的眼睛)

### 助手链（独立）

`/assistant` skill (+ `assistant-qa` subagent) ↔ `code-indexer`(事实层，现算) ↔ `Hindsight`(文档层，`assistant-*` bank)

### 桌面端（desktop/）

把流水线宿主装成一个 Windows 应用：用户双击启动，不用自己开终端跑 `yarn dev` / `yarn runner`。

- **壳只做编排**：窗口、托盘、菜单、通知、进程守护、自动更新；业务 UI 仍是 `xiaoqian-manager`，代码零重写。
- **构建期**：`prepare-runtime` 从 `xiaoqian-manager` 产出 Next standalone，把 runner 打成单文件，连同受管运行时资产和内置 Node 放进 `desktop/resources`。
- **运行期**：Electron 用内置 Node 拉起两个子进程（Next + runner），注入 `FEBOT_WORKSPACE` / `FEBOT_CONFIG` / `XQ_RUNNER_*`，窗口加载 `http://127.0.0.1:<动态端口>`。
- **工作区**：首次启动选「新建」或「接管」；业务数据全部在用户选的工作区，安装目录只读，更新不覆盖用户文件。
- **中断**：退出或 runner 异常时，进行中的 run 记为 `interrupted`，保留现场可恢复。

```bash
yarn desktop:install   # 安装 Electron 壳依赖
yarn desktop:dev       # 开发模式（默认跑 xiaoqian-manager 源码）
yarn desktop:dist      # 生成 desktop/dist/febot-Setup-<version>.exe
```

细节（工作区模型、环境变量、打包踩坑、安全断言）见 [desktop/README.md](desktop/README.md)。

### 独立项目（不参与总流程）

发版看板 `om` 已拆分为独立项目，不再随本仓库分发。

## 17. 定制

- **改 agent 行为**：编辑 `.claude/agents/*.md`（工具/权限/maxTurns prompt）。
- **改流程剧本**：编辑 `.claude/commands/pipeline.md`（委派话术、阶段、轨道约束）。
- **改喂食逻辑**：编辑 `.claude/skills/pipeline-feed/SKILL.md`。
- **改模板**：编辑 `docs/requirements/_template/*`。
- **改 ①④⑤**：编辑 `xiaoqian-manager/`（`lib/server/git`、`lib/server/teamwork`、`components`）。
- **改桌面端**：编辑 `desktop/src/`（`supervisor.ts` 进程守护、`workspace.ts` 工作区、`index.ts` 生命周期），详见 [desktop/README.md](desktop/README.md)。
- **改助手行为**：编辑 `.claude/skills/assistant/SKILL.md`（编排）、`references/service-protocol.md`（答话协议）、`references/what-to-store.md`（存/不存判断）、`.claude/agents/assistant-qa.md`（隔离上下文）。
- 三个流水线 agent 统一 `permission: acceptEdits`，如要更严，单独收紧。

---

## 附：repositories / 平台项目 → 目标仓 映射

映射数据挂在 `febot.config.json` 的 `repositories[]` 登记表上（本地文件，**不入库**，由各团队自己维护）：

```jsonc
"repositories": [
  {
    "name": "example-repo-mobile",
    "projects": [{ "name": "示例产品 A", "keywords": ["移动端"] }]
  },
  { "name": "example-repo", "projects": [{ "name": "示例产品 A" }] }, // 无 keywords = 该产品兜底
  { "name": "example-repo-b", "projects": [{ "name": "示例产品 B" }] }
]
```

> AgentTeam 喂食时据 PM 卡的「产品/模块 + 标题关键词」按下述规则确定性求值，决定改动落在哪个仓：
> ① 项目名精确匹配；② 标题含某条 `keywords` 任一关键词 → 用该条所属仓库（多条命中按数组顺序取第一条）；③ 无关键词命中 → 用该项目下唯一一条无 `keywords` 的兜底条目；④ 兜底不唯一 / 无命中 → 问负责人，确认后回填，不许猜。
> **由负责人维护确认。** 每个 `name` 必须是 `repoRoot` 下的仓库目录名。

---

## 18. 许可证

本项目采用 [MIT License](LICENSE)。Copyright (c) 2026 Zombiesix。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 Issue。
