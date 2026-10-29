# xiaoqian-manager 流水线「会话化」改造计划书

- 版本：v1.3
- 日期：2026-10-27
- 适用仓库：`D:\febot\xiaoqian-manager`（剧本侧变更在 febot 仓，见 §4.3）
- 状态：待实施
- 技术栈：Next.js 16.3.7 / React 19 / TypeScript / yarn 1.22
- 变更：v1.1 吸收三项确认——移除 `PIPELINE_MODE` 双模式、仅整文件驳回、任务只在本机执行；v1.2 增加两项借鉴自 Warp 的设计——注意力路由、结构化事件流；v1.3 审查修订——定仓前移（启动时同源解析目标仓）、锁文件改为 runner 仓库状态注册表 + app 前置门禁（拒绝模型，干净/开工门禁归剧本）、驳回两段式防 staged、事件写入收敛 advance.mjs 经 env 注入、runner 与 yarn dev 解耦、`gate` 事件改名 `wait`、全事件 seq 补发

---

## 0. 一页摘要

| 项 | 内容 |
|---|---|
| **核心目标** | 让应用「拥有」Claude Code 会话，而不是把进程甩到外部窗口 |
| **五个关键词** | 内嵌 PTY、仓库状态门禁、基线 diff、推送式状态、事件时间线 |
| **不做** | worktree 隔离、文件锁（注册表替代）、桌面端打包（延后）、模型网关、多人远程会话 |
| **总工期** | 约 8–11 人日（不含 Tauri 包壳） |
| **最大风险** | Claude Code TUI 在 xterm.js 中的兼容性；node-pty 原生模块安装 |
| **回滚方式** | 独立分支开发，按 Phase tag 回退 |

### 改造前后对比

| 维度 | 现状 | 改造后 |
|---|---|---|
| 终端 | 每个任务弹一个独立 cmd 窗口，应用失管 | 应用内一任务一 tab，PTY 归应用所有 |
| 状态 | 文件轮询 + HTTP 轮询 | 一条 WS 长连接，服务端推送 |
| 退出码 | 靠 `.exit` 文件兜底 | PTY `onExit` 直接拿到 |
| diff | 无归属、靠人肉看 | 锚定 `baseSha`，按任务展示 |
| 并发 | 同仓库多任务互相踩文件 | 仓库状态注册表前置门禁，同仓第二个任务直接拒绝（409），不同仓并行 |
| 会话恢复 | dev 重启即丢 | runner 独立进程，重启 Next 不杀会话，页面刷新可重连 |
| 进度 | 只能看终端滚动猜 | 步骤时间线（事件流）+ 终端原文 |
| 注意力 | 无提示，靠人找 | `needs_input` 状态 + 待处理计数 |

---

## 1. 现状与问题

### 1.1 现状

- UI：Next.js App Router，`app/page.tsx` 单页 + `app/api/tasks/**` 若干 Route Handler
- 任务存储：`lib/server/store.ts`（文件型，单进程写入）
- 启动逻辑：`lib/server/pipeline/runner.ts`，`spawn("cmd.exe", ["/c","start","/wait","cmd","/k", wrapper])`，claude 工作目录固定 febot 根
- 状态回收：包装脚本写 `<id>.exit`，`/pipeline` 剧本写 `<id>.done.json`，服务端每 2s 轮询
- 剧本侧已有机制（app 不知道、本次不重复实现）：开工门禁（分支 == 基准分支且工作区干净）、`file-lock.md` 同仓互斥、done 预检 `advance check`
- 已知边界（代码注释已记录）：仅单进程有效；dev server 重启会丢失轮询

### 1.2 问题

| 编号 | 问题 | 影响 |
|---|---|---|
| P1 | 进程所有权在应用之外 | 窗口无法枚举、无法聚焦、无法终止；用户手动关窗即失控 |
| P2 | 外部窗口开得越多越乱 | 5 个任务就是 5 个窗口，任务与窗口无稳定映射 |
| P3 | 通信依赖轮询 | 状态延迟 ≥2s；HTTP 短连接反复拉；文件系统被当 IPC |
| P4 | app 层无仓库级隔离 | 两个任务可同时开窗口，剧本 file-lock 才发现冲突，白开一个窗口 |
| P5 | 无 diff 视图 | 需要切到 IDE 或手工跑 `git diff`，审阅环节缺失 |
| P6 | 状态源分散 | 内存 map、锁文件、`.exit`、`.done.json`、store 各存一份 |

> P4 说明：仓库互斥在系统层面由剧本 file-lock 兜底，缺的是 app 层的**提前感知**——本方案补的是前置门禁，不是新互斥机制。

---

## 2. 目标与非目标

### 2.1 目标（可度量）

| 编号 | 目标 | 验收方式 |
|---|---|---|
| G1 | 应用内可完整操作 Claude Code 会话 | 输入、输出、Ctrl+C、resize 均可用 |
| G2 | 同一仓库同时最多一个进行中任务 | 并发启动只有一个成功（另一个 409） |
| G3 | 每个任务可看到自己的 diff | 文件列表 + hunk，归属正确 |
| G4 | 状态变更端到端延迟 < 500ms | 推送链路可用 |
| G5 | 页面刷新不丢终端 | 重连后恢复最近 256KB 输出 |
| G6 | 重启 Next 不杀会话 | Next 重启期间 runner 中会话继续存活，重连后状态完整 |
| G7 | 需要人工介入的任务被优先看到 | 列表按注意力排序；待处理计数准确 |
| G8 | 任务进度可结构化回看 | 事件流完整，可由事件还原步骤时间线 |

> G6 边界：只保证 **Next 重启**。runner 自身重启不进行会话热恢复（ConPTY 句柄不可跨进程重挂），进行中 run 一律 failed 后重跑，见 §7.1。

### 2.2 非目标

- ❌ 不做 git worktree 隔离（仓库复制、无 node_modules 无法本地测试）
- ❌ 不做文件锁/心跳/TTL（由仓库状态注册表 + 启动清扫替代，见 D1）
- ❌ 不做排队：同仓库第二个任务直接 409 拒绝（已确认拒绝模型）
- ❌ 不做多人共享同一会话
- ❌ 不做跨机器任务调度（已确认：任务只在本机执行）
- ❌ 不做模型路由/网关（DeepSeek 由 Claude Code 自行配置）
- ❌ 不自动 commit、不自动 push
- ❌ app 层不重复做工作区干净检查（开工门禁归剧本，见 D5）
- ❌ 本期不做桌面端打包（Phase 6 可选）

