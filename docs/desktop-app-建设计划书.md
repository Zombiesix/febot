# febot 桌面端应用建设计划书

> 目标：把现有 febot 工作区（xiaoqian-manager + runner + /pipeline + 本地脚本）做成一个**可安装到本机、双击即用**的 Windows 桌面应用。
>
> 版本：v1.1　日期：2026-11-02　状态：已按评审意见修订（Electron 路线确认；run 中断可恢复；om 看板不集成）
>
> 已完成的现状核实：`xiaoqian-manager` 生产构建在当前环境可通过（`yarn build` 56s，exit 0）；Electron / electron-builder / electron-vite 最新版本已查；Next 16 的 standalone 产物行为、node-pty 1.1.0 的预编译方式已在源码层确认。

---

## 0. 一页结论

### 0.1 技术栈（推荐）

| 层 | 选型 | 版本基线 | 说明 |
| --- | --- | --- | --- |
| 桌面壳 | **Electron** | 45.x（当前 45.2.1） | 只做窗口 / 托盘 / 菜单 / 通知 / 进程守护 / 自动更新，不承载业务逻辑 |
| 壳构建 | **electron-vite** | 6.x | main / preload / 本地设置页统一构建，TypeScript |
| 安装包 | **electron-builder** | 26.x | NSIS 每用户安装（无需管理员），额外产出 portable zip |
| 产品 UI | **沿用 Next.js 16.3.7 + React 19 + Tailwind 4 + shadcn/Radix** | 不升级 | 主窗口直接加载本机 `http://127.0.0.1:<port>`，前端代码零重写 |
| 本地服务 | **Next standalone server + runner（Node 进程）** | 现状 | 两个进程由 Electron 主进程守护，端口动态分配 |
| 终端 | **node-pty 1.1.0** | 不升级 | 已确认是 N-API 预编译（`node-addon-api` + `prebuilds/win32-x64`），跨 Node/Electron ABI 稳定，**不需要 electron-rebuild** |
| 运行时 | **随包内置 Node.js 24 LTS（win-x64 zip）** | 锁定具体 patch | 保证装完即用、与用户全局 Node 版本解耦（也满足仓库“禁止改 node 版本”的铁律） |
| 本地持久化 | JSON 文件（`electron-store` 的轻量替代） | — | 桌面设置、窗口状态、工作区路径；业务数据仍在工作区 |
| 自动更新 | **electron-updater**（generic 源） | 6.x | 内网静态目录 / 对象存储均可，NSIS 增量更新 |
| 测试 | Vitest + Playwright Electron | — | 进程守护、路径解析单测；安装后 E2E |
| CI | Jenkins（现有）或 GitHub Actions windows-latest | — | 产物：`febot-Setup-x.y.z.exe` + `latest.yml` + blockmap |

**结论：Electron 是唯一务实的选择。** 原因不是“Electron 更好”，而是这套产品 90% 的价值在 Node 进程里（Next 服务端路由、node-pty、git、Claude CLI、本地脚本）。Tauri 省下的只是壳体积，却仍要额外打包 Node sidecar，并把进程管理用 Rust 重写一遍，对本团队收益为负。

### 0.2 交付节奏（1 人，约 20 人日）

| 里程碑 | 内容 | 人日 | 产出 |
| --- | --- | --- | --- |
| **M0 可行性穿刺** | standalone 实跑、runner 打包实跑、node-pty 在包内 Node 实跑、Electron 最小窗口 | 2 | 一份可复现的 spike 记录 + 风险清零 |
| **M1 桌面壳与服务守护** | 进程守护、动态端口、日志、单实例、托盘、退出清理 | 4 | 开发机可双击打开产品 UI |
| **M2 工作区与路径改造** | 工作区模型、首次运行向导、路径 env 化、环境自检 | 5 | 支持“新建工作区 / 接管现有 D:\febot”两种模式 |
| **M3 打包与更新** | 运行时资产装配、NSIS 安装包、运行时同步、自动更新 | 5 | 干净 Windows 机器一键安装可用 |
| **M4 加固与发布** | E2E、升级/崩溃/清理测试、签名、文档、试点发布 | 4 | 团队可用的 v1.0 安装包 |

### 0.3 三条不可回避的改造

1. **工作区与安装目录分离**：安装目录在 `%LOCALAPPDATA%\Programs\febot`（或 Program Files），不可写；业务数据、配置、目标仓必须放在用户可选的工作区。
2. **Next standalone 会 `process.chdir(__dirname)`**（已在 Next 16.3.7 构建模板中确认），所有依赖 `process.cwd()` 的路径必须改为显式工作区变量，否则数据会写进安装目录。
3. **Windows 进程树清理**：Electron 退出必须优雅关闭 runner 并 `taskkill /T /F` 兜底，否则 ConPTY 里的 `claude` 会变孤儿进程。
4. **run 中断可恢复**：退出/崩溃不再把进行中的 run 直接判 failed，而是落盘为 `interrupted` 并在下次启动恢复会话（§5.6）。

---

## 1. 现状梳理：要打包的到底是什么

### 1.1 运行时组成

| 组件 | 技术 | 启动方式 | 端口 | 可写位置 |
| --- | --- | --- | --- | --- |
| xiaoqian-manager | Next.js 16 / React 19 | `next dev`（现状）/ standalone server（目标） | 3010 | `xiaoqian-manager/data/`、`../febot.config.json` |
| runner | Node + ws + node-pty + chokidar | `tsx scripts/runner.ts` | 3011 | `xiaoqian-manager/data/{runs,temp}`、`repos.json`、`runner.json` |
| /pipeline 剧本 | Claude Code 命令 + 4 个 subagent + 2 个 skill | runner 的 PTY 里执行 `claude "/pipeline <taskId>"` | — | `docs/requirements/`、`tasks.md`、`file-lock.md`、`.febot/` |
| 流水线脚本 | Node ESM（`scripts/*.mjs`）+ Python（hindsight，可选） | 由 Claude 的 Bash 工具调用 | — | 同上 |
| code-indexer | TS + tsx + Vue 编译器 | 被 `scripts/lib/repo-index.mjs` 调用 | — | `.febot/index/` |
| swagger-mcp-server | npm 包 + launcher | 仓库根 `.mcp.json` 注册项目级 MCP，launcher 启动时读 `services.conf` | — | `swagger-mcp-server/services.conf`、`.mcp.json` |
| Hindsight | Docker（可选） | 外部 | 8888 | 外部 |

> om 发版看板为独立项目，桌面端不集成（不携带、不启动），保持独立部署使用，故不列入运行时组成。

