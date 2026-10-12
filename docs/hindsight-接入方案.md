# febot × Hindsight 接入方案

> 目标：在**不改变「文件即接口」核心不变式**的前提下，用 Hindsight 为 AgentTeam 流水线加上"学习型记忆"，
> 解决"Agent 产出对不齐人工思想"的问题，逐步把人工拍板（decisions.md）、review 纠正、否决记录蒸馏成
> Agent 可检索、可推理的团队经验。
>
> 适用版本：Hindsight 0.7.x（自托管，MIT）。

---

## 0. 现状诊断：为什么现在"对不齐思想"

先明确痛点在流水线中的位置，接入才有靶子。

| #   | 现状                                                                                       | 造成的"对不齐"                                                 | Hindsight 对策                                                  |
| --- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | reviewer 的 rubric 是 5 条通用规则（越界/死代码/测试/偏离需求/敏感文件），**不含人的口味** | 代码"能跑、不越界"，但写法、拆分粒度、抽象层级不是你会写的样子 | 用 Reflect 生成"人工评审画像"，回写 reviewer rubric（见 §5.3）  |
| 2   | 每个需求 = 新会话 + 新 docs 目录，**需求之间零记忆**（2026-10-12 前还各有一份 worktree，现已改为共用主仓工作区） | 上个需求里你纠正过的问题，下个需求原样再犯                     | per-产品线 bank + planning 阶段 recall（见 §4.2）               |
| 3   | `decisions.md` 只记录"拍板结果"，散落在各需求目录，**从未被消费**                          | 相同场景下 agent 推理和当初拍板不一致                          | done 阶段 retain 拍板理由进 bank，planning 时 recall（见 §4.4） |
| 4   | planner/coder/reviewer 全是"一次性 subagent"，prompt 静态                                  | agent 不会随纠正变好，纠正记录随会话消亡                       | Mental Model 常驻知识页，subagent 启动即携带（见 §5.2）         |

结论：febot 的文件流水线解决的是**过程可审计**，Hindsight 补的是**经验可学习**。两者正交，不冲突。

---

## 1. 总体架构

```
                        ┌──────────────────────────────────────────────┐
                        │           Hindsight Server (本机 Docker)        │
                        │  API :8888   UI :9999   MCP /mcp/{bank_id}/    │
                        │                                                │
                        │  ┌─────────────┐ ┌─────────────┐ ┌──────────┐ │
                        │  │li-expertise │ │febot-proj │ │iho-cssd… │ │
                        │  │(人工思想库)  │ │(流水线知识库)│ │(产品线库) │ │
                        │  └─────────────┘ └─────────────┘ └──────────┘ │
                        └──────────────────────────────────────────────┘
            retain ↑            recall / reflect ↑              ↑ MCP
   ┌─────────────────┐  ┌────────────────────────────────┐  ┌────────────┐
   │ orchestrator    │  │  pipeline 各阶段（剧本注入）      │  │ Claude Code│
   │ (pipeline.md    │  │  planning / review / done       │  │ 会话直接挂  │
   │  增加记忆步骤)    │  │                                 │  │ MCP 工具   │
   └─────────────────┘  └────────────────────────────────┘  └────────────┘
```

**三条铁律：**

1. **文件即接口不变**。Hindsight 是增强层，plan.md / decisions.md / review.md 照旧落盘，记忆只作为输入增强，不作为传递媒介。resume 重建仍靠 state.json + orchestrator-log.md。
2. **记忆可追溯**。每条 retain 必须带 `context` 注明来源需求 ID，回查时能找到原始 decisions.md / review.md。
3. **archive 禁区延伸到记忆**。archive 内容不 retain；retain 前由人工把关（后期可开 Memory Defense 做 PII/密钥扫描兜底）。

---

## 2. Bank 设计

不要按需求建 bank（需求记忆已由 docs 落盘承担），按**经验复用维度**建：

