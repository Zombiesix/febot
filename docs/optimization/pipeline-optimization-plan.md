# /pipeline 提速方案：确定性 locate + 快轨（express）

> 归档说明：本文件是历史方案，已被 [pipeline-merged-plan.md](./pipeline-merged-plan.md) 合并。实施以合并方案为准；下文路径已修正，不再单独维护。

## Context

`/pipeline` 的 full 轨道固定走 8 个阶段（init → planning → plan_confirm → coding → code_review → fixing → verify → done），其中 planner / coder / reviewer 各是一次独立 LLM 会话。实测两个 full 需求各耗时约 2 小时（R-161135 16:17→18:0x，R-743150 16:30→18:45），但 6 个已完成需求里有 4 个最终只改了 1–3 个文件。

同时，任务描述的质量已经足够支撑确定性定位。以 `578605085778533231` 为例，`plannedDescription` 直接给出了：

- 路由锚点 `/nursing-record`
- 页面名「护理单」
- 具体行为：「后一天按钮置灰」「时间选择框置灰」
- 新参数 code `RY4.1.14.PBP.79605V`

只读验证结果：`/nursing-record` 精确命中 `src/page/nursing-record/index.vue`；「后一天」逻辑精确落在 `icis-record-sheet.vue:263` 与 `nursing-patient-chart.vue:133`。这个需求根本不需要 planner 全量探索。

**目标**：增加一个确定性的 `locate` 阶段，自动定位「仓库 → 模块 → 组件/文件」，产出带证据的候选改动清单；负责人确认后，简单需求直接进入一次 coder + verify（快轨），复杂需求仍走 full。同时修掉现有流水线中已确认的空转点。

**已定选择**：快轨自动判定 + 人工确认；Hindsight 默认关闭、配置开启；映射表用生成并缓存的仓索引，不手写维护。

---

## 根因（按影响排序）

| # | 根因 | 证据 | 影响 |
|---|---|---|---|
| 1 | 阶段多、LLM 会话来回复用上下文 | full 至少 planner+coder+reviewer 三次会话；R-161135 planner/reviewer 均触 10 轮上限零产出后重试 | **主因**，占大部分墙钟时间 |
| 2 | recon 每次新进程全量扫描，无持久索引 | `recon.mjs:116` 每次 `execFileSync` 起新进程；`code-indexer/src/cache.ts` 仅进程内缓存；实测 9.6–12.3s/次 | 每需求固定 10s+，且 locate 无法复用 |
| 3 | Hindsight 10 次同步调用全部无效 | 剧本传数字 `--budget`，脚本只接受 `low\|mid\|high`；本机 `python` 是 Store 存根；历史 recall 全为空 | 最坏 10×30s 阻塞，实际零产出 |
| 4 | planner/reviewer `maxTurns: 10` 偏小 | R-161135 两者都曾零产出，SendMessage 后才落盘 | 直接翻倍阶段耗时 |
| 5 | 完成标记轮询 30s | `runner.ts:25` `POLL_MS = 30 * 1000`，注释却写 2s | 每次收尾最多多等 30s |
| 6 | 改动文件清单格式不统一、无机器可读版本 | 四个历史 plan.md 有 checkbox / 编号 / 两种表格 | 收尾校验靠人眼，快轨也缺白名单来源 |

---

## 目标流程

```
init (feed)
  ↓
locating  ← 新增，确定性脚本，两条轨道都跑
  ↓
读 locate.json：
  confidence=high 且候选 ≤5
    → 负责人确认候选清单
        → 接受：tier=express → coding(快轨) → verify → done
        → 拒绝：tier=full  → planning → …
  confidence=medium/low 或候选 >5
    → tier=full（不打扰负责人，直接进 planning）
```

- 快轨阶段数：8 → 5；LLM 会话：planner+coder+reviewer → coder 一次；人工门禁：2 → 1。
- full 轨道保留 planner/reviewer/fixing，但 planner 直接吃 `locate.md`，不再从零探索。
- 任何阶段失败仍按现有 fail-safe 停下来问负责人，不硬猜。

---

## 实现

### Step 0 先把本计划落到仓库（批准后第一个动作）

- 本计划归档在 `docs/optimization/pipeline-optimization-plan.md`（仅工作区，不参与流水线）。
- **只写入工作区**：不 `git add`、不 `git commit`、不 `git stash`。文件以未跟踪状态留在工作区，由负责人自行处理。
- 该文件是方案归档，不参与流水线执行，也不进入任何需求的白名单。

### P1-1 新增 `scripts/locate.mjs`

输入：`node scripts/locate.mjs <别名> [--repo <仓名>] [--refresh]`

