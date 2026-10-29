"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FileCode2, Loader2, RefreshCw, TerminalSquare, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PipelineRun } from "@/lib/domain/run";
import { fmtDateTime } from "@/lib/ui/format";
import { RunStatusBadge } from "./run-status";

export interface TaskBrief {
  id: string;
  title: string;
  module: string;
}

const POLL_MS = 3000;

// 待审队列：只显示「已收口 + 有改动 + 未接受」的 run。
// 数据以 runner 为准，任务标题由服务端读 tasks.json 传入。

export default function ReviewQueue({ tasks }: { tasks: TaskBrief[] }) {
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch("/api/runs?status=review", { cache: "no-store" });
        const json = (await res.json()) as { online?: boolean; runs?: PipelineRun[]; error?: string };
        if (stopped) return;
        setOnline(Boolean(json.online));
        setRuns(json.runs ?? []);
        setError(json.error ?? "");
      } catch (e) {
        if (!stopped) {
          setOnline(false);
          setError(e instanceof Error ? e.message : "");
        }
      } finally {
        if (!stopped) {
          setLoading(false);
          timer = setTimeout(poll, POLL_MS);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [tick]);

  const taskMap = useMemo(() => {
    const map: Record<string, TaskBrief> = {};
    for (const t of tasks) map[t.id] = t;
    return map;
  }, [tasks]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">待审队列</h1>
        <span className="text-xs text-muted-foreground">{runs.length} 个待审</span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          title="刷新"
          onClick={() => {
            setLoading(true);
            setTick((n) => n + 1);
          }}
        >
          <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
        </Button>
      </div>

      {!online && (
        <div className="flex items-center gap-2 rounded-md border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <WifiOff className="h-3.5 w-3.5" />
          runner 未启动（<code className="font-mono">yarn runner</code>），队列暂不可用。
        </div>
      )}
      {error && online && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading && runs.length === 0 && (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
        </div>
      )}

      {!loading && runs.length === 0 && online && (
        <p className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          没有待审的流水线。已收口但未接受、且工作区有改动的会出现在这里。
        </p>
      )}

      <div className="flex flex-col gap-2">
        {runs.map((run) => {
          const task = taskMap[run.taskId];
          return (
            <div
              key={run.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-2"
            >
              <RunStatusBadge status={run.status} />
              <span className="min-w-0 flex-1 truncate text-sm">{task?.title ?? `任务 ${run.taskId}`}</span>
              <span className="truncate text-xs text-muted-foreground">{task?.module ?? ""}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {run.repoKey.split("/").pop()}
              </span>
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <FileCode2 className="h-3 w-3" />
                {run.changedFiles}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {run.endedAt ? `收口于 ${fmtDateTime(run.endedAt)}` : `开始于 ${fmtDateTime(run.startedAt)}`}
              </span>
              <Button asChild size="xs" variant="outline">
                <Link href={`/runs/${encodeURIComponent(run.id)}/review`}>审阅</Link>
              </Button>
              <Button asChild size="xs" variant="ghost">
                <Link href={`/runs/${encodeURIComponent(run.id)}`}>
                  <TerminalSquare className="h-3 w-3" />
                  会话
                </Link>
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