| bank_id                                                                           | 存什么                                                                                                                | 谁写入                                | 谁读取                |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------- |
| `li-expertise`                                                                    | 人工的评审标准、设计偏好、否决理由、"为什么不"                                                                        | orchestrator（done/修复后）+ 人工随手 | reviewer、planner     |
| `febot-project`                                                                 | 流水线全局约束（node 版本锁定、node_modules 规矩、commit 单行规范、dev-zjb 基准分支规则）、project-map 映射、历史拍板 | orchestrator（init/done）             | planner、orchestrator |
| `<产品线>`（如 `iho-cssd-ui`、`reuseapp-blood-bank-web`、`iho-nurse-manager-ui`） | 该仓的架构约定、踩坑、API 域特点、历史需求决策摘要                                                                    | orchestrator（done）                  | planner、coder        |

**bank 与现有文件的对应关系：**

- `febot-project` ≈ README 门禁清单 + project-map.md 的**动态版**（README 是规则，bank 是"规则被应用的实例"）
- `<产品线>` ≈ 小游导师 knowledge pages + 各需求 decisions.md 的**浓缩版**
- `li-expertise` ≈ 目前**不存在对应物**——这就是"对不齐思想"的空洞，是本方案的核心产出

---

## 3. 部署（Phase 0，半天）

开发机本机 Docker（Windows x86_64 支持良好）：

```bash
docker run -it --pull always --name hindsight --restart unless-stopped ^
  -p 8888:8888 -p 9999:9999 ^
  -e HINDSIGHT_API_LLM_PROVIDER=anthropic ^
  -e HINDSIGHT_API_LLM_API_KEY=%ANTHROPIC_API_KEY% ^
  -e HINDSIGHT_API_LLM_MODEL=claude-haiku-4-5-20251001 ^
  -v hindsight-data:/home/hindsight/.pg0 ^
  ghcr.io/vectorize-io/hindsight:latest
```

> **抽取模型用便宜模型即可**（retain 的事实抽取 / recall 的重排不需要旗舰模型），问答和 reflect 质量主要由读记忆的 agent 自身模型决定。成本大头可控。

验证：

```bash
pip install hindsight-client
python -c "from hindsight_client import Hindsight; c=Hindsight('http://localhost:8888'); \
c.retain(bank_id='smoke-test', content='测试记忆'); print(c.recall(bank_id='smoke-test', query='测试'))"
```

同时起一个银行：用 UI（`:9999`）或脚本建出 §2 的四个 bank（以 project-map 实际产品线为准）。

---

## 4. 流水线接入点（逐阶段）

每个阶段的接入 = 在 `pipeline.md` 对应委派模板前后各加一步。**风格与现有剧本一致：只传路径、只收摘要。**

### 4.1 init（喂食）— 历史决策注入

pipeline-feed 拷贝模板后，orchestrator 追加：

```
记忆增强：
- recall(bank_id=febot-project, query=<需求标题+产品/模块>, token_budget=500)
- recall(bank_id=<产品线bank>, query=<需求标题>, token_budget=800)
把命中的历史拍板/同类需求决策，以「历史参考」小节追加进 context.md 末尾
（注明来源需求 ID；没有命中就什么都不写，禁止编造）
```

效果：planner 一进来就知道"同类需求上次怎么定的、这个仓有什么规矩"。

### 4.2 planning — planner 双库检索

planner 的委派模板增加：

```
- recall(bank_id=li-expertise, query=<需求涉及的技术点>, token_budget=600)
  若命中人工设计偏好，plan.md 的方案取舍须显式对齐或说明偏离理由
- recall(bank_id=<产品线bank>, query=<模块/页面/组件名>, token_budget=800)
  将相关架构约定写进 plan.md「相关约定」小节
```

questions.md 里**新增一类问题编号 `M1/M2…`**（Memory 类）：当 planner 发现记忆与当前需求冲突时（如 bank 说"此仓用 Options API"，实际代码已改 Composition API），不猜不覆盖，升级成 M 类问题由人工裁决——裁决结果 retain 回 bank，记忆得以修正。

### 4.3 coding — 暂不直插，只继承

