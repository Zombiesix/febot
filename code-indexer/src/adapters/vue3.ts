import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import {
  boolValue,
  createSource,
  dynamicImportSpecifier,
  getProp,
  stringValue,
} from "../ast";
import { resolveModuleFile } from "../resolve";
import type { RouteInfo } from "../types";

interface MetaFields {
  label: string | null;
  isSiderMenu: boolean | null;
  permissionCode: string | null;
  extraMeta: Record<string, string>;
}

function collectMeta(metaObj: ts.ObjectLiteralExpression | null): MetaFields {
  const out: MetaFields = {
    label: null,
    isSiderMenu: null,
    permissionCode: null,
    extraMeta: {},
  };
  if (!metaObj) return out;

  // 中文业务名的字段名各仓不一：example-sys 用 `label`，repo-b 用 `title`，
  // repo-a 用 `meta.name`。按这个优先级取，否则多数仓的路由都没有可读的业务名。
  let label: string | null = null;
  let title: string | null = null;
  let metaName: string | null = null;

  const codes: string[] = [];
  for (const p of metaObj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = ts.isIdentifier(p.name)
      ? p.name.text
      : ts.isStringLiteral(p.name)
        ? p.name.text
        : null;
    if (!key) continue;

    if (key === "label") {
      label = stringValue(p.initializer);
      continue;
    }
    if (key === "title") {
      title = stringValue(p.initializer);
      continue;
    }
    if (key === "name") {
      // meta.name 是业务名（与路由对象顶层的 name 不同，那是技术路由名）
      metaName = stringValue(p.initializer);
      continue;
    }
    if (key === "isSiderMenu") {
      out.isSiderMenu = boolValue(p.initializer);
      continue;
    }

    const literal = stringValue(p.initializer);
    if (literal !== null) {
      out.extraMeta[key] = literal;
      if (/permission/i.test(key) || /Code$/.test(key)) codes.push(literal);
    } else {
      out.extraMeta[key] = "<non-literal>";
    }
  }

  out.label = label ?? title ?? metaName;
  out.permissionCode = codes.length > 0 ? codes.join(",") : null;
  return out;
}

const MAX_ROUTE_DEPTH = 4;

/**
 * 从集中式路由表里提取路由。覆盖的形态：
 *
 * - `const routes = [{ path, component: () => import("@/..."), meta }]`
 * - `createRouter({ routes: [...] })` —— 数组直接内联在配置里
 * - `routes: [...constantRouter]` —— 数组来自别的模块，顺着 import 找过去（repo-d 形态）
 * - 嵌套 `children` —— 递归展开，子路由相对路径拼到父路径上
 *
 * 过去只认第一种单文件写法，repo-d 整仓解析出 0 条路由。
 */
