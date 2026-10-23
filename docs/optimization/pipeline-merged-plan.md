# /pipeline 合并优化方案：统一状态机 + 确定性 locate + 快轨 express

> 状态：设计稿 v1，未实施。
>
> 合并来源：
> - [pipeline-token-speedup.md](./pipeline-token-speedup.md)（下称 A）：机械脚本、状态契约、subagent 回传、token/往返优化。
> - [pipeline-optimization-plan.md](./pipeline-optimization-plan.md)（下称 B）：`locate`、express 快轨、索引缓存、墙钟优化。
>
> 本文是唯一实施依据。A/B 保留为历史设计，不再单独改 `pipeline.md`。两边的共同项只做一次；冲突项按第 0 节结论执行。

---

## 0. 已定决策

| # | 主题 | 结论 |
|---|---|---|
| 1 | 主目标 | 两个 KPI 都要：**full 轨成本**（token/工具往返）与 **express 墙钟**分开验收，不互相替代 |
| 2 | 状态机 | **删除 light**；新增 `locating`，由它决定走 `full` 还是 `express` |
| 3 | tier | 只保留 `full \| express`；`light` 直接删除，不读取、不迁移、不兼容 |
| 4 | 新增脚本 | `advance.mjs` + `locate.mjs`；**不实现 `check-files.mjs`**，能力并入 `advance check` |
| 5 | 白名单 | `plan.files.json` 是唯一权威；`state.selectedFiles` 只做 express 的只读别名 |
| 6 | schema | 用 A 的超集：`{files, deleted, conditional:[{path,reason,question}], exempt}` |
| 7 | reviewer | full 用 `review-input.txt`（reviewer 无 Bash）；**express 不跑 reviewer**，需要审查就在确认页选 full |
| 8 | done 收尾 | 统一用 `advance done`，不再做第二个收尾脚本 |
| 9 | locate / recon | 采纳 B 的 locate + 持久索引；`recon` 输出格式保持不变 |
| 10 | 人工门禁 | full 的 `plan_confirm` 不变；express 单独定义“候选确认”，不套用 plan_confirm |
| 11 | state 写入 | 一律走 `advance`；express 用 `advance set-tier --tier express`，禁止手写 state |
| 12 | feed / SKILL | feed 默认 `tier=full`；locate 确认后由 `advance set-tier` 升级 express；移除 `feed --set-tier` |
| 13 | timings | 增加 `state.timings`，区分 `machineMs`（脚本/agent 实际执行）与 `waitMs`（人工等待）；`pipeline-stats.mjs` 放 P2 |
| 14 | 验证 | 成本、墙钟、正确性合并成一套验收矩阵 |
| 15 | 文档位置 | 统一 `docs/optimization/`；修正 B 的“仓库根目录”旧路径 |

---

## 1. 背景与 KPI

### 1.1 现状

- full 轨道固定 8 个阶段：`init → planning → plan_confirm → coding → code_review → fixing → verify → done`，planner / coder / reviewer 各是独立 LLM 会话。
- 实测两个 full 需求各约 2 小时；6 个已完成需求里 4 个最终只改 1–3 个文件。
- 样例 `578605085778533231` 的 `plannedDescription` 已给出路由 `/nursing-record`、页面名「护理单」、行为「后一天置灰 / 时间选择框置灰」、新参数 code `RY4.1.14.PBP.79605V`。只读验证可精确落到 `src/page/nursing-record/`，不需要 planner 全量探索。
- 主要空转点：

| # | 根因 | 证据 | 影响 |
|---|---|---|---|
| 1 | 阶段多、LLM 会话来回复用上下文 | full 至少 planner + coder + reviewer 三次会话；R-161135 planner/reviewer 均触 10 轮上限零产出后重试 | 墙钟主因 |
| 2 | recon 每次新进程全量扫描，无持久索引 | `recon.mjs` 每次 `execFileSync` 起新进程；`code-indexer` 只有进程内缓存 | 每需求固定 10s+，locate 无法复用 |
| 3 | Hindsight 调用无效 | 剧本传数字 `--budget`，脚本只接受 `low\|mid\|high`；本机 `python` 是 Store 存根 | 最坏 10×30s 阻塞，实际零产出 |
| 4 | planner/reviewer `maxTurns: 10` 偏小 | R-161135 两者都曾零产出 | 直接翻倍阶段耗时 |
| 5 | 完成标记轮询 30s | `runner.ts` `POLL_MS = 30 * 1000`，注释却写 2s | 每次收尾最多多等 30s |
| 6 | 改动文件清单格式不统一 | 四个历史 `plan.md` 有 checkbox / 编号 / 两种表格 | 收尾靠人眼，快轨也缺白名单来源 |

### 1.2 两个 KPI

| KPI | 现状 | 目标 | 测量口径 |
|---|---:|---:|---|
| orchestrator 工具往返 | 92–161 次/需求 | 首期 ≤100；二期 ≤70；争取 ≤60 | 干净重跑一个 full 需求，统计主会话 `tool_use` |
| 主会话输出 token | 182k–255k/需求 | −25% | 分 thinking / `tool_use` 入参 / 可见文字统计 |
| subagent 冷启动 | 0.6M–0.9M fresh tokens/需求 | −15% | 主会话与 subagent 分开统计 |
| 完成标记延迟 | ≤30s | ≤2s | `runner.ts` 轮询间隔 |
| express 端到端 | 无 | ≤25 分钟（不含 coder 实际编辑时间） | `state.timings` 的 `wallMs`，人工等待单列 |
| locate 首次 / 缓存 | 9.6–12.3s/次 recon | 首次约 10s，同 HEAD 第二次 <1s | `.febot/index` 命中 |
| locate 历史召回 | 无 | 实际改动文件进入 top 8 候选 ≥4/5 | 5 个历史需求 |

> **口径提醒**：可见文字只占主会话输出 5.6–8.7%，3 行输出纪律只能影响这一小块；−25% 主要来自写入合并、减少回合和减少代取 diff，不要把全部收益归给“少说话”。

### 1.3 非目标

- 不合并打磨/复验轮；不把 planner/coder/reviewer 合成一个 agent。
- 不给 reviewer Bash；reviewer 继续只读。
- 不改 worktree / 同仓串行 / file-lock / 敏感文件审批铁律；不 `add`、`commit`、`push`、`stash`。
- 不做 `check-files.mjs`；不保留 `light` 新轨道。
- express 不内嵌 reviewer；需要审查就选 full。
- P1 不做 `pipeline-stats.mjs`、`locate --explain`；放 P2。

---

## 2. 状态机

### 2.1 tier 与 phase

