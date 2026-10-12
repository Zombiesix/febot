# 助手层 Agent — 实施步骤

> 配套 `docs/assistant-agent-建设计划.md`（讲**为什么**）；本文件只讲**怎么做**，按依赖顺序排。
> **不列工期。** 每一步都给出：改哪个文件 → 跑什么命令 → 怎么算通过。

---

## 0. 项目架构图

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  用户                                                                           │
│   ① 问：「导管管理是干嘛的？」        ② 存：「把这条存进 iho-icis-ui」             │
└───────────────────────────────────┬────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────────────┐
│  入口层   /assistant      .claude/skills/assistant/                             │
│  SKILL.md ── 解析意图 · 编排下层 · 用人话回话                                    │
│  references/service-protocol.md（只答不问） · references/what-to-store.md       │
└──────────┬─────────────────────────────────────────────────────────┬───────────┘
           │ ① 问：查事实                                             │ ② 存：落文档
           ▼                                                         ▼
┌──────────────────────────────────────────┐  ┌──────────────────────────────────────────┐
│  事实层   每次现算 · 不落盘 · 不喂 LLM      │  │  文档层   按需存 · 只存"读不出来的"        │
│                                          │  │                                          │
│  code-indexer v2                 │  │  Hindsight   http://localhost:8888       │
│    map     <repo>           项目全貌      │  │    recall   → 查已存结论                   │
│    trace   <repo> <模块>    业务链路      │  │    retain   → 存（带溯源元数据）           │
│    trace-event/state      事件/store     │  │    list     → 翻看                        │
│    channels/modules      通道/模块关系    │  │    delete   → 清理                        │
│    search/warnings/stats    检索/探活     │  │                                          │
│                                          │  │  bank:  assistant-<repo>                  │
│  纯静态 · 不喂 LLM · 结果不落盘            │  │         assistant-shared                  │
└───────────────────┬──────────────────────┘  └───────────────────┬──────────────────────┘
                    │                                             │
                    └──────────────────┬──────────────────────────┘
                                       ▼
                  ┌──────────────────────────────────────────────┐
                  │  助手层   合并结果 → 业务语言 → 答案             │
                  │  · 答不上 → 直说答不上（不追问 · 不编造）        │
                  │  · 代码出处（文件:行）只附末尾，不挡正文         │
                  └──────────────────────────────────────────────┘
```

### 0.1 两条数据流（同一张图的时序版）

```
① 问                                       ② 存
─────────────                              ─────────────
用户提问                                    用户明说「存」
   │                                          │
   ▼                                          ▼
/assistant 解析                              /assistant 解析
   │                                          │
   ├─▶ recall(assistant-<repo>)  命中? ─┐      ├─▶ 判断值不值得存（§what-to-store.md）
   │                                   │      │      └─ 无 evidence → 直接丢弃
   ├─▶ xiaoyou-index 按问题选命令      │      │
   │  map/trace/trace-state/…（现算）  │      ▼
   │                                   │   retain(assistant-<repo>,
   ▼                                   ▼      content, context=repo/module/
合并：记忆结论 + 事实现算            evidence/source/date)
   │                                          │
   ▼                                          ▼
