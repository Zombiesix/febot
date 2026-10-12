/**
 * 「状态与事件链路」的纯类型，**不得引入任何 Node 模块**。
 * 客户端组件（ProjectMapView）要 import 这里；一旦引入 typescript / node:fs，
 * 它们会被打进浏览器 bundle 并报 UnhandledSchemeError。
 * 真正需要 AST 的抽取逻辑在 stores.ts / 后续的 events.ts、permissions.ts，那是 server-only。
 *
 * 与 endpoint-types.ts 同一约定，只是分属不同维度。
 */
export {};
