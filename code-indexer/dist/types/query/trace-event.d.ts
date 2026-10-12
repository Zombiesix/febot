import type { ProjectMap } from "../types";
/**
 * 追一个组件事件：**谁 emit → 谁接 → handler 干了什么**。
 *
 * 渲染树是父→子，emit 是子→父的反向通道 —— 这个查询走的就是那条反向边。
 */
export declare function traceEvent(map: ProjectMap, component: string, event: string): string;
