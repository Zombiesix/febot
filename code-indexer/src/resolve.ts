import path from "node:path";
import { applyAlias, getAliasMap } from "./alias";
import { dirExists, fileExists, toRepoRel } from "./ignore";

/**
 * 模块解析层。两个层次，别混用：
 *
 * - `resolveSpecifier`：把 import 说明符变成 **repo 相对路径**，可能无扩展名、也可能是目录。
 *   用于只需要「落在哪个目录下」的判断（如 api 域归属）。
 * - `resolveModuleFile`：在它之上做**文件解析** —— 补扩展名、目录导入取 `index.*`，
 *   返回**真实存在的文件**。用于需要精确对上文件清单的场景（组件图、客户端识别）。
 *
 * 过去的 `resolveComponentFile`（deps.ts）只认 `.vue`，且 `resolveSpecifier` 硬编码 `@/`，
 * 导致目录导入（`@/service` → `src/service/index.ts`）与其它别名全部解析不出 —— 静默少报。
 */

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"];

/**
 * 把 `@/xxx` 别名或相对路径还原成 repo 相对路径（正斜杠）。
 * 别名读真实配置（tsconfig paths + vite alias），不再是硬编码的 `@/`。
 * 裸模块名（第三方包）返回 null。
 */
export function resolveSpecifier(
  spec: string,
  fromFileAbs: string,
  repoRoot: string,
  srcDirRel: string | null,
): string | null {
  // 相对路径
  if (spec.startsWith(".")) {
    return toRepoRel(repoRoot, path.resolve(path.dirname(fromFileAbs), spec));
  }

  // 别名：最长前缀优先
  const aliased = applyAlias(getAliasMap(repoRoot), spec);
  if (aliased) return aliased;

  // 兜底：配置读不到时保持旧行为（@/ → srcDir），不因新逻辑退化
  if (spec.startsWith("@/")) {
    const base = srcDirRel ? path.join(repoRoot, srcDirRel) : repoRoot;
    return toRepoRel(repoRoot, path.join(base, spec.slice(2)));
  }

  return null;
}

/**
 * 解析到**真实文件**：先按原样，再补扩展名，最后按目录导入取 `index.*`。
 * 解析不出返回 null —— 调用方自行决定是丢弃还是记入「说不清」出口。
 */
export function resolveModuleFile(
  spec: string,
  fromFileAbs: string,
  repoRoot: string,
  srcDirRel: string | null,
): string | null {
  const base = resolveSpecifier(spec, fromFileAbs, repoRoot, srcDirRel);
  if (!base) return null;

  const abs = path.join(repoRoot, base);

  // 1) 原样就是文件（说明符自带扩展名）
  if (fileExists(abs)) return base;

  // 2) 补扩展名
  for (const ext of RESOLVE_EXTS) {
    if (fileExists(abs + ext)) return base + ext;
  }

  // 3) 目录导入 → index.*
  if (dirExists(abs)) {
    for (const ext of RESOLVE_EXTS) {
      if (fileExists(path.join(abs, `index${ext}`))) return `${base}/index${ext}`;
    }
  }

  return null;
}
