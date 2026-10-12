export function listWarnings(map, opts = {}) {
    const kind = opts.kind?.trim();
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;
    const filtered = kind ? map.warnings.filter(w => w.kind === kind) : map.warnings;
    return JSON.stringify({
        total: filtered.length,
        kinds: [...new Set(map.warnings.map(w => w.kind))],
        items: filtered.slice(0, limit).map(w => ({
            kind: w.kind,
            message: w.message,
            evidence: w.evidence.slice(0, 3),
        })),
    }, null, 1);
}
