import type {
  ComponentEmits,
  EventEdge,
  GuardInfo,
  ModuleGraph,
  PermissionModel,
  SocketInfo,
  StorageKeyInfo,
  StoreInfo,
  StoreStateIndex,
} from "./channel-types";
import type { Endpoint, UnresolvedFn } from "./endpoint-types";

export type StackKind = "vue3" | "vue2" | "unknown";

export interface RepoStack {
  kind: StackKind;
  vueVersion: string | null;
  builder: "vite" | "vue-cli" | "unknown";
  /** 由入口文件里的 renderWithQiankun / __POWERED_BY_QIANKUN__ 判定，而非只看依赖 */
  isQiankunChild: boolean;
  qiankunDeps: string[];
  entryFile: string | null;
  srcDir: string | null;
  routerFile: string | null;
  /**
   * **所有**存在的页面目录，按优先级排序。
   * 过去只取第一个 —— example-sys 同时有 `src/page`（12 个模块）和 `src/view`（5 个），
   * 后者整片页面被当成"不属于任何模块"。
   */
  pageDirs: string[];
  /** @deprecated 等价于 pageDirs[0]，保留给既有消费方 */
  pageDir: string | null;
  serviceDir: string | null;
}

export interface RouteInfo {
  path: string;
  name: string | null;
  /** meta.label —— 中文业务名，本仓多数路由自带 */
  label: string | null;
  componentFile: string | null;
  redirect: string | null;
  isSiderMenu: boolean | null;
  permissionCode: string | null;
  /** meta 里未识别的字段，留给后续挖掘 */
  extraMeta: Record<string, string>;
}

export interface ApiDomainInfo {
  name: string;
  dir: string;
  files: string[];
  functions: string[];
  /** 该域函数实际打的后端端点（函数 → 方法 + URL） */
  endpoints: Endpoint[];
  /** 有导出但没解析出端点的函数，带原因分类（见 UnresolvedFn.reason） */
  unresolvedFns: UnresolvedFn[];
  /**
   * @deprecated 派生自 unresolvedFns，仅为兼容既有消费方（scripts/recon.mjs）保留。
   * 新代码请用 unresolvedFns —— 它带原因和 evidence。
   */
  nonEndpointFns: string[];
  /** 引用该域的模块名，由 index.ts 回填；数量 >= 3 视为共享基础域 */
  usedByModules: string[];
}

export interface ApiUsage {
  domain: string;
  /** 形如 "catheter/getList" */
  refs: string[];
  /** 引用方在所属模块内的相对子路径，用于判断"子目录名其实对得上域名" */
  subPaths: string[];
  evidence: string[];
}

export interface ModuleInfo {
  name: string;
  dir: string;
  route: RouteInfo | null;
  label: string | null;
  /** 模块目录下的全部 SFC（扁平清单） */
  components: string[];
  /** 从入口组件展开的渲染树；无入口时为 null */
  tree: ComponentNode | null;
  /** 树里去重后的组件数 */
  treeSize: number;
  api: ApiUsage[];
}

/**
 * 组件引用的来路：
 * - import：显式 import 且模板里当标签用
 * - auto：unplugin-vue-components 自动导入，源码里没有 import 语句
 * - async：defineAsyncComponent(() => import(...))
 * - indirect：显式 import 但只作为值传递（塞进数据、传给 props），
 *   由 <component :is> 之类间接渲染。模板里搜不到标签名，最容易让新人迷路。
 */
export type EdgeVia = "import" | "auto" | "async" | "indirect";

export interface ComponentEdge {
  file: string;
  via: EdgeVia;
}

export interface ComponentNode {
  /** repo 相对路径 */
  file: string;
  name: string;
  /** 从父级到本节点的引用方式；根节点没有 */
  via?: EdgeVia;
  children: ComponentNode[];
  /** 模板里出现但解析不到本仓文件的标签（全局/第三方组件） */
  external: string[];
  /** 同一组件已在树中别处展开过，此处不再重复展开 */
  duplicate?: boolean;
  /** 环形引用，停止下探 */
  cyclic?: boolean;
}

/** 模板里绑定在某个子组件上的事件（父 → 子的监听） */
export interface TemplateEventBinding {
  /** 事件名原文，如 `change` / `update:modelValue` */
  event: string;
  /** handler 名；内联箭头函数为 null */
  handler: string | null;
  /** 该绑定在模板里的行号（未加 SFC 偏移） */
  line: number;
  via: "v-on" | "v-model";
}

export interface ComponentGraph {
  /** 每个 SFC → 它直接引用的子组件 */
  edges: Record<string, ComponentEdge[]>;
  /** 每个 SFC → 模板里未解析的标签 */
  externalTags: Record<string, string[]>;
  /** 反向索引：谁引用了这个组件 */
  importedBy: Record<string, string[]>;
  /** 用了 <component :is> 的 SFC：具体渲染谁由数据决定，静态分析看不全 */
  dynamicComponents: string[];
  /**
   * 每个 SFC → 它绑定在**本仓子组件**上的事件。
   * 只记能解析到本仓文件的标签 —— 原生元素上的 `@click` 不算组件事件。
   */
  eventBindings: Record<string, { child: string; event: string; handler: string | null; line: number; via: "v-on" | "v-model" }[]>;
  /** 自动导入清单的来源（dts 优先） */
  autoImportSource: "dts" | "basename" | "none";
  stats: { sfcCount: number; edgeCount: number; externalTagCount: number };
}

export type WarningKind =
  | "naming-mismatch"
  | "orphan-api-domain"
  | "orphan-route"
  | "orphan-module"
  | "dynamic-children"
  | "unresolved-component"
  | "dynamic-routes"
  | "dynamic-storage-key"
  | "orphan-store"
  | "multi-writer"
  | "orphan-emit"
  | "unmatched-event-binding"
  | "unsupported-stack";

export interface Warning {
  kind: WarningKind;
  message: string;
  evidence: string[];
}

export interface ScanStats {
  filesScanned: number;
  filesIgnored: number;
  symlinksSkipped: string[];
  durationMs: number;
}

export interface ProjectMap {
  repo: { path: string; name: string };
  stack: RepoStack;
  routes: RouteInfo[];
  modules: ModuleInfo[];
  apiDomains: ApiDomainInfo[];
  components: ComponentGraph;
  /** Pinia store 与模块级 reactive 单例 */
  stores: StoreInfo[];
  /** storeId → 字段 → 谁读谁写 */
  storeStateIndex: StoreStateIndex;
  /** 权限码台账（路由 / 指令 / inline 三种引用） */
  permissions: PermissionModel;
  /** 路由守卫，如实抽取 */
  guards: GuardInfo[];
  /** 存储通道：localStorage / sessionStorage / cookie 的 key 台账 */
  storageKeys: StorageKeyInfo[];
  /** 每个组件的 emit 声明与调用点 */
  componentEmits: ComponentEmits[];
  /** 子 → 父的事件边（渲染树的反向通道） */
  eventEdges: EventEdge[];
  /** WebSocket / SSE 连接点（实测极少，只做定位与消息 type 清单） */
  sockets: SocketInfo[];
  /** 模块间关系（组件引用 / 共享层 / 共享 store / 共用 API 域 / 跨模块事件） */
  moduleGraph: ModuleGraph;
  warnings: Warning[];
  stats: ScanStats;
}
