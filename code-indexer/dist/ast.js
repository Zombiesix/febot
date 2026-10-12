import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { parse as parseSfc } from "@vue/compiler-sfc";
/**
 * 进程内缓存。6 个抽取器（组件图 / 端点 / store / 权限 / 存储 / WS）都要读同一批文件，
 * 不做缓存的话每个文件会被读盘 + 解析 6~10 次 —— 实测 repo-b 扫描要 9.6s，
 * 缓存后能压回 1s 量级。扫描进程短命，内存换时间很划算。
 */
const partsCache = new Map();
const sourceCache = new Map();
/** 一次解析拿到 script 与 template 两段；非 .vue 只返回 script */
export function readSfcParts(absFile) {
    const hit = partsCache.get(absFile);
    if (hit)
        return hit;
    const parts = readSfcPartsUncached(absFile);
    partsCache.set(absFile, parts);
    return parts;
}
function readSfcPartsUncached(absFile) {
    let raw;
    try {
        raw = fs.readFileSync(absFile, "utf8");
    }
    catch {
        return { script: null, template: null, templateLineOffset: 0 };
    }
    if (path.extname(absFile).toLowerCase() !== ".vue") {
        return { script: { code: raw, lineOffset: 0 }, template: null, templateLineOffset: 0 };
    }
    const { descriptor, errors } = parseSfc(raw, { filename: absFile });
    if (errors.length > 0)
        return { script: null, template: null, templateLineOffset: 0 };
    const block = descriptor.scriptSetup ?? descriptor.script;
    return {
        script: block ? { code: block.content, lineOffset: block.loc.start.line - 1 } : null,
        template: descriptor.template?.content ?? null,
        templateLineOffset: descriptor.template ? descriptor.template.loc.start.line - 1 : 0,
    };
}
/** 读出可解析的脚本源码；.vue 走 SFC 解析取 script/script setup 块 */
export function readScript(absFile) {
    return readSfcParts(absFile).script;
}
/** 同一 fileName 复用同一个 SourceFile —— 节点身份一致，调用方可以安全做引用比较 */
export function createSource(code, fileName) {
    const hit = sourceCache.get(fileName);
    if (hit)
        return hit;
    const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    sourceCache.set(fileName, sf);
    return sf;
}
export function clearSourceCache() {
    partsCache.clear();
    sourceCache.clear();
}
function keyNameOf(name) {
    if (ts.isIdentifier(name))
        return name.text;
    if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
        return name.text;
    return null;
}
export function getProp(obj, name) {
    for (const p of obj.properties) {
        if (!ts.isPropertyAssignment(p))
            continue;
        if (keyNameOf(p.name) === name)
            return p;
    }
    return null;
}
export function stringValue(node) {
    if (!node)
        return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        return node.text;
    // 模板字符串：把 ${...} 原样留成占位符，这样 RESTful 路径（.../delete/${id}）
    // 也能看出形状，而不是整条丢掉
    if (ts.isTemplateExpression(node)) {
        let out = node.head.text;
        for (const span of node.templateSpans) {
            out += `{${expressionText(span.expression)}}${span.literal.text}`;
        }
        return out;
    }
    return null;
}
function expressionText(node) {
    try {
        return node.getText();
    }
    catch {
        return "?";
    }
}
export function boolValue(node) {
    if (!node)
        return null;
    if (node.kind === ts.SyntaxKind.TrueKeyword)
        return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword)
        return false;
    return null;
}
/** 取出 `() => import("x")` 或 `import("x")` 里的模块说明符 */
export function dynamicImportSpecifier(node) {
    if (!node)
        return null;
    let call = node;
    if (ts.isArrowFunction(node))
        call = node.body;
    if (ts.isParenthesizedExpression(call))
        call = call.expression;
    // `import("x").catch(err => ErrorComponent(err))` —— 懒加载兜底的常见写法。
    // 不剥掉这层的话，repo-b 整仓 123 条路由全都解析不出组件。
    if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)) {
        const inner = call.expression.expression;
        if (ts.isCallExpression(inner) && inner.expression.kind === ts.SyntaxKind.ImportKeyword) {
            return stringValue(inner.arguments[0]);
        }
    }
    if (!ts.isCallExpression(call))
        return null;
    if (call.expression.kind !== ts.SyntaxKind.ImportKeyword)
        return null;
    return stringValue(call.arguments[0]);
}
// 模块解析已独立到 resolve.ts（别名读真实配置 + 文件解析）。
// 这里 re-export 保持既有 import 路径不变。
export { resolveSpecifier, resolveModuleFile } from "./resolve";
/** 遍历所有 ImportDeclaration，回调 (模块说明符, 导入名列表, 该声明所在行) */
export function forEachImport(sf, cb) {
    for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt))
            continue;
        const spec = stringValue(stmt.moduleSpecifier);
        if (!spec)
            continue;
        const names = [];
        const clause = stmt.importClause;
        // `import type { X }` 整条是类型，不该混进函数引用
        if (clause && !clause.isTypeOnly) {
            if (clause.name)
                names.push(clause.name.text);
            const bindings = clause.namedBindings;
            if (bindings) {
                if (ts.isNamedImports(bindings)) {
                    // 用 propertyName（原始导出名），否则 `import { a as b }` 会记成 b，
                    // 后面拿它去对 api 函数名就对不上
                    for (const el of bindings.elements) {
                        if (el.isTypeOnly)
                            continue; // `import { type X }`
                        names.push((el.propertyName ?? el.name).text);
                    }
                }
                else if (ts.isNamespaceImport(bindings)) {
                    names.push(`* as ${bindings.name.text}`);
                }
            }
        }
        const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
        cb(spec, names, line);
    }
}
/** 收集导出的函数/常量名，用于 API 域的函数清单 */
export function collectExports(sf) {
    const names = new Set();
    const addFromBindingName = (name) => {
        if (ts.isIdentifier(name)) {
            names.add(name.text);
            return;
        }
        for (const el of name.elements) {
            if (ts.isBindingElement(el))
                addFromBindingName(el.name);
        }
    };
    for (const stmt of sf.statements) {
        const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
        const isExported = mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
        if (ts.isFunctionDeclaration(stmt) && stmt.name) {
            if (isExported || mods?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) {
                names.add(stmt.name.text);
            }
            continue;
        }
        if (ts.isVariableStatement(stmt)) {
            if (!isExported)
                continue;
            for (const d of stmt.declarationList.declarations)
                addFromBindingName(d.name);
            continue;
        }
        if (ts.isExportDeclaration(stmt) && stmt.exportClause) {
            if (ts.isNamedExports(stmt.exportClause)) {
                for (const el of stmt.exportClause.elements)
                    names.add(el.name.text);
            }
            continue;
        }
    }
    return [...names].sort();
}
