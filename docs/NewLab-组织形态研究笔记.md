# New New Lab：使命驱动如何"顺便赚钱"

> 整理自与 AI 助手的探讨（2026-10）。
> 核心命题：使命驱动、自下而上的组织（New Lab）很难活到赚钱阶段，OpenAI 的成功主要是踩中风口 + 疯狂融资。那么如何让使命驱动更容易走到"顺便赚钱"？

---

## 核心结论

**"顺便赚钱"从来不是运气的副产品，而是设计出来的副产品。** 最佳样板是 DeepMind → Isomorphic Labs。

---

## 理论根基：两种模式的组合

这套机制的配方 = **OpenAI 式新范式 + 小张任务模式**：

| 组成 | 来自哪里 | 提供什么 |
|---|---|---|
| **OpenAI 式新范式**（New Lab） | 使命驱动、自下而上、能力代差、范式天花板 | 使命轨的灵魂：选题逻辑（两轴过滤）、能力代差判断、敢碰长周期难题 |
| **小张任务模式**（任务单元） | 1 人 + Agent 端到端负责任务、责权利对等、结果可验收 | 生意轨的骨架：任务制交付、对人负责、按里程碑结算 |

四个机制的分工：

- 机制 1（使命选址）和机制 2（副产品接口化）→ **新范式侧**：决定"研究什么、产出什么"
- 机制 3（双轨分拆）→ **两种模式的缝合处**：使命轨跑新范式，生意轨跑任务模式，资本再耦合
- 机制 4（里程碑变现）→ **任务模式侧**：把使命的中间态切成可验收、可结算的任务包

---

## 四个机制

### 1. 使命选址：挨着钱流做研究

把使命选在已经存在的钱流旁边，而不是先定使命再找钱。

- DeepMind 的使命是 AGI，但它研究蛋白质结构（AlphaFold）——**制药行业每年真金白银为"找到一个好靶点"付几十亿美元**，这是现成的付费需求
- 反例：AMI（杨立昆）做开源世界模型，使命极正，但离任何钱流都远，只能靠融资续命
- **过滤条件（两轴交叉，不是单轴）**：
  - 轴一：需求真实性——"这个方向，今天有没有人已经在花钱解决？"
  - 轴二：能力代差——"没解掉的原因，是问题本身无解（A 类，躲开），还是旧范式缺关键能力、新范式刚刚补上（B 类，首选）？"
  - B 类里"难"反而是加分项——好解的题早被在位者吃完了。AlphaFold 就是标杆：蛋白质结构悬了 50 年、钱一直在流，不是无解，是只有深度学习范式下才可计算
  - **防幻觉测试**：给每个选题做原型，验证能否对现有方案做出 10 倍级改进（便宜/快/准任一维度）。做不出 10 倍，说明所谓"代差"是幻觉，这题对你是 A 类

### 2. 副产品接口化：研究成果第一天就是"可卖单元"

使命的产出物不要默认是论文，要默认设计成商品形态：

- AlphaFold 的产物不是一篇 Nature 论文，是一个**药物设计引擎（IsoDDE）+ 可授权的合作管线**
- Axiom Math 做数学证明，副产品恰好是芯片验证和 AI 训练急需的形式化能力——有买家排队
- **落地规则**：每个研究任务立项时就必须写清楚"它的副产品以什么形态卖给谁"——API、引擎授权、模型权重、里程碑合同，任选其一

### 3. 双轨分拆结构：使命和生意解耦，资本再耦合

Isomorphic 的做法：

```
Alphabet
 ├── Google DeepMind   ← 使命轨：AGI、纯研究、自下而上、不背收入
 └── Isomorphic Labs   ← 生意轨：卖药、签药企合同、任务制交付
      （平级兄弟公司，同一个 CEO，两套账本）
```

- **使命轨保持 New Lab 纯度**：好奇心驱动、无 KPI、不考核
- **生意轨回到任务制**：对客户结果负责、按里程碑交付
- **资本上再耦合**：Isomorphic 拿到 21 亿美元 B 轮 + 礼来/诺华近 30 亿美元合作订单（首付 + 里程碑 + 销售分成），**一分钱药没进人体，使命 already 值上百亿美元**——不用等到使命完成，使命的**中间态**就有人付费

### 4. 里程碑变现：不熬到终局，中途就卖"站票"

在每个阶段设一个"可变现检查点"：

- 阶段 1（方法验证）→ 卖**合作开发合同**（首付 + 里程碑）
- 阶段 2（系统成型）→ 卖**引擎授权 + 分成**
- 阶段 3（产品进临床/上线）→ 才是股权价值兑现

另配一条：**资本结构混合**——不只靠股权融资，用战略合作（Anthropic–Amazon 云合同模式）、里程碑付款、科研经费、授权收入的组合。

---

## 新旧对照

| | New Lab（初代） | New New Lab（优化版） |
|---|---|---|
| 任务来源 | 纯自下而上（好奇心） | 自下而上选题 + "有人付费吗"过滤 |
| 产出物 | 论文/模型 | 论文/模型 + **可售卖单元** |
| 结构 | 单轨，全押使命 | 双轨：使命轨 + 生意轨 |
| 变现 | 熬到终局 or 卖身 | 里程碑中途变现，使命未完先赚钱 |

一句话总结：**使命赚"名"，副产品赚"钱"**——只要你把使命放在钱流旁边、把产出做成商品、把中间态标好价，使命驱动的组织可以比纯商业公司更赚钱，因为它敢碰别人不敢碰的长周期问题。

---

## 参考来源

- [曾鸣最新访谈：2026，像极了1995 - 网易新闻（笔记侠整理）](https://c.m.163.com/news/a/L613JL48051482KS.html)
- [Isomorphic Labs secures $2.1 Billion funding - 官网](https://www.isomorphiclabs.com/press/isomorphic-labs-funding)
- [Isomorphic Labs Raised $2.1 Billion — Without One Drug In Humans](https://theplanettools.ai/blog/isomorphic-labs-2-1-billion-series-b-ai-drug-design-engine-may-2026)
- [DeepMind's Nobel Playbook: From AlphaFold to IsoDDE - Anjin](https://www.anjin.digital/blog-posts/deepmind-nobel-ai-breakthrough-playbook)
- [麻省理工科技评论：美国三家最强AI公司，怎么都去搞生命科学了？](https://www.mittrchina.com/news/detail/16533)
- [复刻"半导体时刻"？AI制药版的"瓶颈交易"正在成形 - 华尔街见闻](http://m.toutiao.com/group/7693528468268663334/)
- [Anthropic: The Economics of an AI Pioneer - Tema](https://temaetfs.com/insights/anthropic-the-economics-of-an-ai-pioneer)
- [Axiom: AI Mathematician Scores Perfect on Putnam - Druckfin](https://www.druckfin.com/en/articles/axiom-ai-mathematician-scores-perfect-on-putnam-as-series-a-hits-16b-valuation-20260420)
