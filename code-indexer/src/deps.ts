import path from "node:path";
import * as ts from "typescript";
import { parse as parseTemplate } from "@vue/compiler-dom";
import {
  type ScriptSource,
  createSource,
  readSfcParts,
  stringValue,
} from "./ast";
import type { AutoComponentIndex } from "./auto-components";
import { toRepoRel } from "./ignore";
import { resolveModuleFile } from "./resolve";
import type {
  ComponentEdge,
  ComponentGraph,
  ComponentNode,
  EdgeVia,
  TemplateEventBinding,
} from "./types";

/** Vue 内置 + HTML + SVG 原生标签。这些不是本仓组件，不进组件树。 */
const NATIVE_TAGS = new Set<string>([
  // Vue 内置
  "component", "transition", "transition-group", "keep-alive", "teleport", "suspense", "slot",
  // HTML
  "a", "abbr", "address", "area", "article", "aside", "audio", "b", "base", "bdi", "bdo",
  "blockquote", "body", "br", "button", "canvas", "caption", "cite", "code", "col", "colgroup",
  "data", "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt", "em", "embed",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "head", "header", "hgroup", "hr", "html", "i", "iframe", "img", "input", "ins", "kbd", "label",
  "legend", "li", "link", "main", "map", "mark", "menu", "meta", "meter", "nav", "noscript",
  "object", "ol", "optgroup", "option", "output", "p", "param", "picture", "pre", "progress",
  "q", "rp", "rt", "ruby", "s", "samp", "script", "section", "select", "small", "source", "span",
  "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "template", "textarea",
  "tfoot", "th", "thead", "time", "title", "tr", "track", "u", "ul", "var", "video", "wbr",
  // SVG
  "svg", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "g", "defs", "use",
  "symbol", "marker", "mask", "pattern", "clippath", "lineargradient", "radialgradient", "stop",
  "filter", "feblend", "fecolormatrix", "fegaussianblur", "femerge", "feoffset", "text", "tspan",
  "textpath", "foreignobject", "image", "switch", "view",
]);

const ELEMENT_NODE = 1;

/** kebab-case 标签转 PascalCase，用来对上 import 名或自动导入名 */
function pascalize(tag: string): string {
  return tag
    .split(/[-_]/)
    .filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/** 展示名：index.vue 用父目录名，否则用文件名 */
function componentName(file: string): string {
  const base = path.basename(file).replace(/\.vue$/i, "");
  if (base.toLowerCase() !== "index") return base;
  return path.basename(path.dirname(file)) || base;
}

const DIRECTIVE_NODE = 7;

/** `@change="onChange"` → onChange；内联箭头函数 / 复杂表达式 → null */
function handlerNameOf(exp: unknown): string | null {
  const content =
    exp && typeof exp === "object" && typeof (exp as any).content === "string"
      ? (exp as any).content.trim()
      : "";
  if (!content) return null;
  // 简单标识符（可带 `.` 路径）才算 handler 名，`v => v.x` 这类内联的不算
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(content) ? content : null;
}

/**
 * 解析模板 AST，收集每个元素标签 + 它上面的 `v-on` / `v-model` 绑定。
 * 含 v-if 各分支。
 */
function collectTemplateElements(
  templateCode: string,
): { tag: string; bindings: TemplateEventBinding[] }[] {
  const out: { tag: string; bindings: TemplateEventBinding[] }[] = [];

  let root: unknown;
  try {
    root = parseTemplate(templateCode);
  } catch {
    return [];
  }

  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;

    if (node.type === ELEMENT_NODE && typeof node.tag === "string") {
      const bindings: TemplateEventBinding[] = [];

      for (const p of node.props ?? []) {
        if (p?.type !== DIRECTIVE_NODE) continue;
        const line: number = p.loc?.start?.line ?? node.loc?.start?.line ?? 1;

        // @change / v-on:change
        if (p.name === "on" && typeof p.arg?.content === "string") {
          bindings.push({
            event: p.arg.content,
            handler: handlerNameOf(p.exp),
            line,
            via: "v-on",
          });
          continue;
        }

        // v-model / v-model:foo —— 等价于 `@update:modelValue` / `@update:foo`，
        // 不展开的话这些组件看着"没有任何事件"
        if (p.name === "model") {
          const arg = typeof p.arg?.content === "string" ? p.arg.content : "modelValue";
          bindings.push({ event: `update:${arg}`, handler: null, line, via: "v-model" });
        }
      }

      out.push({ tag: node.tag, bindings });
    }

    if (Array.isArray(node.children)) for (const c of node.children) visit(c);
    if (Array.isArray(node.branches)) for (const b of node.branches) visit(b);
  };

  visit(root);
  return out;
}

