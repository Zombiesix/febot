import fs from "node:fs";
import path from "node:path";
import type { RunnerInfo } from "@/lib/runner/protocol";

// Next 访问 runner 的唯一入口。Next 不 import 任何 PTY / node-pty 模块，
// 只通过 127.0.0.1 上的 HTTP 通信，保证 Next 重启不影响会话。

const INFO_FILE = path.join(process.cwd(), "data", "runner.json");

export function readRunnerInfo(): RunnerInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(INFO_FILE, "utf8")) as RunnerInfo;
    if (!raw?.httpUrl || !raw?.token) return null;
    return raw;
  } catch {
    return null;
  }
}

export class RunnerOfflineError extends Error {
  constructor() {
    super("runner 未运行：请先执行 yarn runner（独立进程，不要挂在 yarn dev 上）");
    this.name = "RunnerOfflineError";
  }
}

export interface RunnerFetchOptions extends Omit<RequestInit, "signal"> {
  timeoutMs?: number;
}

export async function runnerFetch<T>(
  pathname: string,
  options: RunnerFetchOptions = {}
): Promise<T> {
  const info = readRunnerInfo();
  if (!info) throw new RunnerOfflineError();
  const { timeoutMs = 30_000, ...init } = options;
  let res: Response;
  try {
    res = await fetch(`${info.httpUrl}${pathname}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RunnerOfflineError();
  }
  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `runner 返回 ${res.status}`;
    const err = new Error(message) as Error & { status?: number; payload?: unknown };
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload as T;
}

export async function isRunnerOnline(): Promise<boolean> {
  const info = readRunnerInfo();
  if (!info) return false;
  try {
    const res = await fetch(`${info.httpUrl}/healthz`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** runner 回调 Next 的内部接口鉴权：token 来自 runner 自己写的 data/runner.json */
export function verifyInternalToken(req: Request): boolean {
  const info = readRunnerInfo();
  if (!info) return false;
  return req.headers.get("x-internal-token") === info.token;
}
