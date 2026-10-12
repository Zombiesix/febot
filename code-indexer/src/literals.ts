import path from "node:path";
import * as ts from "typescript";
import { createSource, readScript, stringValue } from "./ast";
import { resolveModuleFile } from "./resolve";

/**
 * 常量解析层。
 *
 * 实测这是端点抽取的**最大单点缺口**：repo-g 的 287 个未解析
 * 全是 `request.post({ url: CommonApi.cancelRecycle })`，repo-f 的 123 个
 * 全是 `request.post(CommonApi.x, data)` —— URL 是 enum 成员。
 * 不解析常量，这些仓的端点永远是 0。
 *
 * 只做**一层 import 跟随 + 两层成员下探**，解析不出返回 null（不硬猜）。
 */

interface FileLiterals {
  /** 枚举 / 常量对象：名字 → 成员 → 字符串 */
  members: Map<string, Map<string, string>>;
  /** 简单常量：名字 → 字符串 */
  consts: Map<string, string>;
  /** import 本地名 → 来源模块与原始导出名 */
  imports: Map<string, { spec: string; imported: string }>;
}

const fileCache = new Map<string, FileLiterals>();
const MAX_DEPTH = 2;

/** 取对象字面量里的「字符串属性」映射；非字符串值的属性直接跳过 */
function membersFromObject(obj: ts.ObjectLiteralExpression): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = ts.isIdentifier(p.name)
      ? p.name.text
      : ts.isStringLiteral(p.name)
        ? p.name.text
        : null;
    if (!key) continue;
    const v = stringValue(p.initializer);
    if (v !== null) out.set(key, v);
  }
  return out;
}

/** 剥掉 `as const` / `satisfies X` 之类包裹，拿到真正的初始值 */
function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  while (
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isParenthesizedExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function parseFile(absFile: string): FileLiterals {
  const out: FileLiterals = { members: new Map(), consts: new Map(), imports: new Map() };

  const script = readScript(absFile);
  if (!script) return out;

  const sf = createSource(script.code, absFile);

  for (const stmt of sf.statements) {
    // enum X { a = "/x" }
    if (ts.isEnumDeclaration(stmt)) {
      const members = new Map<string, string>();
      for (const m of stmt.members) {
        const key = ts.isIdentifier(m.name)
          ? m.name.text
          : ts.isStringLiteral(m.name)
            ? m.name.text
            : null;
        if (!key) continue;
        const v = m.initializer ? stringValue(m.initializer) : null;
        if (v !== null) members.set(key, v);
      }
      if (members.size > 0) out.members.set(stmt.name.text, members);
      continue;
    }

    // const X = { a: "/x" } / const a = "/x"
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = unwrap(decl.initializer);

        if (ts.isObjectLiteralExpression(init)) {
          const members = membersFromObject(init);
          if (members.size > 0) out.members.set(decl.name.text, members);
          continue;
        }
        const v = stringValue(init);
        if (v !== null) out.consts.set(decl.name.text, v);
      }
      continue;
    }

    // import { A as B } from "./x" / import * as NS from "./x"
    if (ts.isImportDeclaration(stmt)) {
      const spec = stringValue(stmt.moduleSpecifier);
      if (!spec) continue;
      const clause = stmt.importClause;
      if (!clause || clause.isTypeOnly) continue;

      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (el.isTypeOnly) continue;
          out.imports.set(el.name.text, {
            spec,
            imported: (el.propertyName ?? el.name).text,
          });
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        out.imports.set(bindings.name.text, { spec, imported: "*" });
      }
    }
  }

  return out;
}

function literalsOf(absFile: string): FileLiterals {
  const hit = fileCache.get(absFile);
  if (hit) return hit;
  const parsed = parseFile(absFile);
  fileCache.set(absFile, parsed);
  return parsed;
}

export interface LiteralResolver {
  /** 把表达式解析成字符串字面量；解析不出返回 null */
  resolveString(node: ts.Node | undefined): string | null;
}

export function createLiteralResolver(
  absFile: string,
  repoRoot: string,
  srcDirRel: string | null,
): LiteralResolver {
  const lookupConst = (fromAbs: string, name: string, depth: number): string | null => {
    if (depth > MAX_DEPTH) return null;
    const lit = literalsOf(fromAbs);

    const local = lit.consts.get(name);
    if (local !== undefined) return local;

    const imp = lit.imports.get(name);
    if (!imp) return null;

    const target = resolveModuleFile(imp.spec, fromAbs, repoRoot, srcDirRel);
    if (!target) return null;
    const targetAbs = path.join(repoRoot, target);
    const nameInTarget = imp.imported === "*" ? name : imp.imported;
    return lookupConst(targetAbs, nameInTarget, depth + 1);
  };

  const lookupMember = (
    fromAbs: string,
    objName: string,
    member: string,
    depth: number,
  ): string | null => {
    if (depth > MAX_DEPTH) return null;
    const lit = literalsOf(fromAbs);

    const local = lit.members.get(objName);
    if (local) return local.get(member) ?? null;

    const imp = lit.imports.get(objName);
    if (!imp) return null;

    const target = resolveModuleFile(imp.spec, fromAbs, repoRoot, srcDirRel);
    if (!target) return null;
    const targetAbs = path.join(repoRoot, target);
    const nameInTarget = imp.imported === "*" ? objName : imp.imported;
    return lookupMember(targetAbs, nameInTarget, member, depth + 1);
  };

  const resolve = (node: ts.Node | undefined): string | null => {
    if (!node) return null;

    const direct = stringValue(node);
    if (direct !== null) return direct;

    // X.member —— enum / 常量对象
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      return lookupMember(absFile, node.expression.text, node.name.text, 0);
    }

    // 裸标识符 —— 简单常量
    if (ts.isIdentifier(node)) {
      return lookupConst(absFile, node.text, 0);
    }

    // 拼接：`HAIMIS_TYPE + "/systemDict/queryByCode"`（repo-d 的写法）。
    // 两侧都解得出来才拼；有一侧是运行时值就整体放弃，不硬猜。
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolve(node.left);
      if (left === null) return null;
      const right = resolve(node.right);
      if (right === null) return null;
      return left + right;
    }

    return null;
  };

  return { resolveString: resolve };
}

export function clearLiteralCache(): void {
  fileCache.clear();
}