/** 只有 .vue 算组件；其余（.ts 工具、store 等）不进组件图 */
function asComponentFile(resolved: string | null): string | null {
  if (!resolved) return null;
  return resolved.toLowerCase().endsWith(".vue") ? resolved : null;
}

interface StaticImport {
  target: string;
  /** 该绑定在 import 语句之外还被用到（赋值给数据、传给 props 等） */
  referenced: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 显式 import 名 → 本仓 .vue 文件 */
function staticImports(
  script: ScriptSource | null,
  absFile: string,
  repoRoot: string,
  srcDirRel: string | null,
): Map<string, StaticImport> {
  const map = new Map<string, StaticImport>();
  if (!script) return map;

  const code = script.code;
  const sf = createSource(code, absFile);

  // 名字在 import 之外还出现 => 被当值用了。用词边界匹配，避免子串误判。
  const isReferenced = (name: string): boolean => {
    const hits = code.match(new RegExp(`\\b${escapeRe(name)}\\b`, "g"));
    return (hits?.length ?? 0) > 1;
  };

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;

    const spec = stringValue(stmt.moduleSpecifier);
    if (!spec) continue;

    const target = asComponentFile(resolveModuleFile(spec, absFile, repoRoot, srcDirRel));
    if (!target) continue;

    const clause = stmt.importClause;
    if (!clause) continue;

    if (clause.name) {
      map.set(clause.name.text, { target, referenced: isReferenced(clause.name.text) });
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        map.set(el.name.text, { target, referenced: isReferenced(el.name.text) });
      }
    }
  }

  return map;
}

/**
 * 脚本里所有对 .vue 的动态 import。
 * 覆盖 `defineAsyncComponent(() => import("..."))` 和裸 `() => import("...")`——
 * 这类引用常常挂在数据上由 <component :is> 渲染，模板里根本看不到。
 */
