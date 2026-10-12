import type { ProjectMap } from "../types";

/**
 * 追一个 store 字段：**谁在读、谁在写**。
 *
 * `trace-state <repo> <store>.<field>` 或 `trace-state <repo> <store>`（列全部字段）。
 * 这是「这个状态谁改的」的直接答案 —— 过去完全没有这个视角。
 */
export function traceState(map: ProjectMap, target: string): string {
  const t = target.trim();

  // 先按 id 精确匹配，再按 binding，最后按路径片段
  const findStore = (key: string) =>
    map.stores.find(s => s.id === key) ??
    map.stores.find(s => s.binding === key) ??
    map.stores.find(s => s.id.toLowerCase().includes(key.toLowerCase()));

  // 支持 `store.field` 与 `store` 两种写法
  const dot = t.lastIndexOf(".");
  const storeKey = dot > 0 ? t.slice(0, dot) : t;
  const field = dot > 0 ? t.slice(dot + 1) : null;

  const store = findStore(storeKey);
  if (!store) {
    return JSON.stringify({
      error: `没有找到 store "${storeKey}"`,
      hint: { someStores: map.stores.slice(0, 10).map(s => s.id) },
    });
  }

  const fields = map.storeStateIndex[store.id] ?? {};

  const describe = (name: string, refs: typeof fields[string]) => {
    const writes = refs.filter(r => r.mode === "write");
    const reads = refs.filter(r => r.mode !== "write");
    return {
      field: name,
      writes: writes.length,
      reads: reads.length,
      ...(writes.length > 0
        ? { writtenAt: writes.slice(0, 8).map(r => `${r.file}:${r.line}${r.owner ? ` (${r.owner})` : ""}`) }
        : {}),
      ...(reads.length > 0
        ? { readAt: reads.slice(0, 5).map(r => `${r.file}:${r.line}${r.owner ? ` (${r.owner})` : ""}`) }
        : {}),
    };
  };

  if (field) {
    const refs = fields[field];
    if (!refs || refs.length === 0) {
      const declared = [...store.state, ...store.getters, ...store.actions];
      return JSON.stringify({
        error: `store "${store.id}" 里没有 "${field}" 的读写记录`,
        hint: {
          declaredButUntouched: declared.includes(field),
          declared,
          touched: Object.keys(fields),
        },
      });
    }
    return JSON.stringify(
      {
        target: `${store.id}.${field}`,
        store: { id: store.id, binding: store.binding, file: `${store.file}:${store.line}`, kind: store.kind },
        ...describe(field, refs),
      },
      null,
      1,
    );
  }

  const touched = Object.keys(fields);
  return JSON.stringify(
    {
      target: store.id,
      store: {
        id: store.id,
        binding: store.binding,
        kind: store.kind,
        style: store.style,
        file: `${store.file}:${store.line}`,
        ownerModule: store.ownerModule,
        ...(store.persist ? { persist: store.persist } : {}),
      },
      declared: { state: store.state, getters: store.getters, actions: store.actions },
      /** 全仓没有任何读写的字段 —— 可能是死代码 */
      untouched: [...store.state, ...store.getters, ...store.actions].filter(n => !touched.includes(n)),
      fields: touched.map(name => describe(name, fields[name])),
    },
    null,
    1,
  );
}
