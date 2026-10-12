# {REQUIREMENT_ID} - 需求上下文

## 需求标题

（PM 卡标题，commit message 以此为准，后续追溯用）1

## 需求描述（一句话）

（一句话概括需求，供 planner 快速理解，plan.md 以此为锚；来源：PM 卡标题/问题描述浓缩）

## 需求来源

- tasks.md 条目：
- 关联文档/入口：

## 需求描述（全文）

（张三或主对话从 tasks.md + 需求文档整理，供 planner 读，不带对话历史）

## 关联代码位置

（可选，若有已知入口）

## 历史参考（Hindsight 注入，可选）

（init 阶段 orchestrator 执行 `hindsight-memo.py recall` 后，把命中的历史拍板/同类需求决策摘要追加在此，
注明来源需求 ID；**没有命中就整节留空/删掉，禁止编造**。planner 只读摘要，不直连记忆。）