function asyncVueImports(
  script: ScriptSource | null,
  absFile: string,
  repoRoot: string,
  srcDirRel: string | null,
): string[] {
  if (!script) return [];

  const sf = createSource(script.code, absFile);
  const targets = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = stringValue(node.arguments[0]);
      if (spec) {
        const target = asComponentFile(resolveModuleFile(spec, absFile, repoRoot, srcDirRel));
        if (target) targets.add(target);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return [...targets];
}

/** 模板里是否有 <component :is> —— 具体渲染谁由数据决定 */
function hasDynamicComponent(templateCode: string): boolean {
  return /<component[\s>]/i.test(templateCode) && /:is\s*=/.test(templateCode);
}

export function buildComponentGraph(
  repoRoot: string,
  srcDirRel: string | null,
  sfcFilesAbs: string[],
  auto: AutoComponentIndex,
): ComponentGraph {
  const edges: Record<string, ComponentEdge[]> = {};
  const externalTags: Record<string, string[]> = {};
  const importedBy: Record<string, string[]> = {};
  const dynamicComponents: string[] = [];
  const eventBindings: ComponentGraph["eventBindings"] = {};
  let edgeCount = 0;
  let externalTagCount = 0;

  for (const abs of sfcFilesAbs) {
    const rel = toRepoRel(repoRoot, abs);
    const parts = readSfcParts(abs);

    if (!parts.template) {
      edges[rel] = [];
      continue;
    }

    const imports = staticImports(parts.script, abs, repoRoot, srcDirRel);
    const edgeMap = new Map<string, EdgeVia>();
    const external = new Set<string>();
    const bindings: ComponentGraph["eventBindings"][string] = [];

    for (const el of collectTemplateElements(parts.template)) {
      const tag = el.tag;
      if (NATIVE_TAGS.has(tag.toLowerCase())) continue;

      let child: string | null = null;

      const imported = imports.get(tag) ?? imports.get(pascalize(tag));
      if (imported) {
        edgeMap.set(imported.target, "import");
        child = imported.target;
      } else {
        // 源码里没有 import 语句的，走自动导入清单
        const autoResolved = auto.byName.get(tag) ?? auto.byName.get(pascalize(tag));
        if (autoResolved) {
          edgeMap.set(autoResolved, "auto");
          child = autoResolved;
        }
      }

      if (!child) {
        external.add(tag);
        continue;
      }

      // 只对**能解析到本仓组件**的标签记事件绑定 ——
      // 原生元素上的 @click 不算组件事件，记了只是噪音
      for (const b of el.bindings) {
        bindings.push({
          child,
          event: b.event,
          handler: b.handler,
          line: b.line + parts.templateLineOffset,
          via: b.via,
        });
      }
    }

    if (bindings.length > 0) eventBindings[rel] = bindings;

    // 动态 import 的组件即使模板看不到也要算进来
    for (const target of asyncVueImports(parts.script, abs, repoRoot, srcDirRel)) {
      if (!edgeMap.has(target)) edgeMap.set(target, "async");
    }

    // 静态 import 但没当标签用：多半被塞进数据由 <component :is> 渲染。
    // 漏掉这类等于漏掉整个 tab 内容页，所以宁可多算。
    for (const info of imports.values()) {
      if (edgeMap.has(info.target) || !info.referenced) continue;
      edgeMap.set(info.target, "indirect");
    }

    if (hasDynamicComponent(parts.template)) dynamicComponents.push(rel);

    const list: ComponentEdge[] = [...edgeMap.entries()]
      .map(([file, via]) => ({ file, via }))
      .sort((a, b) => a.file.localeCompare(b.file));

    edges[rel] = list;
    edgeCount += list.length;

    if (external.size > 0) {
      externalTags[rel] = [...external].sort();
      externalTagCount += external.size;
    }

    for (const e of list) {
      importedBy[e.file] = [...(importedBy[e.file] ?? []), rel];
    }
  }

  for (const key of Object.keys(importedBy)) importedBy[key].sort();

  return {
    edges,
    externalTags,
    importedBy,
    dynamicComponents: dynamicComponents.sort(),
    eventBindings,
    autoImportSource: auto.source,
    stats: { sfcCount: sfcFilesAbs.length, edgeCount, externalTagCount },
  };
}

/**
 * 从入口组件展开引用树。
 * 同一组件在树里出现多次时只在首次展开，其余标 duplicate，避免共享组件导致指数膨胀；
 * 环形引用标 cyclic 并停止下探。
 */
export function buildComponentTree(rootFile: string, graph: ComponentGraph): ComponentNode {
  const expanded = new Set<string>([rootFile]);

  const build = (file: string, pathSet: Set<string>, via?: EdgeVia): ComponentNode => {
    const node: ComponentNode = {
      file,
      name: componentName(file),
      via,
      children: [],
      external: graph.externalTags[file] ?? [],
    };

    if (pathSet.has(file)) {
      node.cyclic = true;
      return node;
    }

    const nextPath = new Set(pathSet).add(file);
    for (const edge of graph.edges[file] ?? []) {
      if (expanded.has(edge.file)) {
        node.children.push({
          file: edge.file,
          name: componentName(edge.file),
          via: edge.via,
          children: [],
          external: [],
          duplicate: true,
        });
        continue;
      }
      expanded.add(edge.file);
      node.children.push(build(edge.file, nextPath, edge.via));
    }
    return node;
  };

  return build(rootFile, new Set());
}

/** 树里去重后的组件数 */
export function countTree(node: ComponentNode): number {
  const seen = new Set<string>();
  const visit = (n: ComponentNode): void => {
    if (seen.has(n.file)) return;
    seen.add(n.file);
    for (const c of n.children) visit(c);
  };
  visit(node);
  return seen.size;
}
