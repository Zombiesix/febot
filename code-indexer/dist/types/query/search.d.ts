import type { ProjectMap } from "../types";
/** 关键词检索：路由 / 模块 / API 域与端点，给 MCP 与 CLI 共用 */
export declare function searchIndex(map: ProjectMap, keyword: string, limit?: number): string;
