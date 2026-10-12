import type { ComponentEmits, EventEdge } from "./channel-types";
import type { ProjectMap } from "./types";
/**
 * 组件 emit 事件链。
 *
 * 渲染树是**父 → 子**；emit 是**子 → 父**的反向通道，过去完全没有。
 *
 * 三个实测反直觉点（不处理会大面积漏）：
 * 1. **emit 的局部变量名要绑定** —— 仓里写的是 `const emits = defineEmits(...)` 然后
 *    `emits("update", v)`，只找 `emit(` 会漏
 * 2. **两种声明形态** —— `defineEmits<IEmits>()`（类型，要解析本地或 import 的 interface）
 *    与 `defineEmits(["listComplete"])`（字面量数组）
 * 3. **`v-model` 是隐式事件** —— 等价于 `@update:modelValue`，不展开的话这些组件
 *    看着"没有任何事件"
 */
/** `my-event` → `myEvent`；`update:model-value` → `update:modelValue` */
export declare function normalizeEvent(name: string): string;
export declare function buildComponentEmits(repoRoot: string, filesAbs: string[]): ComponentEmits[];
/**
 * 子 → 父的事件边。
 * `from` = 子组件（emit 方），`to` = 父组件（监听方），与渲染树方向相反。
 */
export declare function buildEventEdges(map: ProjectMap): EventEdge[];
