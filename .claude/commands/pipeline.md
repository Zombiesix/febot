# pipeline - 前端需求流水线 orchestrator 剧本

> 本文件是主对话的「剧本」，不是调度引擎。主对话每轮用 `node scripts/advance.mjs status <别名>` 读状态，按返回的 `next` 走下一步，再用下方委派模板调用 subagent。
> **禁止手写 `state.json`、手工拼 git 状态、手写完成标记、使用 `feed --set-tier`。** 所有状态写入只走 `scripts/advance.mjs`。

## 启动 / 恢复

- 启动（任务ID）：`/pipeline A-001` —— 计划文件是 xiaoqian-manager 生成的临时 md
- 启动（口头需求）：`/pipeline # <标题>` + 下一行 `产品/模块: <module>` + 描述正文 —— 无任务ID、无现成 md
- 恢复：`/pipeline resume A-001`（任务ID或别名均可）

**参数判别规则**：

1. `resume <别名>` → 恢复流程。
2. 参数能对应已接入的需求（`docs/requirements/<别名>/state.json` 存在）或 xiaoqian-manager 预生成的临时计划文件（`xiaoqian-manager/data/temp/<任务ID>.md` 存在）→ 任务ID流程。
3. 其余一律按口头流程处理，且**必须当场校验格式**：首个非空行匹配 `^#\s+\S`；存在 `^产品/模块[:：]\s*\S` 行；去掉标题行与模块行后剩余正文非空。任一不满足 → 立即报错并列出缺失项，**不创建临时文件、不调用 feed**。不支持由模型提炼标题，也不猜产品/模块。

**主对话动作序**：

1. `state.json` 不存在 → 走「init」接入（feed 已做开工门禁）。
2. 已存在 → `node scripts/advance.mjs status <别名>`，用返回的 `next` 决定阶段；`branchOk:false` / HEAD 异常才停下问负责人（**恢复流程不跑 `gate`**）。停下前写 `wait --name resume_branch --status waiting --message-file <说明>`，负责人处理后补 `--status done`。
3. 需要细节再读 `orchestrator-log.md` 末尾 80 行与 `status.progressTail`。
4. 套用下方阶段模板，**只传路径，只收摘要**。

**输出纪律**：每阶段可见回复只 3 行——`阶段` / `一行摘要` / `下一步`。blocker、问题、人工拍板点完整保留，但不复述 subagent 报告、不粘贴文件全文。resume 所需的「下一步 + 已知信息」写进 `--note-file`。

**人工等待点（`needs_input` 的唯一来源）**

xiaoqian-manager 的注意力路由只认剧本显式声明的人工等待，禁止靠输出空闲/关键词猜测。凡是要停下来等人拍板的地方，**先写 waiting、人处理完再写 done**：

```bash
node scripts/advance.mjs wait <别名> --name <ASCII标识> --status waiting [--message-file <说明.md>]
node scripts/advance.mjs wait <别名> --name <ASCII标识> --status done [--by <ASCII>]
```

- 事件由 advance 统一代写（runner 经 `XQ_EVENTS_FILE` 注入落点，缺省回退 `xiaoqian-manager/data/runs/<taskId>.events.jsonl`）。
- 命令行只放 ASCII；中文说明写文件走 `--message-file`，`--by` 用 ASCII 标识。
- 已有 `waiting` 未 `done` 时不要重复写 waiting；恢复流程若发现仍是 waiting，直接补 `done` 后继续。
- 固定标识：`plan_confirm`、`locate_failed`、`express_confirm`、`conditional`、`resume_branch`、`round_limit`、`fail_safe`。

## 各阶段动作

