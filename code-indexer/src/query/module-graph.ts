import type { ProjectMap } from "../types";

/**
 * 模块间关系视图。
 *
 * 不带参数：全仓的模块依赖全景。
 * 带模块名：只看这个模块的「依赖谁 / 被谁依赖」。
 */
export function moduleGraphView(map: ProjectMap, focus?: string): string {
  const g = map.moduleGraph;
  const target = focus?.trim();

  if (target) {
    const mod = map.modules.find(m => m.name === target || m.dir.endsWith(`/${target}`));
    if (!mod) {
      return JSON.stringify({
        error: `没有找到模块 "${target}"`,
        hint: { someModules: map.modules.slice(0, 12).map(m => m.name) },
      });
    }

    return JSON.stringify(
      {
        module: { name: mod.name, dir: mod.dir, label: mod.label, components: mod.components.length },
        /** 它依赖谁 */
        dependsOn: g.edges.filter(e => e.from === mod.name),
        /** 谁依赖它 */
        dependedBy: g.edges.filter(e => e.to === mod.name),
        /** 它引用的共享层目录 */
        sharedTargets: g.sharedTargets.filter(s => s.from === mod.name),
        /** 它参与读写的共享 store */
        sharedStores: g.sharedStores
          .filter(s => s.modules.includes(mod.name))
          .map(s => ({ id: s.id, sharedWith: s.modules.filter(m => m !== mod.name) })),
        crossModuleEvents: g.crossModuleEvents.filter(e => e.from === mod.name || e.to === mod.name),
      },
      null,
      1,
    );
  }

  const noEdges = g.edges.length === 0 && g.sharedTargets.length === 0;

  return JSON.stringify(
    {
      repo: map.repo.name,
      moduleCount: map.modules.length,
      summary: {
        moduleToModuleEdges: g.edges.length,
        moduleToSharedEdges: g.sharedTargets.length,
        sharedStores: g.sharedStores.length,
        sharedApiDomains: g.sharedApiDomains.length,
        crossModuleEvents: g.crossModuleEvents.length,
      },
      /** 模块 → 模块（组件引用） */
      edges: g.edges.slice(0, 40),
      /** 模块 → 共享层目录（目标不属于任何模块） */
      sharedTargets: g.sharedTargets.slice(0, 25),
      /** 被多模块读写的 store —— 跨模块共享状态的真正来源 */
      sharedStores: g.sharedStores.slice(0, 12),
      sharedApiDomains: g.sharedApiDomains.slice(0, 12),
      crossModuleEvents: g.crossModuleEvents.slice(0, 20),
      ...(noEdges
        ? { note: "没有解析出任何跨模块引用 —— 可能该仓模块间确实低耦合，或组件标签解析率低（看 unresolved-component 告警）" }
        : {}),
    },
    null,
    1,
  );
}
