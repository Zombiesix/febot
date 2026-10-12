# febot 前端研发流水线 × Hindsight 详细实施方案

> 把 Hindsight(0.7.x,自托管 MIT)接进这条 6 步前端研发流水线,让"人工的拍板、纠正、否决理由"沉淀为 Agent 可检索记忆,
> 解决"Agent 每个需求从零开始、对不齐人工思想"的问题。
>
> 本方案是《[hindsight-接入方案.md](./hindsight-接入方案.md)》这份**策略文档**的**落地版**：精确到每条流水线步骤、每个 Agent 阶段改哪个文件、跑哪个命令、落哪张记忆。
>
> 依据当前现状：6 步总流程宿主 `xiaoqian-manager`(Next 16.3.7 + React 19,端口 3010)；`AgentTeam` 在 febot 家靠 `.claude/commands/pipeline.md` 剧本 + planner/coder/reviewer 三 subagent 跑 ②③。

---

## 0. 接入门槛：先回答一个问题

**在这条流水线里,什么东西值得记？**

| 值得记                            | 反例(垃圾记忆)             |
| --------------------------------- | -------------------------- |
| 人工**否决**AI 方案的时刻 + 理由  | "可以,就这样"              |
| decisions.md 里**有理由**的拍板   | 纯确认类拍板               |
| reviewer 发现并纠正的**重复问题** | 一次性 nit                 |
| 某仓库的**架构/API 踩坑**结论     | "用了 Zustand"(没讲为什么) |

铁律:**写"为什么",不写"是什么"**。这条贯穿下面所有 retain 步骤。

---

## 1. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│                  Hindsight Server (本机 Docker)                │
│   API :8888    UI :9999    MCP /mcp/{bank_id}/                 │
│                                                               │
│   ┌─────────────┐ ┌─────────────┐ ┌────────────────────┐      │
│   │li-expertise │ │febot-proj │ │<产品线>×N          │      │
│   │(人工思想库)  │ │(流水线规矩) │ │(架构约定/踩坑/拍板) │      │
│   └─────────────┘ └─────────────┘ └────────────────────┘      │
│   存储: 内置 PostgreSQL + pgvector (volume: hindsight-data)   │
└──────────────────────────────────────────────────────────────┘
         ▲ retain/recall (REST :8888)             ▲ 抽取模型
         │                                         │ DeepSeek
