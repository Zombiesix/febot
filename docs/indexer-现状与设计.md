# code-indexer 现状与设计

> 目标读者：后续接手的人。
> 一句话：**Vue3 仓库静态索引器** —— 扫一遍目标仓，输出「路由 / 模块 / 组件图 / 接口 / 状态 / 事件 / 权限 / 存储 / 连接」的全景 JSON，
> 给 Agent 或人用。纯静态、不喂 LLM。

---

## 1. 能力清单

| 维度              | 抽什么                                                        | 覆盖的形态（全部实测）                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **路由**          | `path / label / component / redirect / permissionCode / meta` | 单文件 `const routes` · `createRouter({routes})` · **多文件** `[...constantRouter]` 顺 import 找 · **`children` 递归**（子路径拼父路径） · 业务名键 `label` / `title` / `meta.name` 三选                                                                                        |
| **模块**          | 模块清单、扁平组件列表、渲染树                                | **多个页面目录都扫**（`page`/`pages`/`view`/`views`），不只第一个                                                                                                                                                                                                               |
| **组件图**        | SFC 级引用边、反向索引、渲染树                                | 来路四类：`import` / `auto`（自动导入）/ `async`（动态 import）/ `indirect`（塞数据由 `<component :is>` 渲染）                                                                                                                                                                  |
| **API 接口**      | API 域 → 函数 → **后端端点（方法 + URL + 出处）**             | 客户端：`$http.get` / 目录导入 / **工厂造客户端** `useRequest()` / **内容式识别**（调了 `axios.create(` 即算）/ **可调用客户端** `request({url,method})`；URL：字面量 / config object / **enum** / **常量拼接**；域形态：目录 或 **单文件**；函数形态：顶层 / 箭头 / **类方法** |
| **Pinia store**   | store 定义 + **每个字段谁读谁写**                             | 对象式 / setup 式 / **模块级 `reactive` 单例**；一文件多 store；`persist` 两种插件形状                                                                                                                                                                                          |
| **组件 emit**     | 声明 + 发出点 + **子→父事件边** + handler 副作用              | `defineEmits<T>()` / `defineEmits([...])` / **Options API `emits` 选项** / **`setup(props,{emit})` 解构** 与 `ctx.emit`；`$emit`；`v-model` 展开；`useVModel`                                                                                                                   |
| **权限**          | **权限码台账** + 守卫                                         | 路由 meta / 模板指令（指令名从 `app.directive()` 读）/ inline `hasPermission("code")`；标注判定在**本仓**还是 **qiankun 宿主仓**                                                                                                                                                |
| **存储**          | key 台账 + 谁读谁写 + 封装层                                  | `localStorage` / `sessionStorage` / cookie；常量 key 还原；封装层识别；store↔storage 桥                                                                                                                                                                                         |
| **WebSocket/SSE** | 连接点 + 消息分发                                             | `new WebSocket` / `SockJS` / `EventSource` / `io()` / **库组合式 `useWebSocket`**                                                                                                                                                                                               |
| **模块间关系**    | 模块→模块 / →共享层 / 共享 store / 共用 API 域 / 跨模块事件   | 组件图本来就是全仓建的，这里只做模块级汇总                                                                                                                                                                                                                                      |

---

## 2. 架构：3 个底座 + 8 个抽取器

```
        ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
        │  alias.ts    │  │  resolve.ts  │  │ literals.ts  │
        │ 真读别名配置  │  │ 目录导入/扩展名│  │ enum/const   │
        │ tsconfig+vite│  │  → index.*   │  │ + 拼接 + 跨文件│
        └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
               └─────────────────┼─────────────────┘
                                 ▼
                    ┌────────────────────────┐
                    │  scan-symbols.ts       │  统一符号引用扫描
                    │  Call/New/Member + ctx │  {file,line,owner,imports}
                    └───────────┬────────────┘
        ┌──────────┬───────────┼───────────┬──────────┬──────────┐
        ▼          ▼           ▼           ▼          ▼          ▼
     stores    events     permissions   storage   sockets   module-graph
        │          │           │           │          │          │
        └──────────┴───────────┴─────┬─────┴──────────┴──────────┘
                                     ▼
                    各自带 reason 的「说不清」出口 + 13 类告警
```

**要点**：这不是「一堆引擎」，而是「**薄底座 + 薄抽取器**」。每个抽取器都是 `scan-symbols` 的封装，
解析不出的一律走各自带原因的出口。

