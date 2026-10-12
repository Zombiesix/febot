/**
 * 把模块引用的 api 函数（形如 "catheter/queryList"）对回真实端点。
 * CLI 与 UI 共用，避免两边逻辑漂移。
 */
export function resolveModuleEndpoints(usages, byDomain) {
    const out = [];
    const seen = new Set();
    for (const usage of usages) {
        const refFns = new Set(usage.refs.map(r => (r.includes("/") ? r.split("/").slice(1).join("/") : r)));
        for (const ep of byDomain.get(usage.domain) ?? []) {
            if (!refFns.has(ep.fn))
                continue;
            const key = `${ep.method} ${ep.url}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            out.push(ep);
        }
    }
    return out.sort((a, b) => a.url.localeCompare(b.url));
}
