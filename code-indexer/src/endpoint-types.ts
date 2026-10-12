/**
 * 端点相关的纯类型与纯逻辑，**不得引入任何 Node 模块**。
 * 客户端组件（ProjectMapView）要 import 这里；一旦引入 typescript / node:fs，
 * 它们会被打进浏览器 bundle 并报 UnhandledSchemeError。
 * 真正需要 AST 的提取逻辑在 endpoints.ts，那是 server-only。
 */
export interface Endpoint {
  /** api 函数名，如 queryCatheterConfigList */
  fn: string;
  /** HTTP 方法：get / post / upload / download / delete */
  method: string;
  /** 后端路径，如 /example-sys/api/catheter-configurations/search */
  url: string;
  /** 路径首段，通常是后端系统标识，如 example-sys */
  urlPrefix: string;
  file: string;
  line: number;
}

/**
 * 一个导出函数没解析出端点的**原因**。
 *
 * 关键是别把原因丢掉：过去这里只留函数名数组，消费方（scripts/recon.mjs）只好
 * 用自然语言重新猜原因。原因分类必须由生产者带上，消费方才能分流处理。
 */
export type UnresolvedReason =
  /** 函数体里压根没有客户端调用 —— 大概率是纯工具函数（日期计算之类），不是提取失败 */
  | "no-client-usage"
  /** 有 `client.method(...)` 调用，但 URL 不是字面量（变量 / 常量 / 拼接）—— 常量解析能救一部分 */
  | "unresolved-url"
  /** 调用了客户端但不是 `<client>.<method>(url)` 形态（解构后直调 / 二次封装 / config object） */
  | "unsupported-call-form";

export interface UnresolvedFn {
  /** api 函数名 */
  fn: string;
  reason: UnresolvedReason;
  /** 命中的调用形态，如 `$http.get(<非字面量>)`，供人工判断 */
  calls: string[];
  /** 文件:行 —— 函数声明处，必填 */
  evidence: string[];
}

/**
 * 把模块引用的 api 函数（形如 "catheter/queryList"）对回真实端点。
 * CLI 与 UI 共用，避免两边逻辑漂移。
 */
export function resolveModuleEndpoints(
  usages: { domain: string; refs: string[] }[],
  byDomain: Map<string, Endpoint[]>,
): Endpoint[] {
  const out: Endpoint[] = [];
  const seen = new Set<string>();

  for (const usage of usages) {
    const refFns = new Set(
      usage.refs.map(r => (r.includes("/") ? r.split("/").slice(1).join("/") : r)),
    );
    for (const ep of byDomain.get(usage.domain) ?? []) {
      if (!refFns.has(ep.fn)) continue;
      const key = `${ep.method} ${ep.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ep);
    }
  }

  return out.sort((a, b) => a.url.localeCompare(b.url));
}
