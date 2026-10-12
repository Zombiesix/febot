/**
 * 「状态与事件链路」的纯类型，**不得引入任何 Node 模块**。
 * 客户端组件（ProjectMapView）要 import 这里；一旦引入 typescript / node:fs，
 * 它们会被打进浏览器 bundle 并报 UnhandledSchemeError。
 * 真正需要 AST 的抽取逻辑在 stores.ts / 后续的 events.ts、permissions.ts，那是 server-only。
 *
 * 与 endpoint-types.ts 同一约定，只是分属不同维度。
 */

/** Pinia store（含模块级 reactive 单例） */
export interface StoreInfo {
  /** 导出的绑定名 —— 使用侧就是拿它调用的（useUserStore / userStore / qiankunState） */
  binding: string;
  /** defineStore 的 id；reactive 单例用 binding */
  id: string;
  file: string;
  line: number;
  style: "options" | "setup" | "reactive";
  kind: "pinia" | "reactive-singleton";
  state: string[];
  getters: string[];
  actions: string[];
  /** 由路径推：`views/x/store/` → x；`src/store/**` 是全局 → null */
  ownerModule: string | null;
  /**
   * 持久化配置（两个插件都归一到这里）：
   * `pinia-plugin-persistedstate` 的 `persist: true | { key, storage }`，
   * 或 `pinia-plugin-persist` 的 `persist: { enabled, strategies: [{ key, storage }] }`。
   */
  persist: { key: string; storage: string } | null;
}

export interface StoreRef {
  file: string;
  line: number;
  mode: "read" | "write";
  owner: string | null;
}

/** storeId → 字段 → 引用点 */
export type StoreStateIndex = Record<string, Record<string, StoreRef[]>>;

/** 权限码的一处引用 */
export interface PermissionRef {
  /** route=路由 meta / directive=模板指令 / inline=代码里调用判定函数 */
  kind: "route" | "directive" | "inline";
  file: string;
  line: number;
  /** 补充信息：指令名、调用名或路由路径 */
  detail?: string;
}

export interface PermissionCodeInfo {
  code: string;
  usedBy: PermissionRef[];
}

/** 本仓能找到的权限判定函数 */
export interface PermissionHelper {
  name: string;
  file: string;
  line: number;
  /**
   * 实现是否落在**宿主仓**（qiankun parent）而不是本仓。
   * 实测这是常态：`window.$inm_parentVuex?.getters["user/hasPermission"]` ——
   * 本仓只有引用。这个标记本身对新人最有用：它解释「为什么这里找不到权限实现」。
   */
  delegatesToHost: boolean;
}

export interface PermissionModel {
  codes: PermissionCodeInfo[];
  helpers: PermissionHelper[];
  /** 是否存在本仓自实现的判定（false = 判定全在宿主仓） */
  definedInRepo: boolean;
}

/** 一处存储访问 */
export interface StorageRef {
  file: string;
  line: number;
  mode: "read" | "write" | "delete";
  /** 归属的函数 / 组件名 */
  owner: string | null;
  /** 该访问位于哪个封装模块内（如 `src/utils/storage.ts`）；null = 直接调用 */
  wrapper: string | null;
}

export interface StorageKeyInfo {
  /** 解析出的 key；null = 动态 key（拼出来的，静态不可解） */
  key: string | null;
  /** 原文，便于人工看动态 key 长什么样 */
  raw: string;
  storage: "local" | "session" | "cookie";
  refs: StorageRef[];
}

/** 组件 emit：声明了哪些事件 + 实际在哪发出 */
export interface ComponentEmits {
  file: string;
  /** 声明的事件名（defineEmits 的结果） */
  declared: string[];
  /** 实际 emit 的调用点 */
  calls: { line: number; event: string; binding: string }[];
  /** 声明形态：type=泛型 interface / array=字面量数组 / none=没声明 */
  style: "type" | "array" | "none";
}

/**
 * 子 → 父的事件边（渲染树是父→子，这是反向通道）。
 *
 * `event` 已归一化（kebab → camel），所以 `@my-event` 与 `emit('myEvent')` 能对上。
 */