| 阶段 | 主对话动作 | 关键命令 |
|---|---|---|
| `init` | 调 feed；按退出码分流；进入 locating | `node scripts/feed.mjs --plan <文件> --json`；`advance set-phase <别名> --phase locating --agent orchestrator` |
| `locating` | 跑 locate；读 `locate.json`；按 confidence 分流 | `node scripts/locate.mjs <别名> --json`；`advance set-tier --tier express\|full` |
| `planning` | 跑 recon；委派 planner；进 plan_confirm | `node scripts/recon.mjs <别名>`；`advance set-phase --phase plan_confirm --agent planner` |
| `plan_confirm` | 展示问题；收答案；处理 conditional；进 coding | `advance approve-files --q Q1`（`--reject`）；`advance set-phase --phase coding` |
| `coding` | 委派 coder；跑 check；full→review，express→verify | `advance check`；`advance set-phase --phase code_review\|verify --agent coder` |
| `code_review` | 生 review-input；委派 reviewer；按 blocker 分流 | `advance review-input`；`advance set-phase --phase fixing\|verify --agent reviewer` |
| `fixing` | 委派 coder 只修 blocker；跑 check；进 verify | `advance check`；`advance set-phase --phase verify --agent coder` |
| `verify` | 委派 coder 跑 lint/test；全绿 done，否则回退 | `advance set-phase --phase coding\|fixing --agent coder`；`advance done <别名>` |
| `done` | 写 worklog；可选 Hindsight reflect | `advance done <别名>` |

`advance status.next` 取值固定：`init→locating`；`locating→locate|human|set-tier full`；`planning→planner`；`plan_confirm→human`；`coding→coder`；`code_review→reviewer`；`fixing→coder`；`verify→coder`；`done→none`。不自己推。

### init → feed 接入

确定性操作全部由 `scripts/feed.mjs` 完成；主对话只准备计划文件、按退出码分流。

**入口一：任务ID流程**

计划文件是 `xiaoqian-manager/data/temp/<任务ID>.md`（xiaoqian-manager「写代码」▶ 预生成；人工启动且文件不存在时，主对话从 `data/tasks.json` 找到对应任务，按同格式补写）：

```markdown
# <任务标题>

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

<plannedDescription 原文>

## 分配任务说明

<assignDescription 原文>
```

`## 问题描述` **只取 `plannedDescription`**：为空就报错停止（提示先在「计划」节点填写并保存），**不回退 `description`、不写 `（空）`**，也不生成临时文件。

**入口二：口头流程**

```text
/pipeline # <标题>
产品/模块: <module>
<需求描述（可多行）>
```

校验通过后落盘 `xiaoqian-manager/data/temp/R-oral-<MMDDHHmm>.md`：

```markdown
# <标题（原样，不提炼）>

产品/模块: <module>

## 问题描述

<描述全文>

## 分配任务说明
```

别名 = 文件名（`R-oral-<同一时间戳>`），由 feed 从文件名取。

**调用 feed**

```bash
node scripts/feed.mjs --plan <计划文件> --json
```

脚本负责：解析/校验 → 定仓 → 基准分支 → 开工门禁（分支 == 基准分支 且工作区干净）→ 拷模板 → 写 `context.md` → upsert `tasks.md` → **最后**写 `state.json`（`tier=full`、`phase=init`、`planFile`、`gate.head`）。

| code | 含义 | 动作 |
| ---- | ---- | ---- |
| 0 | 成功 / 已接入（`already:true`） | 记下 `elapsedMs`；`already:true` 时改跑 `advance status`，不要重复写状态 |
| 1 | 未预期异常 | 贴 stderr，停止 |
| 2 | 映射未命中 | 把 `details.knownProducts` 给负责人；确认后回填 `projectMap`，不许猜 |
| 3 | 门禁失败 | 贴实际分支/脏文件，让负责人先提交；禁止 stash/checkout/commit |
| 5 | 输入或格式不符 | 贴 `details.missing`，让来源方补；不自行补标题/模块/描述 |
| 6 | 配置/环境错误 | 贴 stderr，停止 |

成功后 `advance timing <别名> --name feed --machine-ms <feed.elapsedMs>`，再进 locating。**tier 不由 feed 判定**，也不在这里判定。

### locating → locate + 人工确认（express 分岔）

```bash
node scripts/locate.mjs <别名> --json
```

产物：`locate.md` / `locate.json` / `selected-files.json`。失败 → **停下来问负责人**（重跑，或由负责人决定 `advance set-tier --tier full --reason-file <说明>`），不得猜成 express。停下来前后各写一次 `wait --name locate_failed`（`--status waiting` → 处理后 `--status done`）。
跑完后 `advance timing <别名> --name locate --machine-ms <locate.elapsedMs>`。