coder 保持现有"视野最小化"原则不动。它从 plan.md 的「历史参考」「相关约定」小节**间接**吃到记忆，不直接调 Hindsight——避免 coder 上下文膨胀、也符合"修复轮不读 plan"的最小视野设计。

### 4.4 plan_confirm / decisions — 拍板入库（关键回流点）

这是整个方案**最重要的 retain 时机**。人工答完 answers.md、写入 decisions.md 后，orchestrator 执行：

```
retain(bank_id=febot-project 或 <产品线bank>,
       content=<拍板决策 + 理由原文（decisions.md 条目）>,
       context="来源 R-013345 decisions.md Q2",
       timestamp=<now>)
```

**只 retain"有理由的拍板"**。纯确认类（"可以，就这样"）不入库——那是垃圾记忆，会稀释检索质量。

### 4.5 code_review — reviewer 吃评审画像

reviewer 委派模板增加：

```
- recall(bank_id=li-expertise, query=<本需求改动涉及的技术点>, token_budget=1000)
- 输出 review.md 时新增一节「口味符合度」：
  对照命中的人工偏好，逐条给出 符合/偏离(原因) —— 对齐 plan 的级别定 blocker/suggestion/nit
- 若发现人工此前纠正过的问题模式再次出现，写入 review.md 并在返回摘要中标注「重复问题」
```

### 4.6 fixing / done — 纠正与复盘（第二回流点）

- **fixing 结束**（blocker 清零）：把"本轮 blocker 是什么、根因是什么、人工是否介入" retain 进 `<产品线bank>`（技术类）或 `li-expertise`（口味类）。
- **done 时复盘**（orchestrator 执行，一次 reflect）：

```
reflect(bank_id=<产品线bank>, query="本需求(R-013345)实施中有哪些值得后续需求继承的经验和坑")
reflect(bank_id=li-expertise, query="人工在本需求中否决或纠正了哪些方案，背后的偏好是什么")
reflect 结果人工过目后，retain 回对应 bank（context="R-013345 复盘"）
```

reflect 不自动入库（防止 LLM 幻觉污染记忆），**人工过目是门禁**——这与现有"人工只卡门禁"哲学一致。

### 4.7 resume — 记忆辅助重建（可选）

`resume` 时除读 state.json + orchestrator-log.md 外，追加一次 recall 把该需求相关的历史决策贴回 context.md。**不替代**文件重建，只加速。

---

## 5. 思想蒸馏机制（本方案的核心价值）

### 5.1 四类高价值 retain 素材（按价值排序）

| 优先级 | 素材                       | 时机                         | 说明                                                      |
| ------ | -------------------------- | ---------------------------- | --------------------------------------------------------- |
| ★★★    | **人工否决 AI 方案的时刻** | 任何阶段发生即记             | "agent 建议 X，我否了选了 Y，因为…" —— 最难蒸馏、价值最高 |
| ★★★    | decisions.md 拍板理由      | plan_confirm / fixing 转人工 | 决策逻辑显式化                                            |
| ★★☆    | reviewer 纠正的重复问题    | fixing 后                    | 变成 checklist 类记忆                                     |
| ★☆☆    | 踩坑与排错结论             | coding/done                  | 技术债类记忆                                              |

规则：**写"为什么"，不写"是什么"**。`"用了 Zustand"` 是垃圾；`"此处选 Zustand 因无时间旅行需求且样板少"` 是资产。

### 5.2 Mental Models：把"人工思想"固化为常驻知识页

为 `li-expertise` 建三个常驻心智模型（定义一次，Hindsight 后台自动维护更新）：

```
Q1: 人工评审前端代码的核心标准是什么？（blocker 级 vs suggestion 级的界限）
Q2: 人工在组件设计和状态管理上的偏好与取舍逻辑是什么？
Q3: 人工认为一个"能验收"的需求交付物长什么样？
```

为每个 `<产品线bank>` 建一个：

```
Q: 这个仓库的架构约定和隐性规矩是什么？（新人须知）
```