业务语言答案 + 末尾附 文件:行            回报「已存到 <bank>」
```

### 0.2 文件落点图

```
febot/
├─ .claude/
│  ├─ skills/assistant/
│  │  ├─ SKILL.md                    ← 入口剧本（P2）
│  │  └─ references/
│  │     ├─ service-protocol.md       ← 只答不问（P2）
│  │     └─ what-to-store.md           ← 存/不存参考（P3）
│  └─ agents/assistant-qa.md         ← 可选 subagent（P2）
├─ scripts/
│  ├─ assistant-probe.mjs            ← P0 探针
│  ├─ assistant-memo.mjs             ← P0 CLI（recall/retain/list/delete）
│  ├─ hindsight-memo.py              ← 已有，扩展参考
│  └─ ensure-banks.py                ← 已有，扩 assistant bank
├─ docs/assistant/<repo>/
│  ├─ map.md                         ← P1 中文项目地图
│  └─ glossary.md                    ← P1 术语表
└─ docs/assistant-agent-实施步骤.md   ← 本文件
```

---

## 1. 步骤总览（按依赖顺序）

| #    | 阶段   | 步骤                                                        | 产物                           |
| ---- | ------ | ----------------------------------------------------------- | ------------------------------ |
| P0-1 | 文档层 | 建 `assistant-shared` + `assistant-<repo>` 两个 bank        | bank 列表                      |
| P0-2 | 文档层 | 写探针，验通 retain→recall + list/patch/delete + tags       | `scripts/assistant-probe.mjs`  |
| P0-3 | 文档层 | 写 CLI：recall/retain/list/delete + 元数据拼装              | `scripts/assistant-memo.mjs`   |
| P0-4 | 文档层 | 根 `package.json` 挂 `assistant:*` 脚本                     | yarn scripts                   |
| P0-5 | 文档层 | `/assistant status` 骨架（显式报在线，**不许静默**）        | status 入口                    |
| P1-1 | 事实层 | skill `init`：跑 `map` 出项目地图                           | `docs/assistant/<repo>/map.md` |
| P1-2 | 事实层 | 地图渲染成中文骨架（业务名 map 已带 `label`，缺的留空待补） | 同上                           |
| P1-3 | 事实层 | 文件夹粒度定成按需 `Read`                                   | 无新文件                       |
| P1-4 | 事实层 | `warnings` 降级为可选展示（不做提问队列）                   | `--warnings` 开关              |
| P2-1 | 助手层 | 写 `SKILL.md`（入口剧本）                                   | skill                          |
| P2-2 | 助手层 | 写 `references/service-protocol.md`（只答不问）             | 协议                           |
| P2-3 | 助手层 | 答题流程：先 `recall`，再事实现算，最后合并                 | 流程                           |
| P2-4 | 助手层 | `store` 指令：说存就存                                      | 流程                           |
| P2-5 | 助手层 | （可选）抽 `assistant-qa` subagent                          | agent.md                       |
| P3-1 | 清理   | `store` 元数据规范落地                                      | context 模板                   |
| P3-2 | 清理   | `/assistant list`                                           | list CLI                       |
| P3-3 | 清理   | `/assistant delete` / `patch`                               | 清理入口                       |
| P3-4 | 清理   | `/assistant status` 完整版                                  | status 入口                    |
| P4-1 | 验收   | `iho-icis-ui` 端到端跑通                                    | 验收记录                       |
| P4-2 | 验收   | 换一个仓冷启动                                              | —                              |
| P4-3 | 验收   | 写 `docs/assistant-使用说明.md`                             | 文档                           |

### 1.1 执行记录（2026-10-10 一次走完 P0–P4）

| #        | 状态 | 产物 / 证据                                                                                                                                                                 |
| -------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1     | ✅   | 建 `assistant-shared` / `assistant-iho-icis-ui` / `assistant-probe` 三个 bank（PUT 幂等）                                                                                   |
| P0-2     | ✅   | `scripts/assistant-probe.mjs`；`yarn assistant:probe` 全绿。**4 处契约被实测推翻**，见文末附录                                                                              |
| P0-3     | ✅   | `scripts/assistant-memo.mjs`：recall/retain/list/patch/delete/restore/clear/stats/status/health，**硬报错**非软降级                                                         |
| P0-4     | ✅   | 根 `package.json` 挂 `assistant:probe` / `assistant:memo` / `assistant:map`                                                                                                 |
| P0-5     | ✅   | `assistant-memo.mjs status [--bank B \| --all]`：服务停掉时打 ⚠️ 且 exit 1（已用死端口复验）                                                                                |
| P1-1/1-2 | ✅   | `scripts/assistant-map.mjs`；已出 `docs/assistant/iho-icis-ui/map.md`（路由 11 / 端点 161 / 模块 16）与 `docs/assistant/iho-cssd-ui/map.md`（路由 14 / 端点 237 / 模块 14） |
| P1-3     | ✅   | 写进 `SKILL.md` §3：`folder` 分支按需 `Read`，不接 folder-docs、目标仓零新增文件                                                                                            |
| P1-4     | ✅   | `warnings` 默认只出计数；`assistant-map.mjs --warnings` 才展开                                                                                                              |
| P2-1~2-4 | ✅   | `.claude/skills/assistant/SKILL.md` + `references/service-protocol.md` + `references/what-to-store.md`（skill 已注册、可调起）                                              |
| P2-5     | ✅   | `.claude/agents/assistant-qa.md`                                                                                                                                            |
| P3-1~3-4 | ✅   | CLI 已含 list / patch / delete / status；分发写在 `SKILL.md` §1                                                                                                             |
| P4-1     | ✅   | 存「导管管理三处命名不一致」→ **独立进程** recall 命中，带 `ev:` 出处                                                                                                       |
| P4-2     | ✅   | `iho-cssd-ui` 冷启动：不改一行代码出地图                                                                                                                                    |
| P4-3     | ✅   | `docs/assistant-使用说明.md`                                                                                                                                                |

**与计划书的差异（都是实测逼出来的，不是口味选择）**：

1. retain 的溯源信息原计划塞 `context` 字符串 → 实测 `context` 时有时无、**不可作存储**，改塞 `metadata` 并**冗余进 `tags`**（`repo:` / `module:` / `ev:`）。
2. `delete <id>` 原计划用 `DELETE .../memories` → 实测那是**清空整个 bank**，改为 `PATCH {"state":"invalidated"}`（可逆软退休）。
3. `patch` 的字段名是 `text`，不是 `content`。
4. `tags` 服务端过滤**可用**，但默认 `any` 会连带捞出无标签条目，**必须传 `all_strict`**。
5. 多了一个计划外文件 `scripts/assistant-map.mjs`：把 `map` 的 JSON 确定性渲染成中文 md，免得每次让模型重排 9KB JSON。

---

## 2. P0 — 文档层打通

### P0-1 建两个 bank

**改**：扩 `scripts/ensure-banks.py`（加一个 `--assistant <repo>` 分支），或新写 `scripts/ensure-assistant-banks.py`。

**接口**（`ensure-banks.py` 已实测）：

```
PUT http://localhost:8888/v1/default/banks/assistant-shared        body {}
PUT http://localhost:8888/v1/default/banks/assistant-iho-icis-ui   body {}
→ 409 = 已存在（幂等，视为成功）
```

**通过**：`GET http://localhost:8888/v1/default/banks` 能列出两个新 bank。