- `tier`：只有 `full | express`。`light` 已删除，不读取、不写入。
- `phase`：`init | locating | planning | plan_confirm | coding | code_review | fixing | verify | done`。
- **full**：9 个阶段（原 8 个 + `locating`）。
- **express**：5 个阶段 `init → locating → coding → verify → done`；没有 `planning` / `plan_confirm` / `code_review` / `fixing`。
- LLM 会话：full 通常 planner + coder + reviewer（修复/复验可能再起 coder）；express 只有 coder（coding / verify 复用同一角色，通常 1–2 次会话）。

### 2.2 目标流程

```text
init (feed)
  ↓ advance set-phase locating
locating (locate.mjs)
  ├─ confidence=high 且候选 ≤5
  │    → 负责人确认候选清单
  │        ├─ 接受 / 调整 → advance set-tier --tier express → coding → verify → done
  │        └─ 走全轨       → advance set-tier --tier full    → planning → plan_confirm → coding
  │                                                              → code_review → fixing → verify → done
  └─ confidence=medium/low 或 locate 失败
       → advance set-tier --tier full（记录原因）→ planning → …
```

### 2.3 转移表

未列出的转移需要 `--force`，且只能由人工执行。

| from | to | tier / 条件 | 正常命令 |
|---|---|---|---|
| `init` | `locating` | 所有新需求 | `advance set-phase --phase locating --agent orchestrator` |
| `locating` | `planning` | full（含 medium/low/负责人选全轨） | `advance set-tier --tier full` |
| `locating` | `coding` | express（负责人确认） | `advance set-tier --tier express` |
| `planning` | `plan_confirm` | full | `advance set-phase --phase plan_confirm --agent planner` |
| `plan_confirm` | `coding` | full；conditional 已处理或显式允许 | `advance set-phase --phase coding` |
| `coding` | `code_review` | full | `advance set-phase --phase code_review --agent coder` |
| `coding` | `verify` | express | `advance set-phase --phase verify --agent coder` |
| `code_review` | `fixing` | full，有 blocker | `advance set-phase --phase fixing --inc-iteration --agent reviewer` |
| `code_review` | `verify` | full，无 blocker | `advance set-phase --phase verify --agent reviewer` |
| `fixing` | `verify` | full | `advance set-phase --phase verify --agent coder` |
| `verify` | `coding` | 未全绿；express 最多 2 轮 | `advance set-phase --phase coding --agent coder` |
| `verify` | `fixing` | full，未全绿且有 review 修复 | `advance set-phase --phase fixing --inc-iteration --agent coder` |
| `verify` | `done` | 全绿且 check 通过 | `advance done <别名>` |
| `done` | 任意 | 仅人工 `--force` 重开 | `advance set-phase --force` |

- `done` 只能由 `advance done` 写入；`set-phase --phase done` 永远 exit 5。
- `--inc-iteration` 只能与 `--phase fixing` 一起用，进入 fixing 时 +1；重试不能双计数。
- 幂等：`state.lastTransitionKey = sha1(phase|agent|note)[0..12]`；重试相同 key 只补缺失的 log 行。

### 2.4 locating 判定

`locate.mjs` 输出 `confidence` 与 `recommendedTier`：

- `high`：有 L1/L2/L3 命中，且候选 ≤5。
- `medium`：候选 6–8 个，或只有内容检索命中。
- `low`：候选 >8 个，或没有可用锚点。
- `recommendedTier=express` 必须同时满足：
  1. `confidence=high`；
  2. 候选 ≤5；
  3. 候选不含敏感文件（`.env*`、`febot.config.json`、`hindsight.env` 等）；
  4. 候选不含删除操作；
  5. 至少有一个路由/模块/组件级锚点，而不是纯中文 n-gram 命中。
- `medium/low` 一律回落 `full`，不打扰负责人。
- locate 进程失败、`locate.json` 缺失或格式错误：**停下来问负责人**；由负责人决定 `set-tier --tier full --reason-file ...` 继续，或修复后重跑。禁止编排层自行猜成 express。

### 2.5 人工门禁

**full：`plan_confirm` 不变**

1. planner 写 `plan.md` + `plan.files.json` + `questions.md`。
2. 负责人按编号答 `answers.md`，确认写 `decisions.md`。
3. 对每个 `conditional`：
   - 同意 → `advance approve-files --q Q1`（移入 `files`）；
   - 不同意 → `advance approve-files --q Q1 --reject`（从 `conditional` 移除并记录）；
   - 暂不决定且允许 coder 不碰 → `advance set-phase coding --allow-conditional`。
4. `advance set-phase --phase coding`。

**express：候选确认替代 `plan_confirm`**

在 `locating` 展示 `locate.md` 候选表，用 `AskUserQuestion` 给三个选项：

1. **按此清单改（express）** → `advance set-tier --tier express`；
2. **调整文件后 express** → 负责人编辑 `docs/requirements/<别名>/selected-files.json`，再执行同一命令；
3. **走全轨（full）** → `advance set-tier --tier full --reason-file <确认说明>`。

- 确认结果写 `decisions.md`，不伪造 `Q1`；`answers.md` 只放 planner 的问题。
- express 不跑 reviewer。需要 review 的需求在第 1 步就选“走全轨”，不要在 express 内临时加 reviewer。
- 候选清单最多 5 个文件；需要第 6 个文件时写 `locate-gap.md` 并停下，由负责人决定，禁止静默扩大改动面。

---

## 3. 脚本设计

### 3.1 `scripts/lib/febot.mjs`：共享底座

在现有 `ROOT` / `readConfig` / `reposRoot` / `section` / `stripNoise` 基础上增加：

- `FEBOT_ROOT` 环境变量覆盖 `ROOT`（优先级最高）；`REQUIREMENTS_DIR` / `TASKS_PATH` 由它派生。仅 `FEBOT_CONFIG` 不够，它只影响 `repoRoot`。
- `ScriptError(code)`：`git` 等底层失败抛它；区分 exit 3 / 5 / 6。
- `git(repoDir, args)`：`execFileSync`、无 shell；失败抛 `ScriptError(3)`。
- `checkGate(repoDir, expectedBranch)`：**返回结果，不自己抛门禁错误**：
  `{branch, commit, status, branchOk, clean, dirty, checkedAt}`。
  - `branch`：`git rev-parse --abbrev-ref HEAD`；
  - `commit`：`git rev-parse HEAD`；
  - `status`：`git status --porcelain`。
- `displayPath`、`readText`（去 BOM）、`readJson`、`writeJsonAtomic`（同目录 `tmp-<pid>` + rename）。
- `ALIAS_RE`、`SAFE_ID`、`toPosix`、`isPathInside`。
- `readState(reqDir)` / `writeState(reqDir, patch)`：原子读改写，保留未知字段。
  - 期望分支统一为 `state.baseBranch ?? state.branch`。
