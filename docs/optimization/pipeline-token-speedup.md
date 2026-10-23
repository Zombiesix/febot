# pipeline 降 token + 提速方案（机械项 + 通信契约）

> 归档说明：本文件是历史方案，已被 [pipeline-merged-plan.md](./pipeline-merged-plan.md) 合并。实施以合并方案为准；本文保留为历史设计。
>
> 状态：设计稿 v2（已按 P0/P1 审查意见修订，未实施）。
> 范围：只做确定性脚本收敛与 subagent 回传契约；不合并打磨/复验轮、不改人工门禁、不给 reviewer Bash。
>
> 本轮修订要点：
> - P0：拆分 `status` / `gate`（resume 时脏工作区不能当门禁失败）；兼容 legacy `state.branch` / `changedFiles`；迁移 lib 不得破坏 feed 退出码；fixture 需可重定向根目录；`done` 增加预检与 `planFile` 来源；用 `state.gate.head` 防偷提交。
> - P1：light/conditional 白名单闭环；`-z` 路径解析；中文参数改文件传递；生成文件 `exempt`；log 幂等键；phase 转移校验；agent frontmatter 核实；与另一份 locate/express 方案的关系。

## 1. 问题

对 4 个 full 需求（R-161135 / R-873656 / R-743150 / R-135539）的 transcript 实测：

- 三个 subagent 实际干活 10–16 分钟/需求；orchestrator 主会话 200–325 轮、92–161 次工具调用，加权输入 2.2M–3.5M。
- subagent 冷启动 0.6M–0.9M fresh tokens/需求；planner 读 9–13 个文件、coder 再读 7–15 个，交集 1–7 个。
- orchestrator 输出 182k–255k token/需求；但其中可见文字只占 5.6–8.7%，thinking 占 50–55%，`tool_use` 入参占 36–42%。
- 每需求的机械写入次数：`state.json` 5–8 次、`orchestrator-log.md` 7–11 次、`file-lock.md` 3–7 次、`tasks.md` 2–3 次、`decisions.md` 2–5 次。
- 2 小时墙钟里 >45s 的空档合计 62–97 分钟，多数卡在 `AskUserQuestion` / 人工离开 / 手工验收；机器侧可优化空间约 10–20 分钟。

结论：成本在**往返与复述**，不在写入字节。三个 subagent 各自独立上下文、模型相同，「一个想 / 一个改 / 一个审」的分工本身已成立；本轮不合并轮次，只降低每次交接的成本。

**KPI 口径修正**：3 行输出纪律只能影响可见文字（约 6–9%），不足以单独实现 −25%。−25% 主要来自两处：把 20–35 次 state/log/file-lock/tasks/decisions 写入合并成脚本调用；减少 orchestrator 为了拼 git/diff 而产生的回合与 thinking。工具调用目标分阶段：先 ≤100，再 ≤70，最终争取 ≤60。

预期（单需求）：

| 指标 | 现状 | 目标 |
|---|---:|---:|
| orchestrator 工具往返 | 92–161 次 | 首期 ≤100；二期 ≤70；争取 ≤60 |
| 主会话输出 token | 182k–255k | −25%（主要来自写入合并与回合减少） |
| subagent 冷启动 | 0.6M–0.9M | −15% |
| 完成标记延迟 | ≤30s | ≤2s |

> 测量口径：baseline 取“干净重跑的一个 full 需求”，不要把覆盖多个需求/含调研的混合 session 直接相加；主会话与 subagent 的 token 分开统计。

## 2. 改动

### 2.1 `scripts/lib/febot.mjs`：迁入 git/门禁与共享工具

`advance.mjs` 直接使用 `state.repo` / 期望分支，**不需要** `resolveRepo` / `resolveBranch`；feed 的这两个业务函数不动。

**迁入但不“原样”**：

