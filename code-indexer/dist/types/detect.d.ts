import type { RepoStack } from "./types";
export declare function detectStack(repoRoot: string): RepoStack;
/**
 * 从 vite 配置里读 `build.outDir`。
 *
 * 默认忽略表只有 dist/build —— 但 repo-h 与 repo-a 把 outDir 设成了 `web`，
 * 于是**提交进仓的压缩 bundle**（`web/assets/js/index-*.js`）会被当源码扫描，
 * 污染 store / 组件 / 文件计数。按配置读，不靠猜目录名。
 */
export declare function detectBuildOutDir(repoRoot: string): string | null;
export declare function looksLikeRepo(repoRoot: string): boolean;
/**
 * 按**内容**识别构建产物目录。
 *
 * 配置读不出来的时候只能看内容：example-sys 的 `build` 脚本是纯 `vite build`（默认 outDir=`dist`），
 * 但仓里**提交了 `web/`** 的产物 —— 里面是压缩 bundle，会把守卫、权限码这些
 * 全扫出一堆假命中。
 *
 * 判据：目录里有 `index.html`，且存在带 hash 的产物 js。
 */
export declare function detectBuildOutputDirs(repoRoot: string): string[];