export function extractRoutes(
  routerFileAbs: string,
  repoRoot: string,
  srcDirRel: string | null,
): { routes: RouteInfo[]; unresolved: string[]; dynamicRoutes: boolean } {
  const routes: RouteInfo[] = [];
  const unresolved: string[] = [];

  // 文件 → AST，避免同一文件反复读盘
  const sfCache = new Map<string, ts.SourceFile | null>();
  const load = (absFile: string): ts.SourceFile | null => {
    if (sfCache.has(absFile)) return sfCache.get(absFile) ?? null;
    let sf: ts.SourceFile | null = null;
    try {
      sf = createSource(fs.readFileSync(absFile, "utf8"), absFile);
    } catch {
      sf = null;
    }
    sfCache.set(absFile, sf);
    return sf;
  };

  /** 该文件里 `const X = [...]` 形式的具名数组 */
  const namedArrayIn = (absFile: string, name: string): ts.ArrayLiteralExpression | null => {
    const sf = load(absFile);
    if (!sf) return null;
    let found: ts.ArrayLiteralExpression | null = null;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        found = node.initializer;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  };

  /**
   * 路由对象上方的行内注释，如 `//复印管理`。
   * repo-g 的 24 条路由**没有任何 meta**，中文业务名只写在注释里 ——
   * 这是字面文本不是猜测，收进 extraMeta.comment 供导师层用。
   * 看起来像代码的注释（含 `:`/`(`/`=>`）一律丢弃，避免把注释掉的代码当业务名。
   */
  const commentOf = (obj: ts.ObjectLiteralExpression, ownerFile: string): string | null => {
    const sf = load(ownerFile);
    if (!sf) return null;
    const text = sf.getFullText();
    // 注释写在对象**内部**（`{ //复印管理 \n path: ... }`），所以要取第一个属性的前导注释
    const first = obj.properties[0];
    const from = first ? first.getFullStart() : obj.getFullStart();
    const ranges = ts.getLeadingCommentRanges(text, from);
    const last = ranges?.[ranges.length - 1];
    if (!last) return null;

    const raw = text
      .slice(last.pos, last.end)
      .replace(/^\/\*+/, "")
      .replace(/\*\/$/, "")
      .replace(/^\/+/, "")
      .split("\n")[0]
      .trim();

    if (!raw || /[:()=]/.test(raw)) return null;
    return raw;
  };

  /** 该文件里名字 `name` 是从哪个模块 import 的 */
  const importSpecOf = (absFile: string, name: string): string | null => {
    const sf = load(absFile);
    if (!sf) return null;
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const spec = stringValue(stmt.moduleSpecifier);
      if (!spec) continue;
      const clause = stmt.importClause;
      if (!clause) continue;
      if (clause.name && clause.name.text === name) return spec;
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (el.name.text === name) return spec;
        }
      }
    }
    return null;
  };

  /**
   * 展开一个路由数组。元素不一定是字面量 —— repo-d 是 `[...constantRouter]`，
   * 数组本体在别的模块里，要顺着 import 找过去。
   */
  const walkArray = (
    arr: ts.ArrayLiteralExpression,
    ownerFile: string,
    parentPath: string,
    depth: number,
  ): void => {
    if (depth > MAX_ROUTE_DEPTH) return;

    for (const el of arr.elements) {
      if (ts.isObjectLiteralExpression(el)) {
        routeFromObject(el, ownerFile, parentPath, depth);
        continue;
      }

      if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) {
        const name = el.expression.text;

        const sameFile = namedArrayIn(ownerFile, name);
        if (sameFile) {
          walkArray(sameFile, ownerFile, parentPath, depth + 1);
          continue;
        }

        const spec = importSpecOf(ownerFile, name);
        const target = spec ? resolveModuleFile(spec, ownerFile, repoRoot, srcDirRel) : null;
        const targetAbs = target ? path.join(repoRoot, target) : null;
        const imported = targetAbs ? namedArrayIn(targetAbs, name) : null;

        if (imported && targetAbs) {
          walkArray(imported, targetAbs, parentPath, depth + 1);
          continue;
        }
        unresolved.push(`<无法展开的路由数组 ...${name}>`);
      }
    }
  };

  const routeFromObject = (
    obj: ts.ObjectLiteralExpression,
    ownerFile: string,
    parentPath: string,
    depth: number,
  ): void => {
    const rawPath = stringValue(getProp(obj, "path")?.initializer) ?? "";
    // vue-router 语义：子路由的相对路径要拼到父路径上，否则路径对不上任何真实地址
    const fullPath =
      rawPath.startsWith("/") || !parentPath
        ? rawPath
        : `${parentPath.replace(/\/+$/, "")}/${rawPath}`;

    const nameValue = stringValue(getProp(obj, "name")?.initializer);
    const redirectValue = stringValue(getProp(obj, "redirect")?.initializer);

    const metaProp = getProp(obj, "meta");
    const metaObj =
      metaProp && ts.isObjectLiteralExpression(metaProp.initializer)
        ? metaProp.initializer
        : null;
    const meta = collectMeta(metaObj);

    let componentFile: string | null = null;
    const compProp = getProp(obj, "component");
    if (compProp) {
      const spec = dynamicImportSpecifier(compProp.initializer);
      if (spec) {
        // 走 resolveModuleFile：`import("@/page/foo")` 这类省略扩展名的写法
        // 过去解析出无扩展名路径，与组件图的 key 对不上，整棵树会空掉。
        const resolved = resolveModuleFile(spec, ownerFile, repoRoot, srcDirRel);
        if (resolved && resolved.toLowerCase().endsWith(".vue")) {
          componentFile = resolved;
        } else {
          unresolved.push(spec);
        }
      }
      // component 是标识符（Layout 之类）**不报 unresolved** ——
      // 嵌套路由的布局组件本来就不在 page 下，报出来只是噪音。
    }

    const comment = commentOf(obj, ownerFile);
    const extraMeta = { ...meta.extraMeta };
    // 有 meta 业务名时不塞注释，避免两套名字打架
    if (comment && !meta.label) extraMeta.comment = comment;

    routes.push({
      path: fullPath,
      name: nameValue,
      label: meta.label,
      componentFile,
      redirect: redirectValue,
      isSiderMenu: meta.isSiderMenu,
      permissionCode: meta.permissionCode,
      extraMeta,
    });

    // 嵌套子路由
    const childrenProp = getProp(obj, "children");
    if (childrenProp && ts.isArrayLiteralExpression(childrenProp.initializer)) {
      walkArray(childrenProp.initializer, ownerFile, fullPath, depth + 1);
    }
  };

  // ---- 入口：优先 createRouter 配置里的 `routes: [...]`，退回 `const routes = [...]` ----
  const sf = load(routerFileAbs);
  if (!sf) return { routes, unresolved, dynamicRoutes: false };

  // 路由由 import.meta.glob 在运行时生成（repo-h 形态）—— 静态枚举不了，
  // 必须**显式报出来**，否则调用方看到 routes=0 会以为"这个仓没有路由"。
  const dynamicRoutes = /import\s*\.\s*meta\s*\.\s*glob\s*\(/.test(sf.getFullText());

  let entry: ts.ArrayLiteralExpression | null = null;
  const findEntry = (node: ts.Node): void => {
    if (entry) return;
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "routes" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      entry = node.initializer;
      return;
    }
    ts.forEachChild(node, findEntry);
  };
  findEntry(sf);
  if (!entry) entry = namedArrayIn(routerFileAbs, "routes");

  if (entry) walkArray(entry, routerFileAbs, "", 0);
  return { routes, unresolved, dynamicRoutes };
}
