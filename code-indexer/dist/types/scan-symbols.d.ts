import * as ts from "typescript";
/**
 * 统一的符号引用扫描器。
 *
 * 五个抽取器（store / emit / 权限 / 存储 / WS）要的都是同一件事：
 * **遍历代码文件，在 CallExpression / NewExpression / PropertyAccessExpression 上
 * 按自己的谓词挑出关心的符号**。过去每处各写一遍遍历，逻辑漂移且难维护。
 *
 * 这个模块只做「遍历 + 上下文」，判断留给调用方 —— 不预置任何业务假设。
 */
export interface SymbolCtx {
    sf: ts.SourceFile;
    /** repo 相对路径 */
    relFile: string;
    absFile: string;
    /** 1-based 行号，已把 SFC `<script>` 块的偏移加回去 */
    lineOf(node: ts.Node): number;
    /** 本文件的 import：本地名 → 模块说明符 */
    imports: Map<string, string>;
    /** 最近的具名顶层声明（函数 / 类 / 变量名），用于归因 */
    owner: string | null;
}
export type SymbolKind = "call" | "new" | "member";
export interface SymbolHit {
    kind: SymbolKind;
    /** 被调用 / 被 new / 被访问的对象名 */
    symbol: string;
    /** 成员名，仅 kind === "member" 时有 */
    member?: string;
    file: string;
    line: number;
    owner: string | null;
    /** 命中节点本身，调用方可以继续往下分析 */
    node: ts.Node;
}
export interface SymbolMatcher {
    call?(node: ts.CallExpression, ctx: SymbolCtx): boolean;
    newExpr?(node: ts.NewExpression, ctx: SymbolCtx): boolean;
    member?(node: ts.PropertyAccessExpression, ctx: SymbolCtx): boolean;
}
/**
 * 扫一批文件，按 matcher 挑符号。
 * 命中即回调，不收集不排序 —— 排序与去重交给调用方（各抽取器诉求不同）。
 */
export declare function scanSymbols(repoRoot: string, filesAbs: string[], matcher: SymbolMatcher, onHit: (hit: SymbolHit) => void): void;