- `git(repoDir, args)`：`execFileSync`、无 shell；失败抛 lib 的 `ScriptError(code=3)`。
- `checkGate(repoDir, expectedBranch)`：**返回结果，不自己抛门禁错误**：
  `{head, status, branchOk, clean, dirty}`。由 feed 负责把 `!branchOk` / `!clean` 转成 `fail(3, ...)`，保持现有退出码与文案。
  > 原因：feed 顶层只把 `FeedError` 映射为业务退出码（[feed.mjs:783-792](scripts/feed.mjs#L783-L792)）。若 lib 抛普通 Error，门禁失败会从 3 变成 1。

**新增共享工具**（feed / advance 共用，避免两份实现漂移）：

- `displayPath(abs)`、`readText(abs)`（去 BOM）、`readJson(abs)`、`writeJsonAtomic(abs, obj)`（同目录 `tmp-<pid>` + rename）。
- `ALIAS_RE`、`SAFE_ID`（taskId 只允许 `^[A-Za-z0-9_-]+$`）、`toPosix(p)`、`isPathInside(base, child)`。
- `readState(reqDir)` / `writeState(reqDir, patch)`：读改写、原子写，`{...old, ...patch}` 保留未知字段。
  - 期望分支读取统一为 `state.baseBranch ?? state.branch`（legacy 兼容：R-161135 / R-743150 只有 `branch`）。
- `readWhitelist(reqDir, state, opts)` 来源顺序：
  1. `--files-file <path>`（JSON 文件，不是内联 JSON）
  2. `plan.files.json`
  3. `state.whitelist`（可选快照）
  4. legacy `state.changedFiles`（可作为过渡白名单，标 `source:"state.changedFiles"` 并 warning）
  5. 报错并提示 `--no-whitelist`
  空数组表示“明确不允许改动”，与文件缺失区分。
- `resolveRepoDir(state, cfg)`：`state.repo` → 根 `tasks.md` 第 5 列 → 抛 `ScriptError(code=6)`。

**feed 增加两个字段**：

- `state.planFile`：计划文件相对 ROOT 的路径；必须位于 `xiaoqian-manager/data/temp` 或 `docs/requirements/<别名>` 内。
- `state.gate.head`：开工门禁时的 `git rev-parse HEAD`，供后续发现“偷偷 commit”。

**可测试性**：

- lib 的 `ROOT` 支持 `FEBOT_ROOT` 环境变量覆盖（优先级最高）；`REQUIREMENTS_DIR` / `TASKS_PATH` 由它派生。
- 仅靠 `FEBOT_CONFIG` 不够：它只影响 `repoRoot`，requirements/tasks 仍会写真实目录。

`feed.mjs` 的 `main()` 保持无条件执行（不改成库），行为与退出码不变。

### 2.2 新增 `scripts/advance.mjs`

所有子命令**始终输出一行 JSON**；所有写操作支持 `--dry-run`。

退出码：`0` 成功/幂等、`1` 异常、`3` 强制执行的门禁/白名单/暂存/HEAD/分支不符、`5` 参数或契约错误（含非法 phase、plan.files.json 格式错误）、`6` 配置/state/marker 归属错误。`2` 保留给 feed 的映射未命中。

| 子命令 | 替代 | 行为 |
|---|---|---|
| `status <alias>` | 启动/恢复读 state + 手工 git | **只读，resume 安全**。输出 state 摘要、`repo{name,dir,branch,expected,head,clean,dirty,staged}`、`whitelist{source,files,deleted,conditional,exempt}`、`features`、`next`、`progressTail`。分支不符只报 `branchOk:false`，**不因脏工作区返回 3**。 |
| `gate <alias> [--init] [--enforce-clean] [--record]` | init 开工门禁 | 始终校验分支；`--init` 或 `--enforce-clean` 才要求工作区干净。分支不符，或要求干净但脏 → exit 3。`--init` 仅用于 `phase=init` 且尚未 coding；feed 已做 init 门禁，正常不重复。`--record` 写 `state.gate`（含 head）。 |
| `set-phase <alias> --phase <p> [--agent] [--note-file] [--inc-iteration] [--blockers-file] [--questions-file] [--force]` | 手写 `state.json` + 整篇重写 `orchestrator-log.md` | 见下方转移表。一次完成 state 更新 + log 追加；`--dry-run` 不写。禁止 `--phase done`（done 由 `done` 子命令收口）。 |
| `check <alias> [--files-file] [--no-whitelist] [--mode done\|review] [--accept-light-scope]` | 收尾 2 条 git + 人眼比对 | 白名单 vs `status --porcelain=v1 -uall -z` vs `diff --cached --name-only -z`；校验 `state.gate.head` 与分支未变。输出 `{ok,source,head,branch,changed,staged,foreign,exemptChanged,missing,warnings}`。done 模式下 foreign/staged/HEAD/分支不符 → exit 3。 |
| `review-input <alias> [--files-file] [--no-whitelist] [--max-bytes 200000] [--max-file-bytes 60000]` | orchestrator 代取 diff + 写文件 | 按白名单生成 `review-input.txt`：diff --stat、`git diff HEAD -- <files>`、新增文本文件全文、白名单外文件列表。超限按整文件跳过并标 `omitted`；输出 `{path,bytes,truncated,newFiles,foreign,exempt,omitted}`。 |
| `approve-files <alias> --q Q1 [--dry-run]` | 人工改 `plan.files.json` | 把 `conditional` 中 `question==Q1` 的条目移入 `files`，原子写回；追加 decisions/log；幂等。 |
| `done <alias> [--task-id] [--plan-file] [--files-file] [--no-whitelist] [--accept-light-scope] [--dry-run]` | 收尾 3/5/6 步 | 严格顺序见下；任何预检失败**不写 state/marker、不删文件**。 |

**`set-phase` 转移表**（未列出的转移需 `--force`）：

```text
init        -> planning | coding
planning    -> plan_confirm
plan_confirm-> coding
coding      -> code_review | verify
code_review -> fixing | verify
fixing      -> verify
verify      -> coding | fixing        # 不全绿时回退
done        -> 只能由 advance done 写入；--force 才可重开
```

- `--inc-iteration` 只允许与 `--phase fixing` 一起用，进入 fixing 时 +1；重试不能双计数。
- 幂等：state 记录 `lastTransitionKey = sha1(phase|agent|note)[0..12]`；log 行格式 `## <ISO> phase=<p> (agent=<a>) key=<key>` + note。重试时若 state 已有同 key，只补缺失的 log 行。
- 写序：先 `state`（含 key），再追加 log；log 失败可重试补齐。
- 文本参数一律走文件：`--note-file` / `--blockers-file` / `--questions-file`。`--note` 只用于 ASCII 短备注。**本机含中文的 Bash 命令会 exit 127**，编排层不得把中文写进命令行。
- `--blockers-file` / `--questions-file` 缺省表示“不修改”，空数组表示“清空”。

**`status` 细节**：

- 以非严格模式读白名单：`plan.files.json` 缺失或格式错误只输出 `whitelist.source:"none"` / `whitelist.error`，**不返回 5**。否则 planning 阶段（planner 尚未写 JSON）无法 resume。

**`check` 细节**：

- `status --porcelain=v1 -uall -z`，统一 `-c core.quotepath=false`；按 NUL 解析，避免空格/非 ASCII 路径被转义。rename 同时匹配新旧路径。
- full 轨道必须有白名单；light 轨道要求 coder 首轮先写 `plan.files.json`，缺失时只能 `--no-whitelist --accept-light-scope`，输出 `source:"none"` 并在 state/log 记 warning。
- `plan.files.json` 的 `exempt`（如 `components.d.ts`、`auto-imports.d.ts`）只报告不阻塞，计入 `exemptChanged`；done 时给出 warning。
- `missing`（白名单内未改）只报告，不阻塞。
- `state.gate.head` 与当前 HEAD 不一致 → exit 3（coder 若 `add && commit`，`status` 会显得干净，必须用 HEAD 兜住）。
- legacy state 没有 `gate.head`：首次 resume 用 `advance gate <别名> --record` 补记当前 HEAD（不要求干净、不因脏失败），输出标 `legacyHead:true`；补记前 `check` 只 warning，不比对 HEAD。

**`review-input` 细节**：

- 先跑 HEAD/分支预检；`git -c core.quotepath=false diff --no-ext-diff --no-color HEAD -- <files>`，git 超时放宽到 60s。
- 新增文件：文本（前 8KB 无 NUL）且不超过 `--max-file-bytes` 才附全文；二进制/超大文件整文件跳过并列入 `omitted`，**不按字节截断**（避免切坏 UTF-8）。
- 全局 `--max-bytes` 超限时同样按整文件省略，输出 `truncated:true`。
- `exempt` 文件照常展示但标注，不计入 foreign。

**`done` 顺序**：

1. 预检：state 存在、alias 与 `state.requirement` 一致；`taskId` 取 `--task-id` 或 `state.taskId`，用 `SAFE_ID` 校验；marker 路径限制在 `xiaoqian-manager/data/temp`。
2. marker 已存在：taskId/requirement 一致 → `already:true`（幂等清理后返回）；属于其他任务 → exit 6。**这一步必须在任何写操作之前。**
3. `planFile` 取 `--plan-file` 或 `state.planFile`；路径必须在上文允许目录内；不存在只 warning。
4. `check --mode done`（light 需 `--accept-light-scope`）。失败立即返回。
5. state 置 done + log 追加（同 `lastTransitionKey` 语义）。
6. 删除 `file-lock.md` 中“占用需求”列等于本别名的行（按列匹配，不误删他人）。
7. 删除计划临时文件（`rm -f` 语义，失败只 warning）。
8. **最后**原子写 `<taskId>.done.json`；口头流程（无 taskId）跳过。

若第 5 步之后失败（如 marker 写失败），重跑 `done` 时应能从 state/marker 状态恢复：marker 缺失且 state=done → 跳过 check，补清理并写 marker。

**`status` 输出字段**（供编排层直接决策，避免再读 config）：

```json
{"ok":true,"alias":"R-x","phase":"coding","tier":"full","iteration":0,
 "repo":{"name":"...","dir":"...","branch":"dev","expected":"dev","head":"...","branchOk":true,"clean":false,"dirty":[],"staged":[]},
 "whitelist":{"source":"plan.files.json","files":[],"deleted":[],"conditional":[],"exempt":[]},
 "features":{"hindsight":false},"next":{"phase":"code_review","agent":"reviewer"},"progressTail":"..."}
```

### 2.3 `.claude/commands/pipeline.md`

**启动/恢复**：

1. `docs/requirements/<别名>/state.json` 不存在 → 走 feed（feed 已做 init 门禁）。
2. 已存在 → `advance status <别名>`；用返回的 `next` 决定阶段，用 `features` 决定是否跳过 Hindsight。**恢复流程不跑 `gate`**；分支不符（`branchOk:false`）或 HEAD 异常才停下问负责人。
3. 需要细节再读 `orchestrator-log.md` 末尾 80 行与 `progressTail`。

| 位置 | 改为 |
|---|---|
| feed 调用 | 保留；注明 feed 已做 init 门禁，init 阶段不要重复 gate |
| gate | 仅人工修复/重开门禁时用 `advance gate <别名> --init`；正常启动用 `status` |
| 各 Hindsight 段 | 整节包在 `features.hindsight` 下，**默认 false 整节跳过**；`python`→`py -3`；`--budget 500/600`→`low`、`800`→`mid`、`1000`→`high` |
| planning | 保留 recon；planner 委派要求写 `plan.files.json`（含 `conditional` 的 `question`）；末行改 JSON 契约 |
| plan_confirm | 拍板后先 `advance approve-files <别名> --q Qn` 处理 conditional，再 `advance set-phase <别名> --phase coding --agent orchestrator --note-file <临时说明>` |
| coding | coder 读 `plan.files.json`；结束 `advance set-phase --phase code_review --agent coder --note-file <摘要>`；light 轨道 coder 首轮先写 `plan.files.json` |
| code_review | 先 `advance review-input <别名>`；reviewer 读 `review-input.txt` + `plan.files.json` + `plan.md` + `test-report.md` |
| fixing / verify | 进入 fixing 时 `advance set-phase --phase fixing --inc-iteration`；verify 不再 +1 |
| done | orchestrator 先写 worklog，再 `advance done <别名>` 一次完成收尾；file-lock/计划文件/marker 由脚本处理 |
| 轨道约束 | 新增：机械步骤一律走 `scripts/advance.mjs`；禁止手工拼 git、手写 state.json、手写完成标记。`advance` 失败时停下贴 JSON，不改用手工写入“补救” |

新增**输出纪律**：每阶段可见回复只 3 行——`阶段` / `一行摘要` / `下一步`；blocker、问题、人工拍板点完整保留；不复述 subagent 报告、不粘贴文件全文。resume 所需的“下一步 + 已知信息”写进 `--note-file`，不要为了省字丢掉。

### 2.4 subagent 回传契约

三份 agent 定义统一：**最后一条消息恰好一行 JSON，无代码围栏**。

```json
{"agent":"planner","requirement":"R-x","ok":true,"plan":"docs/requirements/R-x/plan.md","files":"docs/requirements/R-x/plan.files.json","questionCount":0,"fileCount":6}
{"agent":"coder","requirement":"R-x","ok":true,"round":"coding","changedFiles":["src/a.vue"],"tests":{"lint":"pass","test":"na","build":"skipped"},"note":"..."}
{"agent":"reviewer","requirement":"R-x","ok":true,"review":"docs/requirements/R-x/review.md","blockers":0,"suggestions":2,"nits":1,"scopeViolations":0}
```

`plan.files.json`：

```json
{
  "files": ["src/a.vue"],
  "deleted": [],
  "conditional": [{"path": "src/b.ts", "reason": "...", "question": "Q1"}],
  "exempt": ["components.d.ts"]
}
```

- 路径为仓库相对 POSIX、无 `..`、无反斜杠；空数组 ≠ 缺失。缺失视为契约错误。
- `planner.md`：`maxTurns: 10 → 20`；prompt 里同时加“最多 N 次探索，找不到就写 Q”的硬约束。**`maxTurns` 在部分版本存在强制不生效的反馈，实施前用一次真实委派验证。**
- `reviewer.md`：`maxTurns: 10 → 20`；输入改用 `review-input.txt`；继续无 Bash。
- `coder.md`：full 以 `plan.files.json` 为准（`plan.md` 清单仅人读）；需要清单外文件时写 `questions.md` 并 `ok:false`；light 首轮先写 `plan.files.json` 再改代码。
- orchestrator 解析容错：取最后一条非空行、去围栏；解析失败则把原文写 `orchestrator-log.md`，按产物文件是否存续继续，不因契约失败卡死。
- 顺手核实 frontmatter：`permission: acceptEdits` 按文档应为 `permissionMode`，`background: true` 不是 agent frontmatter 字段（会被静默忽略）；本轮要改这三份文件，实施时用 `claude --debug` 确认字段是否生效。

### 2.5 轮询与开关

- `runner.ts`：`POLL_MS = 30 * 1000 → 2 * 1000`（与文件头注释一致）。
- `example/febot.config.json`：`"features": { "hindsight": false }`；缺失按 false。
- 注意配置迁移：`ensure-config.mjs` 只在目标不存在时复制，**已存在的根 `febot.config.json` 不会自动获得 `features`**。默认 false 是行为翻转，需在 README/decisions 写明；`advance status` 输出 `features`，避免编排层再读一次配置。
- `py -3` 与 `--budget low/mid/high` 是本机约定；脚本若跨平台使用，需按 `process.platform` 选择解释器。

### 2.6 不做

不合并打磨/复验轮；不改人工门禁；不给 reviewer Bash；不动 worktree / 同仓串行铁律；不新增 `stats.mjs` / `locate.mjs` / `check-files.mjs`。`check-files` 的能力并入 `advance check`，不要再做第二个脚本。

## 3. 验证

1. **feed 回归**：`node scripts/feed.mjs --plan d:/tmp/feed-fixture.md --dry-run`，对比改动前后 stdout JSON 与退出码。**`checkedAt` / `updatedAt` 每次不同，比较前先归一化**；重点比对 `alias/repo/branch/gate/actions/files` 与退出码 3/5/6 的分支。
2. **advance fixture**（不碰真实需求目录）：
   - `FEBOT_ROOT=d:/tmp/febot-adv-fixture`；fixture 内建 `febot.config.json`（repoRoot 指向新建空仓）、`docs/requirements/_template`、空 `tasks.md`、`file-lock.md`。
   - 本机 git 2.20.1 不支持 `git init -b`：用 `git init` 后 `git checkout -b dev`（或 `git symbolic-ref HEAD refs/heads/dev`）。
   - 覆盖：`status` 脏工作区不失败；`gate --init` 脏/分支错 exit 3；legacy `state.branch` / `changedFiles`；`set-phase` 转移表、幂等重试、`--inc-iteration` 只 +1、非法 phase；`check` 白名单内/越界/暂存/HEAD 变化/exempt/light；`review-input` 新文件/二进制/超大/空格路径；`approve-files` conditional；`done` 预检失败零写入、成功顺序、重复 `already:true`、marker 归属冲突、口头流程不写 marker；中文只走 `--note-file`。
   - 测试后删除 fixture，确认 `git -C d:/febot status --porcelain` 无新增。
3. **剧本演练**：用一个 full 需求（≤3 文件）+ 一个 light 需求，走 init → coding → verify → done：
   - transcript 统计 orchestrator 工具调用：首期 ≤100，目标 ≤70；
   - 每阶段可见回复 ≤3 行；
   - done.json 最后出现，`git diff --cached` 为空，HEAD 与 gate 记录一致。
4. **回归**：`node scripts/recon.mjs <已有别名>` 输出格式不变；`runner.ts` 改了一行，建议跑一次 `xiaoqian-manager` 的 lint/typecheck；不跑目标仓 build。
5. **量化**：对“干净重跑”的 full 需求取 2–3 次样本，对比基线 4 需求的 subagent fresh tokens、orchestrator 输出 token、工具调用分类与墙钟。统计脚本可放 `d:/tmp`（不进仓），按主会话/subagent、thinking/tool_use/可见文字分别统计。

## 4. 风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| feed 回归 | lib 只返回结果、由 feed 抛 FeedError；先 dry-run 比对 | 还原 `feed.mjs` 两个函数与 lib 新增块 |
| resume 被门禁卡死 | `status` 只读；`gate` 仅在 `--init`/`--enforce-clean` 时要求干净 | 编排层改用 `status` |
| legacy state 不兼容 | `baseBranch ?? branch`；`changedFiles` 作为过渡白名单并 warning | 对旧需求显式 `--files-file` |
| done 写一半卡住 | 预检前置；state/log/marker 顺序固定；重跑可恢复 | 人工按 state 现状补 marker |
| coder 偷 commit | gate 记录 HEAD，check/review-input/done 比对 | 立即停下，人工回退 commit |
| light/conditional 死锁 | light 首轮写 `plan.files.json`；conditional 用 `approve-files` 闭环 | `--no-whitelist --accept-light-scope` + 人工确认 |
| 中文/引号参数 | 一律文件传递；`--note` 仅 ASCII | 改用 `--*-file` |
| 路径转义/rename | `-z` + `core.quotepath=false`；新旧路径同时匹配 | 单文件 `--files-file` 重跑 |
| 生成文件误报 | `exempt` 只报告不阻塞 | 手工 `git checkout -- <generated>` |
| 配置迁移漏掉 | 默认 false；README/decisions 说明；`status` 输出 features | 手工在根 config 加 `features` |
| maxTurns 不生效 | 实施前真实委派验证；prompt 加探索上限 | 保留 10，改用 prompt 约束 |
| 与 locate/express 方案冲突 | 见 §5；先定唯一 owner | 停用其中一份的 pipeline.md 改动 |

回退：按 PR 回退（见 §6）；`advance.mjs` 整文件删除即可，feed/agent/pipeline/config 各自独立。

## 5. 与 `pipeline-optimization-plan.md` 的关系

> 已合并：实施以 [pipeline-merged-plan.md](./pipeline-merged-plan.md) 为准；本节对比仅作历史记录。

同目录还有一份 [pipeline-optimization-plan.md](./pipeline-optimization-plan.md)，提出 `locate.mjs` + express 快轨 + `check-files.mjs`。两份方案是不同路线，且重叠面很大：

| 项目 | 本方案 | 另一方案 |
|---|---|---|
| 主目标 | full 轨 token / 往返 | 墙钟 + 简单需求走快轨 |
| `plan.files.json` | 有 | 有（P1-3） |
| `maxTurns 10→20` | 有 | 有（P1-4） |
| Hindsight 默认 false / `py -3` / budget | 有 | 有（P1-4） |
| `POLL_MS 2s` | 有 | 有（P1-4） |
| `locate.mjs` / express / `selectedFiles` | 明确不做 | 核心 |
| `check-files.mjs` | 用 `advance check` 替代 | 新增 |

**不要两份同时改 `pipeline.md`。** 建议：

1. 先把共同项（`plan.files.json` 契约、`features`、`POLL_MS`、`py -3`、agent frontmatter）抽成一个独立改动集，只做一次。
2. 再定主路线：要墙钟优先做 locate/express；要 full 轨 token 优先做本方案。两者可以先后做，但不能并行改同一批文件。
3. 若采纳 express，`advance` 的 phase 枚举要加 `express`，白名单来源要接 `selectedFiles`，并且不要再实现 `check-files.mjs`。

## 6. 实施顺序

1. **PR1（只读 + 低风险）**：lib 错误类型/共享工具、`FEBOT_ROOT`、state 兼容、`status` / `gate` 拆分、`check` / `review-input`、fixture 与单测。
2. **PR2（写路径）**：`set-phase` / `done`、`approve-files`、`planFile` / `HEAD` / marker 预检、light/conditional 策略、`file-lock`/临时文件清理。
3. **PR3（编排与契约）**：`pipeline.md` 3 行纪律与动作序、三份 agent 契约、`features` / `POLL_MS` / `py -3`、frontmatter 核实。

每个 PR 独立可回退；PR1 先只做报告模式（`check`/`review-input` 不阻塞），跑通一个 full + 一个 light 后，PR2 再打开 done 门禁。这样即使脚本有 bug，也不会阻断既有流水线。
