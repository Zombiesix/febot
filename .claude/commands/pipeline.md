# pipeline - 前端需求流水线 orchestrator 剧本

> 本文件是主对话的「剧本」，不是调度引擎。主对话按此执行状态机，读取 `state.json` 决定下一步，再用下方委派模板调用 subagent。主对话不住任何上下文——每次交互结束把认知写 `orchestrator-log.md`，resume 时从文件重建。

## 启动 / 恢复

- 启动（任务ID）：`/pipeline A-001` —— 与 xiaoqian-manager「开始」按钮同款；计划文件是 xiaoqian-manager 生成的临时 md
- 启动（口头需求）：`/pipeline # <标题>` + 下一行 `产品/模块: <module>` + 描述正文 —— 无任务ID、无现成 md，同样只跑 ②③（规划+编码+审查+修复）；①④⑤ 天然不存在，全手动
- 恢复：`/pipeline resume A-001`（任务ID或别名均可）

**参数判别规则**：

1. `resume <别名>` → 恢复流程。
2. 参数能对应已接入的需求（`docs/requirements/<别名>/state.json` 存在）或 xiaoqian-manager 预生成的临时计划文件（`xiaoqian-manager/data/temp/<任务ID>.md` 存在）→ 任务ID流程。
3. 其余一律按口头流程处理，且**必须当场校验格式**：首个非空行匹配 `^#\s+\S`；存在 `^产品/模块[:：]\s*\S` 行；去掉标题行与模块行后剩余正文非空。任一不满足 → 立即报错并列出缺失项，**不创建临时文件、不调用 feed**。不支持由模型提炼标题，也不猜产品/模块。

主对话动作序：

1. 读 `state.json`，取 `tier`、`phase`、`lastAgent`、`iteration`。
2. 读 `progress.md`、`orchestrator-log.md` 重建认知。
3. `phase` 的值 = 下一步委托的 subagent。不猜，直接读。
4. 套用下方对应委派模板，只传路径，只收摘要。

## 各阶段委派模板

### init → 调用 feed 脚本接入

会话开始时，若 `docs/requirements/<别名>/state.json` 不存在，先接入需求。确定性操作全部由 `scripts/feed.mjs` 完成；主对话只负责准备计划文件、判断 tier、按退出码分流。

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

用户输入必须自带标题与模块：

```text
/pipeline # <标题>
产品/模块: <module>
<需求描述（可多行）>
```

校验通过后，主对话落盘 `xiaoqian-manager/data/temp/R-oral-<MMDDHHmm>.md`，内容固定为：

```markdown
# <标题（原样，不提炼）>

产品/模块: <module>

## 问题描述

<描述全文>

## 分配任务说明
```

别名 = 文件名（`R-oral-<同一时间戳>`），由 feed 从文件名取。后续阶段与任务ID流程完全一致。

**调用 feed**

```bash
node scripts/feed.mjs --plan <计划文件> --json
```

脚本负责：解析/校验 → `projectMap` 定仓 → 基准分支（`projectMap[].branch` > `branches.byRepo[repo]` > `branches.default`）→ 开工门禁（分支 == 基准分支 且 `git status --porcelain` 为空）→ 拷模板 → 写 `context.md`（标题/全文/附件/目标仓库/基准分支）→ upsert `tasks.md` → **最后**写 `state.json`（`tier=full, phase=init`）。

按退出码分流，**不做补救性写入**：

| code | 含义 | 动作 |
| ---- | ---- | ---- |
| 0 | 成功 / 已接入（`already:true`） | 继续 |
| 1 | 未预期异常 | 贴 stderr，停止 |
| 2 | 映射未命中 | 把 `details.knownProducts` 给负责人；确认后回填 `projectMap`，不许猜 |
| 3 | 门禁失败 | 贴实际分支/脏文件，让负责人先在 ④ 步 deploy 或人工提交；禁止 stash/checkout/commit |
| 5 | 输入或格式不符 | 贴 `details.missing`，让来源方补；不自行补标题/模块/描述 |
| 6 | 配置/环境错误 | 贴 stderr，停止 |