- `readWhitelist(reqDir, state, opts)` 来源顺序：
  1. `--files-file <path>`（JSON 文件，不是内联 JSON）；
  2. `plan.files.json`；
  3. `state.whitelist`（可选快照）；
  4. 报错并提示 `--no-whitelist`。
  - 空数组表示“明确不允许改动”，与文件缺失区分。
- `resolveRepoDir(state, cfg)`：`state.repo` → 根 `tasks.md` 第 5 列 → `ScriptError(6)`。

> feed 的退出码契约不能破坏：lib 的 `git` 抛 `ScriptError(3)`，`feed` 捕获后转成 `FeedError(3)`；`checkGate` 只返回结果，由 feed 决定 `fail(3, ...)`。`feed.mjs` 顶层只把 `FeedError` 映射为业务退出码，不能改成普通 `Error`。

### 3.2 `scripts/lib/requirement.mjs`：需求/仓库解析

从 `recon.mjs` / `feed.mjs` 抽出，避免两套逻辑漂移：

- `readRequirement(alias)`：`reqDir`、`context.md`、`state.json`。
- `parseTasksRow(alias)`：`tasks.md` 行解析，仓库是第 5 列。
- `resolveRepo(cfg, module, title)`：`projectMap` 精确匹配 + 标题 keywords + 兜底。
- `resolveBranch(cfg, repo)`：`projectMap[].branch` > `branches.byRepo[repo]` > `branches.default`。
- `updateTasksTier(alias, tier)`：只改 tier 列，供 `advance set-tier` 使用。

纯函数优先；`feed` 仍负责把错误转换为 `FeedError`，`recon` / `locate` 按自己的退出码处理。

### 3.3 `scripts/lib/repo-index.mjs`：持久索引

- 路径：`.febot/index/<仓>.json` + `.febot/index/<仓>.map.md`。
- 缓存键：`git rev-parse HEAD` + `git status --porcelain` 哈希 + indexer 版本。
- 未命中才跑 `code-indexer scan <repo> --compact`（复用 `recon.mjs` 的调用方式）。
- `.map.md` 是给人看的映射表：路由 `path | label | componentFile`、模块 `name | dir | 组件数`、API 域。
- 同一 HEAD 第二次定位 <1s；`recon` 也读同一份缓存。
- `.febot/` 加入 `.gitignore`；索引只写本地，不进仓库。

### 3.4 `scripts/advance.mjs`：唯一机械写入器

所有子命令**始终输出一行 JSON**；写操作支持 `--dry-run`。

退出码：

| code | 含义 |
|---|---|
| 0 | 成功 / 幂等 |
| 1 | 未预期异常 |
| 3 | 强制执行的门禁 / 白名单 / 暂存 / HEAD / 分支不符 |
| 5 | 参数或契约错误（非法 phase、`plan.files.json` 格式错误、未处理的 conditional） |
| 6 | 配置 / state / marker 归属错误 |
| 2 | 保留给 feed 的映射未命中 |

#### 子命令

| 子命令 | 替代 | 行为 |
|---|---|---|
| `status <alias>` | 启动/恢复读 state + 手工 git | **只读，resume 安全**。输出 state 摘要、`repo{branch,expected,head,branchOk,clean,dirty,staged}`、`whitelist{source,files,deleted,conditional,exempt}`、`locate`、`features`、`timings` 摘要、`next`、`progressTail`。脏工作区不返回 3。 |
| `gate <alias> [--init] [--enforce-clean] [--record]` | init 开工门禁 | 始终校验分支；`--init` / `--enforce-clean` 才要求干净。分支不符或要求干净但脏 → exit 3。`--record` 写 `state.gate`（含 commit）。feed 已做 init 门禁，正常不重复。 |
| `set-phase <alias> --phase <p>` | 手写 `state.json` + 重写 log | 按转移表更新 state + 追加 log；记录 phase 时间戳与 `wallMs`。禁止 `--phase done`。 |
| `set-tier <alias> --tier full\|express` | feed `--set-tier` / 手写 tier | 见下方专节。`express` 写 `plan.files.json` 并进入 coding；`full` 进入 planning。 |
| `check <alias> [--files-file] [--no-whitelist] [--mode done\|review]` | 收尾 2 条 git + 人眼比对 | 白名单 vs `status --porcelain=v1 -uall -z` vs `diff --cached --name-only -z`；校验 `state.gate.head` 与分支。输出 `{ok,source,head,branch,changed,staged,foreign,exemptChanged,missing,warnings}`。 |
| `review-input <alias> [--files-file] [--max-bytes] [--max-file-bytes]` | orchestrator 代取 diff + 写文件 | 按白名单生成 `review-input.txt`：diff --stat、`git diff HEAD -- <files>`、新增文本文件全文、白名单外文件列表。超限按整文件跳过并标 `omitted`。 |
| `approve-files <alias> --q Q1 [--reject]` | 人工改 `plan.files.json` | 把 `conditional` 中 `question==Q1` 的条目移入 `files`；`--reject` 则移除。原子写回，追加 decisions/log，幂等。 |
| `timing <alias> --name <stage> --machine-ms <n> [--wait-ms <n>]` | 手工记时间 | 记录脚本/agent 实际执行时间与人工等待；默认覆盖同名项，`--add` 累加。不改变 phase。 |
| `done <alias> [--task-id] [--plan-file] [--files-file] [--no-whitelist] [--dry-run]` | 收尾 3/5/6 步 | 严格顺序见下；任何预检失败不写 state/marker、不删文件。 |

`status.next` 固定映射（编排层直接用，不再自己推）：

| phase | next |
|---|---|
| `init` | `locating` |
| `locating` | 无 `locate.json` → `locate`；high → `human`；medium/low → `set-tier full` |
| `planning` | `planner` |
| `plan_confirm` | `human` |
| `coding` | `coder` |
| `code_review` | `reviewer`（仅 full） |
| `fixing` | `coder` |
| `verify` | `coder` |
| `done` | `none` |

#### `set-phase` 细节

```bash
node scripts/advance.mjs set-phase <alias> --phase <p> \
  [--agent <a>] [--note-file <md>] [--inc-iteration] \
  [--blockers-file <json>] [--questions-file <json>] \
  [--allow-conditional] [--force] [--dry-run]
```

