# pipeline-feed 重构方案（可执行）

> 状态：已按 2026-10-23 评审修订，待实施 ｜ 日期：2026-10-23
> 目标：把 pipeline-feed 里**确定性的文件操作**收进脚本，skill 只保留 **tier 的 LLM 判断**；同时去掉两个生成式步骤，统一任务ID流程与口头流程。
>
> 本版修订要点：回填三项拍板（口头标题、严格 plannedDescription、AI 护理工作站映射），并修复口头输入缺模块、退出码冲突、写入顺序、tier 不落盘、全局分支门禁误拦、严格校验未落地等问题。

---

## 1. 决策记录

| # | 决策 | 结论 |
| - | ---- | ---- |
| D1 | 「一句话需求描述」 | **删除**。`_template/context.md` 不再有此小节，feed 不再生成 |
| D2 | 口头需求标题 | **不支持模型提炼**。用户必须显式给出 `# <标题>` 与 `产品/模块: <module>`；缺失或格式不符 → **报错返回**，不落盘、不猜、不自动补 |
| D3 | tier 建议 | **保留 LLM 判断**（当前做法不变） |
| D4 | PM 描述去噪/整理 | **不做**。`需求描述（全文）` 原样取计划文件的 `## 问题描述` + `## 分配任务说明` |
| D5 | 「描述是否够 planner 用 / 缺什么」 | **从 feed 移除**。由 planner 的 `questions.md` Q1/Q2 承担（理由见 §7） |
| D6 | 可执行代码放哪 | 放 `scripts/feed.mjs`，**不内联进 SKILL.md**（理由见 §8） |
| D7 | 是否引入专门的决策模型框架 | 本期**不引入**。只剩 tier 一个判断，LLM 足够；将来量大再评估 |
| D8 | `iHO-AI护理工作站` 映射 | **并入 `iHO-护理系统`** → `iho-nurse-manager-ui`。`projectMap` 显式加一条，不做隐式名称归一化 |
| D9 | `plannedDescription` | **严格必填**。为空 → 源头报错，不回退 `description`，不写 `（空）` 占位 |
| D10 | 基准分支 | **支持 per-repo 覆盖**：`projectMap[].branch` > `branches.byRepo[repo]` > `branches.default`。确定性门禁不能用全局默认值硬拦 |
| D11 | 「已接入」的返回 | **exit 0 + `"already": true`**，不再使用 exit 4。否则与「非 0 即停」的 orchestrator 规则冲突 |
| D12 | 幂等与落盘顺序 | `tasks.md` 按别名 **upsert**；`state.json` **最后写**；存在半成品目录时拒绝静默覆盖 |
| D13 | tier 落盘 | 新增 `--set-tier` 子命令，由脚本确定性写 `state.json` / `tasks.md` / `decisions.md`；skill 只输出判定 |

---

## 2. 职责边界

| 动作 | 实现方 | 确定性 |
| ---- | ------ | ------ |
| 解析计划文件（标题/元信息/正文/附件） | `scripts/feed.mjs` | ✅ |
| 别名推导与校验 | `scripts/feed.mjs` | ✅ |
| 产品 → 仓库（`projectMap`） | `scripts/feed.mjs` | ✅ |
| 仓库 → 基准分支（per-repo） | `scripts/feed.mjs` | ✅ |
| 开工门禁（分支 + 工作区） | `scripts/feed.mjs` | ✅ |
| 拷 `_template/`、替换占位 | `scripts/feed.mjs` | ✅ |
| `tasks.md` 登记（upsert） | `scripts/feed.mjs` | ✅ |
| `state.json` 初始化（`file-lock.md` 不动） | `scripts/feed.mjs` | ✅ |
| 幂等判断（已接入则跳过） | `scripts/feed.mjs` | ✅ |
| 错误契约（退出码 + JSON） | `scripts/feed.mjs` | ✅ |
| **tier 建议** | LLM（skill） | ❌ 语义判断 |
| **tier 落盘** | `scripts/feed.mjs --set-tier` | ✅ |
| 描述全文搬运 | `scripts/feed.mjs` | ✅ 不加工 |
| 映射未命中/歧义 | 脚本退出 + 人拍板 | 策略门禁，不猜 |