分流：

- `confidence=high` 且 `recommendedTier=express` → 展示 `locate.md` 候选表，用 `AskUserQuestion` 给三个选项（提问前 `wait --name express_confirm --status waiting`，选定后补 `--status done`）：
  1. **按此清单改（express）** → `advance set-tier --tier express`；
  2. **调整文件后 express** → 负责人编辑 `docs/requirements/<别名>/selected-files.json`，再执行同一命令；
  3. **走全轨（full）** → `advance set-tier --tier full --reason-file <确认说明>`。
- `confidence=medium/low` → 直接 `advance set-tier --tier full --reason-file <locate 理由>`，不打扰负责人。
- 需要第 6 个文件（express 上限 5）→ 写 `locate-gap.md` 停下来，由负责人决定，**禁止静默扩大改动面**。

确认结果写 `decisions.md`，不伪造 `Q1`；`answers.md` 只放 planner 的问题。express **不跑 reviewer**，需要审查就在确认页选 full。

> 中文参数不得进命令行（本机含中文的 Bash 命令会 exit 127）：`--reason` 只允许 ASCII，中文一律写文件走 `--reason-file` / `--note-file`。

### planning → recon + @planner（仅 full）

```bash
node scripts/recon.mjs <别名>
```

产出 `recon.md`（确定性事实底稿）。失败或标「不支持 / 接口层未解析」不阻塞——照常委派，由 planner 自行 Grep 补位。`advance timing <别名> --name recon --machine-ms <recon.meta.json.elapsedMs>`。

```
请作为 planner 处理需求 <别名>。
- 读 context: docs/requirements/<别名>/context.md（含「历史参考」，可能为空）
- 读 locate: docs/requirements/<别名>/locate.md 与 locate.json（确定性定位候选；用于收敛改动面，不是结论）
- 读事实底稿: docs/requirements/<别名>/recon.md（为空/标「不支持」时自行 Grep，别当结论）
- 可选读记忆: docs/requirements/<别名>/recall-expertise.md（缺失/为空即无记忆）
  命中人工设计偏好时，plan.md 的取舍须显式对齐或说明偏离；与仓库现状冲突 → 升级为 M 类问题，不猜不覆盖
- 有不确定的问题按编号写入 questions.md 并暂停等答案；conditional 文件必须带对应 Q 号
- 计划写入 plan.md（「将改动文件清单」只供人读）
- 必须写 plan.files.json：{"files":[],"deleted":[],"conditional":[{"path":"","reason":"","question":"Q1"}],"exempt":[]}
- 最后一条消息恰好一行 JSON，无代码围栏：
  {"agent":"planner","requirement":"<别名>","ok":true,"plan":"...","files":"...","questionCount":0,"fileCount":0}
```

planner 返回后 `advance set-phase <别名> --phase plan_confirm --agent planner --note-file <note>`。注意：JSON 最后一行解析失败时，把原文写 `orchestrator-log.md`，按产物文件是否存续继续，不因契约失败卡死。

### plan_confirm → 主对话 + 负责人

进入本阶段先写等待点，负责人处理完再落 `done`：

```bash
node scripts/advance.mjs wait <别名> --name plan_confirm --status waiting --message-file <计划评审说明.md>
# …读 questions.md 展示 → 负责人答 answers.md（按编号）→ 确认拍板写 decisions.md…
node scripts/advance.mjs wait <别名> --name plan_confirm --status done --by <ASCII>
```

读 `questions.md` 展示 → 负责人答 `answers.md`（按编号）→ 确认拍板写 `decisions.md`（时间/决策/拍板人/原因）。

逐个处理 `plan.files.json.conditional`：

- 同意 → `advance approve-files <别名> --q Q1`（移入 `files`）；
- 不同意 → `advance approve-files <别名> --q Q1 --reject`（移除并记录）；
- 暂不决定且允许 coder 不碰 → 最后加 `--allow-conditional`。

需要负责人逐个拍板时，先 `wait --name conditional --status waiting`，全部处理完补 `--status done`。

然后 `advance set-phase <别名> --phase coding --agent orchestrator`。还有未处理 conditional 且没加 `--allow-conditional` → exit 5；`plan.files.json` 缺失 → 永远 exit 5（`--allow-conditional` 不放宽文件缺失）。