---

### P0-2 探针 `scripts/assistant-probe.mjs`

一个脚本，一次跑完四件事，**全部打印真实结果**（不软降级）：

1. `retain` 一条测试记忆 → `recall` 同一关键词，**必须命中**。
2. 验 `GET  .../{bank}/memories/list` —— 能列出刚存的条目，拿到 `id`。
3. 验 `PATCH .../{bank}/memories/{id}` —— 改一条，再 list 确认变了。
4. 验 `DELETE .../{bank}/memories`（或 `.../{id}/observations`）—— 删掉测试条目。
5. **验 `tags` 过滤**：retain 时带 `tags:[repo]`，看 list 能否按 tag 服务端过滤
   （决定 `/assistant list --repo X` 是服务端筛还是客户端筛）。

**通过**：往返命中；list/patch/delete 全通；tags 过滤能力**明确**（能或不能，都要有结论）。

---

### P0-3 CLI `scripts/assistant-memo.mjs`

**抄 `scripts/hindsight-memo.py` 的形状**（同一套 REST），但两处**故意不同**：

|          | `hindsight-memo.py`（流水线）  | `assistant-memo.mjs`（助手）                             |
| -------- | ------------------------------ | -------------------------------------------------------- |
| 失败行为 | **软降级**：静默返回空、exit 0 | **硬报错**：stderr 明确写「Hindsight 不可达」+ 非 0 退出 |
| 理由     | 不阻塞流水线                   | 防"以为在存其实没存"                                     |

**子命令**：

```
assistant-memo.mjs recall --bank B --query Q [--budget low|mid|high]
assistant-memo.mjs retain --bank B --content C --repo R [--module M] [--evidence F:L] [--source chat] [--date YYYY-MM-DD]
assistant-memo.mjs list   --bank B [--repo R] [--days N]
assistant-memo.mjs patch  --bank B --id ID [--content C] [--confidence low]
assistant-memo.mjs delete --bank B --id ID
assistant-memo.mjs stats  --bank B
```

`retain` 内部把 `--repo/--module/--evidence/--source/--date` 拼成 `context` 字符串（§4.2 模板）；
若 P0-2 证明 `tags` 可服务端过滤，则**同时**写 tags。

**通过**：带元数据写入；`list --repo X` 能列出；`patch`/`delete` 单条生效。

---

### P0-4 挂 yarn 脚本

**改**：根 `package.json` 的 `scripts`：

```json
"assistant:probe": "node scripts/assistant-probe.mjs",
"assistant:memo":  "node scripts/assistant-memo.mjs"
```

**通过**：`yarn assistant:probe` 能跑。

---

### P0-5 `/assistant status` 骨架

**读**：`GET .../{bank}/stats`（条目数）+ `POST .../{bank}/health/llm`（健康）。