---

## 3. 统一输入契约

### 3.1 计划文件格式

```markdown
# <需求标题>

任务ID: <id>
查询ID: <demandId>
别名: R-<id后6位>
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

- **任务ID流程**：由 `xiaoqian-manager/lib/server/pipeline/runner.ts:66-85` 生成，格式固定。
  - `runner.ts` **必须**补输出 `任务类型: ${task.taskType}`（当前缺失，导致 `tierHint.taskType` 永远为空）。
  - `## 问题描述` **只取** `task.plannedDescription`；为空直接抛错（D9），不再回退 `task.description`，也不再写 `（空）`。
  - 校验放在置 `coder=active` **之前**，避免先置状态再回滚。
- **口头流程**（D2）：orchestrator 先校验用户输入，通过后才落盘 `xiaoqian-manager/data/temp/R-oral-<MMDDHHmm>.md`。

  用户输入格式（首行标题 + 一行模块 + 描述正文）：

  ```text
  /pipeline # <标题>
  产品/模块: <module>
  <需求描述（可多行）>
  ```

  落盘前必须同时满足：

  1. 首个非空行匹配 `^#\s+\S`；
  2. 存在 `^产品/模块[:：]\s*\S` 行；
  3. 去掉标题行与模块行后，剩余文本非空。

  任一条不满足 → 立即报错并列出缺失项，**不创建临时文件、不调用 feed**。脚本侧再校验一次 → exit 5。

  落盘内容：

  ```markdown
  # <标题>

  产品/模块: <module>

  ## 问题描述

  <描述全文>

  ## 分配任务说明

  ```

- **标题解析**：首个非空行匹配 `^# (.+)$`；缺失 → exit 5，**不猜、不生成**。
- **描述校验**：`## 问题描述` 去空白后必须非空，且不能等于 `（空）`；否则 exit 5（D9）。
- **元信息作用域**：只解析标题之后、第一个 `## ` 之前的行；只认白名单键（见 §4.1），正文里的冒号不会污染元信息。

### 3.2 命令行

```bash
node scripts/feed.mjs --plan <计划文件> [--alias R-xxxxxx] [--module <产品/模块>] [--json] [--dry-run]
node scripts/feed.mjs --set-tier <别名> --tier light|full --reason "<一句话理由>" [--json]
```

| 退出码 | 含义 | orchestrator 动作 |
| ------ | ---- | ----------------- |
| 0 | 接入成功，或已接入（`already:true`） | 读 stdout/JSON；已接入直接读 state，不再判 tier |
| 1 | 未预期内部异常 | 停，贴堆栈 |
| 2 | `projectMap` 未命中 | 停，把候选/缺失模块列给负责人，回填配置后重跑 |
| 3 | 分支不对 / 工作区脏 | 停，原样贴出 `git status --porcelain` 与期望分支 |
| 5 | 输入/格式不合契约 | 停，报告缺哪个字段或哪条格式不符 |
| 6 | 配置/环境错误 | 停，报告具体键或路径 |

> **破坏性变更**：原方案的 exit 4（已接入）取消，统一为 exit 0 + `already:true`；orchestrator 的「非 0 即停」规则不再有例外。

`--dry-run`：完成解析、定仓、分支解析、开工门禁，输出将执行的动作清单，**不写任何文件**。

### 3.3 stdout

成功（`--json`）：

```json
{
  "ok": true,
  "alias": "R-371467",
  "already": false,
  "title": "医生站输血医嘱界面血液分类和排序",
  "module": "iHO-输血管理系统",
  "repo": "reuseapp-blood-bank-web",
  "repoDir": "gitlab/reuseapp-blood-bank-web",
  "branch": "dev-zjb",
  "branchSource": "branches.default",
  "gate": {
    "head": "dev-zjb",
    "expected": "dev-zjb",
    "clean": true,
    "checkedAt": "2026-10-23T15:00:00+08:00"
  },
  "requirementDir": "docs/requirements/R-371467",
  "statePath": "docs/requirements/R-371467/state.json",
  "description": "……",
  "assignment": "……",
  "tierHint": { "taskType": "开发任务", "level": "中", "maxHour": 8 },
  "files": ["context.md", "state.json", "decisions.md", "..."],
  "dryRun": false,
  "actions": []
}
```

