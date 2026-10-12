import * as ts from "typescript";
import { createSource, readScript } from "./ast";
import { toRepoRel } from "./ignore";
import { createLiteralResolver } from "./literals";
/**
 * 存储通道：localStorage / sessionStorage / cookie。
 *
 * 实测这类 key 的业务信息量意外地大 —— repo-g 的
 * `mrms/medical/dateType`、`mrms/copy/dateType`、`mrms/putawayManage/dateType`
 * 全是「记住这个页面上次选的日期口径」，是真实的业务行为，之前完全不可见。
 *
 * 关键点：**key 必须走常量解析**。这些仓普遍写成 `setItem(TOKEN_KEY, v)`，
 * 不解析常量的话 key 全是 `<非字面量>`，等于没抽。
 */
const WEB_STORAGE = new Set(["localStorage", "sessionStorage"]);
const METHODS = {
    getItem: "read",
    setItem: "write",
    removeItem: "delete",
    clear: "delete",
};
/** 取出 `localStorage.getItem("k")` 里的存储对象名 */
function storageTarget(node) {
    if (ts.isIdentifier(node) && WEB_STORAGE.has(node.text)) {
        return node.text;
    }
    // window.localStorage
    if (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "window" &&
        WEB_STORAGE.has(node.name.text)) {
        return node.name.text;
    }
    return null;
}
/** 最近的具名声明，用于归因 */
function ownerOf(node) {
    let cur = node;
    while (cur) {
        if (ts.isFunctionDeclaration(cur) && cur.name)
            return cur.name.text;
        if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name))
            return cur.name.text;
        if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name))
            return cur.name.text;
        cur = cur.parent;
    }
    return null;
}
export function buildStorage(repoRoot, filesAbs) {
    const byKey = new Map();
    const push = (storage, key, raw, ref) => {
        const sig = `${storage}::${key ?? `?${raw}`}`;
        const item = byKey.get(sig) ?? { key, raw, storage, refs: [] };
        item.refs.push(ref);
        byKey.set(sig, item);
    };
    for (const absFile of filesAbs) {
        const script = readScript(absFile);
        if (!script)
            continue;
        // 快速跳过：文件里没有存储访问就不必建 AST
        if (!/\b(localStorage|sessionStorage)\s*\./.test(script.code) &&
            !/document\s*\.\s*cookie/.test(script.code)) {
            continue;
        }
        const rel = toRepoRel(repoRoot, absFile);
        const sf = createSource(script.code, absFile);
        const literals = createLiteralResolver(absFile, repoRoot, null);
        // 封装层的判据：存储调用落在**导出函数体**内（`export const getPortal = () => localStorage.getItem(...)`）。
        // 只看「文件里有没有 export」会把几乎每个 Vue 文件都算成封装层 —— 那是假标注。
        const exportedNames = new Set();
        for (const stmt of sf.statements) {
            const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
            const isExported = mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
            if (!isExported)
                continue;
            if (ts.isFunctionDeclaration(stmt) && stmt.name)
                exportedNames.add(stmt.name.text);
            if (ts.isVariableStatement(stmt)) {
                for (const d of stmt.declarationList.declarations) {
                    if (ts.isIdentifier(d.name))
                        exportedNames.add(d.name.text);
                }
            }
        }
        const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 + script.lineOffset;
        // 封装层判定要**沿整条祖先链**找导出声明：example-sys 的 use-storage.ts 把调用写在
        // `export function useStorage()` 内部对象字面量的方法里，只看最近一层会漏。
        const wrapperOf = (n) => {
            let cur = n;
            while (cur) {
                if (ts.isFunctionDeclaration(cur) && cur.name && exportedNames.has(cur.name.text))
                    return rel;
                if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name) && exportedNames.has(cur.name.text)) {
                    return rel;
                }
                cur = cur.parent;
            }
            return null;
        };
        const visit = (node) => {
            const owner = ownerOf(node);
            const wrapper = wrapperOf(node);
            // localStorage.getItem("k") / setItem(KEY, v) / removeItem("k") / clear()
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
                const callee = node.expression;
                const mode = METHODS[callee.name.text];
                const target = mode ? storageTarget(callee.expression) : null;
                if (mode && target) {
                    const storage = target === "sessionStorage" ? "session" : "local";
                    const ref = { file: rel, line: lineOf(node), mode, owner, wrapper };
                    if (callee.name.text === "clear") {
                        push(storage, null, "<clear>", ref);
                    }
                    else {
                        const arg = node.arguments[0];
                        const key = literals.resolveString(arg);
                        // 解析不出就保留原文，让「动态 key」这件事可见，而不是静默丢弃
                        push(storage, key, key ?? (arg ? arg.getText(sf).slice(0, 60) : ""), ref);
                    }
                }
            }
            // document.cookie = "k=v; ..."
            if (ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(node.left) &&
                ts.isIdentifier(node.left.expression) &&
                node.left.expression.text === "document" &&
                node.left.name.text === "cookie") {
                const text = node.right.getText(sf);
                // 取 `k=` 前面的那段作为 key 的近似原文
                const m = text.match(/^\s*[`'"]([^=`'"]+)=/);
                push("cookie", m ? m[1] : null, m ? m[1] : text.slice(0, 60), { file: rel, line: lineOf(node), mode: "write", owner, wrapper });
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }
    for (const item of byKey.values()) {
        item.refs.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    }
    return [...byKey.values()].sort((a, b) => (a.key ?? a.raw).localeCompare(b.key ?? b.raw) || a.storage.localeCompare(b.storage));
}
