import * as ts from "typescript";
import { createSource, readScript, stringValue } from "./ast";
import { toRepoRel } from "./ignore";

/**
 * 统一的符号引用扫描器。
 *
 * 五个抽取器（store / emit / 权限 / 存储 / WS）要的都是同一件事：
 * **遍历代码文件，在 CallExpression / NewExpression / PropertyAccessExpression 上
 * 按自己的谓词挑出关心的符号**。过去每处各写一遍遍历，逻辑漂移且难维护。
 *
 * 这个模块只做「遍历 + 上下文」，判断留给调用方 —— 不预置任何业务假设。
 */

export interface SymbolCtx {
  sf: ts.SourceFile;
  /** repo 相对路径 */
  relFile: string;
  absFile: string;
  /** 1-based 行号，已把 SFC `<script>` 块的偏移加回去 */
  lineOf(node: ts.Node): number;
  /** 本文件的 import：本地名 → 模块说明符 */
  imports: Map<string, string>;
  /** 最近的具名顶层声明（函数 / 类 / 变量名），用于归因 */
  owner: string | null;
}

export type SymbolKind = "call" | "new" | "member";

export interface SymbolHit {
  kind: SymbolKind;
  /** 被调用 / 被 new / 被访问的对象名 */
  symbol: string;
  /** 成员名，仅 kind === "member" 时有 */
  member?: string;
  file: string;
  line: number;
  owner: string | null;
  /** 命中节点本身，调用方可以继续往下分析 */
  node: ts.Node;
}

export interface SymbolMatcher {
  call?(node: ts.CallExpression, ctx: SymbolCtx): boolean;
  newExpr?(node: ts.NewExpression, ctx: SymbolCtx): boolean;
  member?(node: ts.PropertyAccessExpression, ctx: SymbolCtx): boolean;
}

/** 收集一个文件里的 import：本地名 → 模块说明符 */
function collectImports(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stringValue(stmt.moduleSpecifier);
    if (!spec) continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) out.set(clause.name.text, spec);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) out.set(el.name.text, spec);
    }
    if (bindings && ts.isNamespaceImport(bindings)) out.set(bindings.name.text, spec);
  }
  return out;
}

/** 顶层声明的名字，用于 owner 归因 */
function declName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isClassDeclaration(node) && node.name) return node.name.text;
  if (ts.isVariableStatement(node)) {
    const first = node.declarationList.declarations[0];
    if (first && ts.isIdentifier(first.name)) return first.name.text;
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) return node.name.text;
  return null;
}

/**
 * 扫一批文件，按 matcher 挑符号。
 * 命中即回调，不收集不排序 —— 排序与去重交给调用方（各抽取器诉求不同）。
 */
export function scanSymbols(
  repoRoot: string,
  filesAbs: string[],
  matcher: SymbolMatcher,
  onHit: (hit: SymbolHit) => void,
): void {
  const wantsCall = matcher.call !== undefined;
  const wantsNew = matcher.newExpr !== undefined;
  const wantsMember = matcher.member !== undefined;
  if (!wantsCall && !wantsNew && !wantsMember) return;

  for (const absFile of filesAbs) {
    const script = readScript(absFile);
    if (!script) continue;

    const sf = createSource(script.code, absFile);
    const relFile = toRepoRel(repoRoot, absFile);
    const imports = collectImports(sf);

    const ctx: SymbolCtx = {
      sf,
      relFile,
      absFile,
      lineOf: node =>
        sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 + script.lineOffset,
      imports,
      owner: null,
    };

    const walk = (node: ts.Node, owner: string | null): void => {
      const nextOwner = declName(node) ?? owner;
      const hitCtx: SymbolCtx = { ...ctx, owner: nextOwner };

      if (wantsCall && ts.isCallExpression(node) && matcher.call!(node, hitCtx)) {
        const callee = node.expression;
        onHit({
          kind: "call",
          symbol: ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
              ? callee.expression.text
              : callee.getText().slice(0, 40),
          file: relFile,
          line: hitCtx.lineOf(node),
          owner: nextOwner,
          node,
        });
      } else if (wantsNew && ts.isNewExpression(node) && matcher.newExpr!(node, hitCtx)) {
        const expr = node.expression;
        onHit({
          kind: "new",
          symbol: ts.isIdentifier(expr) ? expr.text : expr.getText().slice(0, 40),
          file: relFile,
          line: hitCtx.lineOf(node),
          owner: nextOwner,
          node,
        });
      } else if (wantsMember && ts.isPropertyAccessExpression(node) && matcher.member!(node, hitCtx)) {
        onHit({
          kind: "member",
          symbol: ts.isIdentifier(node.expression) ? node.expression.text : node.expression.getText().slice(0, 40),
          member: node.name.text,
          file: relFile,
          line: hitCtx.lineOf(node),
          owner: nextOwner,
          node,
        });
      }

      ts.forEachChild(node, child => walk(child, nextOwner));
    };

    walk(sf, null);
  }
}
