import * as ts from "typescript";
export interface ScriptSource {
    code: string;
    /** 该段代码在原文件中的起始行（1-based 偏移量），用于把行号还原到原文件 */
    lineOffset: number;
}
export interface SfcParts {
    script: ScriptSource | null;
    template: string | null;
    /** template 内容在原文件中的起始行（1-based 偏移量），用于把模板内行号还原到原文件 */
    templateLineOffset: number;
}
/** 一次解析拿到 script 与 template 两段；非 .vue 只返回 script */
export declare function readSfcParts(absFile: string): SfcParts;
/** 读出可解析的脚本源码；.vue 走 SFC 解析取 script/script setup 块 */
export declare function readScript(absFile: string): ScriptSource | null;
/** 同一 fileName 复用同一个 SourceFile —— 节点身份一致，调用方可以安全做引用比较 */
export declare function createSource(code: string, fileName: string): ts.SourceFile;
export declare function clearSourceCache(): void;
export declare function getProp(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | null;
export declare function stringValue(node: ts.Node | undefined): string | null;
export declare function boolValue(node: ts.Node | undefined): boolean | null;
/** 取出 `() => import("x")` 或 `import("x")` 里的模块说明符 */
export declare function dynamicImportSpecifier(node: ts.Node | undefined): string | null;
export { resolveSpecifier, resolveModuleFile } from "./resolve";
/** 遍历所有 ImportDeclaration，回调 (模块说明符, 导入名列表, 该声明所在行) */
export declare function forEachImport(sf: ts.SourceFile, cb: (spec: string, names: string[], line: number) => void): void;
/** 收集导出的函数/常量名，用于 API 域的函数清单 */
export declare function collectExports(sf: ts.SourceFile): string[];
