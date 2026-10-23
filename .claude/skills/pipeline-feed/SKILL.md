---
name: pipeline-feed
description: AgentTeam 前置喂食器——调用 scripts/feed.mjs 把 PM 计划文件或口头需求接入流水线(生成 docs/requirements/<别名>/、登记 tasks.md、写 state.json)。触发词:喂食、喂给流水线、feed、接入需求、把这个需求弄进流程。
---

# pipeline-feed / 需求接入（薄壳）

确定性文件操作全部在 `scripts/feed.mjs`。本 skill **只调用脚本、判断 tier、汇报**——不读写需求文件、不改配置、不动源码。

## 步骤

1. 在 febot 根目录调用：

   ```bash
   node scripts/feed.mjs --plan <计划文件> --json
   ```

   口头流程的临时文件由 orchestrator 先按 `.claude/commands/pipeline.md` 校验并落盘为 `xiaoqian-manager/data/temp/R-oral-<MMDDHHmm>.md`（别名取自文件名）。

2. **按退出码分流**，不做任何补救性写入：

   | code | 含义 | 动作 |
   | ---- | ---- | ---- |
   | 0 | 成功 / 已接入 | 继续第 3 步 |
   | 1 | 未预期异常 | 贴 stderr，停止 |
   | 2 | 映射未命中 | 把 `details.knownProducts` 给负责人，确认后回填 `projectMap`，不许猜 |
   | 3 | 门禁失败 | 贴 `details`（实际分支 / 脏文件），让负责人先提交；禁止 stash / checkout / commit |
   | 5 | 输入或格式不符 | 贴 `details.missing`，让来源方补；不许自行补标题、模块或描述 |
   | 6 | 配置 / 环境错误 | 贴 stderr，停止 |

3. 解析 stdout JSON：

   - `already:true` → 读 `statePath` 指向的 `state.json`，用其中的 `tier` 汇报；**不重新判 tier、不调用 `--set-tier`**。
   - `already:false` → 按第 4 步判 tier。

4. **tier 判定**（本 skill 唯一保留的判断）：

   - 输入：`title` + `description` + `assignment` + `tierHint`（`taskType` / `level` / `maxHour`）+ `repo`。
   - 改文案 / 样式 / 单文件小修、难度低 → `light`；新增组件、动 store / 表格 / 页面、多步任务 → `full`；拿不准标 `full`。
   - 理由必须具体（引用描述里的证据），不要复述分级规则。

5. 落盘 tier：

   ```bash
   node scripts/feed.mjs --set-tier <alias> --tier <light|full> --reason "<具体理由>"
   ```

   脚本会一次写完 `decisions.md`、`tasks.md`、`state.json`（`phase` 同步为 `planning` / `coding`）。

6. 汇报：别名、标题、模块、仓库、基准分支、门禁结果、tier 及理由、生成的文件、待确认项。

7. 到此为止：不切分支、不建 worktree、不克隆、不跑流水线、不动真实源码。

## 注意

- 别名、仓库、基准分支、门禁结果全部以脚本输出为准，不自行推导。
- `--dry-run` 只预演动作、不落盘，也不会产生 `state.json`。
- 计划文件是临时文件：任务ID流程由 xiaoqian-manager 生成；口头流程在 done 阶段删除。