- `description` / `assignment` **必须输出**：skill 判 tier 直接用它，不用再读文件。
- `already:true` 时同样输出 `alias`、`requirementDir`、`statePath`，否则「直接读 state」不知道读哪个。
- `tierHint` 只是原始信号，**脚本不判 tier**；口头流程缺 `taskType/level/maxHour` 时为 `null`。

失败（`--json` 时 stdout 输出 JSON，stderr 同时给一行人类可读信息）：

```json
{
  "ok": false,
  "code": 5,
  "error": "缺少字段：产品/模块",
  "details": { "missing": ["产品/模块"] }
}
```

---

## 4. `scripts/feed.mjs` 实现规格

### 4.1 解析

```text
parsePlan(md):
  title        = 首个非空行 /^# (.+)$/，否则 exit 5
  header       = 标题行之后、首个 /^## / 之前的行
  meta         = header 中 /^([^:：]+)[:：]\s*(.*)$/，键值均 trim
                 仅保留白名单键：任务ID/查询ID/别名/产品/模块/版本/状态/
                 难度/任务类型/最大工时/执行人/创建人；其余忽略
  description  = section("## 问题描述")
  assignment   = section("## 分配任务说明")
  if !description.trim() || description.trim() === "（空）" -> exit 5
  module       = --module > meta.产品/模块；缺失 -> exit 5
  taskType     = meta.任务类型 || null
  maxHour      = meta.最大工时 非空且 Number.isFinite -> 数字，否则 null
  attachments  = description/assignment 中 /https?:\/\/\S+/ 去重，
                 去掉尾部 ),，。;；、
  alias        =
    显式 --alias > meta.别名 > 口头文件名（R-oral-*）> R-<任务ID后6位>
  alias 必须匹配 /^R-[A-Za-z0-9-]+$/，否则 exit 5
  --alias 与 meta.别名 同时存在且不一致 -> stderr 警告，按 --alias
```

- `section()` 与 `scripts/recon.mjs:79-86` 同语义，**必须**抽到 `scripts/lib/febot.mjs` 复用，不再各写一份。
- `readConfig()` / `reposRoot()` 同样抽到该库：`ROOT` 用 `import.meta.url` 定位，支持 `FEBOT_CONFIG` 环境变量，`repoRoot` 相对配置文件目录解析（与 `recon.mjs` 完全一致）。
- 别名会拼进路径，必须校验；禁止 `../`、绝对路径、Windows 非法字符。

### 4.2 仓库与分支解析（纯函数）

```text
resolveRepo(config, module, title):
  candidates = config.projectMap.filter(e => e.product === module)
  if candidates.length === 0        -> exit 2
  keywordHits = candidates.filter(e => e.keywords?.some(
                  k => title.toLowerCase().includes(k.toLowerCase())))
  if keywordHits.length > 0        -> keywordHits[0]        // 数组顺序即优先级
  fallbacks = candidates.filter(e => !e.keywords?.length)
  if fallbacks.length === 1        -> fallbacks[0]
  if fallbacks.length === 0        -> exit 2
  else                             -> exit 6（同一产品多条兜底 = 配置歧义）
  repo 必须 ∈ config.repos          -> 否则 exit 6
  <repoRoot>/<repo> 必须存在        -> 否则 exit 6

resolveBranch(config, entry, repo):
  entry.branch
    || config.branches.byRepo?.[repo]
    || config.branches.default
  缺失/为空 -> exit 6
```

- `projectMap` 必须新增：`{ "product": "iHO-AI护理工作站", "repo": "iho-nurse-manager-ui" }`（D8）。
- 分支覆盖示例：

  ```json
  "branches": {
    "candidates": ["dev", "dev-zjb", "dev-iho-feat"],
    "default": "dev-zjb",
    "byRepo": { "iho-medical-record-ui": "dev" }
  }
  ```

  这是必须项：`iho-medical-record-ui` 的基准是 `dev`，用全局 `dev-zjb` 会稳定误拦（`file-lock.md:29-30` 已有记录）。