---

## 3. 关键决策（ADR）

### D1｜仓库状态注册表 + 前置门禁（不做锁文件、不做 worktree）

- **决定**：runner 独占维护 `data/repos.json` 仓库状态注册表（repoKey → static/busy + 占用 runId）；app 启动任务时先**前置定仓**解析目标仓（M1，见 §7.1），再查询注册表，static 才放行，busy 直接 409 拒绝（返回占用者）。同仓库不排队。
- **理由**：worktree 会复制仓库且不含 `node_modules`，无法本地跑测试；文件锁需要心跳、TTL、陈旧接管，复杂度高。已确认单本机、单 runner，注册表由唯一进程在事件循环内原子维护即可；且剧本的开工门禁与 file-lock 已在更深处兜底，app 层只做快速失败。
- **代价**：runner 重启 = 进行中 run 全部 failed（不做热恢复）。
- **缓解**：启动清扫保证注册表自洽（§7.1）；不同仓库不受彼此影响，仍可并行；Next 重启不影响 runner（D3）。

### D2｜内嵌 PTY 取代外部窗口

- **决定**：用 `node-pty` 在应用进程内创建会话，前端用 `xterm.js` 渲染。
- **理由**：只有拥有 PTY，才能拿到 stdout、退出码，并能终止、重连、关联 diff。
- **代价**：需要处理 TUI 渲染、resize、输入转发。
- **缓解**：Phase 0 先做技术验证（spike）；验证不通过则本方案暂停、回到技术选型，不保留双模式兜底。

### D3｜runner 独立进程，与 `yarn dev` 解耦

- **决定**：新增 `scripts/runner.ts` 常驻进程，独占 PTY、仓库状态注册表、git 操作；Next.js 只负责 UI 与任务存储。runner 独立启动（`yarn runner`），**不与 `yarn dev` 绑定**。
- **理由**：Next dev 的 HMR/重启会杀掉进程内会话（P6 已踩过）；且 Route Handler 不适合承载 WebSocket。解耦后 Next 可以随便重启、升级，runner 生命周期独立。
- **代价**：多一个进程要手动拉起、要监控。
- **缓解**：runner 提供 `/healthz`；Next 启动及前端常驻探测，未启动则 UI 提示「runner 未运行」（不阻塞浏览与任务管理）；README 写明启动顺序。

### D4｜推送取代轮询

- **决定**：终端 I/O 与状态变更走 WebSocket；git 变更由 runner 监听后推送。
- **理由**：轮询是 P3 的根因；xterm 需要双向通道，SSE 不够。
- **代价**：需要维护连接、心跳、重连。
- **缓解**：单连接多路复用（按 runId 订阅）；断线指数退避重连；**所有事件类型共享同一 seq 并参与断线补发**（§6.2）。

### D5｜diff 锚定 baseSha；干净/开工门禁归剧本

- **决定**：runner 在目标仓记录启动时 HEAD 为 `baseSha`，diff 全部以此为准。工作区是否干净、分支是否等于基准分支，**沿用 `/pipeline` 剧本现有开工门禁，app 不重复校验**（删除 422 与 stash 弹窗）。
- **理由**：剧本门禁已覆盖且更严（多查分支）；app 重复校验只会产生两套口径，且 app 启动时无法可靠判定（定仓后才知目标仓）。
- **代价**：app 放行后剧本门禁仍可能拒绝（exit 5）→ 该 run 无 done.json，按 failed 收口，note 提示「开工门禁未通过，详见终端输出」。
- **缓解**：前置定仓把「未 feed / 无法定仓」提前在 app 层拒绝，不再白开窗口；剧本门禁失败的结构化提示列入后续优化。

### D6｜diff 视图放在任务详情右栏

- **决定**：主位置是会话页右侧常驻窄栏；可展开为全屏审阅；另有全局待审队列。
- **理由**：diff 是某个任务的证据，脱离任务没有意义；跑的过程中就要能看。
- **代价**：页面信息密度上升。
- **缓解**：窄栏默认只显示文件列表，hunk 按需加载；提供折叠。diff 展示工作区相对 baseSha 的全部改动，**不区分改动来源**（剧本改的与用户手改的都展示，已确认）。

### D7｜桌面壳延后

- **决定**：Phase 1–5 全部以 web 形态交付，Phase 6 再评估 Tauri 包壳。
- **理由**：已确认任务只在本机执行，桌面端价值成立；但真正的痛点仍是会话所有权与 diff，先包壳会重复踩坑。
- **代价**：短期内仍有浏览器标签页。
- **缓解**：UI 与运行时解耦，包壳时零改动复用；runner 只监听 `127.0.0.1`，天然适配本地桌面形态。

### D8｜结构化事件流作为第二通道

- **决定**：`/pipeline` 剧本运行过程中产生 `data/runs/<id>.events.jsonl`；**写入点收敛到 `advance.mjs` 统一代写**（剧本各阶段本就要调 advance，主对话与 subagent 不直接拼事件）；事件文件绝对路径由 runner 起 PTY 时经 env 注入（`XQ_EVENTS_FILE`）。终端原始输出保持不变，两条通道并行。
- **理由**：解析 ANSI 输出脆弱、随 Claude Code 版本升级即失效；结构化事件可用于时间线、审计、断线重连与失败复盘。写入收敛到 advance 让契约单点维护，最大限度避免「事件与实现漂移」。
- **代价**：这是**跨仓契约变更**（app 在 xiaoqian-manager，剧本在 febot 仓 `pipeline.md` + `scripts/advance.mjs`），需要两边同步改造。
- **缓解**：不做跨版本兼容/握手，**app 与剧本同步改造、同步启用**（已确认）；事件带 `v` 版本字段；runner 对未知 `type` 忽略并计数，不报错；事件只存引用（路径），不存代码内容。

### D9｜注意力路由

- **决定**：`RunStatus` 增加 `needs_input`；列表按「待你处理 > 失败 > 运行中 > 其他」排序；只有 `needs_input` 与 `failed` 触发通知（web 形态为浏览器通知，Phase 6 托盘才是真·系统通知）。
- **理由**：屏幕默认应保持安静，只在需要人决策时亮起；这正是「窗口很乱、不知道谁在等我」的根因。
- **代价**：需要可靠判定「何时需要人」。
- **缓解**：由剧本显式写入 `wait/waiting` 事件驱动，**不通过输出空闲时间或关键词猜测**。剧本须把所有人工等待点（计划评审、恢复流程问负责人等）显式 wait 化（见 §7.9）。