**AST 共享缓存**：`ast.ts` 里 `readSfcParts` / `createSource` 各有一层进程内缓存（按文件路径），
`clearScanCache` 一并清。没有它每个文件会被 8 个抽取器重复读盘 + 解析 8 次。

---

## 3. 数据模型（`ProjectMap`）

```
ProjectMap
├─ repo / stack / stats
├─ routes        RouteInfo[]          路由
├─ modules       ModuleInfo[]         模块（components 扁平清单 + tree 渲染树）
├─ apiDomains    ApiDomainInfo[]      接口域（endpoints + unresolvedFns 带原因）
├─ components    ComponentGraph       组件图（edges / importedBy / eventBindings / dynamicComponents）
├─ stores        StoreInfo[]          store 定义
├─ storeStateIndex  {storeId: {field: StoreRef[]}}   谁读谁写
├─ permissions   PermissionModel      codes + helpers + definedInRepo
├─ guards        GuardInfo[]          守卫（如实抽取）
├─ storageKeys   StorageKeyInfo[]     存储 key 台账
├─ componentEmits ComponentEmits[]    emit 声明与调用点
├─ eventEdges    EventEdge[]          子→父事件边
├─ sockets       SocketInfo[]         连接点
├─ moduleGraph   ModuleGraph          模块间关系
└─ warnings      Warning[]            13 类告警
```

几个**容易记错**的字段：