### 4.3 开工门禁

```bash
git -C <repoRoot>/<repo> rev-parse --abbrev-ref HEAD   # 必须 == resolveBranch 结果
git -C <repoRoot>/<repo> status --porcelain            # 必须为空
```

失败 → exit 3，stdout 给出原始输出与期望分支；**不 stash / 不 checkout / 不 commit**。

### 4.4 脚手架（幂等）

**固定顺序**（不要调整，顺序本身是幂等性的一部分）：

1. 读取计划文件并解析标题/元信息/别名（§4.1 的前半段）；文件不可读、标题缺失、别名非法 → exit 5。此时未写任何文件。
2. `docs/requirements/<alias>/state.json` 已存在 → 先比对 `state.json.taskId` 与当前 `meta.任务ID`：两者都非空且不同 → **exit 6（别名冲突）**；否则 **exit 0 + `already:true`**，不写任何文件。**幂等判断必须先于门禁**：需求接入后仓库本来就会有未提交改动，重跑不能被 exit 3 拦住。
3. 目录已存在且非空、但没有 `state.json` → **exit 5**，提示「上次接入未完成，请人工删除该目录或补齐 state.json 后重跑」，不静默覆盖。
4. 继续校验输入（模块、描述非空、`（空）` 检查，§4.1 后半段）——失败 exit 5。
5. 解析仓库与分支（§4.2）——失败 exit 2/6，此时未写任何文件。
6. 开工门禁（§4.3）——失败 exit 3，此时未写任何文件。
7. 递归复制 `docs/requirements/_template/` → `docs/requirements/<alias>/`；模板缺失 → exit 6。
8. 对所有文本文件（`.md` / `.json` / `.txt`）替换 `{REQUIREMENT_ID}` → `<alias>`。
9. 重写 `context.md`（骨架见下）。
10. `tasks.md` 按别名 **upsert**（存在则替换该行，不存在则追加）；`tasks.md` 缺失 → exit 6。
11. **最后**写 `state.json`。
12. `file-lock.md` 不预登记，保持原样；由 planner 出 plan 后回填。

`context.md` 骨架：

```markdown
# <alias> - 需求上下文

## 需求标题

<标题原文>

## 需求来源

- PM 文件：<--plan 的路径>（口头流程为临时计划文件，done 时删除）
- tasks.md 条目：<alias>
- 目标仓库：<repo>
- 基准分支：<branch>

## 需求描述（全文）

<## 问题描述 原文>

<## 分配任务说明 原文>

## 附件

（有链接时逐行写 `- <url>`；无附件写「（无）」）

## 关联代码位置

（空）

## 历史参考（Hindsight）

（空）
```

`state.json`（在模板副本上改字段，不重建，保留 `iteration/maxIteration/blockers/questions/lastAgent`）：

```json
{
  "requirement": "<alias>",
  "tier": "full",
  "phase": "init",
  "iteration": 0,
  "maxIteration": 2,
  "blockers": [],
  "questions": [],
  "lastAgent": null,
  "taskId": "<任务ID，口头流程为 null>",
  "demandId": "<查询ID，口头流程为 null>",
  "repo": "<repo>",
  "baseBranch": "<branch>",
  "gate": { "checkedAt": "<ISO8601>", "branchOk": true, "cleanOk": true },
  "updatedAt": "<ISO8601>"
}
```

`tasks.md` 追加/更新行（列序与现有表头一致）：

```markdown
| <alias> | <module> | 待定 | 待定 | <repo> | 待开始 | /pipeline <alias> |
```

> 写入顺序的理由：若先写 `state.json`、后写 `tasks.md`，中途失败会让后续重跑直接 `already:true`，而 `recon.mjs` 永远找不到 tasks 行。upsert + state 最后写可消除这个不可恢复状态。

### 4.5 `--set-tier` 子命令

```bash
node scripts/feed.mjs --set-tier <alias> --tier light|full --reason "<一句话理由>" [--json]
```

