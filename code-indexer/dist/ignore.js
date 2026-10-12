import fs from "node:fs";
import path from "node:path";
/**
 * 目录级排除。命中即不下探，所以这些目录里的文件不计入 filesIgnored。
 * public 也排除：它是静态资源，不是代码。
 */
export const DEFAULT_IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    ".vscode",
    ".idea",
    "public",
]);
/** 文件级排除：构建残留与凭证类文件 */
export const DEFAULT_IGNORED_FILES = [
    /^vite\.config\.ts\.timestamp-.*\.mjs$/, // vite 构建残留
    /\.temp$/, // 如 token.temp
    /^\.env/, // 环境变量，可能含密钥
    /\.log$/,
    /\.zip$/,
    // 压缩过的第三方库（如 src/utils/insurance/insurance.es.min.js）——
    // 不是人写的源码，扫出来的 key/端点全是噪音
    /\.min\.(js|css)$/,
];
/**
 * 递归遍历。符号链接一律不跟随——dirent 对 symlink 的 isDirectory() 为 false，
 * 但仍显式记录，避免以后有人改用 statSync 时静默踩坑。
 */
export function walk(root, opts = {}) {
    const ignoredDirs = opts.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
    const ignoredFiles = opts.ignoredFiles ?? DEFAULT_IGNORED_FILES;
    const files = [];
    const symlinksSkipped = [];
    let filesIgnored = 0;
    const visit = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return; // 权限不足或已删除，跳过即可
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) {
                symlinksSkipped.push(full);
                continue;
            }
            if (entry.isDirectory()) {
                if (!ignoredDirs.has(entry.name))
                    visit(full);
                continue;
            }
            if (!entry.isFile())
                continue;
            if (ignoredFiles.some(re => re.test(entry.name))) {
                filesIgnored++;
                continue;
            }
            files.push(full);
        }
    };
    visit(root);
    return { files, symlinksSkipped, filesIgnored };
}
export function toRepoRel(repoRoot, abs) {
    return path.relative(repoRoot, abs).split(path.sep).join("/");
}
export function fileExists(abs) {
    try {
        return fs.statSync(abs).isFile();
    }
    catch {
        return false;
    }
}
export function dirExists(abs) {
    try {
        return fs.statSync(abs).isDirectory();
    }
    catch {
        return false;
    }
}
/** 按候选名依次探测，返回第一个存在的（绝对路径） */
export function firstExistingDir(base, candidates) {
    for (const c of candidates) {
        const abs = path.join(base, c);
        if (dirExists(abs))
            return abs;
    }
    return null;
}
export function firstExistingFile(base, candidates) {
    for (const c of candidates) {
        const abs = path.join(base, c);
        if (fileExists(abs))
            return abs;
    }
    return null;
}
