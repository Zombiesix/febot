"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, CornerDownLeft, Loader2, SquareCheckBig, SquareX } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DiffSummary, PipelineRun } from "@/lib/domain/run";
import DiffPanel from "./DiffPanel";
import { RunStatusBadge } from "./run-status";

// 全屏审阅：diff 占满页面，批量勾选后一次驳回或接受。
// 驳回是逐文件复原到 baseSha，不会碰其他改动；接受只记标记。

export default function ReviewView({
  initialRun,
  taskTitle,
  taskModule,
}: {
  initialRun: PipelineRun;
  taskTitle: string;
  taskModule: string;
}) {
  const router = useRouter();
  const runId = initialRun.id;
  const [run, setRun] = useState(initialRun);
  const [selected, setSelected] = useState<string[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [busy, setBusy] = useState<"" | "accept" | "reject">("");
  const [notice, setNotice] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [accepted, setAccepted] = useState(Boolean(initialRun.acceptedAt));

  // 只用文件列表做「全选」，patch 仍由 DiffPanel 懒加载
  useEffect(() => {
    let stopped = false;
    fetch(`/api/runs/${encodeURIComponent(runId)}/diff`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<DiffSummary>) : null))
      .then((json) => {
        if (!stopped && json) setFiles(json.files.map((f) => f.path));
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [runId, refreshToken]);

  const act = useCallback(
    async (kind: "accept" | "reject") => {
      if (kind === "reject" && selected.length === 0) return;
      if (
        kind === "reject" &&
        !window.confirm(`确定驳回 ${selected.length} 个文件？它们会被还原到 ${initialRun.baseSha.slice(0, 8)}。`)
      ) {
        return;
      }
      setBusy(kind);
      setNotice("");
      try {
        const res = await fetch(
          kind === "accept"
            ? `/api/runs/${encodeURIComponent(runId)}/accept`
            : `/api/runs/${encodeURIComponent(runId)}/reject`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: kind === "reject" ? JSON.stringify({ paths: selected }) : undefined,
          }
        );
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
          run?: PipelineRun;
          results?: { path: string; action: "deleted" | "restored" }[];
        };
        if (!res.ok) {
          setNotice(json.error ?? `操作失败（${res.status}）`);
          return;
        }
        if (kind === "accept") {
          if (json.run) setRun(json.run);
          setAccepted(true);
          setNotice("已标记接受");
        } else {
          setNotice(`已驳回 ${json.results?.length ?? selected.length} 个文件`);
          setSelected([]);
          setRefreshToken((n) => n + 1);
        }
        router.refresh();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "操作失败");
      } finally {
        setBusy("");
      }
    },
    [initialRun.baseSha, router, runId, selected]
  );

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-[520px] flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/runs/${encodeURIComponent(runId)}`}>
            <CornerDownLeft className="h-3.5 w-3.5" />
            返回会话
          </Link>
        </Button>
        <span className="truncate text-sm font-medium">{taskTitle}</span>
        <span className="truncate text-xs text-muted-foreground">{taskModule}</span>
        <RunStatusBadge status={run.status} />
        {accepted && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
            <Check className="h-3 w-3" /> 已接受
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          base {run.baseSha.slice(0, 8)} · {files.length} 个文件
        </span>
        <Button
          variant="outline"
          size="xs"
          onClick={() => setSelected(files)}
          disabled={files.length === 0}
        >
          <SquareCheckBig className="h-3 w-3" />
          全选
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setSelected([])}
          disabled={selected.length === 0}
        >
          <SquareX className="h-3 w-3" />
          清空
        </Button>
      </div>

      {notice && (
        <div className="rounded-md border border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          {notice}
        </div>
      )}

      <DiffPanel
        runId={runId}
        refreshToken={refreshToken}
        selected={selected}
        onSelectedChange={setSelected}
        className="min-h-0 flex-1"
      />

      <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
        <span className="text-xs text-muted-foreground">
          已选 {selected.length} / {files.length}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={busy !== "" || run.status === "cancelled"}
          onClick={() => void act("accept")}
        >
          {busy === "accept" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          接受全部改动
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy !== "" || selected.length === 0}
          onClick={() => void act("reject")}
        >
          {busy === "reject" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          驳回选中（{selected.length}）
        </Button>
      </div>
    </div>
  );
}