1. **复用需求解析**：把 `recon.mjs` 里的 `readConfig / reposRoot / section / tasks.md 行解析` 抽到 `scripts/lib/requirement.mjs`，`recon.mjs` 与 `locate.mjs` 共用，避免两套逻辑漂移。
2. **定仓库**：`tasks.md` 第 5 列 → 没有则按 `febot.config.json` 的 `projectMap`（产品精确匹配 + 标题 keywords + 兜底）求值 → 仍失败则退出并让负责人补映射。`--repo` 可覆盖。
3. **仓索引缓存**：
   - 路径 `.febot/index/<仓>.json` + `.febot/index/<仓>.map.md`。
   - 缓存键 = `git rev-parse HEAD` + `git status --porcelain` 的哈希 + indexer 版本。
   - 未命中才跑 `code-indexer scan <repo> --compact`（复用 `recon.mjs:116` 的调用方式）。
   - `.map.md` 是给人看的映射表：路由 `path | label | componentFile`、模块 `name | dir | 组件数`、API 域。
   - 效果：同一 HEAD 下第二次定位 <1s；full 的 recon 也改成读同一份缓存。
4. **抽锚点**（从 context.md 的标题、一句话、全文）：
   - 路由：以 `/` 开头的 token，排除 `http(s)`、`//`、`src/`、带文件扩展名的。
   - 引号词：`"…"`、`“…”`、`「…」`、`'…'`。
   - 编码：`RY4.1.14.PBP.79605V` 这类大写点分 code。
   - 中文 2/3/4-gram，复用 `recon.mjs:231` 的停用词表。
5. **分级匹配**（分数从高到低）：
   - L1 路由精确/前缀命中 → `route.componentFile` + 所属模块。
   - L2 路由 `label` 命中 → 同上。
   - L3 模块 `name/label` 命中 → 模块目录 + `modules[].components` 文件清单。
   - L4 组件文件名命中 ASCII 锚点。
   - L5 内容检索：把锚点写进 `.febot/tmp/<别名>.patterns`，用
     `git -C <repo> grep -n -I -F -f <patterns> -- '*.vue' '*.ts' '*.tsx' '*.js' '*.jsx'`
     取 `文件:行:片段`。**不把中文放到命令行参数里**（本机含中文的 Bash 命令会 exit 127），同时比 Node 遍历全仓快。
   - L6 API 域命中 → 该域文件 + 引用它的模块。
6. **打分与置信度**：路由精确 +100、label +70、模块目录文件 +40、组件名 +25、内容命中每条 +10（上限 30）、code 精确 +50；命中高置信模块内文件再加 +20；`.d.ts` / test / `dict.json` 降权并标注。`high` = 有 L1/L2/L3 命中且候选 ≤5；`medium` = 6–8 个或仅有内容命中；`low` = >8 个或无锚点。
7. **新参数 code 的特殊处理**：精确 code 未命中时，用其稳定前缀（如 `RY4.1.14.PBP`）再搜一次，把「同类参数已有写法」的文件列出来。示例任务的新 code 不存在于代码中，但 `store/common.ts` 里有同类 `configServiceExtendCode` 用法，这正是改动入口。
8. **产物**：
   - `docs/requirements/<别名>/locate.md`：锚点表（命中/未命中）、候选表（文件 | 分数 | 证据 | 建议动作）、每条候选的 `file:line` 片段、推荐轨道与理由、`## 确认清单` 占位。
   - `docs/requirements/<别名>/locate.json`：`requirement / repo / branch / index{head,scannedAt} / confidence / recommendedTier / anchors[] / candidates[] / unmatchedAnchors[]`。
   - stdout 一行摘要：`locate: R-xxx -> locate.md (confidence=high candidates=3 repo=iho-icis-ui cached=1)`。

### P1-2 快轨（express）

1. `pipeline.md` 新增 `locating` 阶段；init 后固定执行 `node scripts/locate.mjs <别名>`。
2. 主对话读 `locate.json`：
   - `recommendedTier=express` → 展示 `locate.md` 的候选表，用 `AskUserQuestion` 确认「按此清单改 / 改走全轨 / 调整文件」。
   - 确认后：`state.json` 写 `tier=express`、`selectedFiles`，`phase=coding`；把确认结果按 Q1 写进 `answers.md`。
   - 拒绝或置信度不足 → `tier=full`、`phase=planning`，不额外提问。
3. 快轨 coder 输入：`locate.md` + `locate.json` + `answers.md`，**不读 plan.md**（快轨不生成 plan.md）。
4. 白名单铁律不变：只改 `selectedFiles` 内文件。需要清单外文件时，写 `locate-gap.md` 并停下，由负责人决定，禁止静默扩大改动面。
5. verify 照旧：lint + test 全绿才算完成；build 仍不作为门禁。
6. 需要审查时负责人可在确认页选择「保留 review」，则给快轨加一次 reviewer，但不回到 planner。

### P1-3 full 轨道吃 locate

- planner 输入新增 `locate.md` / `locate.json`，要求先引用 locate 候选再补 Grep；`recon.md` 仍在，但扫描走缓存。
- planner 除 `plan.md` 外，额外写机器可读的 `plan.files.json`：
  ```json
  { "files": ["src/..."], "conditional": ["src/..."] }
  ```
- reviewer 用 `plan.files.json` 限定 diff 范围，不再解析四种不同格式的清单。
- done 收尾用新增的 `scripts/check-files.mjs <别名>` 校验 `git status --porcelain` 与白名单（快轨读 `selectedFiles`，full 读 `plan.files.json`），替代人眼比对。