> 术语区分：本计划的 `wait` 事件 = 人工等待点；剧本已有的 `gate`（`gate.head` 开工门禁）是另一概念，不混用。

---

## 4. 目标架构

### 4.1 进程拓扑

```
┌──────────────────────────────────────────────────────┐
│ 浏览器                                                │
│  task 列表 │ 会话页（终端 + diff）│ 待审队列            │
└───────▲──────────────────────▲───────────────────────┘
        │ HTTP (Next 3010)     │ WebSocket (runner 3011)
┌───────┴──────────┐   ┌───────┴──────────────────────┐
│ Next.js 进程      │   │ runner 进程（常驻，独立启动）   │
│ · UI / SSR       │   │ · PTY 会话池                   │
│ · 任务存储（唯一写）│◄──┤ · 仓库状态注册表 repos.json    │
│ · 内部回调接口     │   │ · git baseline / diff / reject │
└──────────────────┘   │ · 输出环形缓冲                  │
                       │ · WS 推送                      │
                       └───────────▲──────────────────┘
                                   │ ConPTY（cwd = febot 根）
                       ┌───────────┴──────────┐
                       │ claude /pipeline <id> │
                       └──────────────────────┘
```

### 4.2 职责边界（重要）

| 数据 | 唯一写入方 | 说明 |
|---|---|---|
| 任务、阶段、轨迹 | **Next 进程** | 沿用 `lib/server/store.ts`，避免双写 |
| 会话、进程、仓库状态、输出缓冲 | **runner 进程** | 通过内部 HTTP 回调通知 Next 收口 |
| 仓库状态注册表 `repos.json` | **runner 进程** | 启动清扫保证自洽，见 §7.1 |
| 结构化事件 `events.jsonl` | **advance.mjs（剧本侧）** | runner 经 env 注入路径，只读并转发，不回写 |
| diff | 不落库 | 每次按需计算，runner 提供 |

> 禁止两个进程同时写 `data/*.json`。runner 需要改任务状态时，调用 Next 的内部接口。

### 4.3 新增/修改文件清单

**xiaoqian-manager（本仓）**：

| 文件 | 动作 | 说明 |
|---|---|---|
| `scripts/runner.ts` | 新增 | runner 入口，HTTP + WS 服务，独立启动 |
| `lib/runner/pty.ts` | 新增 | PTY 会话池、输出缓冲、resize（cwd 固定 febot 根） |
| `lib/runner/repos.ts` | 新增 | 仓库状态注册表：登记/释放/启动清扫 |
| `lib/runner/repo-resolve.ts` | 新增 | 前置定仓：调 febot `scripts/locate.mjs` 同源解析目标仓 |
| `lib/runner/git.ts` | 新增 | baseline、diff、reject（两段式，见 §7.7） |
| `lib/runner/events.ts` | 新增 | 事件文件 tail、解析、广播 |
| `lib/runner/protocol.ts` | 新增 | WS 消息类型定义（前后端共享） |
| `lib/server/pipeline/runner.ts` | 修改 | 改为调用 runner HTTP；删除旧 spawn 窗口路径 |
| `app/api/tasks/[id]/pipeline/route.ts` | 修改 | 前置定仓 + 门禁 + 409 拒绝语义 |
| `app/api/runs/[id]/route.ts` | 新增 | 查询会话状态 |
| `app/api/runs/[id]/diff/route.ts` | 新增 | 文件列表 + 单文件 patch |
| `app/api/runs/[id]/reject/route.ts` | 新增 | 整文件驳回 |
| `app/api/internal/runs/[id]/settled/route.ts` | 新增 | runner 回调，收口阶段 |
| `components/pipeline/SessionView.tsx` | 新增 | 会话页布局 |
| `components/pipeline/TerminalPane.tsx` | 新增 | xterm 封装 |
| `components/pipeline/DiffPanel.tsx` | 新增 | 右栏 diff |
| `components/pipeline/Timeline.tsx` | 新增 | 步骤时间线 |
| `components/pipeline/ReviewQueue.tsx` | 新增 | 待审队列 |
| `lib/domain/schema.ts` | 修改 | 增加 PipelineRun 类型 |

**febot 仓（剧本侧，同步改造、同步启用）**：

| 文件 | 动作 | 说明 |
|---|---|---|
| `.claude/commands/pipeline.md` | 修改 | 全部人工等待点显式 wait 化（计划评审、恢复流程问负责人等），由 advance 落盘 |
| `scripts/advance.mjs` | 修改 | 代写 events.jsonl（从 `XQ_EVENTS_FILE` env 读路径，缺省回退 data/runs）；done 幂等不变 |

---

## 5. 数据模型

### 5.1 PipelineRun

```ts
export type RunStatus =
  | "starting"    // 前置门禁通过，PTY 未就绪
  | "running"     // claude 已启动
  | "needs_input" // 等待人工决策（由 wait/waiting 事件触发）
  | "settling"    // 结束，等待收口写入
  | "done"        // 见到 done 标记
  | "failed"      // 异常退出 / 超时 / 剧本门禁拒绝 / runner 重启清扫
  | "cancelled";  // 人工终止

export interface PipelineRun {
  id: string;              // 直接复用 taskId（仓库内唯一）
  taskId: string;
  repoRoot: string;        // 前置定仓解析出的目标仓（与剧本「定仓」同源）
  repoKey: string;         // 规范化键：realpath + 小写 + 正斜杠
  baseSha: string;         // 启动时目标仓 HEAD
  status: RunStatus;
  pid: number | null;      // PTY 子进程 pid（排查用）
  cols: number;
  rows: number;
  startedAt: string;       // ISO
  endedAt: string | null;
  exitCode: number | null;
  error: string | null;
}
```

存储位置：`data/runs/<taskId>.json`，由 runner 独占写入，读完即弃可定期清理。

### 5.2 仓库状态注册表（repos.json）

位置：`data/repos.json`，runner 独占写入（读-改-写经模块内 Promise 链串行化，同 store.ts 模式）。

```json
{
  "d:/febot/iho-xxx": {
    "repoRoot": "D:\\febot\\iho-xxx",
    "runId": "123",
    "status": "busy",
    "updatedAt": "2026-10-27T10:00:00.000Z"
  }
}
```

