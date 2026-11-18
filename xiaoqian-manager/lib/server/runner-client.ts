import fs from "node:fs";
import path from "node:path";
import type { RunnerInfo } from "@/lib/runner/protocol";
import { DATA_DIR } from "@/lib/server/workspace";

// Next 访问 runner 的唯一入口。Next 不 import 任何 PTY / node-pty 模块，
// 只通过 127.0.0.1 上的 HTTP 通信，保证 Next 重启不影响会话。

const INFO_FILE = path.join(DATA_DIR, "runner.json");

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
  constructor(detail?: string) {
    super(
      (detail
        ? `runner 连接中断（${detail}）：runner.json 存在，但连接被拒绝或重置，进程可能已退出。`
        : "runner 未启动（原因：会话、diff 与历史记录都由独立 runner 进程提供，Next 进程不承载 PTY）。") +
        "下一步：在项目根目录另开一个终端执行 yarn runner，然后重试。"
    );
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
  } catch (e) {
    // 区分「没启动」与「连不上」：ECONNRESET / ECONNREFUSED 等底层错误码带出来，
    // 否则一律被当成 runner 未启动，排查方向会被带偏。
    const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
    throw new RunnerOfflineError(cause?.code ?? cause?.message);
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
