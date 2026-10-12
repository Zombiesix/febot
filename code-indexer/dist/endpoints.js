import * as ts from "typescript";
import { createSource, getProp, stringValue, } from "./ast";
import { toRepoRel } from "./ignore";
import { createLiteralResolver } from "./literals";
import { resolveModuleFile } from "./resolve";
/**
 * 从调用的第一个实参里取 URL。三种实测写法：
 *
 * 1. 直接字面量 —— `$http.get("/example-sys/api/x", params)`
 * 2. 常量 / enum 成员 —— `request.post(CommonApi.x, data)`（repo-f）
 * 3. config object —— `request.post({ url: CommonApi.x, data })`（repo-a / repo-g）
 *
 * 过去只看第 1 种，于是除 example-sys 外的仓端点全部静默归零。
 */
function urlFromCallArg(arg, literals) {
    if (!arg)
        return null;
    const direct = literals.resolveString(arg);
    if (direct !== null)
        return direct;
    if (ts.isObjectLiteralExpression(arg)) {
        const urlProp = getProp(arg, "url");
        return urlProp ? literals.resolveString(urlProp.initializer) : null;
    }
    return null;
}
/** 可调用客户端的 HTTP 方法在 config 里：`request({ url, method: "POST" })` */
function methodFromConfigObject(node) {
    if (!node || !ts.isObjectLiteralExpression(node))
        return null;
    const p = getProp(node, "method");
    return p ? stringValue(p.initializer) : null;
}
/** 把认不出的实参描述成人话，供人工判断 —— 别只留一句「非字面量」 */
function describeArg(node) {
    if (!node)
        return "";
    if (ts.isObjectLiteralExpression(node)) {
        const urlProp = getProp(node, "url");
        if (urlProp)
            return `{ url: ${urlProp.initializer.getText().slice(0, 48)} }`;
        return "{ 无 url 字段 }";
    }
    return "<非字面量>";
}
function urlPrefixOf(url) {
    const first = url.replace(/^\/+/, "").split("/")[0];
    return first || "";
}
/**
 * 找出该文件里绑到共享 http 客户端的局部名。
 * 认的是「解析结果落在 clientFiles 里」而不是写死 `$http` 这个名字，
 * 这样别名 import 或换了变量名也不会漏。
 *
 * 走 resolveModuleFile 而非 resolveSpecifier —— 目录导入（`@/service`、
 * `@/service/instance`）必须解析到真实的 `index.ts`，否则客户端根本认不出来，
 * 该文件会被当成「不碰客户端」静默跳过。
 */
function clientBindings(sf, absFile, repoRoot, srcDirRel, clientFiles) {
    const names = new Set();
    for (const stmt of sf.statements) {
        if (!ts.isImportDeclaration(stmt))
            continue;
        const spec = stringValue(stmt.moduleSpecifier);
        if (!spec)
            continue;
        const resolved = resolveModuleFile(spec, absFile, repoRoot, srcDirRel);
        if (!resolved || !clientFiles.has(resolved))
            continue;
        const clause = stmt.importClause;
        // `import type { X }` 整条是类型，不该混进客户端绑定
        if (!clause || clause.isTypeOnly)
            continue;
        if (clause.name)
            names.add(clause.name.text);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
                if (el.isTypeOnly)
                    continue;
                names.add(el.name.text);
            }
        }
    }
    return names;
}
/**
 * 收集「对外可见的函数」及其函数体，用于定位客户端调用。三种形态：
 *
 * 1. `export function f() {}`
 * 2. `export const f = () => {}`
 * 3. **类方法** —— repo-d 的写法：`class X { f() { return http.get(...) } }`
 *    配 `export const x = new X()`。类没被 export，但实例被导出了，
 *    所以判定要同时看 `export class` 和 `export const y = new X()`。
 */
function exportedFunctions(sf) {
    const out = [];
    const isExported = (node) => {
        const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
        return mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    };
    const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    // 先算出哪些类是对外可见的
    const exposedClasses = new Set();
    for (const stmt of sf.statements) {
        if (ts.isClassDeclaration(stmt) && stmt.name && isExported(stmt)) {
            exposedClasses.add(stmt.name.text);
            continue;
        }
        if (ts.isVariableStatement(stmt) && isExported(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                const init = decl.initializer;
                if (init && ts.isNewExpression(init) && ts.isIdentifier(init.expression)) {
                    exposedClasses.add(init.expression.text);
                }
            }
        }
    }
    for (const stmt of sf.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
            if (isExported(stmt))
                out.push({ name: stmt.name.text, body: stmt.body, line: lineOf(stmt) });
            continue;
        }
        if (ts.isVariableStatement(stmt) && isExported(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name) || !decl.initializer)
                    continue;
                if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                    out.push({ name: decl.name.text, body: decl.initializer.body, line: lineOf(decl) });
                }
            }
            continue;
        }
        if (ts.isClassDeclaration(stmt) && stmt.name && exposedClasses.has(stmt.name.text)) {
            for (const member of stmt.members) {
                if (!ts.isMethodDeclaration(member) || !member.body)
                    continue;
                const name = ts.isIdentifier(member.name)
                    ? member.name.text
                    : ts.isStringLiteral(member.name)
                        ? member.name.text
                        : null;
                if (!name)
                    continue;
                out.push({ name, body: member.body, line: lineOf(member) });
            }
        }
    }
    return out;
}
/**
 * 函数体里由客户端**工厂**造出的局部客户端。
 *
 * repo-b 的写法：
 *   const request = useRequest(source);
 *   return request.post({ url: Api.x, data });
 * `request` 不是 import 绑定，所以过去整个仓 264 个函数全落空。
 */