- `--allow-conditional` 仅允许 `plan_confirm → coding`；其余阶段出现未处理 conditional 直接 exit 5。
- `--blockers-file` / `--questions-file` 缺省表示“不修改”，空数组表示“清空”。
- 文本参数一律走文件：`--note-file` / `--blockers-file` / `--questions-file`。**本机含中文的 Bash 命令会 exit 127**，编排层不得把中文写进命令行；`--note` 只用于 ASCII 短备注。
- 写序：先 `state`（含 `lastTransitionKey`），再追加 `orchestrator-log.md`；log 失败可重试补齐。
- 离开 `plan_confirm` 进入 `coding` 时，若 `timings.waitMs.planConfirm` 尚未记录，用 `now - timings.phases.plan_confirm.enteredAt` 补记。
- 离开 `locating` 时，把 `locate.json` 摘要写入 `state.locate`（confidence / recommendedTier / candidateCount / indexHead / generatedAt）。
- full 进入 `coding` 前必须存在合法 `plan.files.json`，否则 exit 5；`--allow-conditional` 只放宽 conditional，不放宽文件缺失。

#### `set-tier` 细节

```bash
node scripts/advance.mjs set-tier <alias> --tier full|express \
  [--files-file <json>] [--reason-file <md>] [--reason <ascii>] \
  [--force] [--dry-run]
```

- **只允许在 `phase=locating`**；其他 phase 一律 exit 5。
- `--tier full`：
  - 写 `state.tier="full"`、`state.locate` 摘要、`phase="planning"`；
  - 写 `decisions.md` 一行、更新 `tasks.md` tier 列；
  - 若 `locate.json` 缺失，必须提供 `--reason-file` 或 `--reason`，并在 state/log 标 `locate.missing`。
- `--tier express`：
  - 文件来源优先级：`--files-file` > `docs/requirements/<别名>/selected-files.json` > `locate.json.selectedFiles`；
  - 写 `plan.files.json`（`files` 来自上述来源，`deleted=[]`、`conditional=[]`、`exempt` 取 `locate.json.exempt` 或空）；
  - 写 `state.tier="express"`、`state.selectedFiles=[...]`、`state.locate` 摘要、`phase="coding"`；
  - 写 `decisions.md`、更新 `tasks.md`；
  - 记录 `timings.waitMs.expressConfirm = now - locate.json.generatedAt`（无时间戳则 null）；
  - 已有 `plan.files.json` 且文件列表不同时，必须 `--force` 才覆盖；避免覆盖 planner 的产物。
- 进入目标 phase 时，补记 `timings.phases.locating.exitedAt/wallMs` 与目标 phase 的 `enteredAt`，与 `set-phase` 使用同一套时间逻辑。
- 幂等：已是目标 tier/phase 且文件列表一致 → `already:true`。
- 原因：`--reason` 只允许 ASCII；中文走 `--reason-file`。未提供时，若 `locate.json` 存在，自动生成 `locate: confidence=<c> recommended=<r> candidates=<n>`。

#### `check` 细节

- `status --porcelain=v1 -uall -z`，统一 `-c core.quotepath=false`；按 NUL 解析，避免空格/非 ASCII 路径被转义；rename 同时匹配新旧路径。
- full / express 必须有 `plan.files.json`；缺失时只能 `--no-whitelist`，输出 `source:"none"` 并在 state/log 记 warning。
- `plan.files.json.exempt`（如 `components.d.ts`、`auto-imports.d.ts`）只报告不阻塞，计入 `exemptChanged`；done 时给 warning。
- `missing`（白名单内未改）只报告，不阻塞。
- `state.gate.head` 与当前 HEAD 不一致 → exit 3（防止 coder 偷偷 commit 后 `status` 看起来干净）。
- 所有新 state 必须由 `feed` 写入 `gate.head`；缺失视为契约错误（exit 6）。
- `--mode review` 只报告，exit 0；`--mode done` 下 foreign/staged/HEAD/分支不符 → exit 3。

#### `review-input` 细节

- 先跑 HEAD/分支预检；`git -c core.quotepath=false diff --no-ext-diff --no-color HEAD -- <files>`，超时放宽到 60s。
- 新增文件：文本（前 8KB 无 NUL）且不超过 `--max-file-bytes` 才附全文；二进制/超大文件整文件跳过并列入 `omitted`，**不按字节截断**。
- 全局 `--max-bytes` 超限时同样按整文件省略，输出 `truncated:true`。
- `exempt` 文件照常展示但标注，不计入 foreign。
- full 的 reviewer 只读 `review-input.txt` + `plan.md` + `plan.files.json` + `test-report.md`；express 不调用此命令。

#### `done` 顺序

1. 预检：state 存在、alias 与 `state.requirement` 一致；`taskId` 取 `--task-id` 或 `state.taskId`，用 `SAFE_ID` 校验；marker 路径限制在 `xiaoqian-manager/data/temp`。
2. marker 已存在：taskId/requirement 一致 → `already:true`（幂等清理后返回）；属于其他任务 → exit 6。**这一步必须在任何写操作之前。**
3. `planFile` 取 `--plan-file` 或 `state.planFile`；路径必须在上文允许目录内；不存在只 warning。
4. `check --mode done`。失败立即返回。
5. state 置 `done` + log 追加（同 `lastTransitionKey` 语义）。
6. 删除 `file-lock.md` 中“占用需求”列等于本别名的行（按列匹配，不误删他人）。
7. 删除计划临时文件；只删除 `xiaoqian-manager/data/temp` 下的 intake 文件，或 `docs/requirements/<别名>/R-oral-*.md`；`plan.md` / `plan.files.json` 永不删除。
8. **最后**原子写 `<taskId>.done.json`；口头流程（无 taskId）跳过。

若第 5 步后失败（如 marker 写失败），重跑 `done` 应从 state/marker 状态恢复：marker 缺失且 state=done → 跳过 check，补清理并写 marker。

### 3.5 `scripts/locate.mjs`：确定性定位

```bash
node scripts/locate.mjs <别名> [--repo <仓名>] [--refresh] [--json]
```

1. **复用需求解析**：`lib/requirement.mjs` 读 `context.md`、`tasks.md`、`projectMap`；`--repo` 可覆盖。
2. **仓索引**：`lib/repo-index.mjs` 读缓存；未命中才 `code-indexer scan`；`--refresh` 绕过缓存并允许重写 `selected-files.json`。
3. **抽锚点**：
   - 路由：以 `/` 开头，排除 `http(s)`、`//`、`src/`、带文件扩展名的 token；
   - 引号词：`"…"`、`“…”`、`「…」`、`'…'`；
   - 编码：`RY4.1.14.PBP.79605V` 这类大写点分 code；
   - 中文 2/3/4-gram，复用 `recon.mjs` 的停用词表。
4. **分级匹配**：
   - L1 路由精确/前缀 → `route.componentFile` + 所属模块；
   - L2 路由 `label` → 同上；
   - L3 模块 `name/label` → 模块目录 + `modules[].components`；
   - L4 组件文件名命中 ASCII 锚点；
   - L5 内容检索：锚点写入 `.febot/tmp/<别名>.patterns`，用
     `git -C <repo> grep -n -I -F -f <patterns> -- '*.vue' '*.ts' '*.tsx' '*.js' '*.jsx'`；
     **不把中文放进命令行参数**；`git grep` 无命中 exit 1 视为空结果，不是脚本失败；
   - L6 API 域命中 → 该域文件 + 引用它的模块。
