import * as ts from "typescript";
import { getProp, readScript, stringValue } from "./ast";
import type { StoreInfo, StoreRef, StoreStateIndex } from "./channel-types";
import { toRepoRel } from "./ignore";
import { scanSymbols } from "./scan-symbols";

/**
 * Pinia store 抽取。
 *
 * 实测三种形态，缺一不可：
 * - **对象式** `defineStore({ id, state, getters, actions })` —— example-sys / repo-e / repo-f / repo-a
 * - **setup 式** `defineStore("id", () => { const a = ref(); return { a } })` —— repo-d
 * - **模块级 reactive 单例** `export const x = reactive({ ... })` —— example-sys `store/qiankun.ts`
 *   （既不是 pinia 也不是 props 的隐藏全局状态）
 *
 * 两个反直觉点（不按这两个来会大面积漏）：
 * 1. **id 不是文件名** —— 对象式取 `id` 字段，setup 式取首参
 * 2. **使用侧的标识符是「导出绑定名」** —— 可能是 `useUserStore`，也可能是
 *    `userStore` / `useCodeMapping`，不能假设以 `use` 开头
 */

export type { StoreInfo, StoreRef, StoreStateIndex } from "./channel-types";

/** 会改内容的数组/集合方法 —— 命中即算写 */
const MUTATING = new Set([
  "push", "pop", "shift", "unshift", "splice", "sort", "reverse",
  "fill", "copyWithin", "set", "add", "delete", "clear",
]);

function objectKeys(obj: ts.ObjectLiteralExpression | null): string[] {
  if (!obj) return [];
  const out: string[] = [];
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isShorthandPropertyAssignment(p)) {
      if (ts.isIdentifier(p.name)) out.push(p.name.text);
      else if (ts.isStringLiteral(p.name)) out.push(p.name.text);
    }
  }
  return out.sort();
}

function asObject(node: ts.Node | undefined): ts.ObjectLiteralExpression | null {
  return node && ts.isObjectLiteralExpression(node) ? node : null;
}

/** `state: () => ({ a: 1 })` —— 取箭头函数返回的对象字面量的键 */
function stateKeysOf(init: ts.Node | undefined): string[] {
  if (!init) return [];
  let body: ts.Node = init;
  if (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) body = body.body;
  if (ts.isParenthesizedExpression(body)) body = body.expression;
  return objectKeys(asObject(body));
}

/** 由路径推归属模块（多页面目录都要看） */
function ownerModuleOf(file: string, pageDirsRel: string[]): string | null {
  // 模块目录下的 store：`src/page/<模块>/.../store/` → 模块名
  for (const pageDirRel of pageDirsRel) {
    if (file.startsWith(`${pageDirRel}/`)) {
      return file.slice(pageDirRel.length + 1).split("/")[0] || null;
    }
  }
  // `views/x/store/` / `modules/x/store/` → x
  const segs = file.split("/");
  const i = segs.findIndex(s => s === "store" || s === "stores");
  if (i > 1) return segs[i - 1];
  // `src/store/**`、`src/stores/**` 是全局 store
  return null;
}

/**
 * 持久化配置。两个插件形状不同，都要认：
 * - `pinia-plugin-persistedstate`：`persist: true` 或 `persist: { key, storage, paths }`
 * - `pinia-plugin-persist`（example-sys 在用）：`persist: { enabled, strategies: [{ key, storage, paths }] }`
 *
 * 读不到就返回 null —— **不要拿 store id 兜底**，那等于编造一个不存在的 key。
 */
function persistOf(obj: ts.ObjectLiteralExpression, id: string | null): StoreInfo["persist"] {
  const p = getProp(obj, "persist")?.initializer;
  if (!p) return null;
  if (p.kind === ts.SyntaxKind.TrueKeyword) return { key: id ?? "", storage: "localStorage" };

  const po = asObject(p);
  if (!po) return null;

  // strategies 形态取第一条策略
  const strategies = getProp(po, "strategies")?.initializer;
  const firstEl =
    strategies && ts.isArrayLiteralExpression(strategies) ? strategies.elements[0] : undefined;
  const src = (firstEl ? asObject(firstEl) : null) ?? po;

  const keyNode = getProp(src, "key")?.initializer;
  const storageNode = getProp(src, "storage")?.initializer;
  if (!keyNode && !storageNode) return null;

  return {
    // key 可能是模板串 `${APP_NAME}/x`，stringValue 保留占位符形式，如实反映
    key: stringValue(keyNode) ?? id ?? "",
    // storage 通常是标识符（sessionStorage），不是字符串
    storage:
      storageNode !== undefined && ts.isIdentifier(storageNode)
        ? storageNode.text
        : stringValue(storageNode) ?? "localStorage",
  };
}

