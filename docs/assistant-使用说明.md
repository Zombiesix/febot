# 助手层：使用说明

> 给同事看的操作手册。设计原因见 `docs/assistant-agent-建设计划.md`,分步做法见 `docs/assistant-agent-实施步骤.md`。

## 它是什么

在 Claude Code 里随时叫起来的**业务助手**:问什么答什么、**说存才存**、答不上就直接说答不上。

三件事,零主动性:

| 职责 | 怎么用 |
| --- | --- |
| **答业务** | `/assistant <问题>`,例如 `/assistant 导管管理是干嘛的` |
| **存文档** | 明说「把这条存进 iho-icis-ui」,它才存 |
| **查看/清理** | `/assistant status`、`/assistant list`、`/assistant delete <id>` |

**它不做**:不主动讲解、不追问、不考试式提问、不自动入库、不改目标仓源码。

## 前置:Hindsight 得在跑

文档层是本地 Docker 里的 Hindsight(API `:8888`,UI `:9999`)。

```bash
docker ps --filter name=hindsight      # 看有没有在跑
curl -s http://localhost:8888/health   # 期望 {"status":"healthy",...}
```

没起的话按 `docs/hindsight-接入方案.md` §3 起容器。**没起也能答题**(事实层现算),但记忆不可用——
助手会明确告诉你「文档层不可用」,不会假装没存过。

## 快速上手

### 1. 出项目地图(每个仓一次)

```
/assistant init iho-icis-ui
```

等价于 `yarn assistant:map gitlab/iho-icis-ui`,产出 `docs/assistant/iho-icis-ui/map.md`:
路由 → 中文业务名、模块、API 域、store、权限、存储、告警。

> 地图是**时点快照**,可能过期;权威结论以现算为准。

### 2. 问业务

```
/assistant 导管管理是干嘛的
/assistant 这个 store 字段谁改的
/assistant 权限在哪判的,为什么拦不住
/assistant folder gitlab/iho-icis-ui/src/page/conduit-manage
```

答的是**业务语言**,不贴大段代码;代码出处(`文件:行`)附在末尾。

### 3. 存结论(要你明说)

```
把这条存进 iho-icis-ui
```

助手会判断值不值得存(见 `.claude/skills/assistant/references/what-to-store.md`),
**没有 `evidence` 的猜测直接丢弃**,存完回报「已存到 `assistant-iho-icis-ui`」+ 落库 `id`。

值得存的:业务规则及原因、字段的业务含义、命名不一致映射、状态机的业务语义、历史决策与坑、领域黑话。
不值得存的:路由表 / API 清单 / store 字段清单(会过期,现算就行)。

### 4. 查看与清理

```
/assistant status              # Hindsight 在线?各 bank 存了多少条?
/assistant list --repo iho-icis-ui --days 7
/assistant delete <id>         # 软退休:不再被召回,可 restore 恢复
```

## 命令行速查

```bash
# 事实层(现算,不落盘)
node code-indexer/bin/cli.mjs map    gitlab/<仓>              # 项目全貌
node code-indexer/bin/cli.mjs trace  gitlab/<仓> <模块|路由>    # 业务链路
node code-indexer/bin/cli.mjs trace-state gitlab/<仓> <store>[.<字段>]
node code-indexer/bin/cli.mjs trace-event gitlab/<仓> <组件> <事件>
node code-indexer/bin/cli.mjs channels gitlab/<仓> --kind permission|storage
node code-indexer/bin/cli.mjs modules gitlab/<仓> [<模块>]
node code-indexer/bin/cli.mjs search  gitlab/<仓> <词>
node code-indexer/bin/cli.mjs stats   gitlab/<仓>              # 探活

# 文档层(记忆)
yarn assistant:memo status --all
yarn assistant:memo recall --bank assistant-iho-icis-ui --query "导管管理 命名"
yarn assistant:memo retain --bank assistant-iho-icis-ui --content "<结论>" \
     --repo iho-icis-ui --module conduit-manage --evidence src/x.ts:6 --date 2026-10-10
yarn assistant:memo list   --bank assistant-iho-icis-ui --repo iho-icis-ui --days 7
yarn assistant:memo patch  --bank <bank> --id <id> --text "<改后的结论>"
yarn assistant:memo delete --bank <bank> --id <id>     # 软退休(可逆)
yarn assistant:memo restore --bank <bank> --id <id>
yarn assistant:memo clear  --bank <bank> --yes         # ⚠️ 清空整个 bank

# 自检
yarn assistant:probe        # 端到端探针(可加 --reset 先清空探针库)
yarn assistant:map gitlab/<仓>
```

## 排错

| 现象 | 原因 / 怎么办 |
| --- | --- |
| `✗ Hindsight 不可达` | 容器没起。`docker ps --filter name=hindsight`;此时**存不进也查不到**,别当成「本来就没结论」 |
| 存完立刻 `list` 只看到 1 条 | 派生条(observation)是**异步**的,稍等再看;`status` 的「待整理」数字会告诉你还有多少在排队 |
| 答案里没有 `文件:行` | 该条是**没带 evidence 的旧数据**;`list` 翻到它补 `--evidence`,或用 `patch` 补 |
| `list --repo X` 出条目数忽多忽少 | 已用服务端 `tags_match=all_strict` 过滤;若条目明显不对,查是不是存的时候没带 `--repo` |
| 索引器对某仓返回 0 路由/端点 | **先别接助手**。跑 `stats` + `warnings` 核对,为 0 且无解释时先补索引器(否则助手会说「这个模块没有接口」= 静默撒谎) |
| 目标仓是 Vue2 | 索引器目前只支持 Vue3,需另做适配器 |

> Git Bash 下以 `/` 开头的参数会被 MSYS 转成 Windows 路径,需要时加 `MSYS_NO_PATHCONV=1` 前缀。

## 边界(硬规矩)

- 只读目标仓,产物只写 `docs/assistant/`;不 push、不改目标仓源码。
- 不把源码批量喂 LLM;对话中只按需 `Read` 少量文件补行号。
- 不读敏感文件:`.env*`、`token.temp`、`~/.ssh/*`、`~/.aws/*`。
- 不往流水线 bank(`li-expertise` / `febot-project`)写业务知识——那是研发流程记忆。
- 事实每次现算,`docs/assistant/` 下的地图只是快照。