### P1-4 现有空转点修复

| 文件 | 改动 |
|---|---|
| `.claude/commands/pipeline.md` | 所有 `python` → `py -3`；`--budget 500/600/800/1000` → `low/mid/high`；整段记忆增强由 `features.hindsight` 控制，默认 false；新增 `locating`、快轨、timings 记录说明 |
| `febot.config.json`、`example/febot.config.json` | 新增 `"features": { "hindsight": false }`；缺失时按 false 处理 |
| `.claude/agents/planner.md` | `maxTurns: 10 → 20`；输入加 locate；要求写 `plan.files.json` |
| `.claude/agents/reviewer.md` | `maxTurns: 10 → 20`；diff 范围改用 `plan.files.json` |
| `.claude/agents/coder.md` | 增加快轨模式：读 locate + `selectedFiles`；越界时写 `locate-gap.md` 停下 |
| `xiaoqian-manager/lib/server/pipeline/runner.ts` | `POLL_MS = 30 * 1000 → 2 * 1000`（与既有注释一致） |
| `docs/requirements/_template/state.json` | 增加 `selectedFiles`、`timings`、`locate` 字段 |
| `.gitignore` | 增加 `/.febot/` |
| `scripts/recon.mjs` | 改用 `scripts/lib/requirement.mjs` 与缓存索引；输出格式保持不变 |
| `.claude/skills/pipeline-feed/SKILL.md` | tier 初值改为「待 locate」；明确仓库定位仍由 feed 完成，模块/文件定位交给 locate |

### P2（可选，验证收益后再做）

- `scripts/pipeline-stats.mjs`：汇总 `state.json.timings`，输出每阶段耗时与快轨命中率。
- `locate --explain`：打印打分明细，便于调阈值。
- `projectMap` 已是 `febot.config.json` 里的机器可读配置，feed 只做机械求值，不再解析 markdown。

---

## 验收方式

1. **样例任务**：用 `578605085778533231` 走一遍 `locate`（先由 feed 接入为 `R-533231`）。
   - 必须定位到 `iho-icis-ui`，`/nursing-record` 命中。
   - 候选前 3 必须包含 `src/page/nursing-record/icis-record-sheet.vue` 与 `src/page/nursing-record/component/nursing-patient-chart.vue`。
   - `RY4.1.14.PBP.79605V` 标为未命中，并能通过前缀匹配给出 `src/store/common.ts` 这类同类参数写法。
2. **历史回归**：对 R-161135、R-873656、R-135539、R-114776、R-oral-10161029 跑 `locate`，与各自实际改动文件（state.json / progress.md / test-report.md）比对。
   - 召回：实际改动文件出现在 top 8 候选中的需求 ≥ 4/5。
   - 快轨判定：只有实际改动 ≤5 个文件的需求才推荐 express。
3. **缓存性能**：首次 ≤ code-indexer 扫描耗时（实测 10s 左右），同一 HEAD 第二次 <1s。
4. **无副作用**：跑完 `git -C gitlab/<仓> status --porcelain` 与跑前一致；`locate` 只写 `docs/requirements/<别名>/` 与 `.febot/`。
5. **端到端**：选一个小需求走完整 express，记录 `state.json.timings`，目标是从 init 到 done ≤25 分钟（coder 实际编辑时间除外）。
6. **回归现有 full**：跑一个 full 需求，确认 recon/plan/review 产物格式未变、收尾校验仍通过。

---

## 风险与边界

- `plannedDescription` 目前 12 条任务里只有 1 条非空。快轨只在锚点可解析时触发，其余一律回落 full，不猜测。
- 中文 n-gram 会命中 `dict.json` 等全局文件，因此路由/模块锚点权重远高于内容词，且最终必须经负责人确认。
- 不手写模块映射表：索引由仓库生成、按 git HEAD 失效；`.map.md` 只是可读快照。
- 快轨省掉的是 planner/reviewer 两次 LLM 会话，**不能省掉 coder 的实际编辑时间**；对 1–3 个文件的小改，预期总时长从约 2 小时降到 15–25 分钟。
- 快轨仍不 add/commit/push，改动以未提交形式留在主仓工作区；开工门禁与收尾校验保持不变。
- 同仓串行、file-lock、敏感文件审批等既有铁律不改。

---

## 关键文件

归档（Step 0）：
- `docs/optimization/pipeline-optimization-plan.md`（仅工作区，不参与流水线）

新增：
- `scripts/lib/requirement.mjs`
- `scripts/lib/repo-index.mjs`
- `scripts/locate.mjs`
- `scripts/check-files.mjs`

修改：
- `.claude/commands/pipeline.md`
- `.claude/agents/{planner,coder,reviewer}.md`
- `.claude/skills/pipeline-feed/SKILL.md`
- `scripts/recon.mjs`
- `docs/requirements/_template/state.json`
- `xiaoqian-manager/lib/server/pipeline/runner.ts`
- `febot.config.json`、`example/febot.config.json`
- `.gitignore`