1. `docs/requirements/<alias>/state.json` 不存在 → exit 5。
2. `--tier` 必须是 `light|full`；`--reason` 去空白后非空，否则 exit 5。
3. 更新 `state.json`：`tier`、`phase`（full → `planning`，light → `coding`）、`lastAgent="orchestrator"`、`updatedAt`。
4. `tasks.md` 该别名行的 tier 列更新为同值（不存在则 exit 6，提示重跑 feed）。
5. `decisions.md` upsert 一行（表格列序：时间 / 决策 / 谁拍板 / 原因）：

   ```markdown
   | <YYYY-MM-DD HH:mm:ss> | tier=light | pipeline-feed | <reason> |
   ```

   已有 `决策` 列以 `tier=` 开头的行则替换，避免重复。
6. 落盘顺序：`decisions.md` → `tasks.md` → `state.json`（state 最后）。
7. 幂等：重复执行同一 tier 不产生重复行。
8. `--json` 输出：`{"ok":true,"alias":"...","tier":"light","phase":"coding","tasksUpdated":true,"decisionsUpdated":true}`。

### 4.6 错误码归属速查

| 场景 | 退出码 |
| ---- | ------ |
| 计划文件不存在/不可读、缺 `--plan` | 5 |
| 无 `# 标题`、缺 `产品/模块`、描述为空/`（空）`、别名非法 | 5 |
| 半成品目录（非空且无 `state.json`） | 5 |
| `projectMap` 无匹配 | 2 |
| 同一产品兜底 0 条 | 2 |
| 同一产品兜底多条、`repo` 不在 `repos`、仓库目录不存在 | 6 |
| 配置 JSON 非法、`repoRoot` 无效、模板/`tasks.md` 缺失、分支无法解析 | 6 |
| 别名对应目录已被不同 `任务ID` 占用 | 6 |
| 分支不符、工作区脏 | 3 |

### 4.7 其它实现注意

- **别名碰撞**：`R-<任务ID后6位>` 理论上可能重复。`state.json` 记录 `taskId`，重跑时比对；不同任务撞同一别名 → exit 6，不静默复用。
- **git 命令超时**：两条门禁命令各设 10s 超时；超时/非零退出按 exit 3 处理，并原样带出 stderr。
- **URL 中的凭据**：附件按原文搬运，可能含 `access_token`。`docs/requirements/` 已被 gitignore，但不得把附件 URL 发送到任何外部服务。
- **同仓串行**：feed 不额外加锁；靠「工作区干净」门禁 + tasks.md upsert 保证。同一仓并发跑两个需求仍由门禁拦住，属于预期行为。
- **编码**：计划文件与输出统一用 UTF-8 读写；`--json` 不输出 BOM。

---

## 5. `context.md` 模板变更（D1）与 `recon.mjs`

`docs/requirements/_template/context.md`：

- 删除「需求描述（一句话）」小节。
- 新增「附件」小节（无附件时写「（无）」）。
- 删除 `需求标题` 占位文案末尾多余的 `1`（当前第 5 行）。
- 「历史参考」标题统一为 `## 历史参考（Hindsight）`；同时把 `.claude/commands/pipeline.md:49` 的注入方式改为「填充已有小节，不存在才追加」，避免模板骨架与注入各写一个同名标题。

### 连带：`scripts/recon.mjs`

| 行 | 现状 | 改为 |
| -- | ---- | ---- |
| 89 | `const reqOneLiner = section(context, "需求描述（一句话）");` | `const reqFull = section(context, "需求描述（全文）");` |
| 275 | `splitKeywords(`${reqTitle}\n${reqOneLiner}`)` | `splitKeywords(`${reqTitle}\n${stripNoise(reqFull).slice(0, 1200)}`)` |

- `stripNoise()`：去掉 fenced code block、行内代码与 URL，再交给 `splitKeywords`。全文直接进 2/3/4-gram 会引入大量噪声并拖慢匹配。
- 旧需求目录里残留的「一句话」小节不会报错（`section()` 返回空串），无需迁移。

---

## 6. Skill 瘦身后的流程

