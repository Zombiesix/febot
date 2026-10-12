import type { ProjectMap } from "../types";

/** 关键词检索：路由 / 模块 / API 域与端点，给 MCP 与 CLI 共用 */
export function searchIndex(map: ProjectMap, keyword: string, limit = 20): string {
  const kw = keyword.trim().toLowerCase();
  if (!kw) {
    return JSON.stringify({ error: "keyword is required" });
  }

  const routes = map.routes
    .filter(r => r.path.toLowerCase().includes(kw) || (r.label ?? "").toLowerCase().includes(kw))
    .map(r => ({ type: "route" as const, path: r.path, label: r.label, componentFile: r.componentFile }));

  const modules = map.modules
    .filter(m => m.name.toLowerCase().includes(kw) || (m.label ?? "").toLowerCase().includes(kw))
    .map(m => ({ type: "module" as const, name: m.name, label: m.label, dir: m.dir }));

  const endpoints = map.apiDomains.flatMap(d =>
    d.endpoints
      .filter(e => e.fn.toLowerCase().includes(kw) || e.url.toLowerCase().includes(kw))
      .map(e => ({
        type: "endpoint" as const,
        domain: d.name,
        fn: e.fn,
        method: e.method.toUpperCase(),
        url: e.url,
        at: `${e.file}:${e.line}`,
      })),
  );

  const total = routes.length + modules.length + endpoints.length;
  return JSON.stringify(
    { keyword, total, routes: routes.slice(0, limit), modules: modules.slice(0, limit), endpoints: endpoints.slice(0, limit) },
    null,
    1,
  );
}