规则：

- **登记**：`POST /runs` 受理时在 runner 进程内原子完成「查 static → 置 busy → 起 PTY」。单进程 + 单事件循环天然串行，第二个并发请求直接 409，无需文件锁
- **释放**：run 进入 done / failed / cancelled 任一终态时置回 static（与状态机同一事务路径，不依赖退出钩子）
- **清扫**：runner 启动时扫描 `data/runs/*.json`，凡非终态一律置 `failed`（`error="runner 重启"`），并重建 `repos.json`——指向不存在或非 busy run 的条目一律 static（§7.1）

### 5.3 事件

统一信封（**所有事件类型共享同一单调 seq，全部参与断线补发**）：

```ts
interface WsEvent<T = unknown> {
  type: "output" | "status" | "exit" | "git" | "timeline" | "error" | "pong";
  runId: string;
  seq: number;      // 单调递增，用于断线补发
  data: T;
}
```

### 5.4 时间线事件（TimelineEvent）

位置：`data/runs/<id>.events.jsonl`，一行一个事件，由 **advance.mjs 统一代写**。

```ts
export type TimelineEventType =
  | "stage"    // 阶段切换
  | "step"     // 具体步骤
  | "file"     // 文件变更（只记路径，不记内容）
  | "wait"     // 人工等待点（含 waiting / done）
  | "notice"   // 提示信息
  | "done"     // 流水线完成
  | "error";   // 异常

export interface TimelineEvent {
  v: 1;                                      // schema 版本
  ts: string;                                // ISO 时间
  type: TimelineEventType;
  stage?: string;                            // planer | coder | ...
  name?: string;                             // 步骤/等待点名称
  status?: "start" | "done" | "failed" | "waiting";
  path?: string;                             // type=file
  action?: "edit" | "create" | "delete";     // type=file
  by?: string;                               // wait 操作人
  message?: string;
}
```

典型序列：

```jsonl
{"v":1,"ts":"2026-10-27T10:00:00Z","type":"stage","stage":"coder","status":"start"}
{"v":1,"ts":"...","type":"step","name":"读取任务描述","status":"done"}
{"v":1,"ts":"...","type":"file","path":"src/auth/session.ts","action":"edit"}
{"v":1,"ts":"...","type":"wait","name":"plan_approved","status":"waiting"}
{"v":1,"ts":"...","type":"wait","name":"plan_approved","status":"done","by":"张三"}
{"v":1,"ts":"...","type":"done"}
```

约定：

- 只追加，不改写；文件随 run 保留，用于复盘
- 未知 `type` 由 runner 忽略并计数，不中断
- 单事件建议 < 1KB；大段内容放文件，事件里只放路径
- `wait` ≠ 剧本的 `gate.head` 开工门禁，两者不混用（见 D9 术语区分）

---

## 6. 接口契约

### 6.1 HTTP（Next.js → 浏览器）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/tasks/[id]/pipeline` | 启动；前置定仓 + 门禁，`201` 已启动，`409` 该仓库正被占用（返回占用 runId，拒绝不排队） |
| DELETE | `/api/tasks/[id]/pipeline` | 终止运行 |
| GET | `/api/runs/[id]` | 会话状态快照 |
| GET | `/api/runs/[id]/events` | 时间线事件（首屏加载与历史回看） |
| GET | `/api/runs/[id]/diff` | `{ baseSha, files: DiffFile[] }` |
| GET | `/api/runs/[id]/diff?path=...` | 单文件 patch（懒加载） |
| POST | `/api/runs/[id]/reject` | `{ paths: string[] }`（仅整文件驳回） |
| GET | `/api/runs?status=review` | 待审队列 |

`DiffFile`：

```ts
interface DiffFile {
  path: string;
  oldPath?: string;              // 重命名
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  additions: number;
  deletions: number;
  binary: boolean;
  tooLarge: boolean;             // > 2MB 不返回内容
}
```

### 6.2 WebSocket（浏览器 ⇄ runner）

连接：`ws://127.0.0.1:3011/ws?token=<runnerToken>`

客户端 → 服务端：

```ts
| { type: "attach"; runId: string; lastSeq?: number }
| { type: "detach"; runId: string }
| { type: "input"; runId: string; data: string }
| { type: "resize"; runId: string; cols: number; rows: number }
| { type: "ping" }
```

服务端 → 客户端：

```ts
| { type: "output"; runId: string; seq: number; data: string }
| { type: "status"; runId: string; seq: number; status: RunStatus; ... }
| { type: "exit";   runId: string; seq: number; exitCode: number | null }
| { type: "git";    runId: string; seq: number; changed: number }
| { type: "timeline"; runId: string; seq: number; event: TimelineEvent }
| { type: "error";  runId: string; seq: number; message: string }
| { type: "pong" }
```

约束：

- 单连接可同时 attach 多个 runId
- **所有服务端事件按产生顺序共享同一单调 seq**；`attach` 带 `lastSeq` 时补发 `seq > lastSeq` 的**全部类型事件**；不带 `lastSeq` 则输出回放最近 256KB，并推一次全量快照（当前 status + git 变更数）
- 输出按 16KB 分片，避免单帧过大；输出回放仍受 256KB 环形缓冲限制（已滚出部分以快照 + 「已截断」提示替代）

### 6.3 runner 内部接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 存活探测 |
| GET | `/repos/<repoKey>` | `{ status: "static" \| "busy", runId }`，前置门禁用 |
| POST | `/runs` | `{ taskId, repoRoot, repoKey, cols, rows }`；busy 返回 409 + 占用者；受理即登记 busy |
| DELETE | `/runs/[id]` | 终止 |
| GET | `/runs/[id]` | 状态 |

runner 收口时调用：

```
POST http://127.0.0.1:3010/api/internal/runs/[id]/settled
Body: { ok: boolean, note: string, exitCode: number | null }
Header: x-internal-token: <token>
```

---

## 7. 核心实现要点

### 7.1 前置定仓、仓库状态注册表与启动清扫

启动链路（拒绝模型，全程不排队）：