5. **打分**：路由精确 +100、label +70、模块目录 +40、组件名 +25、内容命中每条 +10（上限 30）、code 精确 +50；命中高置信模块内文件再加 +20；`.d.ts` / test / `dict.json` 降权并标注。
6. **新参数 code**：精确 code 未命中时，用稳定前缀（如 `RY4.1.14.PBP`）再搜一次，列出同类参数已有写法。
7. **产物**：
   - `docs/requirements/<别名>/locate.md`：锚点表、候选表（文件 / 分数 / 证据 / 建议动作）、`file:line` 片段、推荐轨道与理由、确认清单占位；
   - `docs/requirements/<别名>/locate.json`：见 §4.3；
   - `docs/requirements/<别名>/selected-files.json`：`{"files":[...]}`，供负责人调整、`set-tier` 读取；首次生成，已存在且未 `--refresh` 时**不覆盖**，避免冲掉负责人调整；
   - stdout 一行 JSON（`--json`）或一行摘要：`locate: R-xxx -> locate.md (confidence=high candidates=3 repo=... cached=1)`。
8. **副作用边界**：只写 `docs/requirements/<别名>/` 与 `.febot/`；不改 state、不改仓库、不 add/commit。
9. **失败**：别名为空、context 缺失、仓库无法解析、indexer 失败 → 非 0 退出并给出可执行提示；不生成半成品 `locate.json`。

### 3.6 `scripts/feed.mjs`：接入层

- 默认写 `tier="full"`、`phase="init"`；tier 不再由 feed 判定。
- 新增 `state.planFile`：计划文件相对 ROOT 的路径；必须位于 `xiaoqian-manager/data/temp` 或 `docs/requirements/<别名>` 内。
- 新增 `state.gate`：`{checkedAt, branch, head:<commit>, branchOk, cleanOk}`；`head` 是 commit SHA，不是分支名。
- 保留现有退出码 0/1/2/3/5/6；`checkGate` 结果由 feed 转 `FeedError`，不能因 lib 迁移变成 1。
- 移除 `--set-tier`：调用方改用 `advance set-tier`。旧调用直接 exit 5，并提示新命令。
- 输出 JSON 增加 `elapsedMs`（additive），供 `advance timing` 记录。

### 3.7 `scripts/recon.mjs`：planning 事实底稿

- 改用 `lib/requirement.mjs` 与 `lib/repo-index.mjs`；输出 `recon.md` 格式**不变**。
- 缓存命中时直接渲染；未命中才 scan。
- 可额外写 `recon.meta.json`（`elapsedMs` / `head` / `generatedAt`），不影响 `recon.md`。
- 原有错误文案与退出码保持不变。

### 3.8 不新增 `check-files.mjs`

B 的 `check-files.mjs` 与 `advance check` 完全重叠。`advance check` 已覆盖：白名单、`-z` 解析、rename、staged、HEAD、分支、exempt。**不要再实现第二个收尾脚本。**

---

## 4. 契约与 schema

### 4.1 `plan.files.json`

```json
{
  "files": ["src/page/nursing-record/index.vue"],
  "deleted": [],
  "conditional": [
    {
      "path": "src/store/common.ts",
      "reason": "同类参数 code 的既有写法在这里",
      "question": "Q1"
    }
  ],
  "exempt": ["components.d.ts"]
}
```

规则：

- 路径为仓库相对 POSIX、无 `..`、无绝对路径、无反斜杠、无 glob；重复项去重。
- `files` / `deleted` / `conditional[].path` 三者互斥；`deleted` 必须存在于 HEAD。
- `conditional[].question` 必须能在 `questions.md` 找到对应 Q；`approve-files --q Q1` 处理。
- `exempt` 是生成/忽略文件白名单（如 `components.d.ts`），只报告不阻塞。
- 空数组 ≠ 缺失；full 在 `coding` 前缺失视为契约错误（exit 5）。
- express 由 `advance set-tier --tier express` 生成；full 由 planner 写。
- `plan.md` 的“将改动文件清单”只供人读；机器判断一律以 `plan.files.json` 为准。

### 4.2 `state.json`

```json
{
  "requirement": "R-533231",
  "tier": "express",
  "phase": "coding",
  "iteration": 0,
  "maxIteration": 2,
  "repo": "iho-icis-ui",
  "baseBranch": "dev",
  "branch": "dev",
  "taskId": "578605085778533231",
  "demandId": "...",
  "planFile": "xiaoqian-manager/data/temp/578605085778533231.md",
  "gate": {
    "checkedAt": "2026-10-23T09:00:00.000Z",
    "branch": "dev",
    "head": "<commit-sha>",
    "branchOk": true,
    "cleanOk": true
  },
  "lastAgent": "orchestrator",
  "lastTransitionKey": "a1b2c3d4e5f6",
  "blockers": [],
  "questions": [],
  "selectedFiles": ["src/page/nursing-record/index.vue"],
  "locate": {
    "confidence": "high",
    "recommendedTier": "express",
    "candidateCount": 3,
    "indexHead": "<commit-sha>",
    "generatedAt": "2026-10-23T08:59:58.000Z"
  },
  "timings": {
    "phases": {
      "locating": {
        "enteredAt": "2026-10-23T08:59:50.000Z",
        "exitedAt": "2026-10-23T09:00:00.000Z",
        "wallMs": 10000
      }
    },
    "machineMs": {"feed": 1200, "locate": 900},
    "waitMs": {"expressConfirm": 180000}
  },
  "updatedAt": "2026-10-23T09:00:00.000Z"
}
```

说明：

- `baseBranch` 是权威；`branch` 仅 legacy 兼容，读取用 `baseBranch ?? branch`。
- `gate.head` 是 commit SHA；`gate.branch` 是当时分支。
- `selectedFiles` 只是 express 的只读别名；权威是 `plan.files.json`。若二者漂移，`status` warning，`check` 以 `plan.files.json` 为准。
- `locate` 是摘要，不复制候选全文。
- `timings` 可为空；缺失不阻塞。

### 4.3 `locate.json` / `locate.md` / `selected-files.json`

`locate.json`：

