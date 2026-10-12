import fs from "node:fs";
import path from "node:path";
import { collectApiUsage, type ApiIndex } from "./api-calls";
import { buildComponentTree, countTree } from "./deps";
import { toRepoRel, walk } from "./ignore";
import type { ComponentGraph, ModuleInfo, RouteInfo } from "./types";

/** 模块的渲染入口：优先路由指向的组件，其次 index.vue，再退到任意 SFC */
function pickEntry(
  route: RouteInfo | null,
  moduleDirRel: string,
  sfcFiles: string[],
): string | null {
  if (route?.componentFile) return route.componentFile;

  const indexVue = `${moduleDirRel}/index.vue`;
  if (sfcFiles.includes(indexVue)) return indexVue;

  return sfcFiles[0] ?? null;
}

/**
 * 业务模块 = 页面目录下的一级目录。这个仓把业务模块直接摊在 `src/page/<模块>/`，
 * 所以模块划分不用 LLM 聚类，读目录就有。
 *
 * **多个页面目录都要扫**：example-sys 同时有 `src/page`（12 个模块）与 `src/view`（5 个），
 * 只取第一个会让 `src/view` 整片页面不属于任何模块。
 */
export function buildModules(
  repoRoot: string,
  srcDirRel: string | null,
  pageDirsRel: string[],
  api: ApiIndex,
  routes: RouteInfo[],
  graph: ComponentGraph,
): ModuleInfo[] {
  const modules: ModuleInfo[] = [];
  const usedNames = new Set<string>();

  for (const pageDirRel of pageDirsRel) {
    const pageAbs = path.join(repoRoot, pageDirRel);

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(pageAbs, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;

      const dirAbs = path.join(pageAbs, e.name);
      const dirRel = toRepoRel(repoRoot, dirAbs);
      const files = walk(dirAbs).files;

      const components = files
        .filter(f => path.extname(f).toLowerCase() === ".vue")
        .map(f => toRepoRel(repoRoot, f))
        .sort();

      const route = routes.find(r => r.componentFile?.startsWith(`${dirRel}/`)) ?? null;
      const entry = pickEntry(route, dirRel, components);
      const tree = entry ? buildComponentTree(entry, graph) : null;

      // 不同页面目录下同名子目录：加页面目录名做前缀，避免撞名
      let name = e.name;
      if (usedNames.has(name)) name = `${path.basename(pageDirRel)}-${e.name}`;
      usedNames.add(name);

      modules.push({
        name,
        dir: dirRel,
        route,
        label: route?.label ?? null,
        components,
        tree,
        treeSize: tree ? countTree(tree) : 0,
        api: collectApiUsage(repoRoot, srcDirRel, api, files, dirRel),
      });
    }
  }

  modules.sort((a, b) => a.name.localeCompare(b.name));
  return modules;
}