┌────────┴─────────────────────────────────────────┴────────────┐
│ ● febot 家 AgentTeam                                        │
│   pipeline.md 剧本 → scripts/hindsight-memo.py(封 REST)      │
│   → 产物写在 context.md / plan.md / review.md / 复盘        │
│                                                              │
│ ● xiaoqian-manager (Web 宿主)                                  │
│   lib/server/hindsight/client.ts(封 REST)                    │
│   → ①获取需求 recall 提示、④测试完成、⑤部署完成、⑥工时 retain │
└──────────────────────────────────────────────────────────────┘
```

**两种调用方,统一打到 REST :8888：**

- **AgentTeam 侧(文件流水线)** → 用 `hindsight-memo.py` 脚本,结果落成小文件给 subagent 读 —— 贴合"只传路径、只收摘要"。
- **xiaoqian-manager 侧(Web/Node)** → 用 Node 内置 `fetch` 直接调 REST —— 不多引依赖。

---

## 2. 需要哪些开发环境 / 数据库 / 依赖

### 2.1 运行时环境（一次性,Phase 0）

| 项                       | 规格                                                                                               | 用途                                                     | 是否必须  |
| ------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------- |
| **Docker Desktop**       | Windows x86_64 最新版,开启 WSL2 后端                                                               | 跑 Hindsight 服务端与内置 PG                             | ✅        |
| **火山方舟 Ark API Key** | `ark-*`（OpenAI 兼容端点），只存本地 `scripts/hindsight.env`（已被 .gitignore 排除，**禁止提交**） | Hindsight 抽取/嵌入模型鉴权(deepseek 走 OpenAI 兼容协议) | ✅        |
| **Python 3**             | ≥3.10,`pip install hindsight-client`                                                               | 跑 `scripts/hindsight-memo.py`(AgentTeam 侧)             | ✅(方案B) |
| **Node**                 | 现状版本,不改                                                                                      | xiaoqian-manager 运行                                    | ✅(已有)  |

### 2.2 数据库

| 项                        | 说明                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **PostgreSQL + pgvector** | Hindsight 内置(postgres 数据目录 `/home/hindsight/.pg0`,挂卷 `hindsight-data`),**首期不需要单独装 PG**。嵌入向量、事实、索引都在这里 |
| **数据持久化**            | 只靠 `-v hindsight-data:/home/hindsight/.pg0`。建议把该 volume 纳入本机备份                                                          |
| **后期(多机/中心化)**     | Hindsight 支持外部 PG,届时把同一个 PG 作为所有开发机的共享 bank 根(见 §10 扩展)                                                      |

> 需要明确:本方案**不引入新的国产数据库/专用向量库**能力要求,Hindsight 内置 PG 已够。唯一"新数据库"就是这一个 PG volume。

### 2.3 模型(成本大头控制在便宜档)

| 用途                          | 模型                                         | 说明                   |
| ----------------------------- | -------------------------------------------- | ---------------------- |
| retain 事实抽取 / recall 重排 | `deepseek-v4.1-flash`                        | 便宜;不需要旗舰        |
| 问答/reflect 终稿质量         | 由**读记忆的 Agent 自身模型**决定,不回写成本 | 所以贵模型成本不受影响 |

环境变量(**写在 `scripts/hindsight.env`**——该文件已被 `.gitignore` 的 `scripts/*.env` 排除,真实 key 只落这里,不进 Docker run 命令行、不进任何 tracked 文档。deepseek 走 OpenAI 兼容协议,用 provider=openai + base_url 指向方舟;若 Hindsight 版本直接支持 deepseek provider 可改用之):

```
HINDSIGHT_API_LLM_PROVIDER=openai
HINDSIGHT_API_LLM_BASE_URL=<Ark 端点，见 scripts/hindsight.env>
HINDSIGHT_API_LLM_API_KEY=<ark-* key，仅存 gitignored 的 scripts/hindsight.env>
HINDSIGHT_API_LLM_MODEL=deepseek-v4.1-flash
```

### 2.4 网络/通信

- 全部 localhost,AgentTeam、xiaoqian-manager 都只连 `localhost:8888`。
- Hindsight 出网仅用于调 DeepSeek API;无其它外部依赖。

---

## 3. Bank 设计（建 4+N 个库）

> 整合现有的 `project-map.md`、`tasks.md`、`file-lock.md` 三张表的位置:不新增表,靠 bank 承载"规则被应用的实例"。

| bank_id                             | 存什么                                                                                                                  | 谁写                                | 谁读                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------- |
| `li-expertise`                      | 人工评审标准、设计偏好、否决理由、"为什么不"                                                                            | orchestrator(done/修复后)+ 人工随手 | reviewer、planner     |
| `febot-project`                   | 流水线全局约束(node 版本锁定、node_modules 规矩、commit 单行规范、dev-zjb 基准分支规则、**开工门禁/同仓串行**)、project-map 映射、历史全局拍板 | orchestrator(init/done)             | planner、orchestrator |
| `<产品线>`(按 project-map 实际件数) | 该仓架构约定、踩坑、API 域特点、历史需求决策摘要                                                                        | orchestrator(done)                  | planner、coder        |
| `release-metrics`(⓪)                | 需求实际工时 vs 预估、发货状态                                                                                          | xiaoqian-manager(⑥)                 | planner(排期参考)     |

**首期只建 3 个**(`li-expertise` / `febot-project` / 一个试点产品线如 `iho-cssd-ui`),跑通再加。

---

## 4. Phase 0：部署基建（半天,只做一次）

```bash
# 1) 起服务端（Windows CMD 的 ^ 续行；卷缓存数据）
docker run -it --pull always --name hindsight --restart unless-stopped ^
  -p 8888:8888 -p 9999:9999 ^
  --env-file scripts/hindsight.env ^
  -v hindsight-data:/home/hindsight/.pg0 ^
  ghcr.io/vectorize-io/hindsight:latest

# 2) 冒烟：装客户端测 retain/recall 通不通
pip install hindsight-client
python -c "from hindsight_client import Hindsight; c=Hindsight('http://localhost:8888'); \
c.retain(bank_id='smoke-test', content='测试记忆'); print(c.recall(bank_id='smoke-test', query='测试'))"

# 3) 建 3 个 bank（用 UI :9999 或建库脚本，见 §8 scripts/ensure-banks.py）

# 4) 预填充 febot-project 的"静态规矩"（**流程改动后跑 `--reseed` 覆盖，见 §8**）
recall(retain) node 版本锁定 / node_modules 规矩 / commit 单行 / dev-zjb 规则 / 开工门禁 —— 由 scripts/ensure-banks.py 的 STATIC_RULES 统一维护（按 marker 去重）
```

**验收**：recall 命中率有统计、人工无感知负担。

---

## 5. 精确接入：按 6 步流程拆（★=本期必做,◇=可选）

### ① 获取需求（xiaoqian 同步）◇

- **做什么**：同步完成、任务落 `tasks.json` 后，用需求标题 + 产品/模块对 `febot-project` + `<产品线>` recall 一次,把命中摘要挂到任务卡上显示"历史同类 N 条"(不阻塞)。
- **改动**：`xiaoqian-manager/lib/server/hindsight/client.ts` 加 `recallForTask(title,module)`；`components/task/TaskRow.tsx` 渲染提示。
- **目的**：小前端拿到任务就看到同类历史，省前期判断。

### ②③ AgentTeam（核心,★,本期大头）

按 `pipeline.md` 的内部阶段逐个插:

| 阶段                                 | 做什么                                                                                                                                  | 落到哪个文件             | 触发命令                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------- |
| **init 喂食**                        | recall `febot-project`+`<产品线>`(查询=需求标题)，命中历史写进 `context.md` 末尾「历史参考」小节(注明来源需求ID,没命中不写)           | `context.md`             | `hindsight-memo.py recall --bank ... --out`             |
| **planning(planner)**                | recall `li-expertise`(技术点)+`<产品线>`(模块/组件名);命中对齐进 `plan.md`「相关约定」小节;记忆与现状冲突→升级为 `M1/M2…`问题不猜       | `plan.md` `questions.md` | planner 被 derek 模板注入 recall 步骤                   |
| **coding**                           | 不直插,只从 plan.md「历史参考/相关约定」间接吃到记忆                                                                                    | (不改)                   | —                                                       |
| **plan_confirm / decisions** ★最关键 | 小前端答完 written 拍板写 `decisions.md` 后,把**有理由的拍板** retain 进 `febot-project` 或 `<产品线>`(context=`R-xxxx decisions Qn`) | `decisions.md`→bank      | `hindsight-memo.py retain --content "<决策>因为<理由>"` |
| **code_review(reviewer)**            | recall `li-expertise`(评审画像);输出 `review.md` 新增「口味符合度」节;发现**之前纠正过又再犯**→标「重复问题」                           | `review.md`              | reviewer 模板注入                                       |
| **fixing**                           | blocker 清空后,把"本轮 blocker 根因" retain:技术类→`<产品线>`,口味类→`li-expertise`                                                     | bank                     | `hindsight-memo.py retain`                              |
| **done 复盘** ★                      | orchestrator 对各库 reflect("本需求有哪些可继承经验/人工否决了什么")；**摘要给人过目,人工点头才 retain 回库**                           | 复盘文件→bank            | `hindsight-memo.py reflect`(人工门禁)                   |

**done 收尾不变式**(延续 README 边界,2026-10-12 修订:弃用 worktree):AgentTeam **直接在主仓固定分支工作区改代码,改动以未提交形式留下,不 add/commit/push**——retain 只是把经验写进库,跟代码提交解耦。

### ③→④ 关键回流点：deploy 合到远程后 ◇

- 其实 ⑤ deploy 成功才意味着"真的能跑到远程",所以**在 ⑤ 成功后才适合把"本需求结论"计入复盘口径**(避免把没上线的半成品当经验)。整体复盘仍由 ②③ done 触发,但 reflect 的 query 可标注"已部署"。

### ④ 人工测试（xiaoqian test 完成）◇

- **做什么**：小前端在 test 阶段`点完成`时,若备注里写了发现的问题→ retain 进 `<产品线>`(踩坑类)。测试要点(来自 reviewer「口味符合度」)可在点开卡时 recall 贴出。
- **改动**：`xiaoqian-manager/app/api/tasks/[id]/stage/route.ts`(test done) 分支调 `retainIfProblem(note)`。

### ⑤ 提交合并（xiaoqian deploy 完成）◇

- **做什么**：deploy 成功后,把"本需求已部署到 `<目标分支>`"记进 `febot-project` 或 `<产品线>`(一条轻量状态),供复盘/排期引用。
- **改动**：`lib/server/git/deploy.ts` 成功后 + 钩子 retain「已部署」。可用 repo 而非推送到 jenkins 的回归。

### ⑥ 填工时（xiaoqian 工时）◇

- **做什么**：`saveWorkHours` 成功后 retain 进 `release-metrics`：`「需求 R-xxx 实际 Xh / 预估 Yh」`——给 planner 排期做回归样本。
- **改动**：`lib/server/teamwork/client.ts` saveWorkHours 成功后调 retain。

> **本期(Phase 1)只做 ★ 线：②③ 内部 + ⑤部署状态**。◇ 线(①④⑥)等 ★ 线验证有效后再开,避免一上来铺太开。

---

## 6. 代码改造点清单（精确到文件）

### AgentTeam 侧（febot 家）

| 类型 | 文件                                     | 改什么                                                                                                      |
| ---- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 新建 | `scripts/hindsight-memo.py`              | recall/retain/reflect 三子命令,封 `hindsight_client`,支持 `--out FILE`                                      |
| 新建 | `scripts/ensure-banks.py`                | 幂等建 3 bank + 预填充 febot-project 静态规矩                                                             |
| 改   | `.claude/commands/pipeline.md`           | init 步追加 recall;plan_confirm 步追加 retain;done 步追加 reflect+人工门禁;reviewer/fixing 模板注入 §5 内容 |
| 改   | `.claude/agents/planner.md`              | tools 处加「可读 `recall` 产物文件」;prompt 加 M1/M2 记忆冲突问题规则                                       |
| 改   | `.claude/agents/reviewer.md`             | 加起 recall 读 li-expertise;输出「口味符合度」节;标「重复问题」                                             |
| 改   | `docs/requirements/_template/context.md` | 加「历史参考」空小节占位                                                                                    |
| 改   | `docs/requirements/_template/plan.md`    | 加「相关约定」空小节占位                                                                                    |
| 改   | `docs/requirements/_template/review.md`  | 加「口味符合度」空小节占位                                                                                  |

### xiaoqian-manager 侧（Web）

| 类型 | 文件                                  | 改什么                                                                           |
| ---- | ------------------------------------- | -------------------------------------------------------------------------------- |
| 新建 | `lib/server/hindsight/client.ts`      | 封 REST:retain/recall/reflect,超时+错误兜底(拿不到记忆不阻塞)                    |
| 改   | `app/api/tasks/[id]/stage/route.ts`   | test done 分支→① 提示 recall / ④ 备注 retain;deploy done 分支→⑤ retain「已部署」 |
| 改   | `lib/server/teamwork/client.ts`       | saveWorkHours 成功后→⑥ retain                                                    |
| 改   | `components/task/TaskRow.tsx`         | ① 需求卡显示历史同类提示                                                         |
| 改   | `.env.local` / `data/repos.json` 同级 | 新增 `HINDSIGHT_URL=http://localhost:8888`;Hindsight 不可用→走降级空实现         |

---

## 7. 分阶段落地排期

| 阶段                       | 周期        | 内容                                                                                 | 验收                                                                                                 |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Phase 0 基建**           | 半天        | Docker 起服务+冒烟+建 3 bank+预填充                                                  | recall 命中率有统计、人工无负担                                                                      |
| **Phase 1 AgentTeam 吃牌** | 第 3-4 周   | ②③ 全阶段脚本级接入(★线)                                                             | plan.md 出现「相关约定」、review.md 出现「口味符合度」、拍板 retain ≥10 条、同类 fixing blocker 不升 |
| **Phase 2 回流+度量**      | 第 2 个月   | done 复盘 reflect+人工门禁;Mental Models(3+1 心智模型);对齐度量看板;⑤部署状态 retain | Q1-Q3 版本开始演进、拍板命中率稳定 >50%                                                              |
| **Phase 3 固化+扩展**      | 第 3 个月起 | reviewer 切 MCP 直连;reviewer rubric 回写;Knowledge Pages 投影;①④⑥ 可选线开启        | reviewer.md rubric 有真实库条目、「重复问题」率环比下降                                              |

> 全链条**人工门禁**只卡三处:拍板、复盘 reflect 入库、回写 rubric。其余自动。这与现状"人工只卡门禁"哲学一致。

---

## 8. 后期扩展

### 8.1 短期（第 3 个月）

- **方案 A：reviewer 切 MCP 直连**——`/mcp/{bank_id}/` 在 `.claude/settings.json` 配置,reviewer 自主决定查记忆(它最需要灵活访问),其它角色保留脚本。
- **Mental Models** 固化 3+1 个知识页(人工评审标准/组件设计偏好/验收定义 + 产品线架构纲领),读取零成本,版本演进即思想沉淀可视化。

### 8.2 中期

- **harness 容器**：Hindsight 支持 Harness(STAR/Reflex?? 容器),把一个"相似需求模式+反例"打包成可复用的评估容器,喂给后续需求做对照。
- **Reviewer 落地**：把 Hindsight 记忆结合到 `code-review`/`verify` subagent,让审查带"团队历史口味"。
- **多机/中心化 bank**：把内置 PG 换成共享外部 PG,所有开发机读同一套经验(注意 PII/权限)。

### 8.3 远期

- **Memory Defense**：开启 per-bank 的 PII/密钥扫描(45 种模式),与现有"敏感文件人工审批"门禁叠加成双保险。
- **自动回写静态资产**：月度 reflect 提炼 → 人工审 → 自动合并进 `.claude/agents/reviewer.md` rubric + 投影 `docs/team-knowledge/review-checklist.md`。**bank→文件 必经人,bank←文件 可自动**。
- **对齐度量看板**：把 §7 四指标(重复问题率/fixing blocker 数/拍板命中率/plan 人工改动量)接到 xiaoqian-manager 看板。

### 8.4 与现有工具的关系(不重复造轮子)

- **code-indexer 的 ProjectMap** → 作为产品线 bank 的**初始 retain 素材**批量入库(架构上下文)。
- **小游导师产物知识页** → 当产品线 bank 的初始素材;之后靠三操作滚动,导师不再重复输出静态文档。
- **swagger MCP / om / xiaoqian 主流程** → 与记忆正交,不动。

---

## 9. 风险与边界

| 风险                    | 缓解                                                                           |
| ----------------------- | ------------------------------------------------------------------------------ |
| 垃圾记忆稀释检索        | 只 retain"有理由的拍板/否决";reflect 结果人审才入库;逐月抽样(§4 已建 smoke 口) |
| 记忆过期与现状冲突      | M 类问题机制显式暴露冲突,人裁决后修正记忆                                      |
| 上下文膨胀拖累 subagent | coder 不直连记忆;recall 一律 `--budget` 截断;「历史参考」只入 plan.md 摘要级   |
| 成本                    | 抽取用 deepseek 便宜模型;Mental Models 读取零 LLM;recall 频次由剧本控制        |
| 敏感信息入库            | 遵守"敏感文件人工审批"+ 乐观下开启 Memory Defense                              |
| Docker/PG 数据安全      | `hindsight-data` 纳入备份;后期迁外部 PG 双活                                   |

---

## 10. 一页纸收束

> **目标**：给 6 步流水线加"学习型记忆",让第 N+1 个需求吃到前 N 个的人工拍板。
> **基建**：本机 Docker 起 Hindsight(内置 PG+pgvector),建 `li-expertise` / `febot-project` / 产品线三个 bank,抽取用 deepseek 便宜模型省成本。
> **接入**：AgentTeam 靠 `hindsight-memo.py` 在 init/planning/decisions/review/done 五处 recall+retain;xiaoqian-manager 靠封 REST 的 `client.ts` 在 ①④⑤⑥ 轻量读写。②③ done 复盘 reflect 出稿,人工过目才入库。
> **扩展**：MCP 直连 reviewer→Mental Models→共享 PG 中心化→Memory Defense→自动回写 rubric→对齐度量上 xiaoqian 看板。
> **纪律**：文件即接口不变;只记"为什么";reflect 人审门禁;coder 最小视野不直连。**★线先跑通,◇线后补。**