**必须**：服务没起时**显式报警**——打印「⚠️ Hindsight 不可达，记忆不可用」，而不是静默返回 0 条。

**通过**：把 Hindsight 停掉再跑，能看到明确告警。

---

## 3. P1 — 事实层

### P1-1 skill `init`：出项目地图

**注意**：索引器的 `<repo>` 是**文件系统路径**（源码里 `path.resolve(repoPath)`），不是仓名。
Git Bash 下传 `/route-path` 形式参数会被 MSYS 转成 Windows 路径，需加 `MSYS_NO_PATHCONV=1` 前缀。

```
node code-indexer/bin/cli.mjs map <目标仓的绝对/相对路径>
```

**map 一次给全 v2 数据**：路由（含中文 `label`）/ 模块 / API 域 / store / 权限（含 `definedInRepo`）/ 存储通道 / 告警——渲染时一并纳入，不用逐个命令拼。

**改**：`SKILL.md` 里写 `init` 子命令，把输出落到 `docs/assistant/<repo>/map.md`。

**通过**：路由 / 模块 / API 域 / 端点与人工核对一致；**端点与路由非零**（11 仓已验收，新仓为 0 且无 warnings 解释时先补索引器）。

---

### P1-2 地图渲染成中文骨架

把 `map` 的 JSON 渲染成中文表格：**模块清单 + 中文业务名**。
业务名**索引器已抽好**：`routes[].label` / `modules[].label` 直接用（11 仓 257 条路由 194 条带中文业务名），缺的留空待补——本步是**渲染工作，不是抽取工作**。

**通过**：每个模块有中文业务名（label 为 null 的如实标「待补」），不再只有目录名。

---

### P1-3 文件夹粒度：按需 `Read`

**改**：`SKILL.md` 加 `/assistant folder <路径>` 分支 —— 直接 `Read` 该文件夹（必要时先 `trace` 缩小范围），
当场用业务语言答；值得留的由用户 `store` 进 Hindsight，**不落派生文档**。

**通过**：问一个文件夹，答得出业务；目标仓**无新增文件**。

---

### P1-4 `warnings` 降级为可选展示

**改**：`SKILL.md` 里 `warnings` 只在用户加 `--warnings` 时展示；
**不做**旧计划的「告警 → 提问队列」。告警只作为一句事实提示，**不要求用户回答**。
实际 kind（v2）：`naming-mismatch` / `orphan-module` / `orphan-route` / `orphan-api-domain` / `orphan-store` / `orphan-emit` / `multi-writer` / `dynamic-routes` / `dynamic-children` / `dynamic-storage-key` / `unresolved-component` / `unmatched-event-binding`。

**通过**：默认不出现；`--warnings` 才显示。

---

## 4. P2 — 助手层

### P2-1 写 `SKILL.md`（入口剧本）

`.claude/skills/assistant/SKILL.md`，frontmatter `name: assistant` + `description`（触发词：问业务 / 存文档 / status / list）。
正文：解析意图 → 分发到 `init` / 问 / `folder` / `store` / `status` / `list` / `delete`。

**通过**：`/assistant` 可调起。

---

### P2-2 写 `references/service-protocol.md`

**这是与旧「导师」框架的分界线**，必须写死：

- **问什么答什么**，直接给结论，不铺垫、不引导。
- **不追问**：不反问用户、不"先问后讲"、不生成要用户回答的问题。
- **不编造**：答不上直接说「不知道」，并给验证方法（读哪个文件 / 问谁）。
- **只说人话**（铁律二）：不贴大段代码、不用执行流程组织答案、不堆变量名。
- 代码出处（`文件:行`）**只附末尾**，不挡正文。

**通过**：讲解正文无大段代码；**全程不反问用户**。

---

### P2-3 答题流程

固定顺序，写进 `SKILL.md`：

1. **先 `recall`**（`assistant-memo.mjs recall --bank assistant-<repo> --query <问题>`）。
2. **命中** → 引用，注明来源（bank + 日期）。
3. **未命中** → 走事实层现算，按问题类型选命令：

   | 用户问的是…                       | 用                                                                                       |
   | --------------------------------- | ---------------------------------------------------------------------------------------- |
   | 这个模块/页面是干嘛的             | `trace <repo> <模块>`（路由→组件树→API→store/事件/权限/存储一次给全）                    |
   | 这个 store 字段/状态谁读谁写      | `trace-state <repo> <store>[.<field>]`                                                   |
   | 这个事件谁发的、谁接的            | `trace-event <repo> <组件> <事件>`                                                       |
   | 权限在哪判的、为什么拦不住        | `channels <repo> --kind permission`（看 `definedInRepo`：false = 判定在 qiankun 宿主仓） |
   | 数据存哪了（localStorage/cookie） | `channels <repo> --kind storage`                                                         |
   | 模块和谁有牵连                    | `modules <repo> [<模块>]`                                                                |
   | 找个符号/端点/路由                | `search <repo> <词>`                                                                     |

