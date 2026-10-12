export const cap = (s, n) => s.length > n ? s.slice(0, n) + "…" : s;
/** 按原因计数：no-client-usage 是纯工具函数（噪音），其余两类才值得看 */
function countByReason(fns) {
    const out = {};
    for (const f of fns)
        out[f.reason] = (out[f.reason] ?? 0) + 1;
    return out;
}
function stackQiankun(map) {
    return map.stack.isQiankunChild;
}
function moduleNameForRoute(map, routePath) {
    const r = map.routes.find(x => x.path === routePath);
    if (!r?.componentFile)
        return null;
    const m = map.modules.find(x => r.componentFile.startsWith(x.dir + "/"));
    return m?.name ?? null;
}
export function projectOverview(map) {
    return JSON.stringify({
        repo: map.repo.name,
        stack: { kind: map.stack.kind, builder: map.stack.builder, qiankunChild: stackQiankun(map) },
        routes: map.routes.map(r => ({
            path: r.path,
            label: r.label,
            // 没有 meta 业务名时，代码里的行内注释是唯一的中文线索（repo-g 形态）。
            // 单独成字段，不冒充 label —— 消费方自己决定信不信。
            ...(r.extraMeta?.comment ? { comment: r.extraMeta.comment } : {}),
            module: moduleNameForRoute(map, r.path),
        })),
        modules: map.modules.map(m => ({ name: m.name, label: m.label, hasRoute: !!m.route })),
        apiDomains: map.apiDomains.map(d => ({
            name: d.name,
            usedBy: d.usedByModules,
            endpoints: d.endpoints.length,
            // 只出计数不出名字，map 体积不涨
            ...(d.unresolvedFns.length > 0
                ? { unresolved: { total: d.unresolvedFns.length, byReason: countByReason(d.unresolvedFns) } }
                : {}),
        })),
        stores: map.stores.map(s => ({
            id: s.id,
            binding: s.binding,
            kind: s.kind,
            owner: s.ownerModule,
            state: s.state.length,
            getters: s.getters.length,
            actions: s.actions.length,
            // 有没有人读写它 —— 只有定义了没人用的 store 一眼可见
            touchedFields: Object.keys(map.storeStateIndex[s.id] ?? {}).length,
            ...(s.persist ? { persist: s.persist.key } : {}),
        })),
        permissions: {
            codes: map.permissions.codes.length,
            // 判定实现在不在本仓 —— 多数仓是 false（在 qiankun 宿主仓）
            definedInRepo: map.permissions.definedInRepo,
            helpers: map.permissions.helpers.map(h => `${h.name}${h.delegatesToHost ? "(宿主)" : ""}`),
            byKind: {
                route: map.permissions.codes.reduce((n, c) => n + c.usedBy.filter(u => u.kind === "route").length, 0),
                directive: map.permissions.codes.reduce((n, c) => n + c.usedBy.filter(u => u.kind === "directive").length, 0),
                inline: map.permissions.codes.reduce((n, c) => n + c.usedBy.filter(u => u.kind === "inline").length, 0),
            },
            sample: map.permissions.codes.slice(0, 8).map(c => c.code),
        },
        guards: map.guards.map(g => ({ hook: g.hook, at: `${g.file}:${g.line}` })),
        events: {
            /** 有 emit 的组件数 */
            components: map.componentEmits.length,
            /** 子→父的事件边总数 */
            edges: map.eventEdges.length,
            vModelEdges: map.eventEdges.filter(e => e.via === "v-model").length,
            /** 子组件没声明也没发过、且不是 $attrs 透传的边 —— 真的对不上，值得看 */
            mismatched: map.eventEdges.filter(e => e.unmatched && !e.passthrough).length,
            passthrough: map.eventEdges.filter(e => e.passthrough).length,
        },
        storageKeys: map.storageKeys.map(s => ({
            key: s.key ?? `<动态: ${s.raw}>`,
            storage: s.storage,
            // 谁写谁读，一眼看出这个 key 是"用户偏好"还是"鉴权凭证"
            reads: s.refs.filter(r => r.mode === "read").length,
            writes: s.refs.filter(r => r.mode === "write").length,
            ...(s.refs.some(r => r.wrapper) ? { viaWrapper: s.refs.find(r => r.wrapper).wrapper } : {}),
        })),
        warnings: map.warnings.slice(0, 20).map(w => `[${w.kind}] ${cap(w.message, 120)}`),
        warningTotal: map.warnings.length,
    }, null, 1);
}
