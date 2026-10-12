import * as ts from "typescript";
import { parse as parseTemplate } from "@vue/compiler-dom";
import { createSource, readScript, readSfcParts, stringValue } from "./ast";
import type { GuardInfo, PermissionHelper, PermissionModel, PermissionRef } from "./channel-types";
import { toRepoRel } from "./ignore";
import { createLiteralResolver } from "./literals";
import { scanSymbols } from "./scan-symbols";
import type { RouteInfo } from "./types";

/**
 * 权限码台账 + 路由守卫。
 *
 * **实测结论：这些仓的权限不在路由守卫里。** `beforeEach` 全仓 0–2 处，
 * 真正的权限是 `window.$inm_parentVuex?.getters["user/hasPermission"]("RY4.5.7.1.M2.G89544U")`
 * —— 权限码是这种字符串，而**判定实现在 qiankun 宿主仓，本仓只有引用**。
 *
 * 所以这里做的是「权限码台账」而不是「守卫链」：一个权限码控制哪些路由 / 指令 / 代码点。
 * 守卫照抽，但如实报告本仓有几处，不假装它是主机制。
 */

/** 判定函数的名字特征 —— 用来找「声明」而不是硬编码具体名字 */
const HELPER_NAME_RE = /permission|auth|hasPermi/i;
/** 指令名特征：注册名或 `v-xxx` 名匹配即算权限指令 */
const DIRECTIVE_NAME_RE = /permission|auth|perm/i;
/**
 * 实现落在宿主的标记 —— 命中说明判定不归本仓管。
 * 覆盖实测到的三条通路：
 * - qiankun vuex：`$inm_parentVuex` / `$icss_parentVuex` / `window.parent`
 * - iframe 桥：`getIframeStore()`（pathology 的写法）
 * - 直接读宿主 getter：`getters["user/hasPermission"]`
 */