拍板入库（仅 `features.hindsight=true` 时，见下方软降级说明）：只 retain **有理由的拍板**，纯确认类不入库。

### coding → @coder

full 模式输入：

```
请作为 coder 实现需求 <别名>（mode=full）。
- 读 plan.md（只读摘要与文件指针，不重扫全需求）、plan.files.json（唯一白名单）、answers.md
- 严格只改 plan.files.json 中 files 列出的文件；deleted 只删列出的文件
- 需要清单外文件 → 写 locate-gap.md（或带编号的 questions.md）并停止，不擅自扩大改动面
- 每完成子任务更新 progress.md
- 跑 lint/test 写 test-report.md（不跑 build，除非负责人点名或改动涉及构建配置）
- 最后一条消息恰好一行 JSON：
  {"agent":"coder","requirement":"<别名>","ok":true,"round":"coding","mode":"full","changedFiles":[],"tests":{"lint":"pass","test":"na","build":"skipped"},"note":""}
```

express 模式输入（**不读 plan.md**）：

```
请作为 coder 实现需求 <别名>（mode=express）。
- 读 locate.md、locate.json（候选与证据）、plan.files.json（白名单）
- 严格只改 plan.files.json 中 files 列出的文件；需要第 6 个文件 → 写 locate-gap.md 并停止
- 每完成子任务更新 progress.md；跑 lint/test 写 test-report.md
- 最后一条消息恰好一行 JSON（同上，mode=express）
```

coder 返回后跑 `advance check <别名> --mode review`：

- `foreign` 非空 → 停下问负责人，不擅自清理；
- 然后 full → `advance set-phase --phase code_review --agent coder`；express → `advance set-phase --phase verify --agent coder`。

### code_review → @reviewer（仅 full）

```bash
node scripts/advance.mjs review-input <别名>
```

生成 `review-input.txt`（diff --stat、`git diff HEAD -- <白名单>`、新增文本文件全文、白名单外文件列表）。超限按整文件省略并标 `omitted`。

```
请作为 reviewer 审查 <别名>。
- 只读 docs/requirements/<别名>/review-input.txt、plan.md、plan.files.json、test-report.md
- 对照 test-report.md 核验 lint/test 是否真实跑通；build 默认不在门禁内
- 按 rubric 标 blocker / suggestion / nit；越界改动计 scopeViolations
- 可选读记忆: docs/requirements/<别名>/recall-expertise.md（缺失/为空即无）
- 输出 review.md；最后一条消息恰好一行 JSON：
  {"agent":"reviewer","requirement":"<别名>","ok":true,"review":"...","blockers":0,"suggestions":0,"nits":0,"scopeViolations":0}
```

分流：有 blocker → `advance set-phase --phase fixing --inc-iteration --agent reviewer`；无 blocker → `advance set-phase --phase verify --agent reviewer`。reviewer 没有 Bash，不要要求它跑命令。

### fixing → @coder（仅 full，有 blocker 时）

```
请作为 coder 修复 <别名> 的 blocker。
- 只读 review.md、review-fix.md，只改 blocker，不读 plan.md
- 只改 plan.files.json 内的文件；需要清单外文件 → 写 questions.md 并停止
- 复测并更新 test-report.md；最后一条消息恰好一行 JSON（round=fixing）
```

修复后 `advance check <别名> --mode review`，再 `advance set-phase --phase verify --agent coder`。

blocker 清空后，把**本轮 blocker 根因**回流入库（仅 `features.hindsight=true`，软降级）。

### verify → @coder

```
请作为 coder 复验 <别名>。
- 跑 lint/test，更新 test-report.md
- 最后一条消息恰好一行 JSON（round=verify）
```

**「全绿」= lint + test 全过**（build 不计入复验门禁）。不全绿：

- express → `advance set-phase --phase coding --agent coder`（脚本自动计轮，最多 2 轮；到上限 exit 5 → 写 `wait --name round_limit --status waiting` 后停下问负责人，处理好补 `--status done`）；
- full → `advance set-phase --phase fixing --inc-iteration --agent coder`（有 review 修复）或 `--phase coding`。