`already:true` → 读 `statePath` 指向的 `state.json`，按其 `tier` 继续，不重新判 tier。

**tier 判定与落盘**（仅 `already:false`）：

- 输入：feed 输出的 `title` / `description` / `assignment` / `tierHint` / `repo`。
- 改文案/样式/单文件小修、难度低 → `light`；新增组件、动 store/表格/页面、多步任务 → `full`；拿不准标 `full`。
- 执行 `node scripts/feed.mjs --set-tier <别名> --tier <light|full> --reason "<具体理由>"`；脚本写 `decisions.md`、`tasks.md`、`state.json`，并把 `phase` 置为 `planning`（full）或 `coding`（light）。
- 落盘后重新读 `state.json`，按 `phase` 进入对应阶段。

> **记忆增强（可选，全链路软降级）**：以下所有 `hindsight-memo.py` 调用都是**尽力而为**——
> Hindsight 未起 / 无网络 / 接口异常 → 产出空结果、跳过该步，**绝不阻塞流水线、绝不编造**。
> `python scripts/hindsight-memo.py recall --bank X --query Q --out FILE` 输出为 JSON，
> 非空才当作命中；为空则删除该文件、不写进任何文档。

记忆增强（init 喂食后执行）：
```
python scripts/hindsight-memo.py recall --bank febot-project --query "<需求标题+产品/模块>" --budget 500 --out docs/requirements/<别名>/recall-history.md
python scripts/hindsight-memo.py recall --bank <产品线bank> --query "<需求标题>" --budget 800 --out docs/requirements/<别名>/recall-history-line.md
若以上文件非空，把命中摘要填进 context.md 已有的 `## 历史参考（Hindsight）` 小节（注明来源需求ID）；该小节不存在才在末尾追加，避免出现两个同名标题。为空则删除这两个文件。
```

### planning → 先 recon，再 @planner（仅 full）

委派 planner 前，主对话先跑一次事实底稿（确定性，覆盖式）：

```
node scripts/recon.mjs A-001
```

产出 `docs/requirements/A-001/recon.md`。跑失败或底稿标「不支持 / 接口层未解析」不阻塞——照常委派，由 planner 自行 Grep 补位。

委派 planner 前，主对话再跑一次 `li-expertise`（人工思想库）recall，产物给 planner 读（软降级，空则不给）：

```
python scripts/hindsight-memo.py recall --bank li-expertise --query "<本需求涉及的技术点>" --budget 600 --out docs/requirements/A-001/recall-expertise.md
```

```
请作为 planner 处理需求 A-001。
- 读 context: docs/requirements/A-001/context.md（含「历史参考」，可能为空）
- 读事实底稿: docs/requirements/A-001/recon.md（确定性产出；为空/标「不支持」时自行 Grep，别当结论）
- 可选读记忆: docs/requirements/A-001/recall-expertise.md（li-expertise 命中摘要；文件缺失/为空即无记忆）
  若命中人工设计偏好，plan.md 的方案取舍须显式对齐或说明偏离理由；偏离写成 Q。
  若记忆与仓库现状冲突（如 bank 说用 Options API、实际代码已 Composition）→ 升级为 M1/M2… 问题，不猜不覆盖。
