import type { ProjectMap } from "../types";
declare const KINDS: readonly ["store", "event", "permission", "guard", "storage", "ws"];
export type ChannelKind = (typeof KINDS)[number];
/**
 * 状态与事件通道总览。
 * `map` 只出计数（体积不涨），明细走这里，可按 kind 过滤。
 */
export declare function channelsSummary(map: ProjectMap, kind?: string): string;
export {};
