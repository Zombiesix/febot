/**
 * 目录级排除。命中即不下探，所以这些目录里的文件不计入 filesIgnored。
 * public 也排除：它是静态资源，不是代码。
 */
export declare const DEFAULT_IGNORED_DIRS: Set<string>;
/** 文件级排除：构建残留与凭证类文件 */
export declare const DEFAULT_IGNORED_FILES: RegExp[];
export interface WalkResult {
    /** 绝对路径 */
    files: string[];
    symlinksSkipped: string[];
    filesIgnored: number;
}
export interface WalkOptions {
    ignoredDirs?: Set<string>;
    ignoredFiles?: RegExp[];
}
/**
 * 递归遍历。符号链接一律不跟随——dirent 对 symlink 的 isDirectory() 为 false，
 * 但仍显式记录，避免以后有人改用 statSync 时静默踩坑。
 */
export declare function walk(root: string, opts?: WalkOptions): WalkResult;
export declare function toRepoRel(repoRoot: string, abs: string): string;
export declare function fileExists(abs: string): boolean;
export declare function dirExists(abs: string): boolean;
/** 按候选名依次探测，返回第一个存在的（绝对路径） */
export declare function firstExistingDir(base: string, candidates: string[]): string | null;
export declare function firstExistingFile(base: string, candidates: string[]): string | null;