/** 从 defineStore 的实参里抽 id 与三个集合 */
function fromOptions(obj: ts.ObjectLiteralExpression): {
  id: string | null;
  state: string[];
  getters: string[];
  actions: string[];
  persist: StoreInfo["persist"];
} {
  const id = stringValue(getProp(obj, "id")?.initializer);
  const state = stateKeysOf(getProp(obj, "state")?.initializer);
  const getters = objectKeys(asObject(getProp(obj, "getters")?.initializer));
  const actions = objectKeys(asObject(getProp(obj, "actions")?.initializer));

  return { id, state, getters, actions, persist: persistOf(obj, id) };
}

/** setup 式：扫函数体，按 ref/reactive/computed/函数 分类，再用 return 的键收口 */
function fromSetup(fn: ts.Node | undefined): { state: string[]; getters: string[]; actions: string[] } {
  const kind = new Map<string, "state" | "getter" | "action">();

  let body: ts.Node | undefined = fn;
  if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) body = fn.body;

  const returned: string[] = [];

  const visit = (node: ts.Node): void => {
    // const a = ref() / computed() / () => {}
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
        const f = init.expression.text;
        if (f === "computed") kind.set(node.name.text, "getter");
        else if (["ref", "shallowRef", "reactive", "toRef", "toRefs", "customRef", "shallowReactive"].includes(f)) {
          kind.set(node.name.text, "state");
        } else kind.set(node.name.text, "action");
      } else if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        kind.set(node.name.text, "action");
      }
    }
    // function f() {}
    if (ts.isFunctionDeclaration(node) && node.name) kind.set(node.name.text, "action");
    // return { a, b: c }
    if (ts.isReturnStatement(node) && node.expression) {
      const obj = asObject(node.expression);
      if (obj) {
        for (const p of obj.properties) {
          if (ts.isShorthandPropertyAssignment(p)) returned.push(p.name.text);
          else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) returned.push(p.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  if (body) visit(body);

  const state: string[] = [];
  const getters: string[] = [];
  const actions: string[] = [];
  const names = returned.length > 0 ? returned : [...kind.keys()];

  for (const n of names) {
    const k = kind.get(n) ?? "state";
    if (k === "getter") getters.push(n);
    else if (k === "action") actions.push(n);
    else state.push(n);
  }

  return { state: state.sort(), getters: getters.sort(), actions: actions.sort() };
}

export function buildStores(
  repoRoot: string,
  filesAbs: string[],
  pageDirsRel: string[],
): StoreInfo[] {
  const stores: StoreInfo[] = [];

  for (const absFile of filesAbs) {
    const script = readScript(absFile);
    if (!script) continue;
    const rel = toRepoRel(repoRoot, absFile);

    // 顶层 `export const X = defineStore(...) / reactive(...)`
    const sf = ts.createSourceFile(absFile, script.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      const mods = ts.getModifiers(stmt);
      const exported = mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      if (!exported) continue;

      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) continue;

        const callee = init.expression.text;
        const binding = decl.name.text;
        const line = sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1 + script.lineOffset;
        const ownerModule = ownerModuleOf(rel, pageDirsRel);

        if (callee === "defineStore") {
          const a0 = init.arguments[0];
          const a1 = init.arguments[1];

          if (a0 && ts.isObjectLiteralExpression(a0)) {
            const o = fromOptions(a0);
            stores.push({
              binding,
              id: o.id ?? binding,
              file: rel,
              line,
              style: "options",
              kind: "pinia",
              state: o.state,
              getters: o.getters,
              actions: o.actions,
              ownerModule,
              persist: o.persist,
            });
            continue;
          }

          if (a0 && ts.isStringLiteral(a0)) {
            const s = fromSetup(a1);
            stores.push({
              binding,
              id: a0.text,
              file: rel,
              line,
              style: "setup",
              kind: "pinia",
              state: s.state,
              getters: s.getters,
              actions: s.actions,
              ownerModule,
              persist: null,
            });
            continue;
          }
          continue;
        }

        // 模块级 reactive 单例：export const x = reactive({ ... })
        if (callee === "reactive" || callee === "shallowReactive") {
          const obj = asObject(init.arguments[0]);
          stores.push({
            binding,
            id: binding,
            file: rel,
            line,
            style: "reactive",
            kind: "reactive-singleton",
            state: objectKeys(obj),
            getters: [],
            actions: [],
            ownerModule,
            persist: null,
          });
        }
      }
    }
  }

  stores.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return stores;
}

