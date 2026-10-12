import type { ProjectMap } from "../types";
/**
 * 模块间关系视图。
 *
 * 不带参数：全仓的模块依赖全景。
 * 带模块名：只看这个模块的「依赖谁 / 被谁依赖」。
 */
export declare function moduleGraphView(map: ProjectMap, focus?: string): string;