export interface EventEdge {
  /** 子组件（emit 方） */
  from: string;
  /** 父组件（监听方） */
  to: string;
  event: string;
  /** 父组件里绑定的 handler 名；内联箭头函数为 null */
  handler: string | null;
  handlerAt: string;
  via: "v-on" | "v-model";
  /** handler 里干了什么：调用的函数名（api / store action / router 都在这） */
  effects: string[];
  /**
   * 子组件既没声明也没 emit 过这个事件 —— 显式标出来，不静默当正常边。
   * 结合 `passthrough` 看：passthrough=true 是透传包装（正常），
   * false 才是真的对不上（父组件绑错名字 / 动态 emit）。
   */
  unmatched?: boolean;
  /**
   * 子组件是**纯透传包装**：自己不发事件，靠 `v-bind="$attrs"` 转发给内部组件
   * （example-sys 的 `ChartColorPicker.vue` 把 `@update:value` 转发给 `n-color-picker`）。
   * 这类 unmatched 是正常的，且它解释了「为什么在组件里找不到这个 emit」。
   */
  passthrough?: boolean;
}

/** WebSocket / SSE 连接点 */
export interface SocketInfo {
  file: string;
  line: number;
  /**
   * 建连方式。实测四种：
   * `new WebSocket(...)` / `new SockJS(...)` / `new EventSource(...)` / `io(...)`（socket.io），
   * 以及**库组合式**（`useWebSocket` from `@vueuse/core`）—— 直接记真实 API 名。
   */
  ctor: string;
  url: string | null;
  /** 处理的消息 type（从 `msg.type === "x"` 之类的判断与 `.on("x")` 抽） */
  messagesHandled: string[];
  /** 发出的消息（`.emit("x")`） */
  messagesSent: string[];
  /**
   * handler 里按**字段存在性**分发的载荷字段（`if (msg.monitor) …`）。
   * 实测这些仓不用 `msg.type === "x"` 这种类型标签，所以 messagesHandled 常为空 ——
   * 分发依据其实是字段名，记在这里，免得留个空数组让人以为没抽到。
   */
  dispatchFields: string[];
  /** 连接构造所在的封装模块（`hooks/use-socket` 之类） */
  wrapper: string | null;
}

/** 模块间的一条引用关系 */
export interface ModuleEdge {
  from: string;
  to: string;
  /** 该方向的组件引用条数 */
  count: number;
}

/**
 * 模块间关系汇总。
 *
 * 组件图是全仓建的（跨模块边本来就在图里），但过去没有「模块 → 模块」这个视图。
 * 这里把文件级的关系汇总成模块级。
 */
export interface ModuleGraph {
  /** 模块 → 模块（组件引用） */
  edges: ModuleEdge[];
  /**
   * 模块 → 共享层目录的引用（目标不属于任何模块，如 `src/components`）。
   * 实测 example-sys 有 43% 的组件引用边指向这里 —— 不列出来，模块视角会漏掉近一半关系。
   */
  sharedTargets: { from: string; dir: string; count: number }[];
  /** 被多个模块读写的 store —— 跨模块共享状态的真正来源 */
  sharedStores: { id: string; modules: string[] }[];
  /** 被 >= 3 个模块共用的 API 域 */
  sharedApiDomains: { name: string; modules: string[] }[];
  /**
   * 跨模块事件边。方向沿用 `EventEdge` 的约定：
   * `from` 是**发出事件**的模块（子组件所在），`to` 是**监听**的模块（父组件所在），
   * `at` 是监听方的绑定位置。
   */
  crossModuleEvents: { from: string; to: string; event: string; at: string }[];
}

/** 路由守卫 */
export interface GuardInfo {
  /** beforeEach / beforeResolve / afterEach / beforeEnter */
  hook: string;
  file: string;
  line: number;
  /** 守卫里的跳转目标字面量 */
  redirects: string[];
  /** 守卫里调用的函数名 */
  calls: string[];
}
