# {REQUIREMENT_ID} - 事实底稿（recon）

> **占位文件。** 由主对话在 planning 前执行 `node scripts/recon.mjs {REQUIREMENT_ID}` 覆盖生成。
>
> - 该脚本是**确定性**产出，不含 LLM 判断；内容全部来自 code-indexer 对主仓 `gitlab/<仓名>` 的扫描。
> - 同目录的 `recon-endpoints.txt` 是**完整接口清单**（一行一条 `文件<TAB>[METHOD<TAB>]URL[<TAB>fn]`），体积大但可直接 `grep <函数名>`；本文件只放样例。
> - **空白 = 索引器对该仓无产出，不等于该仓没有这段代码。**
> - 标「不支持（Vue2）」或「接口层未解析」时，位置指针必须由 planner 自行 Grep 确认，不得把空底稿当结论。

## §0 探活与可索引判定

## §1 路由表

## §2 业务模块

## §3 接口清单（按域）

## §4 静态告警

## §5 关键词候选命中（启发式，非结论）

## §6 组件反向引用（改动波及面）