const HOST_MARKERS =
  /parentVuex|\$inm_parent|window\.parent|__POWERED_BY_QIANKUN__|iframeStore|getters\s*\[\s*["'`][^"'`]*hasPermission/i;

const DIRECTIVE_NODE = 7; // @vue/compiler-dom NodeTypes.DIRECTIVE
const ELEMENT_NODE = 1;

interface RawRef {
  kind: PermissionRef["kind"];
  file: string;
  line: number;
  detail?: string;
  /** 命中该权限码的调用/指令名 */
  via: string;
  /** 权限码本身 */
  code: string;
}

/** 从模板里抽 `v-permission="'code'"` 这类指令 */
function directiveRefs(
  repoRoot: string,
  absFile: string,
  registered: Set<string>,
): RawRef[] {
  const parts = readSfcParts(absFile);
  if (!parts.template) return [];

  let root: unknown;
  try {
    root = parseTemplate(parts.template);
  } catch {
    return [];
  }

  const rel = toRepoRel(repoRoot, absFile);
  const out: RawRef[] = [];

  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;

    if (node.type === ELEMENT_NODE && Array.isArray(node.props)) {
      for (const p of node.props) {
        if (p?.type !== DIRECTIVE_NODE) continue;
        const name: string = p.name ?? "";
        // 认注册过的名字，也认名字里带 permission/auth 的（可能由 UI 库或宿主注册）
        if (!registered.has(name) && !DIRECTIVE_NAME_RE.test(name)) continue;

        // v-permission="'X'" → exp 是字符串字面量；v-permission="X" → 常量，交给常量解析
        const exp = p.exp;
        if (!exp || typeof exp.content !== "string") continue;
        const code = exp.content.replace(/^['"]|['"]$/g, "");
        if (!code) continue;

        out.push({
          kind: "directive",
          file: rel,
          line: (exp.loc?.start?.line ?? 1) + parts.templateLineOffset,
          detail: `v-${name}`,
          via: name,
          code,
        });
      }
    }

    if (Array.isArray(node.children)) for (const c of node.children) visit(c);
    if (Array.isArray(node.branches)) for (const b of node.branches) visit(b);
  };

  visit(root);
  return out;
}

/** 从脚本里抽 `hasPermission("code")` / `getters["user/hasPermission"]("code")` */
function inlineRefs(repoRoot: string, absFile: string): RawRef[] {
  const script = readScript(absFile);
  if (!script) return [];

  const rel = toRepoRel(repoRoot, absFile);
  const sf = createSource(script.code, absFile);
  const literals = createLiteralResolver(absFile, repoRoot, null);
  const out: RawRef[] = [];

  const lineOf = (n: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 + script.lineOffset;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      // 被调名：hasPermission(...) 或 getters["user/hasPermission"](...)
      let name: string | null = null;
      const callee = node.expression;

      if (ts.isIdentifier(callee)) name = callee.text;
      else if (ts.isPropertyAccessExpression(callee)) name = callee.name.text;
      else if (ts.isElementAccessExpression(callee)) {
        const k = stringValue(callee.argumentExpression);
        if (k) name = k.split("/").pop() ?? k;
      }

      if (name && HELPER_NAME_RE.test(name)) {
        const code = literals.resolveString(node.arguments[0]);
        if (code) {
          out.push({ kind: "inline", file: rel, line: lineOf(node), detail: name, via: name, code });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return out;
}

export function buildPermissions(
  repoRoot: string,
  filesAbs: string[],
  routes: RouteInfo[],
): PermissionModel {
  // 1) 指令名从 `app.directive("name", ...)` 注册处读，不写死
  const registered = new Set<string>();
  scanSymbols(
    repoRoot,
    filesAbs,
    {
      call: node =>
        ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "directive",
    },
    hit => {
      const call = hit.node as ts.CallExpression;
      const name = stringValue(call.arguments[0]);
      if (name) registered.add(name);
    },
  );

  // 2) inline 引用先跑：只有**真被用作权限判定**的名字才进 helper 名单。
  // 否则名字正则会把 `queryPermissionsByShift`（一个 API 函数）、
  // `userSettingPermission`（一个字段）也当成判定函数，`definedInRepo` 就会误报 true。
  const raw: RawRef[] = [];
  for (const absFile of filesAbs) {
    raw.push(...inlineRefs(repoRoot, absFile));
    raw.push(...directiveRefs(repoRoot, absFile, registered));
  }
  const usedNames = new Set(raw.filter(r => r.kind === "inline").map(r => r.via));

  // 3) 找这些名字的声明，并做**传递式**宿主判定：
  // `getPermissionValue = code => hasPermission(code)` 本身没有宿主标记，
  // 但它调的 `hasPermission` 有 —— 只查直接标记会把这种漏判成「本仓实现」。
  interface Decl {
    name: string;
    file: string;
    line: number;
    text: string;
    calls: string[];
  }
  // 同名声明可能有多个（repo-e 里 `hasPermission` 既有收 item 的、也有收权限码的），
  // 取第一个是武断的 —— 全部收集、如实列出，让消费方自己判断
  const decls: Decl[] = [];

  for (const absFile of filesAbs) {
    const script = readScript(absFile);
    if (!script) continue;
    const rel = toRepoRel(repoRoot, absFile);
    const sf = createSource(script.code, absFile);

    const consider = (name: string, body: ts.Node | undefined, at: ts.Node): void => {
      if (!usedNames.has(name)) return;

      const calls = new Set<string>();
      if (body) {
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n)) {
            if (ts.isIdentifier(n.expression)) calls.add(n.expression.text);
            else if (ts.isPropertyAccessExpression(n.expression)) calls.add(n.expression.name.text);
          }
          ts.forEachChild(n, visit);
        };
        visit(body);
      }

      decls.push({
        name,
        file: rel,
        line: sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1 + script.lineOffset,
        text: body ? body.getText(sf) : "",
        calls: [...calls],
      });
    };

    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        consider(stmt.name.text, stmt.body, stmt);
        continue;
      }
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
            consider(d.name.text, d.initializer.body, d);
          }
        }
      }
    }
  }

  const delegates = (name: string, seen: Set<string>): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    const own = decls.filter(d => d.name === name);
    if (own.length === 0) return false;
    return own.some(d => HOST_MARKERS.test(d.text) || d.calls.some(c => delegates(c, seen)));
  };

  const helpers: PermissionHelper[] = decls
    .map(d => ({
      name: d.name,
      file: d.file,
      line: d.line,
      delegatesToHost: HOST_MARKERS.test(d.text) || d.calls.some(c => delegates(c, new Set([d.name]))),
    }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  for (const r of routes) {
    if (!r.permissionCode) continue;
    for (const code of r.permissionCode.split(",").map(s => s.trim()).filter(Boolean)) {
      raw.push({ kind: "route", file: "router", line: 0, detail: r.path, via: "meta", code });
    }
  }

  // 4) 按权限码聚合
  const byCode = new Map<string, PermissionRef[]>();
  for (const r of raw) {
    const list = byCode.get(r.code) ?? [];
    list.push({ kind: r.kind, file: r.file, line: r.line, ...(r.detail ? { detail: r.detail } : {}) });
    byCode.set(r.code, list);
  }

  const codes = [...byCode.entries()]
    .map(([code, usedBy]) => ({
      code,
      usedBy: usedBy.sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file) || a.line - b.line),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  return {
    codes,
    helpers,
    definedInRepo: helpers.some(h => !h.delegatesToHost),
  };
}

/** 路由守卫：如实抽取，不假装它是权限主机制 */
export function buildGuards(repoRoot: string, filesAbs: string[]): GuardInfo[] {
  const HOOKS = new Set(["beforeEach", "beforeResolve", "afterEach", "beforeEnter"]);
  const guards: GuardInfo[] = [];

  scanSymbols(
    repoRoot,
    filesAbs,
    {
      call: node =>
        ts.isPropertyAccessExpression(node.expression) &&
        HOOKS.has(node.expression.name.text) &&
        // 只认挂在 router 实例上的钩子，避免把普通同名方法算进来
        ts.isIdentifier(node.expression.expression),
    },
    hit => {
      const call = hit.node as ts.CallExpression;
      const hook = (call.expression as ts.PropertyAccessExpression).name.text;
      const fn = call.arguments[0];

      const redirects = new Set<string>();
      const calls = new Set<string>();

      if (fn) {
        const visit = (n: ts.Node): void => {
          // next("/login") / return "/login"
          const s = stringValue(n);
          if (s && s.startsWith("/")) redirects.add(s);

          if (ts.isCallExpression(n)) {
            if (ts.isIdentifier(n.expression)) calls.add(n.expression.text);
            else if (ts.isPropertyAccessExpression(n.expression)) calls.add(n.expression.name.text);
          }
          ts.forEachChild(n, visit);
        };
        visit(fn);
      }

      guards.push({
        hook,
        file: hit.file,
        line: hit.line,
        redirects: [...redirects].sort(),
        calls: [...calls].sort(),
      });
    },
  );

  return guards.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