全绿 → `advance done <别名>`。build 仅按需补跑，跑完把 `auto-imports.d.ts` / `components.d.ts` 这类自动生成文件的改动还原，别污染收尾校验。

### done → advance done（一次收尾）

先写 `worklog.md`（本阶段复盘正文），然后：

```bash
node scripts/advance.mjs done <别名> [--task-id <id>] [--plan-file <md>]
```

脚本按固定顺序完成：marker 归属预检 → `check --mode done`（HEAD/分支/staged/foreign）→ state 置 done → 清 `file-lock.md` 中本需求那一行（按列匹配）→ 删计划临时文件（`plan.md` / `plan.files.json` 永不删）→ **最后**原子写 `<taskId>.done.json`。预检失败不写 state/marker、不删文件；重跑幂等返回 `already:true`。

- **没写 marker = 失败**（任务ID流程）：任何 fail-safe 停止、问题待答、中途放弃都**不要**写这个文件。
- 负责人在**主仓固定分支工作区**上自行验收（dev server 直接跑，依赖与 `.env` 现成）。

## Hindsight 记忆增强（可选，全链路软降级）

**仅当配置 `features.hindsight=true` 时执行**；以下调用都是**尽力而为**——未起 / 无网络 / 接口异常 → 产出空结果、跳过该步，**绝不阻塞流水线、绝不编造**。

- Python 用 `py -3`（本机 `python` 是 Store 存根）。
- `--budget` 取 `low|mid|high`：原 500/600 → `low`，800 → `mid`，1000 → `high`。
- 输出为 JSON，非空才当命中；为空则删除该文件、不写进任何文档。

```bash
py -3 scripts/hindsight-memo.py recall --bank febot-project --query "<需求标题+产品/模块>" --budget low --out docs/requirements/<别名>/recall-history.md
py -3 scripts/hindsight-memo.py recall --bank <产品线bank> --query "<需求标题>" --budget mid --out docs/requirements/<别名>/recall-history-line.md
py -3 scripts/hindsight-memo.py recall --bank li-expertise --query "<本需求涉及的技术点>" --budget low --out docs/requirements/<别名>/recall-expertise.md
```

命中摘要填进 `context.md` 已有的 `## 历史参考（Hindsight）` 小节（注明来源需求ID）；该小节不存在才在末尾追加。为空则删除文件。

`done` 阶段复盘（人工门禁）：`py -3 scripts/hindsight-memo.py reflect ...`，把摘要贴出来**给负责人过目**；人工点头后才 retain 回库。**reflect 不自动入库**。

## 轨道约束

- fail-safe：任何阶段拿不到预期产物 → 写 orchestrator-log、写 `wait --name fail_safe --status waiting --message-file <说明>`，停下来问负责人，不硬猜继续；恢复后补 `--status done`。
- orchestrator 每次收到 subagent 摘要后，把「下一步 + 已知信息」写 `orchestrator-log.md` 再丢弃对话。
- **全局约束（对流水线主对话与所有 subagent 生效）**：
  1. **禁止更改 node / npm / yarn 版本**——不执行任何 `nvm use`、`node -v` 引发的变更、`npm`/`yarn`/`pnpm` 全局切换或 `engines`/`.nvmrc`/package.json 里的版本改动。版本锁定为现状。
  2. **涉及 `node_modules` 文件夹数据修改时，必须先严格提示**：在改动前明确打出一句「**因为 <原因> 需要进行 node_modules 修改**」（如依赖安装、重新构建、安装新包），并征得同意后才执行。不得静默 install / 改依赖 / 动 link、不得在收尾工作中顺手清改 node_modules。

> **收尾边界（铁律）**：AgentTeam **直接在主仓基准分支工作区里改代码**，改动以**未提交**形式留在工作区，**不进行 add / commit / push 任何代码**。基准分支按 `projectMap[].branch` > `branches.byRepo[repo]` > `branches.default` 解析。隔离靠两条：① 开工门禁（feed 校验分支 + 干净）；② 改动白名单（`plan.files.json` + `advance check`）。因此**同一仓库同一时间只能跑一个需求**（file-lock 的并行只在不同仓之间成立）。