```json
{
  "requirement": "R-533231",
  "repo": "iho-icis-ui",
  "branch": "dev",
  "index": {
    "head": "<commit-sha>",
    "scannedAt": "2026-10-23T08:59:50.000Z",
    "cached": false,
    "indexerVersion": "..."
  },
  "confidence": "high",
  "recommendedTier": "express",
  "anchors": [
    {"type": "route", "value": "/nursing-record", "matched": true}
  ],
  "candidates": [
    {
      "file": "src/page/nursing-record/icis-record-sheet.vue",
      "score": 130,
      "evidence": ["L1 route /nursing-record", "L5 content 后一天"],
      "action": "edit",
      "sensitive": false
    }
  ],
  "selectedFiles": ["src/page/nursing-record/icis-record-sheet.vue"],
  "exempt": [],
  "unmatchedAnchors": ["RY4.1.14.PBP.79605V"],
  "generatedAt": "2026-10-23T08:59:58.000Z",
  "elapsedMs": 8000
}
```

`selected-files.json`：

```json
{"files": ["src/page/nursing-record/icis-record-sheet.vue"]}
```

`locate.md` 至少包含：锚点表（命中/未命中）、候选表（文件 / 分数 / 证据 / 建议动作）、`file:line` 片段、推荐轨道与理由、`## 确认清单`。

### 4.4 subagent 最后一行 JSON

三份 agent 定义统一：**最后一条消息恰好一行 JSON，无代码围栏**。

```json
{"agent":"planner","requirement":"R-x","ok":true,"plan":"docs/requirements/R-x/plan.md","files":"docs/requirements/R-x/plan.files.json","questionCount":0,"fileCount":6}
{"agent":"coder","requirement":"R-x","ok":true,"round":"coding","mode":"full","changedFiles":["src/a.vue"],"tests":{"lint":"pass","test":"na","build":"skipped"},"note":"..."}
{"agent":"reviewer","requirement":"R-x","ok":true,"review":"docs/requirements/R-x/review.md","blockers":0,"suggestions":2,"nits":1,"scopeViolations":0}
```

- coder 的 `mode` 取值：`full | express`。
- coder 需要清单外文件时：`ok:false`，写 `questions.md` 或 `locate-gap.md`，停止。
- orchestrator 解析容错：取最后一条非空行、去围栏；解析失败把原文写 `orchestrator-log.md`，按产物文件是否存续继续，不因契约失败卡死。

### 4.5 `timings`

```json
"timings": {
  "phases": {
    "<phase>": {"enteredAt": "...", "exitedAt": "...", "wallMs": 1234}
  },
  "machineMs": {
    "feed": 1200,
    "locate": 900,
    "recon": 10000,
    "planner": 300000,
    "coder": 600000,
    "reviewer": 120000
  },
  "waitMs": {
    "expressConfirm": 180000,
    "planConfirm": 600000
  }
}
```

- `machineMs`：脚本/agent 实际执行时间。脚本在 stdout JSON / `locate.json` / `recon.meta.json` 返回 `elapsedMs`，编排层用 `advance timing` 落盘；agent 时间由编排层在委派前后尽量测量，平台不提供则留空。
- `waitMs`：人工等待。`set-tier express` 用 `now - locate.json.generatedAt`；`set-phase` 离开 `plan_confirm` 时用 `now - phase.enteredAt`。
- `wallMs`：`set-phase` 自动记录，包含机器 + 人工。
- `pipeline-stats.mjs`（P2）分别汇总 `machineMs` / `waitMs` / `wallMs`；**不得把 waitMs 当作机器性能**。
- 缺失/null 不阻塞任何阶段。

---

## 5. `.claude/commands/pipeline.md` 编排

### 5.1 启动 / 恢复

1. `docs/requirements/<别名>/state.json` 不存在 → 走 feed（feed 已做 init 门禁）。
2. 已存在 → `advance status <别名>`；用返回的 `next` 决定阶段，用 `features` 决定是否跳过 Hindsight。**恢复流程不跑 `gate`**；分支不符（`branchOk:false`）或 HEAD 异常才停下问负责人。
3. 需要细节再读 `orchestrator-log.md` 末尾 80 行与 `progressTail`。
4. feed 成功后：`advance set-phase <别名> --phase locating --agent orchestrator`。
5. Hindsight 段整节包在 `features.hindsight` 下，默认 false；`python` → `py -3`；`--budget 500/600 → low`、`800 → mid`、`1000 → high`。

禁止：手工拼 git 状态、手写 `state.json`、手写完成标记、用 `feed --set-tier`。

### 5.2 各阶段动作

| 阶段 | orchestrator 动作 | 关键命令 | 产物 / 出口 |
|---|---|---|---|
| `init` | 调 feed；按退出码分流；进入 locating | `node scripts/feed.mjs --plan <文件> --json`；`advance set-phase --phase locating` | `state.json`（full/init）、`planFile`、`gate` |
| `locating` | 跑 locate；读 `locate.json`；按 confidence 分流 | `node scripts/locate.mjs <别名> --json`；`advance set-tier --tier express\|full` | `locate.md` / `locate.json` / `selected-files.json`；high 走人工确认，medium/low 直接 full |
| `planning` | 跑 recon；委派 planner；进入 plan_confirm | `node scripts/recon.mjs <别名>`；`advance set-phase --phase plan_confirm --agent planner` | `recon.md`、`plan.md`、`plan.files.json`、`questions.md` |
| `plan_confirm` | 展示问题；收答案；处理 conditional；进 coding | `advance approve-files --q Q1` / `--reject`；`advance set-phase --phase coding` | `answers.md`、`decisions.md`、最终 `plan.files.json` |
| `coding` | 委派 coder；跑 check；full 进 review，express 进 verify | `advance check`；`advance set-phase --phase code_review\|verify` | `progress.md`、`test-report.md` |
| `code_review` | 生 review-input；委派 reviewer；按 blocker 分流 | `advance review-input`；`advance set-phase --phase fixing\|verify` | `review-input.txt`、`review.md` |
| `fixing` | 委派 coder 只修 blocker；跑 check；进 verify | `advance check`；`advance set-phase --phase verify` | `progress.md`、`test-report.md` |
| `verify` | 委派 coder 跑 lint/test；全绿 done，否则回退 | `advance set-phase --phase coding\|fixing`；`advance done` | `test-report.md` |
| `done` | 写 worklog；可选 Hindsight reflect；一次收尾 | `advance done <别名>` | state=done、file-lock 清理、临时计划删除、marker 最后写 |

### 5.3 三模式输入矩阵

| 模式 | coder 输入 | reviewer | 收尾 |
|---|---|---|---|
| full | `plan.md` + `plan.files.json` + `answers.md` | `review-input.txt` + `plan.md` + `plan.files.json` + `test-report.md` | `advance done` |
| express | `locate.md` + `locate.json` + `plan.files.json`；**不读 `plan.md`** | 不跑；需要审查选 full | `advance done` |

### 5.4 输出纪律

