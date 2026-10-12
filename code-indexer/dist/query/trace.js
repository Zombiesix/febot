import { resolveModuleEndpoints } from "../endpoint-types";
/**
 * 该模块的事件通道：它发出的 / 它监听的事件边。
 * emit 是渲染树的反向通道，模块 trace 里过去完全没有。
 */
function eventsOfModule(map, mod) {
    if (!mod)
        return null;
    const inModule = (f) => f.startsWith(`${mod.dir}/`);
    const outgoing = map.eventEdges.filter(e => inModule(e.from));
    const incoming = map.eventEdges.filter(e => inModule(e.to));
    if (outgoing.length === 0 && incoming.length === 0)
        return null;
    const brief = (e) => ({
        event: e.event,
        via: e.via,
        child: e.from.split("/").pop(),
        parent: e.to.split("/").pop(),
        handler: e.handler,
        ...(e.effects.length > 0 ? { effects: e.effects.slice(0, 6) } : {}),
        ...(e.unmatched && !e.passthrough ? { mismatched: true } : {}),
    });
    return {
        /** 模块内组件发出、被父级接的 */
        outgoing: outgoing.slice(0, 15).map(brief),
        /** 模块内组件监听子组件的 */
        incoming: incoming.slice(0, 15).map(brief),
    };
}
/**
 * 该模块碰过的存储 key。
 * 「记住这个页面上次选的日期口径」这类业务行为就藏在这里。
 */
function storageOfModule(map, mod) {
    if (!mod)
        return null;
    const out = [];
    for (const s of map.storageKeys) {
        for (const r of s.refs) {
            if (!r.file.startsWith(`${mod.dir}/`))
                continue;
            out.push({
                key: s.key ?? `<动态: ${s.raw}>`,
                storage: s.storage,
                mode: r.mode,
                at: `${r.file}:${r.line}`,
            });
        }
    }
    if (out.length === 0)
        return null;
    return out.slice(0, 20);
}
/**
 * 该模块涉及的权限码：路由 meta + 模块文件里的指令 / inline 判定。
 * 权限码是「这个按钮/页面谁能看」的答案，属于业务语义，导师层要用。
 */
function permissionsOfModule(map, mod, route) {
    if (!mod && !route)
        return null;
    const out = [];
    const routeCode = route?.permissionCode ?? mod?.route?.permissionCode ?? null;
    if (routeCode) {
        for (const c of routeCode.split(",").map(s => s.trim()).filter(Boolean)) {
            out.push({ code: c, kind: "route", at: route?.path ?? mod?.route?.path ?? "" });
        }
    }
    if (mod) {
        for (const c of map.permissions.codes) {
            for (const u of c.usedBy) {
                if (u.kind === "route")
                    continue;
                if (!u.file.startsWith(`${mod.dir}/`))
                    continue;
                out.push({ code: c.code, kind: u.kind, at: `${u.file}:${u.line}` });
            }
        }
    }
    if (out.length === 0)
        return null;
    return {
        definedInRepo: map.permissions.definedInRepo,
        items: out.slice(0, 20),
    };
}
/**
 * 该模块的状态通道：它拥有的 store + 它读写过的 store 字段。
 *
 * 「谁改了 caSignMethod」这类问题的答案就在这 —— 过去完全没有这个视角。
 */
function storesOfModule(map, mod) {
    if (!mod)
        return null;
    const owned = map.stores
        .filter(s => s.ownerModule === mod.name)
        .map(s => ({ id: s.id, binding: s.binding, state: s.state.length, actions: s.actions.length }));
    const touched = [];
    for (const [id, fields] of Object.entries(map.storeStateIndex)) {
        for (const [field, refs] of Object.entries(fields)) {
            const inModule = refs.filter(r => r.file.startsWith(`${mod.dir}/`));
            if (inModule.length === 0)
                continue;
            const writes = inModule.filter(r => r.mode === "write").length;
            touched.push({
                store: id,
                field,
                reads: inModule.length - writes,
                writes,
                at: `${inModule[0].file}:${inModule[0].line}`,
            });
        }
    }
    if (owned.length === 0 && touched.length === 0)
        return null;
    touched.sort((a, b) => b.writes - a.writes || a.store.localeCompare(b.store));
    return { owned, touched: touched.slice(0, 30) };
}
/**
 * 该模块涉及的 api 域里「没解析出端点」的函数。
 * 只展开 actionable 的两类（unresolved-url / unsupported-call-form）——
 * no-client-usage 是纯工具函数，只给计数，别把噪音提到链路里。
 */