读取心智模型是**纯数据库读、零 LLM 成本**，所以可以在每个 full 需求的 plan_confirm 门禁时让人工顺手过目一眼 Q1–Q3 的当前版本——这就是"思想对齐度"的可视化度量：**版本演进 = 思想在沉淀；长期不动 = 素材喂得不够**。

### 5.3 回写静态资产：让记忆改变 agent 行为

记忆不能只躺在 bank 里，要周期性固化回流水线的静态层（每月或每 10 个需求）：

```
reflect(bank_id=li-expertise, query="汇总近期所有否决与纠正记录，提炼成 reviewer 可用的评审 checklist")
→ 人工编辑后，合并进 .claude/agents/reviewer.md 的 rubric
→ 同步生成 docs/team-knowledge/review-checklist.md（knowledge pages 投影）
```

同理，`<产品线bank>` 的约定沉淀可回写为小游导师的知识页素材（见 §7）。**回写是人审的**，bank → 文件的方向必须经过人，文件 → bank 的方向可以自动（§4.4）。

### 5.4 对齐度量（怎么知道有效了）

| 指标                       | 怎么测                                        | 健康方向                                         |
| -------------------------- | --------------------------------------------- | ------------------------------------------------ |
| reviewer「重复问题」标注数 | review.md 统计                                | 逐月下降                                         |
| fixing 轮均 blocker 数     | state.json / review.md 统计                   | 同类需求下降                                     |
| M 类问题（记忆冲突）出现率 | questions.md 统计                             | 初期上升（记忆在起作用）、随后下降（记忆在更新） |
| 拍板 retain 命中率         | planning 阶段 recall 命中且被 plan 引用的比例 | 稳定 >50%                                        |
| plan_confirm 人工改动量    | 人工对 plan.md 的修改幅度                     | 同类需求下降                                     |

---

## 6. 接入方式选型：MCP 还是脚本？

| 方案            | 做法                                                                                                                                         | 优点                                                                                | 缺点                                                      | 建议             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------- |
| **A. MCP**      | Hindsight 服务端自带 `/mcp/{bank_id}/`，在 `.claude/settings.json` 配置后，planner/reviewer/orchestrator 直接获得 retain/recall/reflect 工具 | subagent 自主决定何时查记忆，最自然；agent md 只需在 tools 处加 `mcp__hindsight__*` | 工具面变大，可能干扰"视野最小化"；subagent 权限需逐一收紧 | **长期方案**     |
| **B. 剧本脚本** | orchestrator 用 Bash 调一个封装好的 `hindsight-memo.py`（recall/retain/reflect 三个子命令），结果落盘成小文件再让 subagent 读                | 与现有"只传路径"风格完全一致；subagent 工具面不变；行为完全受剧本控制               | 灵活性差，只有剧本规定的时点才触发                        | **推荐起步方案** |

**建议：Phase 1–2 用方案 B（脚本化、可审计），跑顺后 Phase 3 把 reviewer 切到方案 A（它需要最灵活的记忆访问）。**

方案 B 脚本骨架（`scripts/hindsight-memo.py`，相对 febot 家）：

```python
#!/usr/bin/env python
"""hindsight-memo.py recall|retain|reflect --bank X --query/--content Q [--context C] [--budget N]
输出：stdout 打印摘要；如设置 --out FILE，同时落盘（供剧本"只传路径"）。"""
import sys, json, argparse
from hindsight_client import Hindsight

c = Hindsight(base_url="http://localhost:8888")

p = argparse.ArgumentParser()
p.add_argument("op", choices=["recall", "retain", "reflect"])
p.add_argument("--bank", required=True)
p.add_argument("--query"); p.add_argument("--content")
p.add_argument("--context", default=""); p.add_argument("--budget", type=int, default=800)
p.add_argument("--out")
a = p.parse_args()

if a.op == "recall":
    r = c.recall(bank_id=a.bank, query=a.query, token_budget=a.budget)
elif a.op == "retain":
    r = c.retain(bank_id=a.bank, content=a.content, context=a.context)
else:
    r = c.reflect(bank_id=a.bank, query=a.query)

out = json.dumps(r, ensure_ascii=False, indent=2)
print(out[:3000])          # stdout 截断摘要
if a.out:
    open(a.out, "w", encoding="utf-8").write(out)
```

