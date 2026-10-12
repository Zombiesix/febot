import * as ts from "typescript";
export interface LiteralResolver {
    /** 把表达式解析成字符串字面量；解析不出返回 null */
    resolveString(node: ts.Node | undefined): string | null;
}
export declare function createLiteralResolver(absFile: string, repoRoot: string, srcDirRel: string | null): LiteralResolver;
export declare function clearLiteralCache(): void;