1. **前置定仓（M1）**：app 收到启动请求后，先以 taskId 经 febot 仓 `scripts/locate.mjs`（只读子进程）解析目标仓，得到 `repoRoot` / `repoKey` / 基准分支。该解析与剧本「定仓」同源（同一套 `requirement.mjs` / projectMap 配置），不重复实现、不会漂移。解析失败（未 feed、无法定仓）直接在 app 层拒绝并提示先补 feed——不再白开窗口。
2. **前置门禁**：app 调 runner `GET /repos/<repoKey>`；`busy` → 409 返回占用 runId，前端展示「#123 正在使用该仓库」。
3. **受理登记**：app `POST /runs { taskId, repoRoot, repoKey, cols, rows }`；runner 内原子完成「查 static → 置 busy → 起 PTY」。
4. **PTY cwd 仍为 febot 根**：`/pipeline` 剧本的运行约定不变；repoRoot 仅用于基线、diff、文件监听与仓库状态。

```ts
function repoKeyOf(root: string): string {
  return fs.realpathSync(root).replace(/\\/g, "/").toLowerCase();
}
```

runner 重启清扫（唯一恢复路径，不做热恢复）：

- 扫描 `data/runs/*.json`，凡非终态一律置 `failed`（`error="runner 重启"`），补齐 `endedAt`
- 重建 `repos.json`：指向不存在或非 busy run 的条目一律 static
- Windows 上 ConPTY 句柄随 runner 退出关闭，claude 子进程随控制台关闭事件退出，不存在 POSIX 式孤儿进程组问题；残留 pid 巡检（`tasklist`）作为兜底
- 重跑安全：advance done 幂等（`already:true`），重复收口不会双写

### 7.2 baseline

- runner 起 PTY 前在**目标仓**执行 `git rev-parse HEAD` 记为 `baseSha`，写入 PipelineRun；所有 diff 以此为准
- 工作区是否干净、分支是否等于基准分支，由 `/pipeline` 剧本开工门禁校验（app 不重复，见 D5）；剧本拒绝时 run 以 `failed` 收口，note = 「开工门禁未通过，详见终端输出」

### 7.3 PTY 会话

```ts
import * as pty from "node-pty";

const child = pty.spawn("cmd.exe", ["/d", "/c", wrapperPath], {
  name: "xterm-color",
  cwd: FEBOT_ROOT,          // 固定 febot 根，与现状一致；repoRoot 不进 cwd
  cols,
  rows,
  env: {
    ...process.env,
    TERM: "xterm-256color",
    XQ_EVENTS_FILE: eventsFileAbsPath,   // advance.mjs 代写事件的落点（绝对路径）
  },
});

child.onData((d) => appendAndBroadcast(runId, d));
child.onExit(({ exitCode }) => void finish(runId, exitCode));
```

要点：

- Windows 上 `claude` 是 `.cmd` 垫片，必须经 `cmd.exe /c wrapper.cmd` 启动
- 包装脚本保留「`where claude` 自检」，但**删除 `.exit` 落盘**（退出码由 `onExit` 提供）；自检失败（127）只会死在终端滚动里，note 提示看终端
- 保留 `.done.json` 作为语义完成判据（PTY 无法判断「流水线走到 done」）
- `kill()` 使用 `child.kill()`；若进程树残留，用 `taskkill /PID <pid> /T /F`

### 7.4 输出缓冲与重连

- 每个 run 维护一个 256KB 环形缓冲（`Uint8Array` 或字符串数组，按字节裁剪）
- 所有服务端事件共享同一单调 `seq`（见 §6.2），客户端记录已收到的最大 `seq`
- 重连时 `attach { lastSeq }`，服务端补发 `seq > lastSeq` 的全部类型事件；若输出已滚出缓冲，该部分以快照 + 「已截断」提示替代
- 页面关闭 **不** 终止会话；只有显式终止或进程退出才结束

### 7.5 完成判定

| 判据 | 来源 | 优先级 |
|---|---|---|
| `done.json` 中 `phase === "done"` | `/pipeline` 剧本 | 最高，成功 |
| PTY `exitCode` | `onExit` | 次之，失败 |
| 超时（默认 6h，可配置） | runner 定时器 | 兜底，失败 |
| 人工终止 | DELETE | 立即，cancelled |
| runner 重启清扫 | 启动清扫 | failed（`error="runner 重启"`） |

与现状相比，`.exit` 文件机制整体删除。

### 7.6 diff 计算

在**目标仓**（repoRoot）下执行：

```bash
# 文件列表（含未跟踪）
git status --porcelain=v2 --untracked-files=all
git diff --numstat --find-renames <baseSha>

# 单文件内容
git diff --unified=3 --no-color --find-renames <baseSha> -- <path>
```

- 未跟踪文件：直接读内容，构造「全部新增」的 patch
- 重命名：以 `--find-renames` 识别，展示为 rename
- 二进制：`binary: true`，不返回内容
- 超大文件：> 2MB 返回 `tooLarge: true`，前端提示「请在本地查看」
- 刷新：会话 active 时监听**目标仓**工作区（`chokidar`，忽略 `.git`、`node_modules`、`data`），debounce 300ms 后推送 `git` 事件；会话结束后停止监听
- diff 展示工作区相对 baseSha 的全部改动，不区分改动来源（已确认）

### 7.7 驳回动作

| 动作 | 实现 | 前置 |
|---|---|---|
| 驳回整个文件 | `git checkout <baseSha> -- <path> && git reset -q -- <path>`；未跟踪则直接删除文件 | `HEAD == baseSha` 且 index 与 `HEAD` 一致 |
| 接受 | 不改工作区，仅标记 | — |
| 要求重做 | 把驳回路径拼成提示，写入当前 PTY stdin | 会话仍 running |

**已确认只做整文件驳回**，不做 hunk 级反向 patch：避免 `git apply -R` 在 CRLF、部分暂存、文件已被再次修改时的边界问题。

驳回实现按本机 git 版本（2.20.1，`git restore` 需 2.23+）走两段式，边界如下：

- `git checkout <tree-ish> -- <path>` 会同时写 index 和工作区，必须补 `git reset -q -- <path>` 把该路径的 index 条目恢复成 `HEAD` 版本，让驳回只表现为工作区未暂存改动。**index 必须恢复干净**，否则 `/pipeline` 的 `advance check` 会因“有暂存内容”门禁失败，且后续一次 `git commit` 可能把驳回状态带进提交。
- `HEAD != baseSha`（会话期间有人 commit / pull）时**禁止驳回**：直接报错交人工，否则会把基准之后的改动一起抹掉。
- rename：新路径（未跟踪）删除 + 旧路径从 `baseSha` 还原，两段式。
- 纯新增文件在 `baseSha` 中不存在，`checkout` 会报 `pathspec did not match`，走“未跟踪直接删除”分支。
- 后续若统一升级到 git ≥ 2.23，可简化为 `git restore --source=<baseSha> --worktree -- <path>`，此时删掉第二段 `git reset`。