`pipeline-feed/SKILL.md` 只保留以下步骤，**不做任何文件写入**：

1. 调用 `node scripts/feed.mjs --plan <path> --json`。
2. 按退出码分流（§3.2）：1/2/3/5/6 直接汇报并停止，不自行补文件。
3. 若 `already:true`：读 stdout 给出的 `statePath`，按 `state.json.tier` 返回概况，**不重新判 tier**。
4. 仅 exit 0 且 `already:false` 时做 tier 判断：
   - 输入：JSON 里的 `title` + `description` + `assignment` + `tierHint` + `repo`。
   - 输出：`light | full` + 一句理由。
   - 拿不准标 `full`。
5. 调用 `node scripts/feed.mjs --set-tier <alias> --tier <x> --reason "<理由>"` 落盘（state/tasks/decisions 一次写完）。
6. 返回概况：别名、模块、仓库、基准分支、门禁结果、tier 及理由、已生成文件、待确认项。
7. 到此为止：不切分支、不建 worktree、不动源码。

目标：SKILL.md 从 ~74 行降到 ~30 行，且不再包含任何文件操作细节。

---

## 7. 「描述是否够 planner 用」到底在判断什么

原判断隐含的检查项：

| 检查项 | 例子 | planner 是否已有对应机制 |
| ------ | ---- | ------------------------ |
| 定位到业务模块/页面 | 哪个系统、哪个菜单、哪个角色 | 有：`recon.md` + planner 自行 Grep |
| 当前现象 vs 期望结果 | “现在不会自动排序，希望按血液分类排序” | 有：`questions.md` Q 机制 |
| 验收标准 / 边界 | 空数据、权限、兼容旧数据 | 有：Q 机制 |
| 接口/字段契约 | 用哪个接口、字段含义 | 有：swagger + Q 机制 |
| 约束 | 版本、不能动的范围 | 有：Q 机制 + `decisions.md` |
| 附件是否可访问 | 图片/CDN 链接 | feed 已做 URL 提取 |

**结论（D5）：删除。** feed 只负责「搬运 + 定仓 + 建目录」，不负责判断需求质量；planner 本来就会把缺口写成编号 Q，提前判一遍等于重复劳动，还多一次 LLM 调用和一处格式漂移风险。若将来确实需要 pre-gate，用「带选项的结构化提问」实现，且**只提示、不阻断**；本期不做。

---

## 8. 可执行代码能不能直接写在 skill 里

**能，但不建议内联。**

| 方式 | 机制 | 代价 |
| ---- | ---- | ---- |
| SKILL.md 里写代码块 | 只是指令，模型看到后照做 | 整段代码每次触发都进上下文；无法独立运行/测试 |
| skill 目录带脚本（`.claude/skills/<name>/scripts/x.mjs`） | 模型只执行路径，文件内容不进上下文 | 可运行；但跨 skill 复用差 |
| 仓库级 `scripts/feed.mjs` | 同左，且其他入口（`package.json`、xiaoqian-manager、om）可复用 | **推荐**；与 `recon.mjs`、`assistant-*.mjs` 同层，便于单测 |

本仓已有先例：`.claude/skills/assistant/references/` 放说明文件。但**可执行逻辑**统一放 `scripts/`，skill 只写「调用哪个命令、怎么读结果」。

---

## 9. 连带改动清单