/** `v.member = x` / `v.member.push(...)` 判为写，其余为读 */
function modeOf(node: ts.PropertyAccessExpression): "read" | "write" {
  const p = node.parent;
  if (ts.isBinaryExpression(p) && p.left === node) return "write";
  if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) return "write";
  // v.member.push(...) —— node 的父是 v.member.push，祖父才是调用
  if (ts.isPropertyAccessExpression(p) && ts.isCallExpression(p.parent) && p.parent.expression === p) {
    if (MUTATING.has(p.name.text)) return "write";
  }
  // $patch / $reset / $state 是显式写
  if (node.name.text === "$patch" || node.name.text === "$reset" || node.name.text === "$state") {
    return "write";
  }
  return "read";
}

/**
 * 谁在读、谁在写。
 * 使用侧的标识符是**导出绑定名**，所以先把 `const s = <binding>()` 的局部名认出来，
 * 再统计 `s.member` 的读写。
 */
export function buildStoreStateIndex(
  repoRoot: string,
  filesAbs: string[],
  stores: StoreInfo[],
): StoreStateIndex {
  const byBinding = new Map(stores.map(s => [s.binding, s]));
  if (byBinding.size === 0) return {};

  // 用 Map 而不是普通对象：字段名可能是 `constructor` / `toString` 这类原型属性，
  // `obj[name] ??= []` 会取到原型上的函数，`??=` 不生效，随后 .push 直接崩。
  const index = new Map<string, Map<string, StoreRef[]>>();

  for (const absFile of filesAbs) {
    const script = readScript(absFile);
    if (!script) continue;
    const rel = toRepoRel(repoRoot, absFile);
    const sf = ts.createSourceFile(absFile, script.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const lineOf = (node: ts.Node): number =>
      sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 + script.lineOffset;

    // 局部名 → store 绑定名：const s = useUserStore() / storeToRefs(useUserStore())
    const locals = new Map<string, string>();
    const visitLocals = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = node.initializer;
        if (ts.isCallExpression(init)) {
          let callee: ts.Node = init.expression;
          if (ts.isIdentifier(callee) && byBinding.has(callee.text)) {
            locals.set(node.name.text, callee.text);
          }
          // storeToRefs(useUserStore())
          if (ts.isIdentifier(callee) && callee.text === "storeToRefs") {
            const arg = init.arguments[0];
            if (arg && ts.isCallExpression(arg) && ts.isIdentifier(arg.expression) && byBinding.has(arg.expression.text)) {
              locals.set(node.name.text, arg.expression.text);
            }
          }
        }
      }
      ts.forEachChild(node, visitLocals);
    };
    visitLocals(sf);

    if (locals.size === 0) continue;

    scanSymbols(
      repoRoot,
      [absFile],
      {
        member: (node, ctx) =>
          ts.isIdentifier(node.expression) && locals.has(node.expression.text),
      },
      hit => {
        const binding = locals.get(hit.symbol);
        if (!binding || !hit.member) return;
        const store = byBinding.get(binding);
        if (!store) return;

        const bucket = index.get(store.id) ?? new Map<string, StoreRef[]>();
        if (!index.has(store.id)) index.set(store.id, bucket);

        const refs = bucket.get(hit.member) ?? [];
        if (refs.length === 0) bucket.set(hit.member, refs);

        refs.push({
          file: rel,
          line: hit.line,
          mode: modeOf(hit.node as ts.PropertyAccessExpression),
          owner: hit.owner,
        });
      },
    );
  }

  const out: StoreStateIndex = {};
  for (const [id, fields] of index) {
    const bucket: Record<string, StoreRef[]> = {};
    for (const [name, refs] of fields) {
      bucket[name] = refs.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    }
    out[id] = bucket;
  }
  return out;
}
