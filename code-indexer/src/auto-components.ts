import fs from "node:fs";
import path from "node:path";
import { fileExists, toRepoRel } from "./ignore";

export interface AutoComponentIndex {
  /** 组件名 → repo 相对路径 */
  byName: Map<string, string>;
  /** 同名冲突，无法确定是哪个 */
  ambiguous: Map<string, string[]>;
  /** dts = 读 unplugin 生成的声明；basename = 按约定目录兜底；none = 没有 */
  source: "dts" | "basename" | "none";
  dtsFile: string | null;
}

/** 匹配 `Foo: typeof import('./x/Foo.vue')['default']` */
const DTS_DECL_RE =
  /^\s*([A-Za-z_$][\w$]*)\s*:\s*typeof\s+import\(\s*['"]([^'"]+)['"]\s*\)/gm;

function loadFromDts(repoRoot: string, dtsAbs: string): Map<string, string> {
  const byName = new Map<string, string>();

  let code: string;
  try {
    code = fs.readFileSync(dtsAbs, "utf8");
  } catch {
    return byName;
  }

  const baseDir = path.dirname(dtsAbs);
  for (const match of code.matchAll(DTS_DECL_RE)) {
    const [, name, spec] = match;
    const abs = path.resolve(baseDir, spec);
    if (!fileExists(abs)) continue;
    byName.set(name, toRepoRel(repoRoot, abs));
  }

  return byName;
}

/**
 * 兜底：按 unplugin-vue-components 的默认约定，只认 components 目录下的 SFC。
 * 不放全仓，否则 `<Menu>` 会随便匹配到某个 Menu.vue，造出假边。
 */
function loadByBasename(
  repoRoot: string,
  sfcFilesAbs: string[],
): { byName: Map<string, string>; ambiguous: Map<string, string[]> } {
  const buckets = new Map<string, string[]>();

  for (const abs of sfcFilesAbs) {
    const rel = toRepoRel(repoRoot, abs);
    if (!rel.includes("/components/") && !rel.startsWith("components/")) continue;

    const name = path.basename(abs).replace(/\.vue$/i, "");
    buckets.set(name, [...(buckets.get(name) ?? []), rel]);
  }

  const byName = new Map<string, string>();
  const ambiguous = new Map<string, string[]>();
  for (const [name, list] of buckets) {
    if (list.length === 1) byName.set(name, list[0]);
    else ambiguous.set(name, [...list].sort());
  }

  return { byName, ambiguous };
}

export function loadAutoComponents(
  repoRoot: string,
  sfcFilesAbs: string[],
  allFilesAbs: string[],
): AutoComponentIndex {
  const dtsAbs = allFilesAbs.find(f => path.basename(f) === "components.d.ts");

  if (dtsAbs) {
    const byName = loadFromDts(repoRoot, dtsAbs);
    if (byName.size > 0) {
      return {
        byName,
        ambiguous: new Map(),
        source: "dts",
        dtsFile: toRepoRel(repoRoot, dtsAbs),
      };
    }
  }

  const { byName, ambiguous } = loadByBasename(repoRoot, sfcFilesAbs);
  return {
    byName,
    ambiguous,
    source: byName.size > 0 ? "basename" : "none",
    dtsFile: null,
  };
}
