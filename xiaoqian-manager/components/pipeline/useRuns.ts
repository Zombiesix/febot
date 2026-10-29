"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PipelineRun, RunStatus } from "@/lib/domain/run";

// 任务列表的 run 汇总：轮询保持简单（列表页对 500ms 不敏感），
// 会话页走 WS 推送。runner 未启动时返回 online:false，不阻塞任务管理。

export const ATTENTION_WEIGHT: Record<RunStatus, number> = {
  needs_input: 0,
  failed: 1,
  running: 2,
  starting: 3,
  done: 4,
  cancelled: 4,
  settling: 4,
};

/** 没有 run 的任务排在所有 run 之后 */
export const NO_RUN_WEIGHT = 9;

const POLL_MS = 2000;

export interface RunsState {
  online: boolean;
  runs: PipelineRun[];
  byTask: Record<string, PipelineRun>;
  refresh: () => void;
}

export function useRuns(): RunsState {
  const [online, setOnline] = useState(true);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [tick, setTick] = useState(0);
  const notified = useRef(new Set<string>());
  const originalTitle = useRef<string>("");

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch("/api/runs", { cache: "no-store" });
        const json = (await res.json()) as { online?: boolean; runs?: PipelineRun[] };
        if (stopped) return;
        setOnline(Boolean(json.online));
        setRuns(json.runs ?? []);
      } catch {
        if (!stopped) setOnline(false);
      } finally {
        if (!stopped) timer = setTimeout(poll, POLL_MS);
      }
    };
    void poll();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [tick]);

  // 注意力通知：只对 needs_input / failed，按 runId+status 去重；
  // 离开该状态时清除去重键（回落后再次进入可重新通知）。
  useEffect(() => {
    if (!originalTitle.current) originalTitle.current = document.title;
    const pending = runs.filter((r) => r.status === "needs_input").length;
    document.title = pending > 0 ? `(${pending}) ${originalTitle.current}` : originalTitle.current;

    for (const run of runs) {
      if (run.status === "needs_input" || run.status === "failed") {
        const key = `${run.id}:${run.status}`;
        // 清掉该 run 的其他状态键
        for (const k of notified.current) {
          if (k.startsWith(`${run.id}:`) && k !== key) notified.current.delete(k);
        }
        if (!notified.current.has(key)) {
          notified.current.add(key);
          notify(run);
        }
      } else {
        for (const k of notified.current) {
          if (k.startsWith(`${run.id}:`)) notified.current.delete(k);
        }
      }
    }
  }, [runs]);

  useEffect(() => {
    return () => {
      if (originalTitle.current) document.title = originalTitle.current;
    };
  }, []);

  const byTask = useMemo(() => {
    const map: Record<string, PipelineRun> = {};
    for (const run of runs) map[run.taskId] = run;
    return map;
  }, [runs]);

  return { online, runs, byTask, refresh };
}

function notify(run: PipelineRun): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    const title =
      run.status === "needs_input" ? "流水线需要你处理" : "流水线失败";
    const body =
      run.status === "needs_input"
        ? `#${run.taskId} 在等待人工决策`
        : `#${run.taskId}：${run.error ?? "未产出完成标记"}`;
    const n = new Notification(title, { body, tag: `${run.id}:${run.status}` });
    n.onclick = () => {
      window.focus();
      window.open(`/runs/${run.id}`, "_self");
    };
  } catch {
    // 通知失败不影响页面
  }
}

/** 浏览器通知需要用户手势触发，启动流水线时调用一次 */
export function requestNotificationPermission(): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission === "default") {
    void Notification.requestPermission().catch(() => undefined);
  }
}
