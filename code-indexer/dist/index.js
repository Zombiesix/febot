import path from "node:path";
import { extractRoutes } from "./adapters/vue3";
import { buildApiIndex } from "./api-calls";
import { loadAutoComponents } from "./auto-components";
import { buildComponentGraph } from "./deps";
import { detectBuildOutDir, detectBuildOutputDirs, detectStack, looksLikeRepo } from "./detect";
import { buildComponentEmits, buildEventEdges } from "./events";
import { DEFAULT_IGNORED_DIRS, walk } from "./ignore";
import { buildModuleGraph } from "./module-graph";
import { buildModules } from "./modules";
import { buildGuards, buildPermissions } from "./permissions";
import { buildStorage } from "./storage";
import { buildSockets } from "./sockets";
import { buildStoreStateIndex, buildStores } from "./stores";
function tokens(name) {
    return name
        .split(/[-_/]/)
        .filter(Boolean)
        .map(t => t.toLowerCase());
}
/** 名字层面是否相关：存在相同 token，或 token 互为前缀 */
function nameRelated(a, b) {
    const ta = tokens(a);
    const tb = tokens(b);
    return ta.some(x => tb.some(y => x === y || x.startsWith(y) || y.startsWith(x)));
}
export function scanRepo(repoPath) {
    const started = Date.now();
    const repoRoot = path.resolve(repoPath);
    const stack = detectStack(repoRoot);
    // 构建产物目录：配置读 outDir + 按内容识别（仓里提交的产物配置读不出来）
    const extraIgnore = new Set();
    const outDir = detectBuildOutDir(repoRoot);
    if (outDir)
        extraIgnore.add(outDir);
    for (const d of detectBuildOutputDirs(repoRoot))
        extraIgnore.add(d);
    const ignoredDirs = extraIgnore.size > 0 ? new Set([...DEFAULT_IGNORED_DIRS, ...extraIgnore]) : undefined;
    const { files, symlinksSkipped, filesIgnored } = walk(repoRoot, { ignoredDirs });
    const warnings = [];
    let routes = [];
    if (stack.kind === "vue3" && stack.routerFile) {
        const extracted = extractRoutes(path.join(repoRoot, stack.routerFile), repoRoot, stack.srcDir);
        routes = extracted.routes;
        for (const spec of extracted.unresolved) {
            warnings.push({
                kind: "unresolved-component",
                message: `无法解析的组件引用：${spec}`,
                evidence: [stack.routerFile],
            });
        }
        if (extracted.dynamicRoutes) {
            warnings.push({
                kind: "dynamic-routes",
                message: "路由由 import.meta.glob 动态生成，静态分析无法枚举 —— routes 为 0 不代表没有路由，需人工确认",
                evidence: [stack.routerFile],
            });
        }
    }
    else if (stack.kind !== "vue3") {
        warnings.push({
            kind: "unsupported-stack",
            message: `M1 只支持 Vue 3 仓，本仓检测为 ${stack.kind}`,
            evidence: [stack.vueVersion ? `vue@${stack.vueVersion}` : "未找到 vue 依赖"],
        });
    }
    else {
        warnings.push({
            kind: "unresolved-component",
            message: "未找到集中式路由表文件",
            evidence: [],
        });
    }
    const api = buildApiIndex(repoRoot, stack.serviceDir, stack.srcDir);
    // 组件图建在全仓 SFC 上：模块内的组件也可能引用模块外的共享组件，
    // 只扫模块目录会断链。
    const sfcFiles = files.filter(f => path.extname(f).toLowerCase() === ".vue");
    const auto = loadAutoComponents(repoRoot, sfcFiles, files);
    const components = buildComponentGraph(repoRoot, stack.srcDir, sfcFiles, auto);
    const modules = buildModules(repoRoot, stack.srcDir, stack.pageDirs, api, routes, components);
    // 状态通道：store 定义 + 谁读谁写。只扫代码文件（.vue 里的 <script> 也算）
    const codeFiles = files.filter(f => {
        const ext = path.extname(f).toLowerCase();
        return ext === ".vue" || ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx";
    });
    const stores = buildStores(repoRoot, codeFiles, stack.pageDirs);
    const storeStateIndex = buildStoreStateIndex(repoRoot, codeFiles, stores);
    // 权限与守卫：权限码台账（路由 / 指令 / inline）+ 守卫如实抽取
    const permissions = buildPermissions(repoRoot, codeFiles, routes);
    const guards = buildGuards(repoRoot, codeFiles);
    // 存储通道：localStorage / sessionStorage / cookie
    const storageKeys = buildStorage(repoRoot, codeFiles);
    for (const s of storageKeys) {
        // key 解析不出 = 无法审计。显式报出来，不静默丢弃。
        if (s.key === null && s.raw !== "<clear>") {
            warnings.push({
                kind: "dynamic-storage-key",
                message: `${s.storage}Storage 的 key 是动态的，静态解析不出，无法审计：${s.raw}`,
                evidence: s.refs.slice(0, 3).map(r => `${r.file}:${r.line}`),
            });
        }
    }
    // 共享域：被 >= 3 个模块引用的基础域（common / auth-server 之类）。
    // 它们本来就不该跟某个业务模块同名，报出来只是噪音。
    const domainUsedBy = new Map();
    for (const m of modules) {
        for (const u of m.api) {
            domainUsedBy.set(u.domain, [...(domainUsedBy.get(u.domain) ?? []), m.name]);
        }
    }
    const SHARED_DOMAIN_THRESHOLD = 3;
    for (const d of api.domains) {
        d.usedByModules = domainUsedBy.get(d.name) ?? [];
    }
    // 命名不一致：链接关系由 import 推导，所以"确有调用但名字对不上"是真信号。
    // 比对时同时看模块名和引用方的子路径——system-config/water-content-reference
    // 用 water-content 域其实对得上，只看模块名会误报。
    for (const m of modules) {
        for (const usage of m.api) {
            if ((domainUsedBy.get(usage.domain)?.length ?? 0) >= SHARED_DOMAIN_THRESHOLD)
                continue;
            const byModuleName = nameRelated(m.name, usage.domain);
            const bySubPath = usage.subPaths.some(sp => nameRelated(sp, usage.domain));
            if (byModuleName || bySubPath)
                continue;
            warnings.push({
                kind: "naming-mismatch",
                message: `页面模块 "${m.name}" 实际调用 API 域 "${usage.domain}"，命名对不上，需人工确认业务含义`,
                evidence: usage.evidence,
            });
        }
    }
    // 孤儿 API 域：没有任何页面模块引用它
    const usedDomains = new Set(modules.flatMap(m => m.api.map(u => u.domain)));
    for (const d of api.domains) {
        if (!usedDomains.has(d.name)) {
            warnings.push({
                kind: "orphan-api-domain",
                message: `API 域 "${d.name}" 未被任何页面模块引用`,
                evidence: [d.dir],
            });
        }
    }
    // 无模块归属的路由：指向 src/page 之外（如 src/view/out-page/）
    for (const r of routes) {
        if (!r.componentFile)
            continue;
        const owned = modules.some(m => r.componentFile.startsWith(`${m.dir}/`));
        if (!owned) {
            warnings.push({
                kind: "orphan-route",
                message: `路由 "${r.path}"（${r.label ?? "无 label"}）指向 src/page 之外的模块`,
                evidence: [r.componentFile],
            });
        }
    }
    // 无路由入口的模块：可能是子页面、被父级内嵌，也可能是死代码——都值得问人
    for (const m of modules) {
        if (!m.route) {
            warnings.push({
                kind: "orphan-module",
                message: `业务模块 "${m.name}" 没有路由入口，可能是子页面或未挂载代码`,
                evidence: [m.dir],
            });
        }
    }
    // 动态渲染：子组件由数据决定，静态分析看不全，是最容易让新人迷路的一类跳转
    const dynamicSet = new Set(components.dynamicComponents);
    for (const m of modules) {
        const hits = m.components.filter(f => dynamicSet.has(f));
        if (hits.length > 0) {
            warnings.push({
                kind: "dynamic-children",
                message: `模块 "${m.name}" 用 <component :is> 动态渲染，子组件由数据决定，静态分析看不全`,
                evidence: hits.slice(0, 3),
            });
        }
    }
    const componentEmits = buildComponentEmits(repoRoot, codeFiles);
    // 状态 / 事件通道的告警
    for (const s of stores) {
        const fields = storeStateIndex[s.id] ?? {};
        const touched = Object.keys(fields).length;
        if (touched === 0) {
            warnings.push({
                kind: "orphan-store",
                message: `store "${s.id}"（${s.binding}）定义了 ${s.state.length} 个 state，但全仓没有任何字段读写 —— 可能是死代码，或只被整体传递`,
                evidence: [`${s.file}:${s.line}`],
            });
        }
        // 同一个字段被 3 处以上写 —— 状态来源分散，最容易出难查的 bug
        for (const [field, refs] of Object.entries(fields)) {
            const writers = refs.filter(r => r.mode === "write");
            if (writers.length >= 3) {
                warnings.push({
                    kind: "multi-writer",
                    message: `store "${s.id}" 的字段 "${field}" 有 ${writers.length} 处写入，状态来源分散，改一处容易漏另一处`,
                    evidence: writers.slice(0, 3).map(r => `${r.file}:${r.line}`),
                });
            }
        }
    }
    const sockets = buildSockets(repoRoot, codeFiles);
    const map = {
        repo: { path: repoRoot, name: path.basename(repoRoot) },
        stack,
        routes,
        modules,
        apiDomains: api.domains,
        components,
        stores,
        storeStateIndex,
        permissions,
        guards,
        storageKeys,
        componentEmits,
        eventEdges: [], // 占位：事件边依赖组件图，建好 map 后回填
        sockets,
        moduleGraph: { edges: [], sharedTargets: [], sharedStores: [], sharedApiDomains: [], crossModuleEvents: [] },
        warnings,
        stats: {
            filesScanned: files.length,
            filesIgnored,
            symlinksSkipped,
            durationMs: Date.now() - started,
        },
    };
    map.eventEdges = buildEventEdges(map);
    map.moduleGraph = buildModuleGraph(map);
    // 事件通道的告警（要等 eventEdges 建好）
    // 父组件绑了一个子组件既没声明也没发过的事件，且不是 $attrs 透传 —— 大概率是名字写错
    for (const e of map.eventEdges) {
        if (e.unmatched && !e.passthrough) {
            warnings.push({
                kind: "unmatched-event-binding",
                message: `"${e.to}" 绑定了 "${e.event}"，但子组件 "${e.from}" 既没声明也没发过该事件（也不是 $attrs 透传）—— 事件名可能写错`,
                evidence: [e.handlerAt],
            });
        }
    }
    // 子组件发了、且**确实被父级用过**，但那些父级都不监听这个事件。
    // 只报这一类：组件压根没被用过 / 被 <component :is> 动态挂载的，都属于"静态看不见"，
    // 全报出来会淹掉真信号（实测前者会让告警数从 ~30 涨到 700+）。
    const listened = new Set(map.eventEdges.map(e => `${e.from}::${e.event}`));
    const usedAsChild = new Set(map.eventEdges.map(e => e.from));
    for (const c of map.componentEmits) {
        if (!usedAsChild.has(c.file))
            continue;
        for (const ev of new Set(c.calls.map(x => x.event))) {
            if (listened.has(`${c.file}::${ev}`))
                continue;
            warnings.push({
                kind: "orphan-emit",
                message: `"${c.file}" 被父级使用，但发出的 "${ev}" 没有任何父级监听 —— 事件名可能对不上，或监听方在动态组件上`,
                evidence: c.calls.filter(x => x.event === ev).slice(0, 2).map(x => `${c.file}:${x.line}`),
            });
        }
    }
    return map;
}
export { looksLikeRepo };
export { getScan, clearScanCache } from "./cache";