- 每阶段可见回复只 3 行：`阶段` / `一行摘要` / `下一步`。
- blocker、问题、人工拍板点完整保留；不复述 subagent 报告、不粘贴文件全文。
- resume 所需的“下一步 + 已知信息”写进 `--note-file`，不要为了省字丢掉。
- 3 行纪律只影响可见文字（约占输出 6–9%），不要把它当成 −25% 的主要来源。

---

## 6. 逐文件改动

### 新增

| 文件 | 内容 |
|---|---|
| `scripts/lib/requirement.mjs` | tasks/需求/仓库/分支解析 |
| `scripts/lib/repo-index.mjs` | `.febot/index` 缓存与 code-indexer 扫描 |
| `scripts/advance.mjs` | `status/gate/set-phase/set-tier/check/review-input/approve-files/timing/done` |
| `scripts/locate.mjs` | 确定性定位与 `locate.md/json/selected-files.json` |
| `docs/optimization/pipeline-merged-plan.md` | 本文 |

### 修改

| 文件 | 改动 |
|---|---|
| `scripts/lib/febot.mjs` | `FEBOT_ROOT`、`ScriptError`、`git`/`checkGate`、原子读写、`readWhitelist`、`readState`/`writeState` |
| `scripts/feed.mjs` | `planFile`、`gate.head`（commit）、默认 full/init、移除 `--set-tier`、保留退出码、`elapsedMs` |
| `scripts/recon.mjs` | 改用 `lib/requirement` + `lib/repo-index`；`recon.md` 输出不变；可选 `recon.meta.json` |
| `.claude/commands/pipeline.md` | 全套阶段动作、locate/express、set-tier、review-input、done、3 行纪律 |
| `.claude/agents/planner.md` | `maxTurns 10→20`；输入加 `locate.md/json`；要求写 `plan.files.json`；最后一行 JSON |
| `.claude/agents/coder.md` | full/express 两模式；白名单；越界写 `locate-gap.md` 停下；最后一行 JSON |
| `.claude/agents/reviewer.md` | `maxTurns 10→20`；输入改 `review-input.txt`；继续无 Bash；最后一行 JSON |
| `.claude/skills/pipeline-feed/SKILL.md` | 删除 tier 判定与 `--set-tier`；feed 默认 full，tier 由 locate 决定 |
| `docs/requirements/_template/state.json` | 增加 `planFile`、`gate`、`selectedFiles`、`locate`、`timings`、`lastTransitionKey` |
| `xiaoqian-manager/lib/server/pipeline/runner.ts` | `POLL_MS = 2 * 1000` |
| `example/febot.config.json` | 增加 `"features": { "hindsight": false }` |
| `.gitignore` | 增加 `/.febot/` |
| `README.md` | `tier: full\|light` → `full\|express`；`--set-tier` → `advance set-tier`；补 locate/express 说明 |
| `docs/optimization/pipeline-optimization-plan.md` | 修正“仓库根目录”旧路径；加归档说明 |
| `docs/optimization/pipeline-token-speedup.md` | 加归档说明；§5 指向本文 |

### 明确不做

- 不新增 `scripts/check-files.mjs`。
- 不新增 `scripts/pipeline-stats.mjs`（P2）。
- 不新增 express reviewer 分支。
- 不改 worktree / 同仓串行 / file-lock / 敏感文件审批规则。
- 不改 node / yarn 版本；不静默改 `node_modules`。

---

## 7. 实施顺序（PR）

| PR | 内容 | 依赖 | 验收 | 回退 |
|---|---|---|---|---|
| **PR0 卫生与文档** | 本文、A/B 归档说明、B 路径修正；`features.hindsight=false`；`POLL_MS=2s`；`py -3` / budget 映射；`maxTurns 10→20`；frontmatter 核实；state 模板；`.gitignore`；README tier 文案 | 无 | 配置/agent 改动一次完成；不改变流水线行为 | 单文件回退 |
| **PR1 只读底座** | `lib/febot` 扩展、`lib/requirement`；`advance status/gate/check/review-input/timing`；feed `planFile`/`gate.head`；state 校验；fixture | PR0 | feed 退出码回归；fixture 覆盖；full/express 只读跑通；`check` 仅报告 | 删除 `advance` 与 lib 新增块 |
| **PR2 写路径** | `set-phase` / `set-tier` / `approve-files` / `done`；`plan.files.json`；file-lock/临时文件/marker；移除 `feed --set-tier`；SKILL 改口 | PR1 | fixture 全转移；full 需求可收尾；express 用 mock `locate.json` 可落盘 | 关闭写命令，保留只读 |
| **PR3 locate/索引** | `lib/repo-index`、`locate.mjs`、recon 缓存、`.febot`；locate fixture | PR0 | 样例命中；历史召回 ≥4/5；缓存 <1s；无副作用 | 删除 locate/index，recon 回退 |
| **PR4 合并编排** | `pipeline.md` 一次重写；三份 agent；full/express；locate 接入；review-input | PR2 + PR3 | full E2E + express E2E ≤25min | 还原 `pipeline.md`/agent |
| **PR5 度量与收口** | `timings` 完整落盘、`pipeline-stats.mjs`（P2）、README 收口、成本/墙钟测量 | PR4 | 2–3 次干净样本对比基线；文档一致 | 保留 timings，移除 stats |

- PR1 与 PR3 可在 PR0 后并行；PR2 等 PR1；PR4 等 PR2 + PR3。
- **`pipeline.md` 只在 PR4 改一次**，避免两份方案各改一版。
- 每个 PR 独立可回退；PR1 先只报告，PR2 再打开写门禁，避免脚本 bug 阻断既有流水线。

---

## 8. 验收矩阵

### 8.1 正确性