4. 合并 → 业务语言 → 答案；代码出处附末尾。
5. 都没查到 → **直说不知道**，不追问；索引器给出「说不清」（带原因 + evidence）的也**照实转述原因**，不脑补。

**通过**：第二次问同一模块，能引用上次存的结论，**不必重读代码**。

---

### P2-4 `store` 指令

用户明说「存一下 / 存进 X 仓」才触发。流程：

1. 判断值不值得存（`references/what-to-store.md`）；**无 `evidence` 的猜测直接丢弃**。
2. 调 `assistant-memo.mjs retain`，补全 `repo/module/evidence/source/date`。
3. **回报**「已存到 `assistant-<repo>`」。

**通过**：说存就存；助手**不会自己存**东西。

---

### P2-5 （可选）抽 `assistant-qa` subagent

`.claude/agents/assistant-qa.md`：隔离上下文，只传路径、只收摘要，工具面受限（`Read`/`Glob`/`Grep`/`Bash`）。
用途：答案很长时，主会话不被淹没。

---

## 5. P3 — 按需存 + 查看/清理

| 步骤 | 做什么                                         | 通过                       |
| ---- | ---------------------------------------------- | -------------------------- |
| P3-1 | `store` 元数据规范落地（§4.2 的 context 模板） | 每条可溯源到 `文件:行`     |
| P3-2 | `/assistant list [--repo X] [--days N]`        | 列出近期条目               |
| P3-3 | `/assistant delete <id>`（+ `patch` 改单条）   | 删掉一条后不再被召回       |
| P3-4 | `/assistant status` 完整版                     | 一眼看出「到底存没存进去」 |

---

## 6. P4 — 端到端验收

| 步骤 | 做什么                                                                  | 通过                                   |
| ---- | ----------------------------------------------------------------------- | -------------------------------------- |
| P4-1 | 拿 `iho-icis-ui` 走全程：`init` → 问 3 个模块 → 说存 → **新开会话再问** | 第二次更准：引用上次结论、无需重读代码 |
| P4-2 | 换一个仓冷启动                                                          | 不改代码可用                           |
| P4-3 | 写 `docs/assistant-使用说明.md`                                         | 同事照做即可用                         |

验收标准（8 条）见 `docs/assistant-agent-建设计划.md` §6。

---

## 附：已实测接口契约（写代码时照抄）

> ⚠️ 本节 2026-10-10 按 `/openapi.json` + 真跑**逐条复验**，修正了原契约的 4 处错误。
> 复验脚本：`scripts/assistant-probe.mjs`（`yarn assistant:probe`）。

```
BASE = http://localhost:8888/v1/default/banks

建 bank      PUT    {BASE}/{bank}                        body {}
retain       POST   {BASE}/{bank}/memories               {"items":[{"content":"…","metadata":{…},"tags":[…],"timestamp":"…"}]}
recall       POST   {BASE}/{bank}/memories/recall        {"query":"…","budget":"low|mid|high","tags":[…],"tags_match":"all_strict"}
reflect      POST   {BASE}/{bank}/reflect                {"query":"…"}
list         GET    {BASE}/{bank}/memories/list          支持 tags/tags_match/state/time_field/start_date/limit
read one     GET    {BASE}/{bank}/memories/{id}
patch one    PATCH  {BASE}/{bank}/memories/{id}          {"text":"…","state":"invalidated|valid","reason":"…"}
软删除       PATCH  {BASE}/{bank}/memories/{id}          {"state":"invalidated"}   ← 删单条用这个
清空整库     DELETE {BASE}/{bank}/memories               ⚠️ 不是删单条！删掉该 bank 全部 unit
health       GET    /health  ·  GET /version             bank 级 POST {bank}/health/llm 在本实例被禁用
stats        GET    {BASE}/{bank}/stats
tags         GET    {BASE}/{bank}/tags
```

### 实测修订（2026-10-10，推翻了原设计的 4 条假设）

