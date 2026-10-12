/**
 * 路径别名表。
 *
 * 过去 `resolveSpecifier` 硬编码「`@/` → srcDir」，结果 repo-d 的
 * `@service`（→ src/service/api）、repo-e 的 `@treatment` / `@nurse`
 * 全部解析不出来，被静默丢弃 —— 那些仓的 import 关系有系统性缺口。
 *
 * 这里真读配置：tsconfig 的 `compilerOptions.paths`（全仓都有）+ vite 的
 * `resolve.alias`（对象式与数组式都要认）。
 */
export interface AliasEntry {
    /** 无尾部 `/*`，如 `"@"`、`"@service"` */
    prefix: string;
    /** repo 相对路径，无尾部斜杠，如 `"src"`、`"src/service/api"` */
    target: string;
}
export interface AliasMap {
    entries: AliasEntry[];
    /** 配置来源，便于诊断（如 `["tsconfig.json", "vite.config.ts"]`） */
    sources: string[];
    /** 认得出形态但求值失败的别名 —— 铁律二：说不清必须带原因和 evidence */
    unresolved: {
        prefix: string;
        reason: string;
        evidence: string[];
    }[];
}
export declare function getAliasMap(repoRoot: string): AliasMap;
export declare function clearAliasCache(): void;
/**
 * 别名匹配：前缀必须落在边界上（精确相等，或后跟 `/`）。
 * 返回 repo 相对路径（未做文件解析，可能是目录或无扩展名）。
 */
export declare function applyAlias(map: AliasMap, spec: string): string | null;
