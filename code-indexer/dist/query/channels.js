const KINDS = ["store", "event", "permission", "guard", "storage", "ws"];
/**
 * 状态与事件通道总览。
 * `map` 只出计数（体积不涨），明细走这里，可按 kind 过滤。
 */
export function channelsSummary(map, kind) {
    const want = kind?.trim();
    if (want && !KINDS.includes(want)) {
        return JSON.stringify({ error: `未知的 kind: ${want}`, available: KINDS });
    }
    const out = { repo: map.repo.name };
    const include = (k) => !want || want === k;
    if (include("store")) {
        out.store = {
            total: map.stores.length,
            byKind: {
                pinia: map.stores.filter(s => s.kind === "pinia").length,
                reactiveSingleton: map.stores.filter(s => s.kind === "reactive-singleton").length,
            },
            byStyle: {
                options: map.stores.filter(s => s.style === "options").length,
                setup: map.stores.filter(s => s.style === "setup").length,
            },
            items: map.stores.map(s => ({
                id: s.id,
                binding: s.binding,
                owner: s.ownerModule,
                state: s.state.length,
                actions: s.actions.length,
                touchedFields: Object.keys(map.storeStateIndex[s.id] ?? {}).length,
                ...(s.persist ? { persist: s.persist.key, persistStorage: s.persist.storage } : {}),
            })),
        };
    }
    if (include("event")) {
        out.event = {
            componentsWithEmits: map.componentEmits.length,
            edges: map.eventEdges.length,
            vModelEdges: map.eventEdges.filter(e => e.via === "v-model").length,
            mismatched: map.eventEdges.filter(e => e.unmatched && !e.passthrough).length,
            passthrough: map.eventEdges.filter(e => e.passthrough).length,
            /** 被监听最多的子组件 —— 交互最密集的地方 */
            busiestChildren: topCounts(map.eventEdges.map(e => e.from), 8),
        };
    }
    if (include("permission")) {
        out.permission = {
            codeCount: map.permissions.codes.length,
            definedInRepo: map.permissions.definedInRepo,
            helpers: map.permissions.helpers.map(h => ({
                name: h.name,
                at: `${h.file}:${h.line}`,
                delegatesToHost: h.delegatesToHost,
            })),
            byKind: {
                route: map.permissions.codes.reduce((n, c) => n + c.usedBy.filter(u => u.kind === "route").length, 0),
                directive: map.permissions.codes.reduce((n, c) => n + c.usedBy.filter(u => u.kind === "directive").length, 0),
                inline: map.permissions.codes.reduce((n, c) => n + c.usedBy.filter(u => u.kind === "inline").length, 0),
            },
            codes: map.permissions.codes.map(c => ({ code: c.code, usedBy: c.usedBy.length })),
        };
    }
    if (include("guard")) {
        out.guard = {
            total: map.guards.length,
            items: map.guards.map(g => ({
                hook: g.hook,
                at: `${g.file}:${g.line}`,
                redirects: g.redirects,
                calls: g.calls.slice(0, 8),
            })),
        };
    }
    if (include("storage")) {
        out.storage = {
            keys: map.storageKeys.length,
            dynamicKeys: map.storageKeys.filter(k => k.key === null).length,
            items: map.storageKeys.map(s => ({
                key: s.key ?? `<动态: ${s.raw}>`,
                storage: s.storage,
                reads: s.refs.filter(r => r.mode === "read").length,
                writes: s.refs.filter(r => r.mode === "write").length,
                ...(s.refs.some(r => r.wrapper) ? { wrapper: s.refs.find(r => r.wrapper).wrapper } : {}),
            })),
        };
    }
    if (include("ws")) {
        out.ws = {
            total: map.sockets.length,
            items: map.sockets.map(s => ({
                ctor: s.ctor,
                at: `${s.file}:${s.line}`,
                url: s.url,
                // 实测这些仓不用 msg.type 标签，靠字段存在性分发 —— 两个都列出来
                handled: s.messagesHandled,
                sent: s.messagesSent,
                dispatchFields: s.dispatchFields.slice(0, 12),
                wrapper: s.wrapper,
            })),
        };
    }
    return JSON.stringify(out, null, 1);
}
function topCounts(values, n) {
    const counts = new Map();
    for (const v of values)
        counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
        .slice(0, n);
}