| 场景 | 命令 / 方法 | 通过标准 |
|---|---|---|
| feed 回归 | `node scripts/feed.mjs --plan d:/tmp/feed-fixture.md --dry-run`，对比改动前后 stdout/退出码 | `alias/repo/branch/gate/actions/files` 一致；3/5/6 分支不变；`checkedAt`/`updatedAt` 归一化后比较 |
| advance fixture | `FEBOT_ROOT=d:/tmp/febot-merged-fixture`；空仓 + 模板 + tasks + file-lock；本机 git 2.20 不支持 `git init -b`，用 `git init` 后 `git checkout -b dev` | `status` 脏工作区不失败；`gate --init` 脏/分支错 exit 3；`set-phase` 转移/幂等/iteration；`set-tier` full/express；`check` 白名单/越界/staged/HEAD/exempt；`review-input` 新文件/二进制/超大/空格路径；`approve-files` conditional；`done` 预检失败零写入、重复 `already:true`、marker 归属冲突 |
| full E2E | 选一个 ≤3 文件的历史 full 需求 | init → planning → plan_confirm → coding → code_review → fixing/verify → done；`plan.files.json` 生效；reviewer 只读 `review-input.txt`；marker 最后出现 |
| express E2E | `578605085778533231`（feed 为 `R-533231`） | 定位到 `iho-icis-ui`；`/nursing-record` 命中；候选前 3 含 `icis-record-sheet.vue` 与 `nursing-patient-chart.vue`；确认后 5 阶段完成；≤25min（不含 coder 编辑） |
| locate 历史召回 | R-161135 / R-873656 / R-135539 / R-114776 / R-oral-10161029 | 实际改动文件进入 top 8 候选 ≥4/5；只有 ≤5 文件的需求推荐 express |
| locate 缓存 | 同一 HEAD 连跑两次 | 首次约 10s；第二次 <1s |
| 无副作用 | locate/recon 前后 `git -C gitlab/<仓> status --porcelain` | 完全一致；只新增 `docs/requirements/<别名>/` 与 `.febot/` |
| done 幂等 | 重复 `advance done` | 第二次 `already:true`；marker 不被改写；不重复删文件 |
| 暂存/HEAD | coder 模拟 `git add` / `commit` | `check --mode done` exit 3；`advance done` 不写 marker |
| 中文/路径 | 中文备注走 `--note-file`；空格/中文路径 | 不出现 exit 127；`-z` 解析正确 |
| runner | `xiaoqian-manager` lint/typecheck | 通过；`POLL_MS` 为 2s |

### 8.2 成本 KPI

- baseline：4 个 full transcript（R-161135 / R-873656 / R-743150 / R-135539）。
- 目标：工具调用首期 ≤100、二期 ≤70、争取 ≤60；主会话输出 −25%；subagent fresh tokens −15%。
- 统计：主会话/subagent 分开；thinking / `tool_use` 入参 / 可见文字分开；取 2–3 次干净重跑。
- 不要把混合调研 session 直接相加；不要用 3 行纪律解释全部降幅。

### 8.3 墙钟 KPI

- express：init → done ≤25 分钟，不含 coder 实际编辑时间；`state.timings` 记录 `wallMs`、`machineMs`、`waitMs`。
- locate：首次约 10s，缓存 <1s。
- full：机器侧目标减少 10–20 分钟；人工等待单列，不混入机器性能。

### 8.4 文档一致性

- A/B 顶部有归档说明；B 的“仓库根目录”路径已修正。
- README 不再出现“新需求 tier=light”或 `feed --set-tier`。
- `pipeline-feed/SKILL.md` 不再判 tier。
- 所有新命令在 `pipeline.md` 有且仅有一处定义。

---

## 9. 风险与边界

| 风险 | 缓解 | 回退 |
|---|---|---|
| `plannedDescription` 稀疏（12 条只有 1 条非空） | locate 只在锚点可解析时推荐 express；其余回落 full，不猜 | 手工选 full |
| locate 假阳性 | 高置信才 express；负责人确认；候选 >5 或含敏感文件直接 full | 确认页选“走全轨” |
| express 无 reviewer | 需要审查的需求在确认页选 full；express 不内嵌 reviewer | 重新走 full（新需求或人工决定） |
| state 漂移/手写 | 唯一写入器 `advance`；`status` 只读；`plan.files.json` 权威 | 用 `advance status` 对照修复 |
| `plan.files.json` schema 迁移 | 统一 A 超集；旧 `conditional:string[]` 在 `readWhitelist` 升级并 warning | 手工改成对象 |
| `selectedFiles` 与 `plan.files.json` 漂移 | 以 `plan.files.json` 为准；`status` warning | 重跑 `set-tier` 或 `--force` |
| conditional 死锁 | `approve-files --reject`；或 `set-phase coding --allow-conditional`（不碰该文件） | 人工改 JSON 后重跑 |
| `set-tier` 覆盖 planner 产物 | 已存在且文件不同必须 `--force` | 还原 `plan.files.json` |
| done 写一半 | 预检前置；state/log/marker 顺序固定；重跑可恢复 | 按 state 现状补 marker |
| coder 偷 commit | `gate.head` + `check` 比对 HEAD | 立即停下，人工回退 commit |
| 索引缓存过期/脏树 | 缓存键含 HEAD + status 哈希 + indexer 版本；`--refresh` | 删 `.febot/index/<仓>.*` 重跑 |
| 中文命令行 | 备注/锚点一律文件传递；`--note` 仅 ASCII | 改用 `--*-file` |
| maxTurns 不生效 | PR0 真实委派验证；prompt 加“最多 N 次探索，找不到写 Q” | 保留 10，改 prompt 约束 |
| frontmatter 字段名不对 | PR0 用 `claude --debug`/文档核实 `permissionMode`、`background`、`maxTurns` | 只保留确认有效的字段 |
| `pipeline.md` 两份方案各改一版 | 只在 PR4 改一次；A/B 只加归档说明 | 还原单文件 |
| 测试矩阵膨胀 | PR1/PR2/PR3 各自 fixture；PR4 只做 E2E | 按 PR 回退 |
| `FEBOT_ROOT` fixture 写真实目录 | 所有路径由 `FEBOT_ROOT` 派生；测试后检查 `git status` | 删除 fixture |
| Windows 路径/CRLF/BOM | `toPosix`、去 BOM、`-z`、原子写 | 单文件 `--files-file` 重跑 |

---

## 10. 文档同步

- **B**：顶部加归档说明；Step 0 与“关键文件”里的“仓库根目录”改为 `docs/optimization/pipeline-optimization-plan.md`。
- **A**：顶部加归档说明；§5 标注“已合并，见本文”。
- **README**：`tier: full|light` → `full|express`；`feed --set-tier` → `advance set-tier`；`/pipeline R-16931 # tier=light` 改为 express 说明。
- **pipeline-feed/SKILL.md**：删除 tier 判定与 `--set-tier`，改为“feed 默认 full，locate 决定 full/express”。
- **`docs/requirements/_template/state.json`**：补 `planFile`、`gate`、`selectedFiles`、`locate`、`timings`。
- **`.gitignore`**：`/.febot/`。
- **`docs/optimization/pipeline-feed-refactor.md`**：历史文档，不再更新；如被引用，注明 `--set-tier` 已废弃。

---

## 11. P2 / 后续

- `scripts/pipeline-stats.mjs`：汇总 `state.timings`，输出每阶段 `machineMs` / `waitMs` / `wallMs`、express 命中率、locate 召回率。
- `locate --explain`：打印打分明细，便于调阈值。
- `projectMap` 已是机器可读配置，feed/locate 只做机械求值，不解析 markdown。
- 如后续确实需要“express + reviewer”，作为独立开关另评估；本次不做，避免把快轨又加回一次 LLM 会话。