| 文件 | 改动 |
| ---- | ---- |
| `scripts/lib/febot.mjs` | **新增（必做）**：抽出 `section()` / `readConfig()` / `reposRoot()`，`recon.mjs` 与 `feed.mjs` 共用；`ROOT` 用 `import.meta.url`，支持 `FEBOT_CONFIG` |
| `scripts/feed.mjs` | **新增**：解析/校验/映射/分支/门禁/脚手架/登记/`--set-tier`/`--dry-run`/JSON 输出 |
| `scripts/recon.mjs` | 89/275 行改用「需求描述（全文）」+ `stripNoise`；改用共享库 |
| `docs/requirements/_template/context.md` | 删「一句话」；加「附件」；修掉多余 `1`；统一「历史参考（Hindsight）」标题 |
| `.claude/skills/pipeline-feed/SKILL.md` | 重写为薄壳（§6），不再直接读写文件 |
| `.claude/commands/pipeline.md` | 口头流程改为「必须带标题 + 产品/模块，否则报错」；init 段改为调用脚本；修正参数判别规则；删除 `plannedDescription` 回退；「历史参考」改为填充已有小节 |
| `xiaoqian-manager/lib/server/pipeline/runner.ts` | 83 行严格取 `plannedDescription`；元信息补 `任务类型`；校验前置到置 active 之前；抛带中文文案的 `MissingPlannedDescriptionError` |
| `xiaoqian-manager/app/api/tasks/[id]/pipeline/route.ts` | 识别 `MissingPlannedDescriptionError`，返回 **422**（其余仍 500） |
| `xiaoqian-manager/components/task/StageSheet.tsx` | 59 行去掉 `\|\| task.description` 回退，否则打开计划节点一保存就把原始描述灌进 `plannedDescription`，严格校验形同虚设 |
| `xiaoqian-manager/components/task/TaskRow.tsx`、`components/flow/TaskFlow.tsx`、`components/flow/StageNode.tsx` | `plannedDescription` 为空时禁用「写代码」▶，hover 提示先填计划描述 |
| `febot.config.json`（本机，不入库） | `projectMap` 加 `iHO-AI护理工作站 → iho-nurse-manager-ui`；`branches.byRepo` 加 `iho-medical-record-ui: dev` |
| `example/febot.config.json` | **只加 `branches.byRepo` 的结构示例**，不写真实产品；`ensure-config.mjs` 的 hint 同步 |
| `README.md` | 喂食流程、context 结构、口头格式、升级迁移说明同步 |
| `package.json` | 可选：`"feed": "node scripts/feed.mjs"` |
| `xiaoqian-manager/data/tasks.json` | 不改代码，但需人工补齐：当前 11 条任务有 **10 条** `plannedDescription` 为空，严格化后都无法启动 |

> **配置迁移说明**：`febot.config.json` 被 gitignore，`yarn setup` 对已存在文件只跳过、不合并。已有环境必须手工补 `projectMap` 和 `branches.byRepo`；`example/` 只放结构示例，不放假产品映射。

---

## 10. 验收用例

**前置条件**：目标仓库工作区干净。当前 `gitlab/iho-pathology-ui` 有 `auto-imports.d.ts`、`components.d.ts` 两条未提交改动，验收前先还原，否则用例 1 会直接 exit 3。

准备 fixture 计划文件 `d:/tmp/feed-fixture.md`：

```markdown
# 病理参数添加备注

任务ID: 57825163712659426
查询ID: 578251611431783751
别名: R-659426
产品/模块: iHO-病理系统
版本: V3.1.7
状态: 处理中
难度: 中
任务类型: 开发任务
最大工时: 4
执行人: 张九波(03376)
创建人: 詹益鑫

## 问题描述

是否使用第三方采图、是否开启大体取材，参数含义需明确；各参数需要添加备注说明。

## 分配任务说明

同上。
```

