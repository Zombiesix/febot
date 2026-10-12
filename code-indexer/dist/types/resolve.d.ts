/**
 * 把 `@/xxx` 别名或相对路径还原成 repo 相对路径（正斜杠）。
 * 别名读真实配置（tsconfig paths + vite alias），不再是硬编码的 `@/`。
 * 裸模块名（第三方包）返回 null。
 */
export declare function resolveSpecifier(spec: string, fromFileAbs: string, repoRoot: string, srcDirRel: string | null): string | null;
/**
 * 解析到**真实文件**：先按原样，再补扩展名，最后按目录导入取 `index.*`。
 * 解析不出返回 null —— 调用方自行决定是丢弃还是记入「说不清」出口。
 */
export declare function resolveModuleFile(spec: string, fromFileAbs: string, repoRoot: string, srcDirRel: string | null): string | null;