### 1.2 桌面化后必然出问题的点（已逐条核实）

| 问题 | 现状证据 | 影响 |
| --- | --- | --- |
| 安装目录只读 | Program Files / `%LOCALAPPDATA%\Programs` | `data/`、`docs/`、`.claude/settings.local.json` 写入失败 |
| Next standalone 改 cwd | `next/dist/build/utils.js:1122` 生成 `process.chdir(__dirname)` | `store.ts`、`runner-client.ts`、`teamwork/client.ts`、`repo-resolve.ts` 全部路径错位 |
| 相对路径散落 | `process.cwd()/data` 出现于 4 个服务端模块；`repo-resolve.ts` 用 `cwd/..` 找 `scripts/resolve-repo.mjs` | 打包后定仓、任务读写、runner 发现全部失效 |
| 剧本依赖相对 `scripts/` | `pipeline.md` 大量 `node scripts/advance.mjs ...` | 工作区里必须能看到 `scripts/`、`code-indexer/`、`.claude/` |
| GUI 启动 PATH 不完整 | Windows 从资源管理器启动时常见 npm 全局 bin 不在 PATH | 找不到 `claude`，PTY 直接退出 127 |
| 端口固定 | 3010 / 3011 / 3000 | 与已开 dev server 冲突 |
| 进程生命周期 | runner 用 ConPTY 起 `claude` | 应用退出后孤儿进程、仓库忙位残留 |
| 外部依赖 | Git、Claude Code、Git Bash、Python/Docker（可选） | 用户机器缺一项就跑不起来，需要自检与引导 |

---

## 2. 技术选型论证

### 2.1 方案对比

| 维度 | Electron（推荐） | Tauri 2 | PWA / 本地快捷方式 |
| --- | --- | --- | --- |
| 复用现有 Node/Next 代码 | 直接复用 | 仍需 Node sidecar，等于多一层 | 不解决安装与进程守护 |
| node-pty | 直接可用（N-API） | 只能放 sidecar | 不可用 |
| 进程守护/日志/托盘/更新 | 生态成熟 | 需 Rust 实现 | 无 |
| 安装包体积 | 约 250–350 MB | 约 150–250 MB | — |
| 团队学习成本 | 低（前端栈） | 高（Rust + sidecar） | 低 |
| Windows 兼容性 | 稳定 | 依赖 WebView2 运行时 | 依赖浏览器 |
| 结论 | **采用** | 不采用 | 不采用 |

### 2.2 为什么保留 Next 服务端，而不是静态导出 + IPC

`app/api/**` 里有 15 个服务端路由，承担 teamwork 登录、任务落盘、git 提交/推送/cherry-pick、runner 代理、diff 读取。静态导出意味着把这些全部改写成 Electron IPC + 本地 HTTP 客户端，工作量和回归风险远大于“启动一个本地 Next 进程”。**桌面壳只做进程编排，不侵入业务。**

### 2.3 为什么内置 Node，而不是要求用户装

- Claude Code 本身依赖 Node；但用户机器上的 Node 版本不可控（本项目实测 25.x，README 要求 22.22+）。
- runner 依赖 node-pty 原生模块；内置 Node 后 ABI 固定，打包与升级都可复现。
- 仓库铁律“禁止更改 node / npm / yarn 版本”：内置运行时**只对本应用子进程生效**，不修改系统 PATH、不安装全局包，符合约束。

---

## 3. 目标架构

### 3.1 进程模型

```text
┌─────────────────────────────── Electron 主进程 ───────────────────────────────┐
│ 单实例锁 · 窗口/托盘/菜单 · 自动更新 · 通知 · 日志 · 进程守护(Supervisor)      │
│                                                                              │
│  Supervisor                                                                  │
│   ├─ node.exe resources/next/server.js     ← Next standalone（cwd=resources/next）│
│   └─ node.exe resources/runner/server.mjs  ← runner（cwd=<workspace>）          │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ BrowserWindow.loadURL(http://127.0.0.1:<appPort>)
                ▼
       现有 xiaoqian-manager UI（Next 页面 + xterm）
                │ WebSocket ws://127.0.0.1:<runnerPort>/ws?token=...
                ▼
        runner ── ConPTY ──> claude "/pipeline <taskId>"（cwd=<workspace>）
                                   │
                                   └─ Bash 工具 ──> node scripts/*.mjs / git / py -3
```

要点：

- **主窗口不注入 Node 能力**：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`；只有本地“设置/向导”窗口通过 preload IPC 与主进程通信。
- **产品 UI 原样加载 localhost**，不打包成 file://，避免 Next 客户端路由、绝对路径、CSP 问题。
- **runner 仍是独立进程**，保持“Next 重启不杀会话”的现有不变式。
- **om 看板不集成**：om 是独立项目，桌面端不携带、不启动，继续独立部署使用。

### 3.2 目录模型

```text
安装目录（不可写，随安装包/更新变化）
%LOCALAPPDATA%\Programs\febot\
  febot.exe
  resources\
    app.asar                     # Electron 壳
    next\                        # Next standalone + .next/static + public
    runner\                      # server.mjs + node_modules/node-pty
    runtime\                     # 可复制到工作区的运行时资产（见 3.3）
    node\                        # node.exe / npm / npx（win-x64）
    runtime-manifest.json        # runtime 每个文件的 sha256（构建期生成）

工作区（用户可选，应用更新绝不覆盖用户数据）
<workspace>\
  febot.config.json              # 用户配置（模板 seed，之后归用户）
  tasks.md
  file-lock.md
  docs\requirements\             # 流水线产物
  gitlab\                        # 目标仓（repoRoot，按配置可改）
  .claude\
    commands\pipeline.md         # 运行时资产（受管）
    agents\  skills\             # 运行时资产（受管）
    settings.json                # 首次 seed，之后归用户
    settings.local.json          # 用户
  .febot\index\  tmp\  runtime.json   # 索引缓存 / 临时 / 上次同步清单
  .mcp.json                      # 项目级 MCP 注册（受管，指向 swagger launcher）
  scripts\                       # 运行时资产（受管，hindsight.env 除外）
  code-indexer\                  # 运行时资产（受管，含 node_modules）
  swagger-mcp-server\            # 运行时资产（受管，services.conf 除外）
  example\                       # 模板（受管）
  xiaoqian-manager\data\         # tasks.json / runs / temp / repos.json / runner.json
  xiaoqian-manager\data\temp\    # 计划文件与 .run.cmd

用户级（与具体工作区无关）
%APPDATA%\febot\
  desktop.json                   # 工作区路径、端口偏好、claude 路径、窗口状态
  logs\main.log  next.log  runner.log
  updates\                       # 更新缓存
