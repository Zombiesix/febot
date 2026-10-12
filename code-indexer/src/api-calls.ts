import fs from "node:fs";
import path from "node:path";
import {
  collectExports,
  createSource,
  forEachImport,
  readScript,
  resolveSpecifier,
} from "./ast";
import type { Endpoint, UnresolvedFn } from "./endpoint-types";
import { extractEndpoints } from "./endpoints";
import { dirExists, toRepoRel, walk } from "./ignore";
import { resolveModuleFile } from "./resolve";
import type { ApiDomainInfo, ApiUsage } from "./types";

export interface ApiIndex {
  /** repo 相对的 api 根目录，如 src/service/api */
  root: string | null;
  /** 直接放在根下的代码文件（如 $http.ts），属于共享层而非某个域 */
  sharedFiles: string[];
  domains: ApiDomainInfo[];
}

const CODE_EXT = new Set([".ts", ".js", ".tsx", ".jsx", ".vue"]);

function isCode(f: string): boolean {
  return CODE_EXT.has(path.extname(f).toLowerCase());
}

export function buildApiIndex(
  repoRoot: string,
  serviceDirRel: string | null,
  srcDirRel: string | null,
): ApiIndex {
  if (!serviceDirRel) return { root: null, sharedFiles: [], domains: [] };

  const serviceAbs = path.join(repoRoot, serviceDirRel);
  const apiSubAbs = path.join(serviceAbs, "api");
  const rootAbs = dirExists(apiSubAbs) ? apiSubAbs : serviceAbs;
  const rootRel = toRepoRel(repoRoot, rootAbs);

  // 共享层 = 服务层根下的代码文件，但**排除 api 域目录内部**。
  // 这样 $http.ts（service 根）、instance/index.ts、request/config.ts（嵌套目录）
  // 都算共享层 —— 过去只收「直接文件」，导致目录导入的客户端（@/service/instance）
  // 识别不出来，整个仓的端点静默归零。
  // 没有 api/ 子目录时退回旧口径（只收 service 根下的直接文件）。
  const hasApiSubdir = rootAbs !== serviceAbs;
  const sharedFiles = [...new Set(
    walk(serviceAbs)
      .files.filter(isCode)
      .map(f => toRepoRel(repoRoot, f))
      .filter(rel =>
        hasApiSubdir
          ? !rel.startsWith(`${rootRel}/`)
          : !rel.slice(serviceDirRel.length + 1).includes("/"),
      ),
  )].sort();

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(rootAbs, { withFileTypes: true });
  } catch {
    entries = [];
  }

  // 先把「域 → 文件清单」摊开：后面既要用它推客户端，也要用它抽端点
  const descs: { name: string; dir: string; files: string[] }[] = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;

    // api 域有两种形态：**目录**（example-sys / repo-a / repo-b）和
    // **单文件**（repo-d 的 api/common.ts、repo-mobile 的 api/*.ts）。
    // 过去只认目录，repo-d 整仓解析出 0 个域。
    if (e.isDirectory()) {
      const dirAbs = path.join(rootAbs, e.name);
      descs.push({
        name: e.name,
        dir: toRepoRel(repoRoot, dirAbs),
        files: walk(dirAbs)
          .files.filter(isCode)
          .map(f => toRepoRel(repoRoot, f))
          .sort(),
      });
      continue;
    }

    if (e.isFile() && isCode(e.name)) {
      const base = e.name.replace(/\.[^.]+$/, "");
      if (base === "index") continue; // 域根下的 index 是聚合入口，不是域
      const rel = toRepoRel(repoRoot, path.join(rootAbs, e.name));
      descs.push({ name: base, dir: rel, files: [rel] });
    }
  }

  // 内容式客户端识别：域文件 import 的、位于 api 域目录之外的模块，
  // 只要内容里调了 `axios.create(` 就算 http 客户端。
  // 不按路径也不按名字猜 —— repo-mobile 的客户端在 `src/utils/request`，
  // 根本不在 service 根下，按路径识别永远找不到。
  const outsideImports = new Set<string>();
  for (const d of descs) {
    for (const rel of d.files) {
      const abs = path.join(repoRoot, rel);
      const script = readScript(abs);
      if (!script) continue;
      forEachImport(createSource(script.code, rel), spec => {
        const resolved = resolveModuleFile(spec, abs, repoRoot, srcDirRel);
        if (!resolved || resolved.startsWith(`${rootRel}/`)) return;
        outsideImports.add(resolved);
      });
    }
  }

  const contentClients = [...outsideImports].filter(rel => {
    try {
      return /axios\s*\.\s*create\s*\(/.test(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
    } catch {
      return false;
    }
  });

  const clientFiles = new Set([...sharedFiles, ...contentClients]);
  const domains: ApiDomainInfo[] = [];

  for (const { name, dir: dirRel, files } of descs) {
    const funcs = new Set<string>();
    const endpoints: Endpoint[] = [];
    // 按函数名去重，保留首次出现的 reason/evidence
    const unresolved = new Map<string, UnresolvedFn>();

    for (const rel of files) {
      const abs = path.join(repoRoot, rel);
      const script = readScript(abs);
      if (!script) continue;

      for (const n of collectExports(createSource(script.code, rel))) funcs.add(n);

      const extracted = extractEndpoints(script, abs, repoRoot, srcDirRel, clientFiles);
      endpoints.push(...extracted.endpoints);
      for (const u of extracted.unresolvedFns) {
        if (!unresolved.has(u.fn)) unresolved.set(u.fn, u);
      }
    }

    const unresolvedFns = [...unresolved.values()].sort((a, b) =>
      a.reason.localeCompare(b.reason) || a.fn.localeCompare(b.fn),
    );

    domains.push({
      name,
      dir: dirRel,
      files,
      functions: [...funcs].sort(),
      endpoints: endpoints.sort(
        (a, b) => a.fn.localeCompare(b.fn) || a.url.localeCompare(b.url),
      ),
      unresolvedFns,
      nonEndpointFns: unresolvedFns.map(u => u.fn),
      usedByModules: [],
    });
  }

  domains.sort((a, b) => a.name.localeCompare(b.name));
  return { root: rootRel, sharedFiles, domains };
}

function domainOf(resolvedRel: string, apiRootRel: string): string | null {
  if (!resolvedRel.startsWith(`${apiRootRel}/`)) return null;
  const rest = resolvedRel.slice(apiRootRel.length + 1);
  return rest.split("/")[0] || null;
}

/** 从一组文件里找出它们引用了哪些 API 域，链接关系完全由 import 推导，不靠猜名字 */
export function collectApiUsage(
  repoRoot: string,
  srcDirRel: string | null,
  api: ApiIndex,
  filesAbs: string[],
  moduleDirRel: string | null = null,
): ApiUsage[] {
  if (!api.root) return [];
  const known = new Set(api.domains.map(d => d.name));
  // 每个域真正导出的函数名。用它把混合 import 里的类型/常量剔掉——
  // 纯语法分析分不出 `import { SomeDTO, someFn }` 哪个是类型。
  const domainFns = new Map(api.domains.map(d => [d.name, new Set(d.functions)]));

  const byDomain = new Map<
    string,
    { refs: Set<string>; subPaths: Set<string>; evidence: Set<string>; onlyTypes: boolean }
  >();

  for (const abs of filesAbs) {
    if (!isCode(abs)) continue;
    const script = readScript(abs);
    if (!script) continue;

    const sf = createSource(script.code, abs);
    const rel = toRepoRel(repoRoot, abs);
    const subPath = moduleDirRel && rel.startsWith(`${moduleDirRel}/`)
      ? rel.slice(moduleDirRel.length + 1)
      : rel;

    forEachImport(sf, (spec, names, line) => {
      const resolved = resolveSpecifier(spec, abs, repoRoot, srcDirRel);
      if (!resolved) return;

      const domain = domainOf(resolved, api.root!);
      if (!domain || !known.has(domain)) return;

      const entry = byDomain.get(domain) ?? {
        refs: new Set<string>(),
        subPaths: new Set<string>(),
        evidence: new Set<string>(),
        onlyTypes: true,
      };

      for (const n of names) {
        if (n.startsWith("* as ")) {
          entry.refs.add(`${domain}/*`);
          entry.onlyTypes = false;
          continue;
        }
        if (!domainFns.get(domain)?.has(n)) continue; // 类型/常量，不是 api 函数
        entry.refs.add(`${domain}/${n}`);
        entry.onlyTypes = false;
      }

      entry.subPaths.add(subPath);
      entry.evidence.add(`${rel}:${line + script.lineOffset}`);
      byDomain.set(domain, entry);
    });
  }

  // 只引了类型、没调任何函数的域不算"使用该域"，否则会污染共享域统计和命名告警
  return [...byDomain.entries()]
    .filter(([, v]) => !v.onlyTypes)
    .map(([domain, v]) => ({
      domain,
      refs: [...v.refs].sort(),
      subPaths: [...v.subPaths].sort(),
      evidence: [...v.evidence].sort(),
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}
