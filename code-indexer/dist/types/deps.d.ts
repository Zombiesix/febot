import type { AutoComponentIndex } from "./auto-components";
import type { ComponentGraph, ComponentNode } from "./types";
export declare function buildComponentGraph(repoRoot: string, srcDirRel: string | null, sfcFilesAbs: string[], auto: AutoComponentIndex): ComponentGraph;
/**
 * 从入口组件展开引用树。
 * 同一组件在树里出现多次时只在首次展开，其余标 duplicate，避免共享组件导致指数膨胀；
 * 环形引用标 cyclic 并停止下探。
 */
export declare function buildComponentTree(rootFile: string, graph: ComponentGraph): ComponentNode;
/** 树里去重后的组件数 */
export declare function countTree(node: ComponentNode): number;
