import { type ApiIndex } from "./api-calls";
import type { ComponentGraph, ModuleInfo, RouteInfo } from "./types";
/**
 * 业务模块 = 页面目录下的一级目录。这个仓把业务模块直接摊在 `src/page/<模块>/`，
 * 所以模块划分不用 LLM 聚类，读目录就有。
 *
 * **多个页面目录都要扫**：example-sys 同时有 `src/page`（12 个模块）与 `src/view`（5 个），
 * 只取第一个会让 `src/view` 整片页面不属于任何模块。
 */
export declare function buildModules(repoRoot: string, srcDirRel: string | null, pageDirsRel: string[], api: ApiIndex, routes: RouteInfo[], graph: ComponentGraph): ModuleInfo[];