所有驳回操作写入任务轨迹（操作人、文件、时间）。**永不自动 commit。**

### 7.8 前端布局

```
┌──────────────────────────────────────────────────────┐
│  #123 修复登录超时   ● 进行中   已改 7 个文件            │
├──────────────────────────────────────────────────────┤
│ Timeline：✓ 读取任务 → ✓ 生成计划 → ● 修改 auth → …     │
├─────────────────────────────┬────────────────────────┤
│  TerminalPane               │  DiffPanel             │
│  （xterm + fit addon）       │  文件列表（默认）        │
│                             │  hunk（点选后加载）      │
├─────────────────────────────┴────────────────────────┤
│ [全屏审阅]  [接受]  [驳回]  [要求重做]  [终止]          │
└──────────────────────────────────────────────────────┘
```

- 时间线默认 40px 高，可展开为完整步骤列表；数据来自事件流，不解析终端
- 窄栏宽度 360px，可拖拽；< 1280px 时自动折叠为抽屉
- 全屏审阅页复用 `DiffPanel`，增加批量选择与整文件驳回
- 面板状态（折叠、选中文件）存 `localStorage`，按任务记忆

### 7.9 结构化事件流的实现

写：

- **由 `advance.mjs` 统一代写**：剧本各阶段调 advance（status / done / timing）时，由 advance 把 stage / step / wait / file 事件追加到 `XQ_EVENTS_FILE` 指定的文件，每行一个 JSON，写完即 flush。主对话与 subagent 不直接拼事件，契约单点维护
- `XQ_EVENTS_FILE` 由 runner 起 PTY 时注入（绝对路径）；advance 读不到该 env 时回退 `<febot>/xiaoqian-manager/data/runs/<id>.events.jsonl`（与 markerDir 同约定）
- advance 未被调到（剧本崩溃）可能缺最后一条事件；runner 收口时按实际退出码补发一条 `error` 或 `done`
- **剧本同步改造**：`pipeline.md` 把所有人工等待点（计划评审、恢复流程问负责人等）显式 wait 化，等待开始写 `wait/waiting`、被处理写 `wait/done`

读：

- runner 用 `chokidar` 监听该文件，记录已读字节偏移，只解析新增部分（避免整文件重读）
- 解析成功的事件广播 `timeline`；解析失败的行跳过并计数，不阻塞后续
- 首屏加载走 `GET /api/runs/[id]/events`，不依赖 WS 是否已连上

约束：

- 事件只记引用（`path`），不记代码内容，避免日志膨胀
- 单事件 < 1KB
- 未知 `type`、未知字段一律忽略
- `v` 字段用于后续 schema 演进；不匹配时按「尽力解析」处理
- 不做跨版本兼容：app 与剧本（pipeline.md + advance.mjs）同步改造、同步启用（已确认）

### 7.10 注意力路由的实现

状态来源（全部显式，不做猜测）：

| 触发 | 状态变化 |
|---|---|
| 剧本写 `wait` + `status=waiting` | `running → needs_input` |
| 剧本写 `wait` + `status=done` | `needs_input → running` |
| PTY 退出且无 done 标记 | `failed` |
| 收到 `done` 事件 | `done` |
| 人工终止 | `cancelled` |

排序权重：

```ts
const ATTENTION_WEIGHT = {
  needs_input: 0,
  failed: 1,
  running: 2,
  starting: 3,
  done: 4,
  cancelled: 4,
  settling: 4,
};
```

通知：

- 只对 `needs_input` 与 `failed` 发通知（web 形态为浏览器 Notification，localhost 可用；Phase 6 托盘才是真·系统通知）
- 按 `runId + status` 去重，**离开该状态时清除去重键**（`wait/done` 回落 running 后再次 waiting 可重新通知）
- `running / done / cancelled` 一律静默
- 页面标题显示待处理数：`(3) xiaoqian-manager`

**禁止的判定方式**：输出空闲超时、关键词匹配（如看到 "Continue?"）、终端光标位置。这些都不可靠，且会随 Claude Code 版本变化而误报。等待人工必须由剧本显式声明。

> 覆盖边界：claude 在 PTY 内的交互式提问（claude 层）不产生 `needs_input`——只有剧本层显式声明的等待点才触发（已确认）。

---

## 8. 分阶段实施

### Phase 0｜技术验证与骨架（0.5–1 人日）

| # | 任务 | 交付物 |
|---|---|---|
| 0.1 | 阅读 `node_modules/next/dist/docs/` 中当前版本的 Route Handler、自定义服务相关文档 | 记录差异点（Next 16 可能有破坏性变更） |
| 0.2 | 安装依赖：`yarn add node-pty @xterm/xterm @xterm/addon-fit diff2html ws chokidar`、`yarn add -D @types/ws` | `package.json` |
| 0.3 | 写 20 行 spike：PTY 起 `cmd.exe`，浏览器 xterm 显示并输入 | 验证 TUI 可用 |
| 0.4 | 搭 runner 骨架：`/healthz` + 静态 token；独立启动（`yarn runner`），不挂 `yarn dev` | `scripts/runner.ts` |

**验收**：浏览器里能跑 `claude --version`，中文不乱码，resize 正常；**附录 C 两个重点测试项全部实测通过**（不通过 → 回到 D2 选型）。

**风险**：`node-pty` 原生模块编译失败 → 优先用预编译包；仍失败则退到 `conpty` 方案或暂缓 D2。

### Phase 1｜仓库状态与基线（1–1.5 人日）

| # | 任务 | 交付物 |
|---|---|---|
| 1.1 | 前置定仓：app 调 febot `scripts/locate.mjs` 同源解析 repoRoot/repoKey/基准分支 | `lib/runner/repo-resolve.ts` |
| 1.2 | 仓库状态注册表：登记/释放；`POST /runs` 原子受理 | `lib/runner/repos.ts` + runner |
| 1.3 | runner 启动清扫（runs 置 failed + 重建 repos.json） | runner |
| 1.4 | 前置门禁 409 语义 + 「#N 正在使用该仓库」UI | `app/api/tasks/[id]/pipeline/route.ts` |
| 1.5 | baseSha 记录（目标仓 HEAD） | `lib/runner/git.ts` |
| 1.6 | 定义 `TimelineEvent` schema；事件路径经 env 注入 | `lib/runner/protocol.ts` |

