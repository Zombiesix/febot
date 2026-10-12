import * as ts from "typescript";
import { createSource, readScript, stringValue } from "./ast";
import { toRepoRel } from "./ignore";
/** 收集一个文件里的 import：本地名 → 模块说明符 */
function collectImports(sf) {
    const out = new Map();
    for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt))
            continue;
        const spec = stringValue(stmt.moduleSpecifier);
        if (!spec)
            continue;
        const clause = stmt.importClause;
        if (!clause)
            continue;
        if (clause.name)
            out.set(clause.name.text, spec);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
            for (const el of bindings.elements)
                out.set(el.name.text, spec);
        }
        if (bindings && ts.isNamespaceImport(bindings))
            out.set(bindings.name.text, spec);
    }
    return out;
}
/** 顶层声明的名字，用于 owner 归因 */
function declName(node) {
    if (ts.isFunctionDeclaration(node) && node.name)
        return node.name.text;
    if (ts.isClassDeclaration(node) && node.name)
        return node.name.text;
    if (ts.isVariableStatement(node)) {
        const first = node.declarationList.declarations[0];
        if (first && ts.isIdentifier(first.name))
            return first.name.text;
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name))
        return node.name.text;
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name))
        return node.name.text;
    return null;
}
/**
 * 扫一批文件，按 matcher 挑符号。
 * 命中即回调，不收集不排序 —— 排序与去重交给调用方（各抽取器诉求不同）。
 */
export function scanSymbols(repoRoot, filesAbs, matcher, onHit) {
    const wantsCall = matcher.call !== undefined;
    const wantsNew = matcher.newExpr !== undefined;
    const wantsMember = matcher.member !== undefined;
    if (!wantsCall && !wantsNew && !wantsMember)
        return;
    for (const absFile of filesAbs) {
        const script = readScript(absFile);
        if (!script)
            continue;
        const sf = createSource(script.code, absFile);
        const relFile = toRepoRel(repoRoot, absFile);
        const imports = collectImports(sf);
        const ctx = {
            sf,
            relFile,
            absFile,
            lineOf: node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 + script.lineOffset,
            imports,
            owner: null,
        };
        const walk = (node, owner) => {
            const nextOwner = declName(node) ?? owner;
            const hitCtx = { ...ctx, owner: nextOwner };
            if (wantsCall && ts.isCallExpression(node) && matcher.call(node, hitCtx)) {
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
            }
            else if (wantsNew && ts.isNewExpression(node) && matcher.newExpr(node, hitCtx)) {
                const expr = node.expression;
                onHit({
                    kind: "new",
                    symbol: ts.isIdentifier(expr) ? expr.text : expr.getText().slice(0, 40),
                    file: relFile,
                    line: hitCtx.lineOf(node),
                    owner: nextOwner,
                    node,
                });
            }
            else if (wantsMember && ts.isPropertyAccessExpression(node) && matcher.member(node, hitCtx)) {
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