| 字段                            | 实际语义                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ModuleInfo.components`         | **扁平清单**（模块目录下全部 SFC）—— 不是树                                                            |
| `ModuleInfo.tree`               | **渲染树**（从入口组件展开）—— 两个都有                                                                |
| `StoreInfo.binding`             | 导出的**绑定名**，使用侧就是拿它调用（可能是 `useUserStore`，也可能是 `userStore` / `useCodeMapping`） |
| `StoreInfo.id`                  | `defineStore` 的 id（对象式取 `id` 字段，setup 式取首参）—— **不是文件名**                             |
| `PermissionModel.definedInRepo` | 在 **model 级**，不在 `PermissionCodeInfo` 上（仓库级事实，非按码）                                    |
| `EventEdge.from / to`           | `from` = **子组件（emit 方）**，`to` = **父组件（监听方）** —— 与渲染树方向相反                        |
| `SocketInfo.ctor`               | **字符串**，记真实 API 名（`useWebSocket` 等库组合式也在这）                                           |
| `RepoStack.pageDirs`            | **所有**页面目录；`pageDir` 是 deprecated 的 `pageDirs[0]`                                             |

---

## 4. 设计原则（三条铁律）

### 铁律一：跨文件才看得见的东西，必须靠底座解析，不许逐文件正则猜

五个盲区全是跨文件通道。逐文件正则会给你一堆**看起来对、其实漏一半**的结果 —— 比没有更糟。

### 铁律二：每个「说不清」出口必须带 **原因分类 + evidence + 消费方**

三样缺一即为死数据。反例见 §5。

### 铁律三：沿用既有纪律

- 事实每次现算，**不把源码批量喂 LLM**
- **只读目标仓**，产物只写本仓
- 敏感文件排除：`.env*`、`token.temp`、`~/.ssh/*`、`~/.aws/*`
- **不引 `ts.Program` / 类型检查器** —— 纯静态语法层 + 一层常量解析，保住扫描耗时
- 不硬猜：解析不出就走「说不清」出口，带原因，不编

---

## 5. 「说不清」出口的实际形态

**注意：没有一个统一的 `unresolved[]` 类型**（早期计划里画过，实际没建成）。
每个抽取器各自带原因，形态如下：

| 出口         | 位置                                  | 形态                                             |
| ------------ | ------------------------------------- | ------------------------------------------------ |
| 端点未解析   | `ApiDomainInfo.unresolvedFns`         | `{fn, reason, calls, evidence}`，reason 三分类   |
| 事件对不上   | `EventEdge.unmatched` / `passthrough` | 布尔标记，区分「真对不上」与「`$attrs` 透传」    |
| 别名求值失败 | `AliasMap.unresolved`                 | `{prefix, reason, evidence}`                     |
| 动态路由     | `dynamic-routes` 告警                 | `import.meta.glob` 生成，静态枚举不了            |
| 动态存储 key | `dynamic-storage-key` 告警            | key 解析不出 = 无法审计                          |
| 动态子组件   | `dynamic-children` 告警               | `<component :is>` 由数据决定                     |
| 组件引用来路 | `EdgeVia: "indirect"`                 | import 了但没当标签用 → 大概率 `<component :is>` |

**反例（值得记住）**：`ApiDomainInfo.nonEndpointFns` 早期是裸名字数组 ——
不留原因、不留行号、**没有消费方**。三处落点之后全仓无人读，只在裸 `scan` 输出里存在。
它后来被改成带原因的 `unresolvedFns`，而**接上消费方的第一件事就暴露了一个藏了很久的全仓级失败**（见 §6-C）。
`nonEndpointFns` 作为 deprecated 派生字段保留，只为兼容 `scripts/recon.mjs`。

---

## 6. 踩坑记录（本文件最有价值的部分）

按主题重排，不按时间。**每条都是实测踩出来的，不是推测。**

### A. 跨文件解析：三处硬编码让大部分仓静默失效

| 硬编码                             | 后果                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `resolveSpecifier` 只认 `@/`       | haimis 的 `@service → src/service/api`、medical-ui 的 `@treatment`/`@nurse` 全被**静默丢弃** |
| `resolveComponentFile` 只认 `.vue` | 指向 `.ts` 的一律 `null`，目录导入（`@/service` → `index.ts`）解析不出                       |
| `extractRoutes` 只读单文件         | 多文件路由（`routes: [...constantRouter]`）整个丢失                                          |

**教训**：别名要**真读配置**（tsconfig `paths` + vite `resolve.alias`，对象式与数组式都要），
解析要**补扩展名 + 取 `index.*`**，不要硬编码任何一种写法。

### B. 形态总比预期多

| 维度       | 实测形态数 | 最意外的那个                                                                                                                 |
| ---------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| emit 声明  | **4**      | **Options API `emits: [...]` 选项** + `setup(props,{emit})` 解构 —— 预过滤写 `includes("defineEmits")` 把这类文件直接跳过了  |
| 客户端     | **5**      | 工厂造客户端 `const r = useRequest(src)`；内容式识别（客户端在 `src/utils/request` 且用 `taro-axios`，按路径按名字都找不到） |
| URL 取值   | **4**      | enum 成员作 URL；常量 + 字面量拼接                                                                                           |
| store 定义 | **3**      | 模块级 `reactive` 单例（既不是 pinia 也不是 props 的隐藏全局状态）                                                           |
| WS 建连    | **5**      | 库组合式 `useWebSocket` —— 内部才 `new WebSocket`，只找构造会漏                                                              |
| api 域     | **2**      | **单文件也是域**（haimis `api/common.ts`），只认目录会 0 域                                                                  |
| 函数声明   | **3**      | **类方法**（`class X { f() {} }` + `export const x = new X()`）                                                              |

### C. 静默失败是最危险的一类

| 现象                       | 根因                                                                                                         | 怎么发现的                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| **11 仓里 10 仓端点为 0**  | 四个结构假设（域=目录 / 客户端靠路径匹配 / 客户端来自 import 绑定 / URL 是首参字面量），只有 icis 四个全满足 | 给 `nonEndpointFns` 接消费方 —— **接上第一眼就看见了** |
| aers **匹配到错的绑定**    | 目录导入 `@/service` 解析不出，反而匹配上从未调用的 `baseRequest`，真客户端 `request` 被漏掉                 | 同上                                                   |
| 路由组件**组件树整棵空掉** | `import("@/page/foo")` 省略扩展名 → 解析出无扩展名路径，与组件图 key 对不上                                  | 改 `resolveModuleFile` 时顺带发现                      |
| 4 个「守卫」全来自构建产物 | icis `build` 脚本是纯 `vite build`（outDir=`dist`），**但仓里提交了 `web/`**，配置读不出来                   | 守卫列表里行号集中在 `web/assets/*.js`                 |

**教训**：静态索引器最大的失败模式是**静默少报** —— 看着跑通了，其实漏了一半。
**单仓通过 = 零信心。** 每个抽取器都要跑全部 11 个仓，产出为零就是红灯。

### D. 差点给出假声明

| 差点说错                                                       | 实际                                                                                                                  | 修法                                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `definedInRepo: true`（权限判定在本仓）                        | 名字正则把 `queryPermissionsByShift`（**API 函数**）、`userSettingPermission`（**字段**）当成判定函数                 | 只认**真出现在权限检查点上的被调名**                             |
| `getPermissionValue` 是本仓实现                                | 它调的 `hasPermission` 委托给宿主                                                                                     | 委托判定要**传递**                                               |
| pathology 判定在本仓                                           | 它走 **iframe 桥**（`getIframeStore()` + `getters["...hasPermission"]`），宿主通路不止 `parentVuex`                   | 补标记                                                           |
| `wrapper: src/view/borrow/BorrowApplication.vue`（这是封装层） | 判据「文件里有 export 且碰 storage」几乎命中每个 Vue 文件                                                             | 改为「存储调用落在**导出声明的函数体**内」，且**沿整条祖先链**找 |
| `persist: {key: "icis/useNrStore"}`                            | 该 store 用的是 `pinia-plugin-persist`（`{strategies:[{key,storage}]}`），顶层没有 `key` —— 我拿 id 兜底了 = **编造** | 读不到就返回 `null`，**不拿 id 兜底**                            |

### E. 仓里的「非源码」

| 类型             | 例子                                                                          | 处理                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 构建产物**目录** | aers / cssd-ui 的 `build.outDir: "web"`；icis 提交了 `web/` 但配置写的 `dist` | 配置读 `build.outDir`（**必须限定在 `build` 对象内**，别处也有 `outDir`）+ **按内容识别**（目录里有 `index.html` 且有带 hash 的产物 js） |
| 压缩 vendor 库   | `src/utils/insurance/insurance.es.min.js`                                     | `DEFAULT_IGNORED_FILES` 加 `/\.min\.(js                                                                                                  | css)$/` |

**症状**：行号集中在 `assets/*.js`、字段名像 DOM 属性（`referrerPolicy` / `toUpperCase`）。
**aers 的 stateIndex 从 3525 条降到 1 条**就是这个原因。

### F. 告警要能行动，不能淹掉真信号

`orphan-emit` 初版报「发了但没人听」共 **714 条，占告警总数 68%** ——
因为它把「组件压根没被用过」「被 `<component :is>` 动态挂载」也算进去了，
那属于**静态看不见**，不是缺陷。

改成只报「**确实被父级用过、但那些父级都不听这个事件**」后降到 **121 条**。

### G. 小陷阱

| 坑       | 现象                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| 原型链   | `obj[field] ??= []` 当 field 是 `constructor` / `toString` 时取到原型上的函数，`??=` 不生效 → `.push` 崩。改用 `Map` |
| 可选实参 | `useRequest()` 无参时 `node.arguments[0]` 是 `undefined`，喂给 `ts.is*` 直接崩                                       |
| 同名声明 | medical-ui 的 `hasPermission` 既有收 `item` 的也有收权限码的，取第一个是武断的 → 全部收集如实列出                    |
| 嵌套声明 | handler 声明在嵌套作用域里（还被塞进某个 `return {}`），只扫顶层语句会漏 effects                                     |
| 注释位置 | 业务名注释写在对象**内部**（`{ //复印管理 \n path: ... }`），要取**第一个属性**的前导注释                            |
| 性能     | 8 个抽取器各读各的 → 每文件重复解析 8 次。加 AST 缓存后 nurse-manager **9581ms → 3324ms**                            |

---

## 7. 实测规模（11 个 Vue3 仓）

| 指标      | 数量     | 备注                            |
| --------- | -------- | ------------------------------- |
| 端点      | **2624** | 11/11 仓非零                    |
| 路由      | 257      | 带中文业务名 194                |
| store     | 90       | 含 1 个 reactive 单例           |
| 事件边    | 约 2500  | 真对不上仅 ~65 条（2.6%）       |
| 权限码    | 200+     | 引用点 250+                     |
| 存储 key  | 55       | **动态 key 归零**               |
| WS 连接点 | 5        | 计划估 3 处，多出的来自库组合式 |
| 告警      | 448      | 13 类                           |

**扫描耗时**：icis 1151ms / haimis 2571ms / nurse-manager 3324ms（448 / 957 / 1235 个文件）。

### 端点数分布（说明覆盖面）

| 仓                    | 端点 | 路由 | store | 事件边 | 权限码 | 存储 key | WS  |
| --------------------- | ---- | ---- | ----- | ------ | ------ | -------- | --- |
| iho-nurse-manager-ui  | 751  | 123  | 5     | 1057   | 75     | 7        | 1   |
| iho-haimis-ui         | 649  | 53   | 16    | 266    | 68     | 5        | 0   |
| iho-medical-record-ui | 287  | 24   | 6     | 235    | 7      | 16       | 1   |
| iho-cssd-ui           | 237  | 14   | 7     | 391    | 45     | 2        | 0   |
| iho-icis-ui           | 161  | 11   | 6     | 166    | 7      | 2        | 1   |
| iho-pathology-ui      | 152  | 18   | 1     | 155    | 4      | 6        | 2   |
| iho-ehr-ui            | 123  | 12   | 6     | 83     | 0      | 3        | 0   |
| iho-aers-web          | 90   | 0    | 3     | 34     | 4      | 3        | 0   |
| iho-nbs-web           | 82   | 2    | 6     | 23     | 0      | 7        | 0   |
| iho-cssd-ui-mobile    | 72   | 0    | 0     | 36     | 0      | 0        | 0   |
| iho-medical-ui        | 20   | 0    | 14    | 277    | 7      | 4        | 0   |

---

## 8. 已知局限（不静默跳过）

| 局限                            | 影响 | 说明                                                                                                                                   |
| ------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **iho-medical-ui 模块数为 0**   | 中   | 它**没有 router 目录**，且模块放在 `src/modules/` 而非 `page/pages/view/views` → `detectStack` 的页面目录探测不到。属于**探测面**问题  |
| **iho-aers-web 路由为 0**       | 低   | 路由由 `import.meta.glob("@/views/**/*.vue")` **运行时生成**，静态枚举不了 → 已有 `dynamic-routes` 告警如实报出                        |
| **iho-cssd-ui-mobile 路由为 0** | 低   | Taro 移动端，路由不在 `.ts/.js` 里（未找到 `createRouter`）                                                                            |
| **消息 type 清单为空**          | 低   | 这些仓**不用 `msg.type === "x"` 标签**，按**字段存在性**分发（`if (msg.monitor) …`）→ 已用 `dispatchFields` 如实记录，空数组不是没抽到 |
| **权限判定多不在本仓**          | 中   | 在 qiankun 宿主仓 → `definedInRepo: false` 就是答案本身（解释「为什么这里找不到权限实现」）                                            |
| **部分路由无 meta 业务名**      | 低   | ehr-ui / medical-record / pathology 部分路由确实没写 —— 数据不存在，非缺陷                                                             |
| **Vue2 仓不覆盖**               | —    | `reuseapp-blood-bank-web` 是 Vue2，索引器只支持 Vue3                                                                                   |
| **不做完整 WS 抽取器**          | —    | 实测仅 5 处，只做定位 + 消息分发字段                                                                                                   |
| **不做生命周期/重连抽取**       | —    | WS 的 `close()` / 心跳 / 重连逻辑未抽                                                                                                  |

