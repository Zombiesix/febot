import type { ProjectMap } from "../types";
/**
 * 追一个 store 字段：**谁在读、谁在写**。
 *
 * `trace-state <repo> <store>.<field>` 或 `trace-state <repo> <store>`（列全部字段）。
 * 这是「这个状态谁改的」的直接答案 —— 过去完全没有这个视角。
 */
export declare function traceState(map: ProjectMap, target: string): string;