- 有不确定的问题按编号写入 questions.md 并暂停等答案
- 计划写入 plan.md，必须含「将改动文件清单」；如有相关架构约定，写入 plan.md「相关约定」小节
- 改动敏感文件时写成 Q
返回:只一行摘要(plan.md 路径 + 问题数)
```

### plan_confirm → 主对话 + 负责人

读 questions.md 展示 → 负责人答 answers.md(按编号) → 确认拍板写 decisions.md(时间/决策/拍板人/原因)。

拍板写入 decisions.md 后，**回流入库（关键回流点）**：只 retain **有理由的拍板**（决策 + 为什么）；纯确认类（"可以，就这样"）不入库。逐条执行（软降级，失败跳过）：
```
python scripts/hindsight-memo.py retain --bank febot-project --content "<决策> 因为 <理由>" --context "R-<别名> decisions <Q号>"      # 全局件
python scripts/hindsight-memo.py retain --bank <产品线bank> --content "<决策> 因为 <理由>" --context "R-<别名> decisions <Q号>"    # 产品线件
```

### coding → @coder

```
请作为 coder 实现需求 A-001。
- 读 plan.md、answers.md(修复轮改传 review.md、review-fix.md)
- 只读 plan 摘要与文件指针，不重扫全需求
- 每子任务更新 progress.md
- 跑 lint/test 写 test-report.md（**不跑 build**，除非负责人点名或改动涉及构建配置）
返回:只摘要(进度 + 测试结果)
```

### code_review → @reviewer（仅 full）

委派 reviewer 前，主对话跑一次评审画像 recall（软降级，空则不给）：

```
python scripts/hindsight-memo.py recall --bank li-expertise --query "<本需求改动涉及的技术点>" --budget 1000 --out docs/requirements/A-001/recall-expertise.md
```

```
请作为 reviewer 审查 A-001。
- 读 git diff（**限定范围**：`git -C <repoRoot>/<仓库> diff -- <plan.md「将改动文件清单」里的文件>`）和 plan.md(含「将改动文件清单」)
- 对照 test-report.md 核验测试是否真实跑通
- 可选读记忆: docs/requirements/A-001/recall-expertise.md（li-expertise 人工偏好；文件缺失/为空即无）
  对照命中偏好逐条标 符合/偏离(原因)，出 review.md「口味符合度」节；发现此前纠正过的问题再犯 → 标「重复问题」