| #   | 原假设                                     | 实测                                                                                                                                               | 后果                                                                                                           |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | `delete` = `DELETE {bank}/memories` 删单条 | 那是**清空整库**（`{"deleted_count":N}`，不可逆）                                                                                                  | 删单条改用 `PATCH {"state":"invalidated"}`：软退休、list/recall 均排除、`state=valid` 可恢复                   |
| 2   | 溯源元数据拼进 `context` 字符串            | 一条 retain 落 **2 个 unit**：`world` + 派生 `observation`；`context`/`metadata` **只在 world 上有**，observation 上恒为空；`context` 更是时有时无 | 溯源进 `metadata`（逐字存活，且 recall 也回传）；**出处再冗余写一份进 tags**（`ev:<文件:行>`）才能跟着派生条走 |
| 3   | `patch` 字段是 `content`                   | 字段名是 **`text`**                                                                                                                                | CLI 以 `--text` 为准，`--content` 仅作兼容别名                                                                 |
| 4   | `tags` 过滤能力待验                        | **服务端可过滤**，但 `tags_match` 默认 `any`/`all` 会**连带捞出无标签条目**；必须 `all_strict`/`any_strict`                                        | `list --repo/--module` 一律显式传 `all_strict`                                                                 |

**另两条值得记住的**：

- 顶层 `GET /health` 返回 `{"status":"healthy","database":"connected"}`，是探活正解；`GET /version` 的 `features.bank_llm_health=false` 说明 bank 级 LLM 健康检查在本实例没开——`status` 不要假装查过它。
- 折叠 `observation` 是**异步**的（`stats.pending_consolidation`），retain 后立刻 list 常常只看到 world 那一条。

### 存储约定（P0-3 落地，后续 P2/P3 照此读写）

| 通道        | 内容                                             | 理由                                                        |
| ----------- | ------------------------------------------------ | ----------------------------------------------------------- |
| `tags`      | `repo:<仓名>` · `module:<模块>` · `ev:<文件:行>` | 唯一在 world/observation 上**都存在**且**服务端可筛**的通道 |
| `metadata`  | `{repo, module, evidence, source, date}`         | 逐字存活、recall 回传；但只在 world 上，故与 tags 冗余一份  |
| `timestamp` | `--date` 传入                                    | 落到原生 `date` 字段，是 list 时间筛选的锚点                |

**已有可抄的实现**：`scripts/hindsight-memo.py`（recall/retain/reflect 的 payload 与调用已实测）、
`scripts/ensure-banks.py`（bank 创建 + 409 幂等）。
**不要抄的**：`xiaoqian-manager/lib/server/hindsight/client.ts`（Next 服务端模块，位置不对）。

## 附2：索引器 CLI 契约（事实层，照用即可）

```
node code-indexer/bin/cli.mjs <cmd> <repo> [...args]     # repo = 文件系统路径

scan    <repo>                        完整 ProjectMap JSON（大，别直接喂模型）
map     <repo>                        项目全貌：路由(label)/模块/API域/store/权限/存储/告警
trace   <repo> <route|module>         业务链路：路由→组件树→API→store/事件/权限/存储
trace-event  <repo> <组件> <事件>       谁 emit → 谁接 → handler 干了什么
trace-state <repo> <store>[.<field>]   store 字段谁读谁写（不传字段列全部）
channels <repo> [--kind K]            K = store|event|permission|guard|storage|ws
modules <repo> [<module>]             模块间关系（模块→模块 / →共享层 / 共享 store / 共用 API 域）
warnings <repo> [--kind K] [--limit N]
search  <repo> <词>                   路由/模块/端点关键词检索
stats   <repo>                        扫描规模与耗时（探活）
rescan  <repo>                        清缓存重扫
serve   <repo>                        stdio MCP server（9 工具；单仓单 server；进程内缓存 300s）
```

- 全部输出 JSON；`--compact` 单行。
- **说不清的不静默**：`unresolvedFns[].reason` / `dynamic-routes` / `dynamic-storage-key` / `alias.unresolved` 等出口都带原因 + evidence——助手照实转述，不脑补。
- Git Bash 下 `/route-path` 参数会被 MSYS 转路径，加 `MSYS_NO_PATHCONV=1`。
- 11 仓验收基线（2026-10-10）：端点 2624 / 路由 257（194 带中文业务名）/ store 90 / 事件边约 2500 / 权限码 200+ / 存储 key 55 / WS 5 处；单仓扫描约 1–3s。新仓接入先跑 `stats` + `map` 核对非零。