function localClients(body, clients) {
    const names = new Set();
    const factoryCalls = new Set();
    const visit = (node) => {
        const isCall = ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            clients.has(node.expression.text);
        const isNew = ts.isNewExpression(node) &&
            ts.isIdentifier(node.expression) &&
            clients.has(node.expression.text);
        // 可调用客户端的一次请求：`request({ url, method })` —— 这是在**用**客户端，不是造客户端。
        // 不排除掉的话，repo-mobile 的请求会被误判成工厂而整仓落空。
        // 注意 node.arguments[0] 在无参调用（useRequest()）时是 undefined，别直接喂给 is*
        const firstArg = ts.isCallExpression(node) ? node.arguments[0] : undefined;
        const isInvocation = isCall &&
            firstArg !== undefined &&
            ts.isObjectLiteralExpression(firstArg) &&
            getProp(firstArg, "url") !== null;
        if ((isCall || isNew) && !isInvocation) {
            factoryCalls.add(node);
            const parent = node.parent;
            if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
                names.add(parent.name.text);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(body);
    return { names, factoryCalls };
}
export function extractEndpoints(script, absFile, repoRoot, srcDirRel, clientFiles) {
    const sf = createSource(script.code, absFile);
    const clients = clientBindings(sf, absFile, repoRoot, srcDirRel, clientFiles);
    const rel = toRepoRel(repoRoot, absFile);
    const literals = createLiteralResolver(absFile, repoRoot, srcDirRel);
    const endpoints = [];
    const unresolvedFns = [];
    if (clients.size === 0) {
        // 这个文件根本不碰共享客户端，不当作"未解析"，避免噪音
        return { endpoints, unresolvedFns };
    }
    for (const { name, body, line } of exportedFunctions(sf)) {
        const found = [];
        /** 见过的客户端调用形态（带行号），供人工判断 */
        const calls = [];
        let sawNonLiteralUrl = false;
        let sawUnsupportedForm = false;
        // 工厂造出的局部客户端：const request = useRequest(source)
        const local = localClients(body, clients);
        const isClientName = (n) => clients.has(n) || local.names.has(n);
        const visit = (node) => {
            if (ts.isCallExpression(node)) {
                const at = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 + script.lineOffset;
                const callee = node.expression;
                if (ts.isPropertyAccessExpression(callee)) {
                    const target = callee.expression;
                    const method = callee.name.text;
                    // 客户端可能是 import 绑定、工厂造的局部 const，或直接挂在工厂调用上
                    const isClient = (ts.isIdentifier(target) && isClientName(target.text)) ||
                        (ts.isCallExpression(target) && local.factoryCalls.has(target));
                    if (isClient) {
                        const arg = node.arguments[0];
                        const url = urlFromCallArg(arg, literals);
                        if (url) {
                            found.push({ fn: name, method, url, urlPrefix: urlPrefixOf(url), file: rel, line: at });
                        }
                        else {
                            // 调了客户端但 URL 取不出来 —— 变量/常量/拼接，常量解析能救一部分
                            sawNonLiteralUrl = true;
                            calls.push(`${target.getText().slice(0, 40)}.${method}(${describeArg(arg)}) @ ${at}`);
                        }
                    }
                }
                else if (ts.isIdentifier(callee) &&
                    clients.has(callee.text) &&
                    // 工厂调用本身不是「不支持的调用形态」—— 它是在造客户端，产物已被上面的分支消费
                    !local.factoryCalls.has(node)) {
                    const arg = node.arguments[0];
                    const url = urlFromCallArg(arg, literals);
                    const method = methodFromConfigObject(arg);
                    if (url && method) {
                        // 可调用客户端：`request({ url, method: "POST", data })`（repo-mobile）。
                        // 方法与 URL 都在 config 里，不是 `request.post(...)` 形态。
                        found.push({ fn: name, method, url, urlPrefix: urlPrefixOf(url), file: rel, line: at });
                    }
                    else {
                        // 具名导入后直调（get("/x")）等：拿不到 HTTP 方法，如实标为不支持
                        sawUnsupportedForm = true;
                        calls.push(`${callee.text}(${stringValue(arg) ?? describeArg(arg)}) @ ${at}`);
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(body);
        if (found.length > 0) {
            endpoints.push(...found);
            continue;
        }
        const reason = sawUnsupportedForm
            ? "unsupported-call-form"
            : sawNonLiteralUrl
                ? "unresolved-url"
                : "no-client-usage";
        unresolvedFns.push({
            fn: name,
            reason,
            calls,
            evidence: [`${rel}:${line + script.lineOffset}`],
        });
    }
    return { endpoints, unresolvedFns };
}