- 按 rubric 出 review.md，标记 blocker/suggestion/nit
返回:只摘要(blocker 数 + 其余条数)
```

### fixing → @coder（仅 full，有 blocker 时）

```
请作为 coder 修复 A-001 的 blocker。
- 只读 review.md、review-fix.md，只改 blocker，不读 plan.md
返回:只摘要(已修 blocker + 复测结果)
```

iteration+1；超 maxIteration(2) → 写 decisions.md 转人工。

blocker 清空后，把**本轮 blocker 根因**回流入库（软降级，失败跳过）：
```
python scripts/hindsight-memo.py retain --bank <产品线bank> --content "<本轮 blocker 根因>" --context "R-<别名> fixing"    # 技术类
python scripts/hindsight-memo.py retain --bank li-expertise --content "<人工介入的口味问题根因>" --context "R-<别名> fixing"  # 口味类
```

### verify → @coder

```
请作为 coder 复验 A-001。
- 跑 lint/test，更新 test-report.md
返回:只摘要(是否全绿)
```

**「全绿」= lint + test 全过**（2026-10-14 修订：build 不再计入复验门禁，见 coder.md「不跑 build」）。不全绿 → 回 coding/fixing；全绿 → done。
build 仅作按需项：负责人点名、或本次改动涉及构建配置时才补跑，跑完把 `auto-imports.d.ts` / `components.d.ts` 这类自动生成文件的改动还原，别污染收尾校验的改动清单。

### done → 主对话

写 `worklog.md`、`state.json` 置 done → 收尾校验（见下）→ 负责人在**主仓固定分支工作区**上自行验收（人工验收不单列步骤；dev server 直接跑，依赖与 `.env` 都现成）：

复盘（一次性 reflect，**人工门禁**；软降级，失败跳过）：
```bash
python scripts/hindsight-memo.py reflect --bank <产品线bank> --query "本需求(R-<别名>)实施中有哪些值得后续需求继承的经验和坑" --out docs/requirements/<别名>/reflect-line.md
python scripts/hindsight-memo.py reflect --bank li-expertise --query "本需求(R-<别名>)中人工否决或纠正了哪些方案，背后的偏好是什么" --out docs/requirements/<别名>/reflect-expertise.md
```
把 reflect 摘要贴出来**给负责人过目**；人工点头后，再把结论 retain 回库（`--context "R-<别名> 复盘"`）。**reflect 不自动入库**——防止 LLM 幻觉污染记忆；这与现状"人工只卡门禁"一致。

> **收尾边界（铁律，2026-10-12 修订：不再用 worktree）**：AgentTeam **直接在主仓基准分支工作区里改代码**，改动以**未提交**形式留在工作区，**不进行 add / commit / push 任何代码**。基准分支按 `projectMap[].branch` > `branches.byRepo[repo]` > `branches.default`（默认 `dev`，非 master）解析，主仓 checkout 常驻该分支。人工验收**也就在这个工作区上跑 dev server**（不再单列步骤，这是放弃 worktree 换来的：依赖、`.env`、后端代理、登录态全都现成）；提交、合并、推送、部署是 ④ 步，由小前端在 xiaoqian-manager 的 deploy 阶段手动完成。AgentTeam 全程不触碰任何提交与远程写操作。
>
> **隔离怎么保证（替代 worktree 的两条）**：
> ① **开工门禁** —— init 阶段校验主仓在固定分支且工作区干净，脏就停（上一条需求必须已在 ④ 步提交掉）；
> ② **改动白名单** —— coder/reviewer 只认 plan.md「将改动文件清单」内的文件，收尾按它校验。
> 因此**同一仓库同一时间只能跑一个需求**（file-lock 的并行只在不同仓之间成立）。

1. 开工门禁已在 init 阶段校验（主仓在固定分支 + `git status --porcelain` 为空）。不满足就不开工，没有例外。
2. coder 全程直接写主仓工作区，只改 plan.md「将改动文件清单」内的文件；不 `add`、不 `commit`、不 `stash`。
3. 收尾校验（不通过就停下查，别往下走）：
   - `git -C <repoRoot>/<仓库> status --porcelain` —— **只应出现本需求清单内的改动**；出现清单外文件 → 写 orchestrator-log 并停下来问负责人，不擅自清理别人的改动。
   - `git -C <repoRoot>/<仓库> diff --cached --name-only` —— **必须为空**（证明没有任何东西被暂存或提交）。
4. 清 `file-lock.md` 中本需求条目。
5. 删 init 时的计划临时文件（`rm -f xiaoqian-manager/data/temp/<启动时用的那个 md>`；任务ID流程 xiaoqian-manager 会在收到完成标记后也删一次，rm -f 幂等；口头流程一定是主对话这里删）。
6. **回写完成标记（任务ID流程必做，口头流程跳过）**——这是 xiaoqian-manager 判定成功的**唯一**依据：
   用 Write 工具写 `xiaoqian-manager/data/temp/<任务ID>.done.json`，内容为一行 JSON：
   ```json
   {"taskId":"<任务ID>","requirement":"<别名>","phase":"done","finishedAt":"<当前时间 ISO8601>"}
   ```
   - `<任务ID>` 取 PM 计划文件元信息里的「任务ID」（也是计划文件名）。
   - **必须放在第 3/5 步都做完之后最后写**：标记一出现，xiaoqian-manager 就会把「写代码」节点置 done 并删除计划文件。
   - **没写标记 = 失败**：任何 fail-safe 停止、问题待答、中途放弃都**不要**写这个文件；窗口关闭时 xiaoqian-manager 会把「写代码」节点置为 failed 并附退出码/原因。
   - 只写本地文件，不涉及提交与远程。

## 轨道约束

- fail-safe：任何阶段拿不到预期产物 → 写 orchestrator-log 并停下来问负责人，不硬猜继续。
- orchestrator 每次收到 subagent 摘要后，把「下一步 + 已知信息」写 orchestrator-log.md 再丢弃对话。
- **全局约束（对流水线主对话与所有 subagent 生效）**：
  1. **禁止更改 node / npm / yarn 版本**——不执行任何 `nvm use`、`node -v` 引发的变更、`npm`/`yarn`/`pnpm` 全局切换或 `engines`/`.nvmrc`/package.json 里的版本改动。版本锁定为现状。
  2. **涉及 `node_modules` 文件夹数据修改时，必须先严格提示**：在改动前明确打出一句「**因为 <原因> 需要进行 node_modules 修改**」（如依赖安装、重新构建、安装新包），并征得同意后才执行。不得静默 install / 改依赖 / 动 link、不得在收尾工作中顺手清改 node_modules。
