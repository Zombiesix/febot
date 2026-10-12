import type { RouteInfo } from "../types";
/**
 * 从集中式路由表里提取路由。覆盖的形态：
 *
 * - `const routes = [{ path, component: () => import("@/..."), meta }]`
 * - `createRouter({ routes: [...] })` —— 数组直接内联在配置里
 * - `routes: [...constantRouter]` —— 数组来自别的模块，顺着 import 找过去（repo-d 形态）
 * - 嵌套 `children` —— 递归展开，子路由相对路径拼到父路径上
 *
 * 过去只认第一种单文件写法，repo-d 整仓解析出 0 条路由。
 */
export declare function extractRoutes(routerFileAbs: string, repoRoot: string, srcDirRel: string | null): {
    routes: RouteInfo[];
    unresolved: string[];
    dynamicRoutes: boolean;
};