**验收**：

- 同仓库并发两次启动，第二个返回 409 并显示占用者；不同仓库可并行
- kill runner 后重启：进行中 run 被标记 failed，仓库状态恢复 static，无残留占用
- 未 feed / 无法定仓的任务在 app 层直接被拒，不再白开窗口

### Phase 2｜PTY 会话（2.5–3 人日）

| # | 任务 | 交付物 |
|---|---|---|
| 2.1 | 会话池、输出环形缓冲、seq | `lib/runner/pty.ts` |
| 2.2 | WS 服务：attach/detach/input/resize | `scripts/runner.ts` |
| 2.3 | Next 改为调用 runner，删除旧 spawn 路径 | `lib/server/pipeline/runner.ts` |
| 2.4 | 包装脚本瘦身：删 `.exit`，保留自检 | 生成逻辑 |
| 2.5 | 前端 TerminalPane + 重连 | `components/pipeline/*` |
| 2.6 | 会话生命周期：终止、退出、超时、启动清扫 | runner |
| 2.7 | advance.mjs 代写事件 + 注入 `XQ_EVENTS_FILE`；runner tail 文件并转发 `timeline` | 剧本 + runner |

**验收**：

- 页面刷新后终端恢复最近 256KB 输出
- Ctrl+C 能中断 claude；关闭页面会话继续跑
- 重启 Next 不影响进行中的会话（runner 不动）
- 退出码正确回传并收口

### Phase 3｜推送与状态机（1–1.5 人日）

| # | 任务 | 交付物 |
|---|---|---|
| 3.1 | 删除文件轮询与 HTTP 轮询 | 代码清理 |
| 3.2 | 状态变更统一走 `status` 事件 | runner |
| 3.3 | 断线重连、心跳、全事件 seq 补发 | 前端 |
| 3.4 | runner 回调 Next 收口 | `app/api/internal/runs/[id]/settled` |
| 3.5 | `needs_input` 状态 + 注意力排序 | 前端列表 |
| 3.6 | 通知规则：仅 `needs_input` / `failed`，按 runId+status 去重（离开状态清除） | 前端 |

**验收**：端到端延迟 < 500ms；断网 10s 后自动恢复且断线期间事件全部补回；`needs_input` 任务排在列表首位；运行中任务不触发通知。

### Phase 4｜diff 展示与时间线（2 人日）

| # | 任务 | 交付物 |
|---|---|---|
| 4.1 | diff API（列表 + 单文件懒加载） | `app/api/runs/[id]/diff` |
| 4.2 | DiffPanel：文件列表 + 状态图标 + 增删行数 | 组件 |
| 4.3 | hunk 渲染（diff2html） | 组件 |
| 4.4 | 全屏审阅页 | 页面 |
| 4.5 | 整文件驳回 / 要求重做（两段式，§7.7） | API + UI |
| 4.6 | 文件监听与节流刷新（目标仓） | runner |
| 4.7 | 会话页步骤时间线（读事件流，可展开） | `components/pipeline/Timeline.tsx` |

**验收**：

- 100 文件、5MB 以内可流畅渲染（虚拟列表）
- 未跟踪文件显示为新增；重命名正确识别；二进制不渲染
- 驳回后工作区与 diff 立即一致，**且 `git status` 无任何暂存内容**
- 所有驳回写入轨迹
- 事件流可还原完整步骤时间线；未知事件被忽略

### Phase 5｜待审队列与收尾（1 人日）

| # | 任务 | 交付物 |
|---|---|---|
| 5.1 | `/api/runs?status=review` + 队列页 | `ReviewQueue.tsx` |
| 5.2 | 任务结束后脏工作区提醒（先提交/stash 再开新任务） | UI |
| 5.3 | 冒烟测试脚本 | `scripts/smoke-pipeline.ts` |
| 5.4 | README / 运维说明（含 runner 独立启动顺序） | 文档 |

**验收**：完整跑通「启动 → 观察 → 审阅 → 驳回/接受 → 收尾 → 下一任务」全流程。

### Phase 6｜桌面壳（可选，2–3 人日）

- Tauri 2 包壳，加载 `http://127.0.0.1:3010`
- 托盘常驻、真·系统通知（任务完成/失败）
- 自动拉起 runner 与 Next
- 仅当需要分发给非技术同事时再做

---

## 9. 总验收清单

- [ ] 一个仓库同时只能跑一个任务，第二个直接 409（不排队）
- [ ] 不同仓库可并行
- [ ] 未 feed / 无法定仓的任务在 app 层被直接拒绝
- [ ] 应用内可完整操作 Claude Code（输入、Ctrl+C、resize、粘贴）
- [ ] 刷新页面终端可恢复，输出不丢（除超缓冲）
- [ ] 重启 Next 不影响进行中会话
- [ ] runner 重启后进行中的 run 标记 failed、仓库状态恢复 static，无孤儿 claude 进程
- [ ] 进程退出码正确，不再依赖 `.exit` 文件
- [ ] 任务 diff 只包含本任务的改动
- [ ] 驳回文件后工作区与视图一致，且 `git status` 无暂存内容
- [ ] 所有人工介入写入轨迹
- [ ] 中文路径、CRLF、二进制文件均正常
- [ ] 旧 spawn 路径已删除，无残留入口
- [ ] `needs_input` 可由 `wait/waiting` 事件触发，并可由 `wait/done` 回落到 running
- [ ] 任务列表按「待你处理 > 失败 > 运行中 > 其他」排序
- [ ] 只有 `needs_input` / `failed` 触发通知，运行中静默；通知去重键在离开状态时清除
- [ ] 事件流完整，可由事件还原步骤时间线；未知事件不导致崩溃

---

