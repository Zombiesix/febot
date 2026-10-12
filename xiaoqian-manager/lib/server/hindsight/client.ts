// 服务端专用：xiaoqian-manager 侧 Hindsight 记忆客户端（软降级）。
// 只从服务端调用（读 process.env + node fetch）；浏览器端严禁 import 本文件。
//
// 软降级：Hindsight 未起 / 无网络 / 接口异常 / 响应异常 → 一律返回空结果，
// 绝不让记忆问题拖垮主流程。调用方据此"拿不到就不展示/就不写"。
//
// 接口地址已对照 OpenAPI 实测验证（2026-10-08）。

const BASE_URL =
  process.env.HINDSIGHT_URL?.replace(/\/$/, "") || "http://localhost:8888";

const API_PREFIX = "/v1/default/banks";

const ENDPOINTS: Record<string, (bank: string) => string> = {
  recall: (b) => `${API_PREFIX}/${b}/memories/recall`,
  retain: (b) => `${API_PREFIX}/${b}/memories`,
  reflect: (b) => `${API_PREFIX}/${b}/reflect`,
};

const TIMEOUT_MS = 8000;

export interface RecallHit {
  content?: string;
  context?: string;
  [k: string]: unknown;
}

type Method = "recall" | "retain" | "reflect";

async function call(method: Method, bank: string, body: unknown): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE_URL + ENDPOINTS[method](encodeURIComponent(bank)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.trim() ? JSON.parse(text) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function recall(
  bank: string,
  query: string,
  budget: "low" | "mid" | "high" = "low"
): Promise<RecallHit[]> {
  const r = await call("recall", bank, { query, budget });
  // 实测响应结构为 { results: [...], entities: {...} }
  if (r && typeof r === "object" && Array.isArray((r as { results?: unknown }).results)) {
    return (r as { results: RecallHit[] }).results;
  }
  return [];
}

export async function retain(
  bank: string,
  content: string,
  context = ""
): Promise<boolean> {
  const item: Record<string, string> = { content };
  if (context) item.context = context;
  const r = await call("retain", bank, { items: [item] });
  return r !== null;
}

export async function reflect(bank: string, query: string): Promise<unknown> {
  return call("reflect", bank, { query });
}