```

> 工作区布局刻意与当前仓库布局保持一致：`scripts/`、`code-indexer/`、`.claude/`、`.febot/`、`xiaoqian-manager/data/`、`docs/requirements/`。因此 `advance.mjs` 里写死的 `<ROOT>/xiaoqian-manager/data/{runs,temp}` **不需要改**，现有剧本与文档全部继续有效。

### 3.3 运行时资产（从 `resources/runtime` 复制到工作区）

| 受管（升级时同步） | 用户所有（永不同步） |
| --- | --- |
| `scripts/**`（排除 `scripts/hindsight.env`） | `febot.config.json` |
| `code-indexer/**`（含 `dist` 与 `node_modules`） | `tasks.md`、`file-lock.md` |
| `.claude/commands/**`、`.claude/agents/**`、`.claude/skills/**` | `.claude/settings.json`、`.claude/settings.local.json` |
| `example/**` | `scripts/hindsight.env` |
| `docs/requirements/_template/**` | `docs/requirements/R-*/**` |
| `swagger-mcp-server/{package.json,yarn.lock,README.md,.npmrc,update_global_mcp.sh,node_modules/**}` | `swagger-mcp-server/services.conf` |
| — | `gitlab/**`、`.febot/index/**`、`xiaoqian-manager/data/**` |

体积预算（构建期实测后写入 CI 断言）：

| 资产 | 预估 |
| --- | --- |
| Electron 运行时 | ~200 MB |
| 内置 Node（zip 解压） | ~80 MB |
| Next standalone（实测 25 MB） | ~25 MB |
| code-indexer（含 node_modules） | ~72 MB |
| node-pty（剔除 `.pdb` 后） | ~2 MB |
| swagger-mcp-server node_modules | ~11 MB |
| **安装后合计** | **~390–440 MB** |
| NSIS 压缩后 | **~150–220 MB** |

### 3.4 环境变量契约（桌面端注入，子进程继承）

| 变量 | 值 | 消费方 | 说明 |
| --- | --- | --- | --- |
| `PORT` | 动态空闲端口 | Next standalone | 避免 3010 冲突 |
| `HOSTNAME` | `127.0.0.1` | Next standalone | 只监听本机 |
| `FEBOT_WORKSPACE` | `<workspace>` | 新增路径模块 | 唯一事实源 |
| `FEBOT_CONFIG` | `<workspace>/febot.config.json` | Next / scripts | 已有支持 |
| `FEBOT_ROOT` | `<workspace>` | `scripts/lib/febot.mjs` | 已有支持 |
| `XQ_RUNNER_PORT` | 动态空闲端口 | runner | 避免 3011 冲突 |
| `XQ_RUNNER_TOKEN` | 随机 32 字节 | runner | 内部 HTTP / WS 鉴权 |
| `XQ_APP_URL` | `http://127.0.0.1:<appPort>` | runner | 收口/轨迹回调 |
| `XQ_RUN_TIMEOUT_MS` | 6h（沿用默认） | runner | 兜底超时 |
| `PATH` | `resources\node;` + 原 PATH | 全部子进程 | 保证 `node` / `npm` 可解析 |
| `NEXT_TELEMETRY_DISABLED` | `1` | Next | 关闭遥测 |

### 3.5 启动 / 退出时序

**启动**

1. `app.requestSingleInstanceLock()`；已有实例则聚焦。
2. 读取 `%APPDATA%\febot\desktop.json`；无工作区 → 打开首次运行向导。
3. 运行时版本检查：工作区 `.febot/runtime.json` 与 `resources/runtime-manifest.json` 比对 → 执行同步（见 §6.3）。
4. 分配两个空闲端口；启动 Next，轮询 `GET /api/runner/info` 直到 200（超时 60s）。
5. 启动 runner，轮询 `GET /healthz` 直到 200（超时 30s）。
6. 创建主窗口，`loadURL`；失败则显示本地错误页（带“查看日志 / 重试 / 换工作区”）。

**退出**

1. `before-quit` 拦截；**若存在活动 run，先弹确认框**（"N 个任务进行中，退出将中断会话（下次启动可恢复）"），用户取消则中止退出（自动更新触发的退出同样确认）；确认后标记 `quitting=true`，窗口隐藏。
2. 调用 runner `POST /shutdown`（`x-internal-token`），等待 ≤5s。
3. `taskkill /PID <runnerPid> /T /F`、`taskkill /PID <nextPid> /T /F` 兜底。
4. 写完日志后 `app.exit(0)`。

**崩溃恢复**

- Next 退出：指数退避重启（1s/2s/4s/8s，最多 5 次），窗口提示“服务重启中”。
- runner 退出：重启后把非终态 run 置为 **interrupted**（改造 `cleanupStale` 语义，详见 §5.6），桌面端弹原生通知；下次启动可查看现场并恢复会话。
- 端口占用（EADDRINUSE）：重新分配端口并重启对应服务。

---

## 4. 关键可行性验证

### 4.1 已完成（本次计划阶段）

| 验证项 | 方法 | 结论 |
| --- | --- | --- |
| 生产构建 | `cd xiaoqian-manager && yarn build` | **通过**，56.45s，exit 0；15 个 API 路由正常产出 |
| standalone 实跑（V1 提前完成） | 启用 `output:'standalone'` 构建后 `PORT=3999 node .next/standalone/server.js` | **通过**：`/`、`/review`、`/api/runner/info` 均返回 200 |
| standalone 产物体积 | `du -sh .next/standalone .next/static public` | **约 25 MB**（23 MB + 1.6 MB + 11 KB），远低于原估 60–100 MB |
| 文件追踪安全风险 | 检查 `.next/standalone/data` | **发现**：Next 会把构建机的 `data/` 原样打进产物，含 `tasks.json`、`runs/`、`runner.json`（**真实 token**）、`.tw-cookie.json`。必须在构建时排除并加产物断言，否则安装包会泄露构建机凭据与业务数据 |
| standalone 存在性 | 查阅 `node_modules/next/dist/docs/.../output.md` | 支持 `output: 'standalone'`，产出 `.next/standalone/server.js`，支持 `PORT`/`HOSTNAME` |
| standalone 的 cwd 行为 | 阅读 `next/dist/build/utils.js:1108–1122` | 生成代码含 `process.chdir(__dirname)` → **必须 env 化路径** |
| node-pty 原生 ABI | 阅读 `node-pty/package.json`、`lib/utils.js`、`prebuilds/win32-x64/` | 1.1.0 使用 `node-addon-api` + N-API 预编译，跨 ABI 稳定，无需 rebuild |
| 工具链版本 | `npm view` | electron 45.2.1 / electron-builder 26.18.0 / electron-vite 6.0.0 |
| 运行环境 | `node -v` 等 | Node 25.0.0 / yarn 1.22.19 / git 2.20.1 / Claude Code 2.1.296 / Python 3.14.7 / Docker 29.8.2 |

### 4.2 M0 必须实跑验证（2 人日，不通过就调整方案）

> V1 已在计划阶段提前通过（见 4.1）；M0 仍需在**桌面端最终目录结构**下复跑一次，并补上第 2 步的产物安全断言。

| # | 验证 | 命令 / 方法 | 通过标准 |
| --- | --- | --- | --- |
| V1 | standalone 实跑 | 临时加 `output:'standalone'`，`yarn build`，复制 `static`/`public`，`PORT=3999 FEBOT_WORKSPACE=D:/tmp/ws node .next/standalone/server.js` | 首页 200，`/api/runner/info` 200 |
| V2 | 包内 Node 跑 node-pty | `resources/node/node.exe -e "const pty=require('node-pty');..."`（require 路径指向打包副本） | 能 spawn `cmd.exe` 并回显，无 ABI 报错 |
| V3 | runner 打包 | esbuild 单文件 + external node-pty，`node resources/runner/server.mjs` | `/healthz` 200，`data/runner.json` 写入正确工作区 |
| V4 | Electron 最小壳 | electron-vite 模板加载 `http://127.0.0.1:3999` | 页面渲染、xterm 可输入 |
| V5 | 进程树清理 | 启动 run → 退出应用 | `tasklist` 无残留 node/claude；仓库忙位释放 |
| V6 | Windows 长路径/中文路径 | 工作区放在 `D:\测试 工作区\febot` | 脚本、git、PTY 全部正常 |
| V7 | teamwork 登录全流程 | 在 Electron 窗口内完成一次 teamwork 登录（含可能的 SSO 跳转/回调） | 登录成功、`.tw-cookie.json` 落盘；若 `will-navigate` 拦截破坏跳转，需产出 SSO 域名导航白名单方案 |

> 若 V2 失败（N-API 预编译在特定 Node 版本异常），备选：构建机安装 VS Build Tools，用 `node-gyp` 针对内置 Node 重新编译 node-pty；或退回 `@homebridge/node-pty-prebuilt-multiarch`。该备选不影响整体方案。

---

## 5. 代码改造清单

### 5.1 xiaoqian-manager：路径 env 化（必须）

新增 `xiaoqian-manager/lib/server/workspace.ts`：

```ts
import path from "node:path";

const WS = process.env.FEBOT_WORKSPACE?.trim();

/** 工作区根：桌面端显式注入；本地开发回退为 xiaoqian-manager 的上级目录 */
export const WORKSPACE_ROOT = WS ? path.resolve(WS) : path.resolve(process.cwd(), "..");

/** 数据目录：保持与现有仓库布局一致（<workspace>/xiaoqian-manager/data） */
export const DATA_DIR = path.join(WORKSPACE_ROOT, "xiaoqian-manager", "data");

/** 配置路径：优先显式 env，其次工作区根 */
export const CONFIG_PATH = process.env.FEBOT_CONFIG?.trim()
  ? path.resolve(process.env.FEBOT_CONFIG.trim())
  : path.join(WORKSPACE_ROOT, "febot.config.json");
```

替换点（逐个改 import，逻辑不变）：

| 文件 | 现状 | 改为 |
| --- | --- | --- |
| `lib/server/store.ts:11` | `path.join(process.cwd(), "data")` | `DATA_DIR` |
| `lib/server/runner-client.ts:8` | `path.join(process.cwd(), "data", "runner.json")` | `path.join(DATA_DIR, "runner.json")` |
| `lib/server/teamwork/client.ts:30` | `path.join(process.cwd(), "data", ".tw-cookie.json")` | `path.join(DATA_DIR, ".tw-cookie.json")` |
| `lib/server/git/config.ts:185` | `path.join(process.cwd(), "data", "repos.json")` | `path.join(DATA_DIR, "repos.json")` |
| `lib/runner/paths.ts:8-16` | `PROJECT_ROOT` / `FEBOT_ROOT` / `DATA_DIR` | `FEBOT_ROOT = FEBOT_WORKSPACE || resolve(PROJECT_ROOT,"..")`；`DATA_DIR = <FEBOT_ROOT>/xiaoqian-manager/data` |
| `lib/runner/repo-resolve.ts:16` | `path.resolve(process.cwd(), "..")` | `FEBOT_ROOT`（从 `paths.ts` 导入） |
| `xiaoqian-manager/scripts/probe-handlers.ts:21` | `process.cwd()/data/tasks.json` | `DATA_DIR` |
| `xiaoqian-manager/scripts/probe-op.ts:14` | `process.cwd()/data/.tw-cookie.json` | `DATA_DIR` |

兼容性说明：本地开发时 `FEBOT_WORKSPACE` 未设置，回退值与现有行为**逐字节等价**；`next dev`、`yarn runner`、现有测试均不受影响。

### 5.2 runner 改造

| 文件 | 改动 |
| --- | --- |
| `scripts/runner.ts` | 新增 `POST /shutdown`（校验 `x-internal-token`），调用 `manager.shutdown()` 后退出；保留 `/healthz` |
| `scripts/runner.ts` | 启动日志打印工作区、端口、内置 Node 版本，便于诊断 |
| `scripts/runner.ts` | 中断语义：应用退出与 `cleanupStale` 把非终态 run 置 `interrupted`（保留现场）；仅真实执行错误才置 `failed`（详见 §5.6） |
| `next.config.ts` | 增加 `output: "standalone"`（dev 下无副作用）与 `outputFileTracingExcludes: { "/*": ["./data/**"] }`，防止把本地 `data/`（含 runner token、cookie）打进产物 |
| `desktop/scripts/prepare-runtime.mjs` | 复制后断言 `resources/next/data`、`runner.json`、`.tw-cookie.json` 均不存在；命中则构建失败 |
| `package.json`（xiaoqian-manager） | 增加 `build:desktop`（standalone 构建 + 复制 static/public），供桌面端构建调用 |

> runner 保持 `tsx` 开发方式不变；生产由 esbuild 打成单文件，`node-pty` 保持 external 并从 `resources/runner/node_modules` 解析。

### 5.3 根目录脚本

| 文件 | 改动 |
| --- | --- |
| `package.json` | 增加 `desktop:dev` / `desktop:build` / `desktop:dist`；`setup` 增加 `yarn --cwd desktop` |
| `scripts/ensure-config.mjs` | 保持不动；首启向导在桌面端复用同一模板清单，避免两套 seed 逻辑漂移（建议把模板清单抽成 `example/manifest.json`，两端共读） |
| `.gitignore` | 增加 `desktop/node_modules`、`desktop/out`、`desktop/resources/node`、`desktop/.cache` |

### 5.4 新增 `desktop/` 工程

```text
desktop/
  package.json
  electron.vite.config.ts
  tsconfig.json
  src/
    main/
      index.ts            # app 生命周期、单实例、窗口
      settings.ts         # %APPDATA%/febot/desktop.json 读写 + zod 校验
      supervisor.ts       # 子进程状态机、健康检查、退避重启、日志管道
      ports.ts            # 空闲端口分配
      workspace.ts        # 工作区校验、创建、接管
      runtime-sync.ts     # manifest 比对、复制、冲突处理
      doctor.ts           # git / claude / bash / python / docker / yarn 检测
      menu.ts  tray.ts  notifications.ts  updater.ts  logging.ts
      ipc.ts              # 设置窗与主进程的 IPC
    preload/
      index.ts            # contextBridge：只暴露白名单 API
    renderer/
      setup/              # 首启向导 + 环境自检 + 设置（轻量 HTML/TS，不引入新框架）
      error/              # 服务启动失败页
  scripts/
    prepare-runtime.mjs   # 构建 Next/runner/资产/node，生成 manifest
  build/
    icon.ico  installer.nsh
  resources/              # 构建产物（gitignore）
  tests/
    unit/  e2e/
```

**桌面端设置项（`desktop.json`）**

```jsonc
{
  "workspace": "D:\\febot-workspace",
  "claudePath": "",              // 空 = 从 PATH 解析
  "minimizeToTray": true,
  "autoLaunchAtLogin": false,
  "autoUpdate": true,
  "updateChannel": "stable",
  "lastWindow": { "x": 100, "y": 80, "width": 1440, "height": 900 },
  "runtimeVersion": "1.0.0"
}
```

**preload 暴露的最小 API**

```ts
window.febotDesktop = {
  getBootstrap(): Promise<{ workspace: string; appPort: number; runnerPort: number; version: string; runtimeVersion: string }>;
  pickWorkspace(): Promise<string | null>;
  openWorkspace(): Promise<void>;
  openLogs(): Promise<void>;
  openExternal(url: string): Promise<void>;
  restartServices(): Promise<void>;
  runDoctor(): Promise<DoctorReport>;
  onServiceStatus(cb: (s: ServiceStatus) => void): () => void;
};
```

> 产品 UI（Next 页面）**不依赖**该 API 即可运行；后续如需“在页面里显示桌面状态/通知”，再按需接入，避免首版侵入。

### 5.5 需要新增的产品能力（按优先级）

| 优先级 | 能力 | 说明 |
| --- | --- | --- |
| P0 | 首启向导 | 新建工作区 / 接管现有目录；填 `repoRoot`、`repos`、`branches`；写 `febot.config.json` |
| P0 | 环境自检 | 硬依赖：Git、Claude Code、Git Bash；软依赖：Python、Docker、yarn |
| P0 | 服务守护与日志 | 详见 §3.5、§7 |
| P0 | 单实例 + 动态端口 | 避免与现有 dev server 冲突 |
| P1 | 托盘 + 原生通知 | run 进入 done/failed 时通知；关闭窗口默认最小化到托盘 |
| P1 | 原生菜单 | 打开工作区 / 打开配置 / 重启服务 / 查看日志 / 检查更新 |
| P1 | 自动更新 | 空闲时下载，有 run 进行中则延后 |
| P1 | Swagger MCP 一键配置 | 调 `scripts/sync-swagger.mjs`：写 `services.conf`、打补丁、维护项目级 `.mcp.json`（不依赖 bash/claude） |
| P2 | 诊断包导出 | 日志 + 配置（**脱敏 password/cookie/token**）+ 版本信息，打 zip |
| P2 | 克隆目标仓向导 | 在 `gitlab/` 下执行 clone，读 `branches` 并 checkout |

**明确不做（v1）**：多工作区同时打开、账号体系、远程工作区、macOS/Linux 安装包、把 Claude Code 打包进应用、om 看板集成（独立项目，不随桌面端分发）。

---

### 5.6 run 的 `interrupted` 状态与会话恢复（评审补充）

**状态语义**

| 触发 | 行为 |
| --- | --- |
| 应用退出（用户确认后） | 活动 run 落盘为 `interrupted`，保留现场（输出缓冲、会话元数据、会话标识） |
| runner 崩溃 / `cleanupStale` | 非终态 run 置 `interrupted`；仅真实执行错误才置 `failed` |
| 下次启动 | 服务恢复后，UI 中 interrupted run 提供"恢复会话"：优先利用 v1.3 会话化改造产出的会话标识恢复（如 `claude --resume <sessionId>`），在原工作区继续；无法恢复时降级为"输出现场可完整查看 + 重新发起"，并说明原因 |

**约束**：中断恢复不得伪造 run 已完成；恢复后的 run 与原 run 共享同一 run id 与轨迹。退出确认、`interrupted` 落盘、`cleanupStale` 语义改造列入 M2（任务 M2-7）。

---

## 6. 工作区模型与运行时同步

### 6.1 首次运行

1. 选择工作区目录（默认 `%USERPROFILE%\febot-workspace`；若检测到 `D:\febot` 等已有目录，提供“接管”）。
2. 新建模式：复制 `resources/runtime` → 工作区；创建 `docs/requirements`、`gitlab`、`xiaoqian-manager/data/{runs,temp}`、`.febot/{index,tmp}`。
3. 从 `example/` seed 用户文件（**仅当不存在**）：`febot.config.json`、`tasks.md`、`file-lock.md`、`.claude/settings.json`、`swagger-mcp-server/services.conf`、`scripts/hindsight.env`。
4. 打开配置向导（至少填 `repoRoot` / `repos` / `branches.default`），做 JSON Schema 校验；提供“打开文件手动编辑”。
5. 环境自检；通过后启动服务、打开主窗口。

**接管已有目录**：校验 `febot.config.json`、`scripts/advance.mjs`、`.claude/commands/pipeline.md` 至少存在两项；不复制运行时，先以现有文件启动；首次成功启动后生成基线快照写入 `.febot/runtime.json`（若跳过，则按 §6.3 无基线规则在首次升级时处理）；在设置里提供”同步到桌面版运行时（先备份）”按钮。

### 6.2 工作区布局校验（启动时）

| 检查 | 不通过时 |
| --- | --- |
| 工作区存在且可写 | 阻断，要求重新选择 |
| 位于本地 NTFS（非 OneDrive 同步盘 / 网络盘） | 警告并允许继续（可能文件锁/性能异常） |
| `febot.config.json` 可解析 | 阻断，打开配置向导 |
| `repoRoot` 存在 | 警告，仍可启动（同步/定仓会失败） |
| 至少一个仓库目录存在 | 警告 |
| 剩余磁盘 ≥ 2 GB | 警告 |

### 6.3 运行时同步（升级）

1. 构建期：`prepare-runtime.mjs` 遍历受管文件，生成 `runtime-manifest.json`：`{ version, files: { "<相对路径>": "<sha256>" } }`。
2. 工作区 `.febot/runtime.json` 记录上次同步的 `{ version, files }`。
3. 启动时若版本不同，逐文件决策：

| 工作区文件状态 | 动作 |
| --- | --- |
| 不存在 | 复制 |
| 与 **旧 manifest** 哈希一致（用户未改） | 用新版本覆盖 |
| 与新 manifest 哈希一致 | 跳过 |
| 与两者都不同（用户改过） | **不覆盖**，写 `<file>.febot-new`，记入冲突列表 |

4. 冲突汇总弹窗：列出文件、提供”打开目录 / 保留我的 / 用新版覆盖”。
5. **仅对”将被覆盖”的文件**（存在且与旧 manifest 一致、需用新版替换者）打 zip 备份到 `%APPDATA%\febot\backup\<version>-<ts>.zip`（保留最近 3 份）。

> **无基线（首次同步）**：工作区 `.febot/runtime.json` 缺失（典型：接管模式跳过基线生成）时，按首次同步处理——直接覆盖受管文件，覆盖前做一次**全量**备份（仅此一次），随后写入基线，之后的升级恢复正常比对。
6. 任何同步失败都不阻断启动，只降级提示（运行时文件缺失会导致流水线失败，需明确告警）。

### 6.4 与现有 `D:\febot` 的关系

- 当前仓库可直接作为“接管模式”工作区使用，无需迁移数据。
- 桌面版的默认新工作区不包含 `gitlab/` 历史与 `docs/requirements/` 历史（用户自行 clone / 拷贝）。
- 仓库本身继续支持 `yarn dev` / `yarn runner` 的开发者工作流；桌面端不替代开发模式。

---

## 7. 桌面壳功能规格（v1）

| 模块 | 规格 |
| --- | --- |
| 主窗口 | 1440×900 默认，最小 1024×700；记忆位置；标题显示当前工作区名 |
| 加载失败页 | Next 未就绪/崩溃时显示本地页：错误摘要、日志按钮、重试、切换工作区 |
| 托盘 | 图标 + 菜单：显示主窗口 / 服务状态 / 重启服务 / 打开工作区 / 退出；关闭窗口默认隐藏到托盘 |
| 通知 | run 状态变为 done/failed/interrupted 时发 Windows 通知（主进程 watch `runs/*.json`，避免改 runner 协议）；点击聚焦对应 `/runs/<id>` |
| 菜单 | 文件：打开工作区/打开配置/打开日志目录/退出；服务：重启 Next/重启 Runner/环境自检；工具：配置 Swagger MCP；帮助：版本/检查更新 |
| 日志 | `electron-log`；子进程 stdout/stderr 带前缀写入；单文件 10 MB × 5 滚动；设置页可一键打开 |
| 更新 | 启动后 5 分钟检查一次，之后每 4h；有进行中的 run 时只下载不重启；重启前提示保存 |
| 安全 | 只加载 `http://127.0.0.1:*`；`will-navigate` 拦截外部 URL 并 `shell.openExternal`；禁止 `window.open` 新 Electron 窗口；不开启远程调试 |
| 诊断包 | 版本、工作区路径、服务状态、日志、配置副本（`password`/`cookie`/`token`/`autograph` 全部替换为 `***`） |

---

## 8. 里程碑与任务清单

> 估算按 1 名熟悉前端与 Node 的工程师计；括号内为依赖。

### M0 可行性穿刺（2 人日）

- [ ] M0-1 临时启用 `output:'standalone'`，产出并实跑 standalone（V1）
- [ ] M0-2 用内置 Node 实跑 node-pty（V2）；记录成功版本组合
- [ ] M0-3 esbuild 打包 runner，实跑 `/healthz` 与一次 fake-claude 会话（V3）
- [ ] M0-4 electron-vite 最小壳加载 UI，xterm 输入回显（V4）
- [ ] M0-5 退出清理验证（V5）
- [ ] M0-6 teamwork 登录全流程验证（V7）；若导航拦截破坏登录，产出 SSO 域名白名单方案
- [ ] M0-7 形成 `docs/desktop/spike-report.md`（版本、命令、结论、备选）

**验收**：V1–V7 全绿；任一红灯有明确备选方案与工作量重估。

### M1 桌面壳与服务守护（4 人日）

- [ ] M1-1 `desktop/` 工程脚手架（electron-vite + TS + eslint）
- [ ] M1-2 `supervisor.ts`：状态机、健康检查、退避重启、日志管道
- [ ] M1-3 `ports.ts`：动态端口 + EADDRINUSE 重试
- [ ] M1-4 单实例锁、窗口状态、托盘、菜单、加载失败页
- [ ] M1-5 退出时序：`/shutdown` + `taskkill /T /F`
- [ ] M1-6 开发模式：`desktop:dev` 拉起 `next dev` + `tsx runner`（保留 HMR）

**验收**：开发机上双击启动 → 页面可用 → 启动一次流水线 → 退出后无残留进程。

### M2 工作区与路径改造（5 人日）

- [ ] M2-1 新增 `lib/server/workspace.ts`，替换 §5.1 全部路径点
- [ ] M2-2 runner `paths.ts` / `repo-resolve.ts` env 化；新增 `/shutdown`
- [ ] M2-3 工作区创建/校验/接管逻辑 + 布局校验
- [ ] M2-4 首启向导（选择目录、seed、配置表单、JSON 校验）
- [ ] M2-5 环境自检 `doctor.ts` + 修复引导（含 `claude` 绝对路径探测：PATH / `%APPDATA%\npm\claude.cmd`）
- [ ] M2-6 回归：`yarn dev`、`yarn runner`、现有流水线在未设置 env 时行为不变
- [ ] M2-7 run `interrupted` 状态 + 退出确认弹框 + 会话恢复（§5.6）；`cleanupStale` 语义改造

**验收**：① 新建工作区可完整跑通”同步 → 计划 → fake-claude 会话 → 收口”；①b 有活动 run 时退出弹确认，确认退出再启动后 run 为 interrupted、现场可查看并可恢复会话；② 接管 `D:\febot` 可正常启动且不覆盖任何现有文件；③ 未设置 env 的开发模式行为与改造前一致。

### M3 打包与更新（5 人日）

- [ ] M3-1 `prepare-runtime.mjs`：Next standalone、runner bundle、runtime 资产、node 下载与校验、manifest
- [ ] M3-2 electron-builder NSIS 配置（每用户安装、快捷方式、图标、`extraResources`）
- [ ] M3-3 运行时同步与冲突处理（§6.3）
- [ ] M3-4 `electron-updater` 接入 + `latest.yml` 生成 + 内网源
- [ ] M3-5 干净 Windows 11 虚拟机安装测试（仅装 Git + Claude Code）
- [ ] M3-6 体积优化：剔除 `.pdb`/`.map`；评估 code-indexer 打包裁剪（可选）

**验收**：干净机器上安装 → 向导 → 跑通一次会话；安装包 ≤ 250 MB（压缩后）。

### M4 加固与发布（4 人日）

- [ ] M4-1 单元测试：路径解析、端口分配、同步冲突、supervisor 状态机
- [ ] M4-2 Playwright E2E：安装后启动、首启向导、fake-claude 全流程、退出清理
- [ ] M4-3 升级测试：v1 安装并产生数据 → 安装 v2 → 数据与用户改动保留
- [ ] M4-4 异常测试：杀掉 runner/Next、端口占用、工作区只读、断网
- [ ] M4-5 代码签名（有证书则签；无证书则在发布说明中写明 SmartScreen 处理）
- [ ] M4-6 用户文档 `docs/desktop/使用说明.md` + 试点 2 人反馈

**验收**：测试矩阵全绿；试点用户独立完成“安装 → 配置 → 跑通一个需求”。

**总计：约 20 人日（4 周，含缓冲）。**

---

## 9. 打包与发布

### 9.1 构建流水线

```text
yarn --cwd desktop dist
  ├─ 1. 清理 desktop/resources、desktop/out
  ├─ 2. xiaoqian-manager: yarn build（output: standalone + 排除 ./data/**）
  │     复制 .next/standalone → resources/next
  │     复制 .next/static → resources/next/.next/static
  │     复制 public → resources/next/public
  │     断言：不得存在 data/**、runner.json、.tw-cookie.json（否则构建失败）
  ├─ 3. esbuild scripts/runner.ts → resources/runner/server.mjs
  │     resources/runner/node_modules/node-pty（剔除 .pdb）
  ├─ 4. 复制运行时资产 → resources/runtime
  │     scripts / code-indexer / .claude 模板 / example / swagger / docs 模板
  ├─ 5. 下载并校验 Node 24.x win-x64 → resources/node（缓存命中则跳过）
  ├─ 6. 生成 resources/runtime-manifest.json
  ├─ 7. electron-vite build（main / preload / renderer）
  └─ 8. electron-builder --win nsis
        产物：dist/febot-Setup-<version>.exe、latest.yml、*.blockmap
```

### 9.2 electron-builder 关键配置

```yaml
appId: com.example.febot
productName: febot
directories: { output: dist, buildResources: build }
files: ["out/**", "package.json"]
extraResources:
  - { from: resources/next, to: next }
  - { from: resources/runner, to: runner }
  - { from: resources/runtime, to: runtime }
  - { from: resources/node, to: node }
  - { from: resources/runtime-manifest.json, to: runtime-manifest.json }
win:
  target: [ { target: nsis, arch: [x64] } ]
  icon: build/icon.ico
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  deleteAppDataOnUninstall: false   # 卸载保留工作区与设置
publish:
  provider: generic
  url: https://<内网静态源>/febot/
```

### 9.3 发布策略

- **版本号**：`major.minor.patch`；运行时资产版本与安装包版本一致（`runtimeVersion`）。
- **渠道**：`stable` / `beta`（beta 供试点）；`latest.yml` 按渠道分目录。
- **签名**：优先使用公司代码签名证书（避免 SmartScreen 拦截）；无证书时在发布说明中给出“更多信息 → 仍要运行”的指引，并在试点范围内分发。
- **回滚**：保留上一个版本的安装包与 `latest.yml`；electron-updater 支持降级需显式开关，默认不降级。

---

## 10. 测试与验收

### 10.1 测试矩阵

| 场景 | 步骤 | 期望 |
| --- | --- | --- |
| 干净安装 | Win11 虚拟机，仅装 Git + Claude Code | 安装成功，向导完成，主界面可用 |
| 新建工作区 | 默认目录 | 运行时资产齐全，配置模板生成，服务启动 |
| 接管现有目录 | 指向 `D:\febot` | 不覆盖任何文件，现有流水线可直接跑 |
| fake-claude 冒烟 | PATH 前置假 `claude.cmd` | run 正常启动、输出、收口；无真实调用 |
| 端口冲突 | 先占用 3010/3011 | 自动换端口，UI 正常 |
| 服务崩溃 | 任务管理器杀掉 runner | 自动重启 + 通知；进行中的 run 标记 interrupted，重启应用后可恢复会话 |
| 应用退出 | 有进行中的 run | 弹确认框；确认后无孤儿 node/claude；忙位释放；run 标记 interrupted，重启后现场可查看并可恢复 |
| 升级 | v1 产生数据后装 v2 | 数据/配置/用户改动保留；受管文件更新；冲突可见 |
| 缺依赖 | 卸载 Git / 改坏 claude 路径 | 自检给出明确指引，不崩溃 |
| 中文/空格路径 | 工作区 `D:\测试 工作区` | 全流程正常 |
| 网络盘/OneDrive | 工作区放同步盘 | 启动前警告 |
| 长时间运行 | 运行 6h+ | 日志滚动正常，内存无持续增长 |

### 10.2 v1.0 发布验收（必须全部满足）

1. 干净 Windows 11 上，**只装 Git for Windows 与 Claude Code** 即可完成安装与首次运行。
2. 新建工作区与接管现有目录两条路径均可跑通“同步 → 计划 → 编码会话 → 收口”。
3. 应用退出后 `tasklist` 无 `node.exe` / `claude.exe` / `winpty-agent.exe` 残留。
4. 升级安装不丢失 `febot.config.json`、`tasks.json`、`docs/requirements/**`、`gitlab/**`。
5. 安装包 ≤ 250 MB；冷启动到主界面 ≤ 15s（SSD）。
6. 日志与诊断包不泄露 `teamwork.password` / `teamwork.cookie` / `devplatform.token` / runner token。

---

## 11. 风险登记册

| # | 风险 | 概率 | 影响 | 对策 |
| --- | --- | --- | --- | --- |
| R1 | Next standalone 在生产模式下路径/静态资源异常 | 中 | 高 | M0-1 先实跑；所有路径 env 化；准备 `next start` 全量 node_modules 备选方案 |
| R2 | node-pty 在内置 Node 版本下无法加载 | 低 | 高 | 已确认 N-API 预编译；M0-2 实跑；备选 node-gyp 重编译 / 预编译多架构包 |
| R3 | GUI 启动时找不到 `claude` | 高 | 中 | 自检 + 绝对路径配置 + 将 `%APPDATA%\npm` 前置到 PATH；文档给出安装指引 |
| R4 | 退出后 ConPTY 子进程残留 | 中 | 中 | `/shutdown` + `taskkill /T /F` + E2E 断言 |
| R5 | 安装包过大 | 中 | 低 | 剔除 pdb/map；code-indexer 二次裁剪；portable 版供内网分发 |
| R6 | 无签名导致 SmartScreen 拦截 | 高 | 中 | 申请证书；过渡期发布说明 + 试点范围 |
| R7 | 工作区在 OneDrive/网络盘导致文件锁异常 | 中 | 中 | 启动校验 + 警告 + 建议本地目录 |
| R8 | 运行时同步覆盖用户定制 | 低 | 高 | 哈希三方比对 + `.febot-new` + 备份 + 冲突弹窗 |
| R9 | 现有 `D:\febot` 与桌面版并发操作同一工作区 | 中 | 中 | 启动时写 `desktop.lock`（pid）；检测到 `yarn dev` 占用时警告 |
| R10 | 后续 Next/React 升级破坏 standalone 假设 | 中 | 中 | 安装包锁定依赖版本；升级前跑 M0 验证集 |
| R11 | 流水线依赖 Git Bash / Python 未安装 | 中 | 中 | 自检分级：硬依赖阻断、软依赖警告 |
| R12 | 安全：`bypassPermissions` + 本地代码执行 | 已知 | 高 | 沿用现有 `archive` deny；工作区由用户选择；不新增远程能力；文档明示 |
| R13 | standalone 文件追踪把构建机 `data/` 打进安装包（**已实测复现**，含 runner token、`.tw-cookie.json`） | 高 | 高 | `outputFileTracingExcludes` 排除 `./data/**`；构建后断言产物无 `data/**`、`runner.json`、`.tw-cookie.json`；CI 使用干净检出构建 |
| R14 | teamwork 登录含外部跳转/回调，被 `will-navigate` 拦截破坏 | 中 | 高 | M0-V7 实跑验证；必要时 SSO 域名加入导航白名单，或 `setWindowOpenHandler` 放行登录窗口 |

---

## 12. 排期与资源

| 周 | 里程碑 | 关键交付 |
| --- | --- | --- |
| W1 | M0 + M1 前半 | spike 报告、最小可运行壳 |
| W2 | M1 后半 + M2 | 服务守护、工作区、首次运行向导 |
| W3 | M3 | 安装包、运行时同步、自动更新 |
| W4 | M4 | E2E、加固、试点、v1.0 |

**可选快速验证（V0，3–5 人日）**：只做 Electron 壳 + 进程守护 + 指向现有 `D:\febot`，不做工作区分离、不做安装包。用于提前验证“桌面壳形态是否被团队接受”，再决定是否投入完整方案。**建议先做 V0 的 M0 部分（2 天），用真实 UI 给 1–2 名同事试用。**

---

## 13. 立即行动清单（接下来 3 天）

1. **评审本计划**，确认：① Electron 路线；② 工作区采用“复制运行时资产”而非 junction；③ v1 仅 Windows。
2. 执行 M0-1：临时启用 standalone，按 §4.2 跑通 V1，记录实际产物体积。
3. 执行 M0-2/M0-3：内置 Node + node-pty + runner 打包实跑，记录版本组合。
4. **构建安全**：给 `prepare-runtime.mjs` 加产物断言（禁止 `data/**`、`runner.json`、`.tw-cookie.json` 进入安装包）；CI 一律从干净检出构建。
5. 产出 `docs/desktop/spike-report.md`；若 V1–V3 全绿，按 M1 开工；若有红灯，先修订 §3/§9 再排期。
6. 同步准备：应用图标（`.ico`，含 256/128/64/48/32/16）、内网更新源目录、代码签名证书申请（如有）。

---

## 附录 A：本地开发命令（改造后）

```bash
# 现有方式保持不变
yarn dev
yarn runner

# 桌面壳开发（HMR：Next 仍跑 next dev）
yarn desktop:dev

# 构建安装包
yarn desktop:dist

# 仅装配运行时资产（调试打包问题）
node desktop/scripts/prepare-runtime.mjs
```

## 附录 B：关键路径速查

| 用途 | 路径 |
| --- | --- |
| 配置唯一入口 | `xiaoqian-manager/lib/server/config/root.ts`（已有 `FEBOT_CONFIG` 支持） |
| runner 固定路径 | `xiaoqian-manager/lib/runner/paths.ts` |
| 定仓脚本 | `scripts/resolve-repo.mjs` |
| 剧本 | `.claude/commands/pipeline.md` |
| 首次运行 seed 清单 | `scripts/ensure-config.mjs` |
| 依赖检查 | `xiaoqian-manager/package.json`、根 `README.md` §0.1 |

## 附录 C：结论复述

- **技术栈：Electron 45 + electron-vite 6 + electron-builder 26 + 现有 Next 16 前端/服务端 + 内置 Node 24 + node-pty 1.1.0（N-API）。**
- **架构：桌面壳只做进程编排；Next 与 runner 作为本地服务由壳守护；产品 UI 原样复用。**
- **最大改造不是“写桌面 UI”，而是“把工作区从代码目录里拆出来”**——路径 env 化、首次运行、运行时同步三件事做好，剩下的都是工程化包装。
- **中断不丢 run**：应用退出/崩溃只把 run 标记为 `interrupted` 并保留现场，下次启动恢复会话——这是桌面端区别于 dev 体验的核心承诺（§5.6）。
- **先做 2 天 M0 穿刺**，用实跑结果锁定版本与打包方式，再进入 4 周正式开发。
