import type { StoreInfo, StoreStateIndex } from "./channel-types";
/**
 * Pinia store 抽取。
 *
 * 实测三种形态，缺一不可：
 * - **对象式** `defineStore({ id, state, getters, actions })` —— example-sys / repo-e / repo-f / repo-a
 * - **setup 式** `defineStore("id", () => { const a = ref(); return { a } })` —— repo-d
 * - **模块级 reactive 单例** `export const x = reactive({ ... })` —— example-sys `store/qiankun.ts`
 *   （既不是 pinia 也不是 props 的隐藏全局状态）
 *
 * 两个反直觉点（不按这两个来会大面积漏）：
 * 1. **id 不是文件名** —— 对象式取 `id` 字段，setup 式取首参
 * 2. **使用侧的标识符是「导出绑定名」** —— 可能是 `useUserStore`，也可能是
 *    `userStore` / `useCodeMapping`，不能假设以 `use` 开头
 */
export type { StoreInfo, StoreRef, StoreStateIndex } from "./channel-types";
export declare function buildStores(repoRoot: string, filesAbs: string[], pageDirsRel: string[]): StoreInfo[];
/**
 * 谁在读、谁在写。
 * 使用侧的标识符是**导出绑定名**，所以先把 `const s = <binding>()` 的局部名认出来，
 * 再统计 `s.member` 的读写。
 */
export declare function buildStoreStateIndex(repoRoot: string, filesAbs: string[], stores: StoreInfo[]): StoreStateIndex;
