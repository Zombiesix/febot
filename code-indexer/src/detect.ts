import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import {
  DEFAULT_IGNORED_DIRS,
  dirExists,
  fileExists,
  firstExistingDir,
  firstExistingFile,
  toRepoRel,
  walk,
} from "./ignore";
import type { RepoStack, StackKind } from "./types";

function readJson(abs: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

function majorOf(range: string): number | null {
  const m = String(range).match(/(\d+)\./);
  return m ? Number(m[1]) : null;
}

const QIANKUN_ENTRY_MARKERS = [
  "__POWERED_BY_QIANKUN__",
  "renderWithQiankun",
  "vite-plugin-qiankun",
];

export function detectStack(repoRoot: string): RepoStack {
  const pkg = readJson(path.join(repoRoot, "package.json"));
  const deps: Record<string, string> = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };

  const vueVersion = deps.vue ?? null;
  const vueMajor = vueVersion ? majorOf(vueVersion) : null;

  let kind: StackKind = "unknown";
  if (vueMajor !== null) kind = vueMajor >= 3 ? "vue3" : "vue2";

  let builder: RepoStack["builder"] = "unknown";
  if (deps.vite) builder = "vite";
  else if (deps["@vue/cli-service"]) builder = "vue-cli";

  const srcDir = firstExistingDir(repoRoot, ["src", "app", "source"]);
  const srcAbs = srcDir ?? repoRoot;

  const entryFile = firstExistingFile(srcAbs, [
    "main.ts",
    "main.js",
    "main.tsx",
    "main.jsx",
    "index.ts",
    "index.js",
  ]);

  // 子应用判定要看运行时标记，光有 qiankun 依赖可能是主应用
  let isQiankunChild = false;
  if (entryFile) {
    try {
      const code = fs.readFileSync(entryFile, "utf8");
      isQiankunChild = QIANKUN_ENTRY_MARKERS.some(m => code.includes(m));
    } catch {
      /* 读不到就当没标记 */
    }
  }

  const routerFile = firstExistingFile(srcAbs, [
    "router/index.ts",
    "router/index.js",
    "router.ts",
    "router.js",
  ]);
  const routerDir = firstExistingDir(srcAbs, ["router", "routers"]);
  const resolvedRouterFile =
    routerFile ?? (routerDir ? firstExistingFile(routerDir, ["index.ts", "index.js"]) : null);

  // 收集**所有**存在的页面目录，不只是第一个 ——
  // example-sys 同时有 src/page 与 src/view，只取第一个会让 src/view 整片页面消失
  const pageDirs = ["page", "pages", "view", "views"]
    .map(c => firstExistingDir(srcAbs, [c]))
    .filter((d): d is string => d !== null)
    .map(d => toRepoRel(repoRoot, d));
  const pageDir = pageDirs[0] ? path.join(repoRoot, pageDirs[0]) : null;
  const serviceDir = firstExistingDir(srcAbs, ["service", "services", "api"]);

  return {
    kind,
    vueVersion,
    builder,
    isQiankunChild,
    qiankunDeps: Object.keys(deps).filter(d => d.includes("qiankun")),
    entryFile: entryFile ? toRepoRel(repoRoot, entryFile) : null,
    srcDir: srcDir ? toRepoRel(repoRoot, srcDir) : null,
    routerFile: resolvedRouterFile ? toRepoRel(repoRoot, resolvedRouterFile) : null,
    pageDirs,
    pageDir: pageDirs[0] ?? null,
    serviceDir: serviceDir ? toRepoRel(repoRoot, serviceDir) : null,
  };
}

/**
 * 从 vite 配置里读 `build.outDir`。
 *
 * 默认忽略表只有 dist/build —— 但 repo-h 与 repo-a 把 outDir 设成了 `web`，
 * 于是**提交进仓的压缩 bundle**（`web/assets/js/index-*.js`）会被当源码扫描，
 * 污染 store / 组件 / 文件计数。按配置读，不靠猜目录名。
 */
export function detectBuildOutDir(repoRoot: string): string | null {
  const candidates = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"];

  for (const name of candidates) {
    const abs = path.join(repoRoot, name);
    if (!fileExists(abs)) continue;

    let code: string;
    try {
      code = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }

    const kind = name.endsWith(".ts") || name.endsWith(".mts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(abs, code, ts.ScriptTarget.Latest, true, kind);

    // 用数组累加而不是 let 变量：TS 的控制流分析看不到闭包里的赋值，会把它收窄成 never
    const hits: string[] = [];
    // 必须限定在 `build: { outDir }` 里 —— 别的插件配置也可能有 outDir
    // （repo-h 第 72 行就是 `outDir: "."`，取第一个会误判成仓根）
    const visit = (node: ts.Node, inBuild: boolean): void => {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
        if (node.name.text === "build") {
          ts.forEachChild(node, c => visit(c, true));
          return;
        }
        if (inBuild && node.name.text === "outDir" && ts.isStringLiteral(node.initializer)) {
          hits.push(node.initializer.text);
        }
      }
      ts.forEachChild(node, c => visit(c, inBuild));
    };
    visit(sf, false);

    const found = hits[0];
    if (found) {
      const base = path.basename(found.replace(/[/\\]+$/, ""));
      // "." 表示输出到仓根，绝不能当忽略目录（会把整个仓排除）
      if (base && base !== "." && base !== "..") return base;
    }
  }

  return null;
}

export function looksLikeRepo(repoRoot: string): boolean {
  return fileExists(path.join(repoRoot, "package.json")) && dirExists(repoRoot);
}

/** 带 hash 的构建产物文件名，如 `index-6a7be331.js` / `BedOverviewItem-a13ac7b5.js` */
const HASHED_BUNDLE = /[.-][0-9a-f]{8}\./i;

/**
 * 按**内容**识别构建产物目录。
 *
 * 配置读不出来的时候只能看内容：example-sys 的 `build` 脚本是纯 `vite build`（默认 outDir=`dist`），
 * 但仓里**提交了 `web/`** 的产物 —— 里面是压缩 bundle，会把守卫、权限码这些
 * 全扫出一堆假命中。
 *
 * 判据：目录里有 `index.html`，且存在带 hash 的产物 js。
 */
export function detectBuildOutputDirs(repoRoot: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    if (DEFAULT_IGNORED_DIRS.has(e.name)) continue;

    const dir = path.join(repoRoot, e.name);
    if (!fileExists(path.join(dir, "index.html"))) continue;

    const js = walk(dir).files.filter(f => f.toLowerCase().endsWith(".js"));
    if (js.some(f => HASHED_BUNDLE.test(path.basename(f)))) out.push(e.name);
  }
  return out;
}