---

## 9. 输出面

**11 个 CLI 命令**

| 命令                                                 | 用途                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `scan <repo>`                                        | 完整 ProjectMap JSON（体积大）                                    |
| `map <repo>`                                         | 全貌摘要（计数为主，体积克制）                                    |
| `trace <repo> <route\|module>`                       | **业务链路**：路由 → 组件树 → API → store / 事件 / 权限 / 存储    |
| `trace-event <repo> <组件> <事件>`                   | 谁 emit → 谁接 → handler 干了什么                                 |
| `trace-state <repo> <store>[.<字段>]`                | 谁读谁写                                                          |
| `channels <repo> [--kind K]`                         | 六类通道总览（store / event / permission / guard / storage / ws） |
| `modules <repo> [<module>]`                          | 模块间关系                                                        |
| `warnings` / `search` / `stats` / `rescan` / `serve` |                                                                   |

**9 个 MCP 工具**：`get_project_map` / `trace_flow` / `trace_event` / `trace_state` /
`list_channels` / `list_module_graph` / `list_warnings` / `search_index` / `rescan`

**13 类告警**：`naming-mismatch` · `orphan-api-domain` · `orphan-route` · `orphan-module` ·
`orphan-store` · `orphan-emit` · `unmatched-event-binding` · `multi-writer` ·
`dynamic-children` · `dynamic-routes` · `dynamic-storage-key` · `unresolved-component` · `unsupported-stack`

每条都带 `evidence`（文件:行）。

---

## 10. 如果还要往下做

按「投入产出比」排序的候选：

1. **`detectStack` 探测面补全** —— 修 iho-medical-ui（`src/modules/` 也是模块目录）与 Taro 仓的路由
2. **跨模块依赖的「环」检测** —— 现在有 `moduleGraph.edges`，加一个环检测就能报循环依赖
3. **共享层识别** —— 目前 `sharedTargets` 只按 `src/<段>` 归类，可以更精确地识别「公共组件库」并单列
4. **WS 生命周期** —— 目前只有连接点，重连/心跳/关闭没抽（实测量小，优先级低）
5. **增量扫描** —— 现在是全量扫；大仓（1235 文件 3.3s）可以考虑按 mtime 增量
