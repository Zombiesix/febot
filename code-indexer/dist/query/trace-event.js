import { normalizeEvent } from "../events";
/** 组件名匹配：文件名（去扩展名）或路径片段命中即可 */
function matcher(component) {
    const needle = component.trim().toLowerCase().replace(/\.vue$/i, "");
    return file => {
        const base = file.split("/").pop()?.replace(/\.vue$/i, "").toLowerCase() ?? "";
        return base === needle || file.toLowerCase().includes(needle);
    };
}
/**
 * 追一个组件事件：**谁 emit → 谁接 → handler 干了什么**。
 *
 * 渲染树是父→子，emit 是子→父的反向通道 —— 这个查询走的就是那条反向边。
 */
export function traceEvent(map, component, event) {
    const ev = normalizeEvent(event.trim());
    const isTarget = matcher(component);
    const emitters = map.componentEmits.filter(e => isTarget(e.file));
    if (emitters.length === 0) {
        const sample = map.componentEmits.slice(0, 10).map(e => e.file.split("/").pop()).join(", ");
        return JSON.stringify({
            error: `没有找到组件 "${component}" 的 emit 记录`,
            hint: { someComponentsWithEmits: sample },
        });
    }
    const listeners = map.eventEdges.filter(e => isTarget(e.from) && e.event === ev);
    const out = {
        target: `${component} @ ${ev}`,
        emitters: emitters.map(e => ({
            file: e.file,
            style: e.style,
            /** 声明里有没有这个事件 */
            declared: e.declared.includes(ev),
            declaredEvents: e.declared.slice(0, 12),
            /** 实际在哪一行发出 */
            calls: e.calls.filter(c => c.event === ev).map(c => ({ at: `${e.file}:${c.line}`, binding: c.binding })),
        })),
        listeners: listeners.map(l => ({
            parent: l.to,
            handler: l.handler,
            at: l.handlerAt,
            via: l.via,
            // handler 里调了什么 —— api / store action / router 都在这
            effects: l.effects.slice(0, 12),
            ...(l.unmatched ? { unmatched: true } : {}),
            ...(l.passthrough ? { passthrough: true } : {}),
        })),
    };
    if (listeners.length === 0) {
        return JSON.stringify({
            ...out,
            note: `没有任何父组件监听 "${ev}" —— 可能该事件只被透传，或名字对不上（试 camelCase / kebab-case 互换）`,
        });
    }
    return JSON.stringify(out, null, 1);
}