---

## 7. 与现有子项目的关系（不重复造轮子）

| 子项目                            | 与 Hindsight 的关系                                                                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fe_project_mentor（小游导师）** | 导师产物（项目理解文档、knowledge pages）是 `<产品线bank>` 的**优质初始 retain 素材**，一次批量入库；之后银行靠流水线的三操作滚动更新，导师不再重复输出静态文档 |
| **code-indexer**                  | 生成的 ProjectMap（路由/模块/API 域/组件图）同样可初始 retain 进产品线 bank，作为 planner 的架构上下文                                                          |
| **om / xiaoqian-manager**         | 与记忆无关，不动                                                                                                                                                |
| **swagger-mcp-server**            | 与记忆无关，不动；planner recall 到 API 域问题时仍走原 MCP                                                                                                      |

---

## 8. 分阶段落地与验收

### Phase 0：部署 + 静默蓄水（第 1–2 周）

- 部署服务端，建 bank（§2）
- 只做两件事：init 时 recall（§4.1）、done 时拍板 retain（§4.4）
- **验收**：recall 命中率有统计、拍板入库 ≥10 条、人工无感知负担

### Phase 1：planner/reviewer 增强（第 3–4 周）

- planner 双库 recall + M 类问题（§4.2）；reviewer 吃画像（§4.5）
- **验收**：plan.md 出现「相关约定」小节；review.md 出现「口味符合度」节；同类需求 fixing 轮 blocker 不升

### Phase 2：复盘闭环 + Mental Models（第 2 个月）

- done 复盘 reflect + 人工过目回流（§4.6）；建 3+1 个心智模型（§5.2）；对齐度量看板（§5.4）
- **验收**：Q1–Q3 版本开始演进；度量基线建立

### Phase 3：固化回写（第 3 个月起，常态化）

- reviewer rubric 回写（§5.3）；reviewer 切 MCP 直连；Knowledge Pages 投影到 `docs/team-knowledge/`
- **验收**：reviewer.md 的 rubric 有来自银行的真实条目；「重复问题」率环比下降

---

## 9. 风险与边界

| 风险                       | 缓解                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------- |
| 垃圾记忆污染检索质量       | 只 retain"有理由的拍板/否决"；reflect 结果人工过目才入库；每季度人工抽查 bank 抽样      |
| 记忆与现状冲突（记忆过期） | M 类问题机制（§4.2）显式暴露冲突，人工裁决后修正记忆                                    |
| 上下文膨胀拖累 subagent    | coder 不直连记忆；recall 一律带 token_budget 截断；「历史参考」只在 plan.md 摘要级      |
| 成本                       | retain 抽取用 haiku/mini 级模型；心智模型读取零成本；recall 频次有剧本控制              |
| 敏感信息入库               | 遵守现有"敏感文件人工审批"门禁 + 开启 per-bank Memory Defense（45 种密钥/PII 模式扫描） |
| 单机 Docker 数据安全       | `hindsight-data` volume 纳入本机备份；Hindsight 支持外部 PG，后续可迁                   |

---

## 10. 一页纸总结

> **问题**：流水线的文件传递解决了"过程可审计"，但 agent 每个需求都从零开始，人工的纠正和拍板随会话消亡——这就是"对不齐思想"。
>
> **做法**：本机 Docker 起 Hindsight，建 `li-expertise`（人工思想库）/ `febot-project`（流水线知识）/ 各产品线三个层级的 bank；在 init/planning/decisions/review/done 五个剧本时点插入 recall（注入）与 retain（回流）；用 Mental Models 把"人工评审标准"固化为常驻知识页；每月 reflect 提炼、人工回写 reviewer rubric。
>
> **纪律**：文件即接口不变；reflect 结果人工过目才入库；只记"为什么"不记"是什么"；coder 保持最小视野不直连记忆。
>
> **度量**：重复问题率、fixing 轮 blocker 数、拍板命中率、plan 人工改动量四个指标逐月盯。