## 10. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| Claude Code TUI 在 xterm.js 渲染异常 | 中 | 高 | Phase 0 spike 先验证（含附录 C 两项实测）；不通过则暂停方案、重新选型，不做双模式兜底 |
| `node-pty` 安装失败 | 中 | 高 | 优先预编译；检查 VS Build Tools；仍不行则用 `child_process` + `conpty` 包装 |
| runner 崩溃后仓库状态卡 busy | 中 | 中 | 启动清扫（runs 置 failed + 重建 repos.json）；`/healthz` 探测，前端展示 runner 离线 |
| runner 重启丢失进行中会话 | 中 | 中 | 明确不支持热恢复（ConPTY 不可跨进程重挂）；启动清扫 + advance 幂等（already:true），重跑即可 |
| 双进程写 store 冲突 | 低 | 高 | 明确单一写入方；runner 只回调，不直接写任务文件 |
| 大 diff 卡顿 | 中 | 中 | 虚拟列表 + 单文件懒加载 + 2MB 上限 |
| 用户忘记提交，下一任务基线被污染 | 高 | 中 | 剧本开工门禁拦截（分支 + 干净）；任务结束 UI 提醒先提交/stash |
| Windows 编码问题 | 中 | 低 | 统一 UTF-8；`chcp 65001` 仅在必要时使用；增加中文路径用例 |
| 事件契约与剧本实现漂移 | 中 | 中 | 写入收敛 advance.mjs 单点维护；事件带 `v` 版本；契约变更同步改剧本与 UI；app 与剧本同步发布 |
| `needs_input` 误判导致通知打扰 | 低 | 中 | 只认剧本显式 `wait/waiting` 事件，禁止空闲超时/关键词猜测 |

---

## 11. 回滚方案

已确认不保留 `PIPELINE_MODE` 双模式，改造在独立分支进行，回滚以 git 为单位：

1. 改造全程在 `feat/pipeline-session` 分支，`main` 保持可用
2. 每个 Phase 结束打一个 tag，出问题按 Phase 回退：
   - `git revert <phase-commit>`：撤销单个阶段
   - `git checkout main`：整体放弃
3. 新增功能全部走新路由，不改动既有任务数据结构
4. 运行时清理：停 runner → 删除 `data/repos.json` → 终止残留 `claude` 进程
5. `data/*.json` 无破坏性 schema 变更，回退代码无需迁移数据
6. **风险窗口**：Phase 2 切换 PTY 后新旧两套启动方式不并存，切换前必须完成 spike 与 Phase 2 验收；剧本侧（pipeline.md + advance.mjs）与 app 同步回滚，不留半边契约

---

## 12. 已确认与待确认

### 已确认（2026-10-27）

| # | 结论 | 影响 |
|---|---|---|
| 1 | 不保留 `PIPELINE_MODE` 双模式，改造在独立分支进行 | 删除开关；回滚改为按分支/Phase 进行 |
| 2 | 只做整文件驳回，不做 hunk 级驳回 | Phase 4 减 1 人日；去掉 `git apply -R` 路径 |
| 3 | 任务只在本机执行 | runner 仅监听 `127.0.0.1`；桌面端（Phase 6）价值成立 |
| 4 | 启动前置定仓：app 经 febot `scripts/locate.mjs` 同源解析目标仓，repoRoot 作为启动必填；单仓库模型 | PTY cwd 不变（仍 febot 根）；删除 422 与 stash 弹窗；未 feed 任务 app 层直接拒绝 |
| 5 | 拒绝模型：同仓库第二个任务直接 409，不排队 | 删除 `queued` 状态与排队 UI |
| 6 | 工作区干净/开工门禁归剧本，app 不重复校验 | app 层无干净检查；剧本门禁拒绝时 run 按 failed 收口 |
| 7 | 事件写入收敛 advance.mjs，经 `XQ_EVENTS_FILE` env 注入；app 与剧本同步改造、不做跨版本兼容 | 无握手；半边契约不回滚（见 §11.6） |
| 8 | runner 与 `yarn dev` 解耦，独立启动 | 删除 concurrently；Next 重启不杀会话（G6 边界） |
| 9 | diff 不区分改动来源（剧本/用户手改都展示） | DiffPanel 无需白名单交叉 |

### 仍待确认

1. 是否允许任务运行中人工接管输入（比如回答 Claude 的提问）？本方案默认允许。注意：claude 层交互提问不产生 `needs_input`，只有剧本显式 wait 点才触发。
2. 是否需要 token/成本展示？如需，可从 PTY 输出或 Claude Code 状态文件解析。

---

## 附录 A｜新增依赖

```bash
yarn add node-pty @xterm/xterm @xterm/addon-fit diff2html ws chokidar
yarn add -D @types/ws
```

- `node-pty`：PTY（原生模块）
- `@xterm/xterm` + `@xterm/addon-fit`：终端渲染
- `diff2html`：diff 渲染（若后续需要更强交互，再评估 Monaco）
- `ws`：WebSocket 服务端
- `chokidar`：事件文件 tail 与工作区文件监听
- runner 与 Next 解耦启动，不再需要 `concurrently`

## 附录 B｜术语

| 术语 | 含义 |
|---|---|
| run | 一次任务执行，与 task 一一对应 |
| runner | 拥有 PTY 与仓库状态注册表的常驻 Node 进程，独立启动 |
| 前置定仓 | 启动时由 app 经 febot scripts 同源解析任务目标仓（M1） |
| repoKey | 仓库的规范化唯一键（realpath + 小写 + 正斜杠），用于仓库状态注册表 |
| 仓库状态注册表 | `data/repos.json`，repoKey → static/busy，runner 独占写，启动清扫保自洽 |
| baseSha | 任务启动时目标仓的 HEAD，diff 的基准 |
| settle | 将运行结果写回任务阶段与轨迹的动作 |
| 事件流 | advance.mjs 代写追加的结构化 JSONL，与终端字节流并行 |
| wait 事件 | 剧本声明的人工等待点（≠ 剧本 `gate.head` 开工门禁） |
| needs_input | 会话等待人工决策的状态，由 `wait/waiting` 事件驱动 |
| 注意力权重 | 任务列表排序依据，越需要人介入越靠前 |

## 附录 C｜重点测试项（实施中由负责人实测，Phase 0 spike 必测）

1. **中文 IME 输入**：xterm.js 内用系统中文输入法（微软拼音）输入中文，候选窗定位与上屏正确。xterm.js 历史痛点，输出不乱码不代表输入可用。
2. **TUI 兼容与回放性能**：Claude Code TUI 在 ConPTY + xterm.js 下的 Ctrl+C、大段粘贴、resize 重排、alt-screen 渲染，以及 256KB 输出回放的流畅度（分片写入 + 客户端渲染瓶颈）。