function unresolvedOfModule(map, mod) {
    if (!mod)
        return null;
    const domains = new Set(mod.api.map(u => u.domain));
    const actionable = [];
    let utilityCount = 0;
    for (const d of map.apiDomains) {
        if (!domains.has(d.name))
            continue;
        for (const u of d.unresolvedFns) {
            if (u.reason === "no-client-usage") {
                utilityCount++;
                continue;
            }
            actionable.push({
                domain: d.name,
                fn: u.fn,
                reason: u.reason,
                evidence: u.evidence.slice(0, 1),
            });
        }
    }
    if (actionable.length === 0 && utilityCount === 0)
        return null;
    return { actionable: actionable.slice(0, 20), utilityCount };
}
function serializeTree(node, depth, budget) {
    if (budget.left <= 0)
        return { truncated: true };
    budget.left--;
    return {
        file: node.file,
        via: node.via ?? "root",
        ...(node.cyclic ? { cyclic: true } : {}),
        ...(node.duplicate ? { duplicate: true } : {}),
        ...(node.external.length > 0 ? { external: node.external.slice(0, 8) } : {}),
        children: depth >= 6 ? [] : node.children.map(c => serializeTree(c, depth + 1, budget)),
    };
}
export function traceFlow(map, target) {
    const t = target.trim();
    const route = map.routes.find(r => r.path === t || r.path === `/${t}`);
    const mod = route
        ? map.modules.find(m => route.componentFile?.startsWith(m.dir + "/"))
        : map.modules.find(m => m.name === t || m.name === t.replace(/^\/+|\/+$/g, ""));
    if (!route && !mod) {
        const routeHints = map.routes.slice(0, 8).map(r => r.path).join(", ");
        const moduleHints = map.modules.slice(0, 8).map(m => m.name).join(", ");
        return JSON.stringify({
            error: `not found: "${t}"`,
            hint: { someRoutes: routeHints, someModules: moduleHints },
        });
    }
    const usages = mod?.api ?? [];
    const byDomain = new Map(map.apiDomains.map(d => [d.name, d.endpoints]));
    const endpoints = mod ? resolveModuleEndpoints(usages, byDomain) : [];
    return JSON.stringify({
        target: t,
        route: route
            ? {
                path: route.path,
                label: route.label,
                ...(route.extraMeta?.comment ? { comment: route.extraMeta.comment } : {}),
                name: route.name,
                permissionCode: route.permissionCode,
                componentFile: route.componentFile,
            }
            : null,
        module: mod
            ? {
                name: mod.name,
                label: mod.label,
                dir: mod.dir,
                components: mod.components.length,
                treeSize: mod.treeSize,
            }
            : null,
        componentTree: mod?.tree ? serializeTree(mod.tree, 0, { left: 50 }) : null,
        stores: storesOfModule(map, mod),
        permissions: permissionsOfModule(map, mod, route),
        storage: storageOfModule(map, mod),
        events: eventsOfModule(map, mod),
        api: usages.map(u => ({ domain: u.domain, refs: u.refs.slice(0, 20), evidence: u.evidence.slice(0, 3) })),
        endpoints: endpoints.slice(0, 30).map(e => ({
            fn: e.fn,
            method: e.method.toUpperCase(),
            url: e.url,
            at: `${e.file}:${e.line}`,
        })),
        unresolved: unresolvedOfModule(map, mod),
        relatedWarnings: map.warnings
            .filter(w => (mod && w.message.includes(`"${mod.name}"`)) || (route && w.evidence.some(ev => ev.includes(route.path))))
            .slice(0, 10)
            .map(w => `[${w.kind}] ${w.message}`),
    }, null, 1);
}