| # | 命令/操作 | 期望 |
| - | --------- | ---- |
| 1 | `node scripts/feed.mjs --plan d:/tmp/feed-fixture.md --json` | exit 0；生成 `docs/requirements/R-659426/`；repo=`iho-pathology-ui`；branch=`dev-zjb` |
| 2 | 查看 `context.md` | 有标题、全文、附件、目标仓库/基准分支；**无「一句话」** |
| 3 | 查看 `tasks.md` | 新增一行，仓库列=`iho-pathology-ui`，tier=待定 |
| 4 | 重跑同命令 | exit 0，`already:true`，不覆盖任何文件 |
| 4b | 保持别名不变、把 fixture 的 `任务ID` 改成另一串后重跑 | exit 6，报「别名冲突」 |
| 5 | 删除 `state.json` 后重跑 | exit 5，提示半成品目录，不覆盖 |
| 6 | 模块改成真正未映射的值 | exit 2，列出 `projectMap` 候选 |
| 7 | 构造同一产品两条无 `keywords` 兜底 | exit 6（配置歧义） |
| 8 | 在有未提交改动的仓上跑 | exit 3，原样输出 `git status --porcelain` |
| 9 | 仓库切到非基准分支后跑 | exit 3，输出期望分支 |
| 10 | `## 问题描述` 留空 / 写 `（空）` | exit 5，明确报「缺少问题描述」 |
| 11 | 删除首行 `# 标题` | exit 5 |
| 12 | 删除 `产品/模块` 行且不传 `--module` | exit 5 |
| 13 | `--alias ../evil` | exit 5（别名非法） |
| 14 | `--dry-run` | 不产生任何文件，输出动作清单 |
| 15 | 在 `iho-medical-record-ui`（`dev`）上跑 | 门禁通过（验证 per-repo 分支） |
| 15b | 模块=`iHO-AI护理工作站`，`iho-nurse-manager-ui` 在 `dev-zjb` 且干净 | repo=`iho-nurse-manager-ui`（验证 D8 映射） |
| 16 | 口头流程：输入 `# 标题` + `产品/模块: iHO-护理系统` + 描述 | 落盘并接入成功 |
| 17 | 口头流程：只给描述、无 `# 标题` | orchestrator 立即报错，不创建临时文件、不调用 feed |
| 18 | 口头流程：有标题但无 `产品/模块` | 同上（exit 5） |
| 19 | 任务ID流程：`plannedDescription` 为空时点 ▶ | API 返回 422，不生成计划文件，`coder` 不置 active |
| 20 | `node scripts/feed.mjs --set-tier R-659426 --tier light --reason "单文件文案"` | `state.json` tier=light、phase=coding；tasks.md tier=light；decisions.md 一行；重复执行不重复写 |
| 21 | `node scripts/recon.mjs R-659426` | 正常生成 recon；无「一句话」不报错；关键词来自全文（已去噪） |

> 用例 4b/5 会改写或删除 `R-659426` 的 `state.json`；执行后续用例 20/21 前先重跑用例 1 恢复。

---

## 11. 已确认结论（2026-10-23）

1. **`iHO-AI护理工作站`**：并入 `iHO-护理系统`，落到 `iho-nurse-manager-ui`；`projectMap` 显式加条目，不做隐式名称归一化。
2. **口头标题**：不支持模型提炼。用户必须按 `# <标题>` + `产品/模块: <module>` 的格式提供，否则报错返回。
3. **`plannedDescription`**：严格必填。源头（xiaoqian-manager ▶）与 feed 双层校验；当前 10/11 条历史任务需先在「计划」节点补齐描述。
4. **基准分支**：采用 per-repo 覆盖，解决 `iho-medical-record-ui`（`dev`）被全局 `dev-zjb` 误拦的问题。

> 无剩余开放问题。实施中若出现新歧义，按 fail-safe 停下并回到本文档补决策。

---

## 12. 执行顺序

- [x] 1. 新增 `scripts/lib/febot.mjs`，`recon.mjs` 改用共享库并完成「全文关键词」改造（先用现有需求如 `R-873656` 冒烟：无「一句话」也不报错）
- [x] 2. 改 `runner.ts`（严格描述 + `任务类型` + 前置校验）、API 422、`StageSheet.tsx` 回退、▶ 禁用
- [x] 3. 新增 `scripts/feed.mjs`：解析/校验/定仓/分支/门禁/脚手架/`--set-tier`/`--dry-run`；先跑 fixture，不接 skill
- [x] 4. 改 `_template/context.md` 与 `README.md`
- [x] 5. 重写 `pipeline-feed/SKILL.md` 为薄壳
- [x] 6. 改 `pipeline.md` 口头流程、参数判别与 init 段
- [x] 7. 本机 `febot.config.json` 补 `iHO-AI护理工作站` 与 `branches.byRepo`；`example/` 只补结构示例
- [ ] 8. 全量跑 §10 验收用例（1–14、16–18、20–21 已用 fixture/脚本验证；15 通过 dry-run；15b 因 `iho-nurse-manager-ui` 当前在 `master` 未通过分支门禁；19 由 `renderPlanFile` 单测 + tsc 覆盖，未起 dev server）
