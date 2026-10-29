"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  CornerDownLeft,
  Loader2,
  Maximize2,
  RotateCcw,
  Square,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PipelineRun, RunStatus, TimelineEvent } from "@/lib/domain/run";
import type { ClientMessage, RunnerInfo, ServerMessage } from "@/lib/runner/protocol";
import { cn } from "@/lib/utils";
import DiffPanel from "./DiffPanel";
import Timeline from "./Timeline";
import TerminalPane, { type TerminalApi } from "./TerminalPane";
import { RunStatusBadge } from "./run-status";

// 会话页：左终端、右 diff。所有输出与状态都来自 runner 的 WS 推送，
// 断线后按 lastSeq 重连补发；时间线首屏走 GET /events（WS 不补发历史时间线）。

const LIVE_STATUSES: RunStatus[] = ["starting", "running", "needs_input", "settling"];

function isLive(status: RunStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

export default function SessionView({
  initialRun,
  taskTitle,
  taskModule,
  planPath,
}: {
  initialRun: PipelineRun;
  taskTitle: string;
  taskModule: string;
  planPath?: string;
}) {
  const router = useRouter();
  const runId = initialRun.id;
  const [run, setRun] = useState<PipelineRun>(initialRun);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [redoOpen, setRedoOpen] = useState(false);
  const [redoText, setRedoText] = useState("");
  const [busy, setBusy] = useState<"" | "accept" | "reject" | "redo" | "cancel">("");
  const [notice, setNotice] = useState("");
  const lastRejected = useRef<string[]>([]);

  const termApi = useRef<TerminalApi | null>(null);
  const pendingOutput = useRef("");
  const lastSeq = useRef<number | undefined>(undefined);
  const wsRef = useRef<WebSocket | null>(null);
  const lastStatus = useRef<RunStatus>(initialRun.status);

  // ---------- 首屏时间线 ----------
  useEffect(() => {
    let stopped = false;
    fetch(`/api/runs/${encodeURIComponent(runId)}/events`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json()) as { events?: TimelineEvent[] };
        if (!stopped && Array.isArray(json.events)) setEvents(json.events);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [runId]);

  // ---------- WS：连接 / 重连 / 补发 ----------
  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let attempt = 0;

    const send = (msg: ClientMessage) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    const applyMessage = (msg: ServerMessage) => {
      if ("seq" in msg && typeof msg.seq === "number") {
        lastSeq.current = Math.max(lastSeq.current ?? 0, msg.seq);
      }
      switch (msg.type) {
        case "snapshot": {
          setRun(msg.run);
          if (msg.truncated) {
            termApi.current?.reset();
          }
          return;
        }
        case "output": {
          const api = termApi.current;
          if (api) api.write(msg.data);
          else pendingOutput.current += msg.data;
          return;
        }
        case "status": {
          setRun((prev) => ({
            ...prev,
            status: msg.status,
            pid: msg.pid ?? prev.pid,
            changedFiles: msg.changedFiles ?? prev.changedFiles,
          }));
          return;
        }
        case "exit": {
          setRun((prev) => ({ ...prev, exitCode: msg.exitCode }));
          return;
        }
        case "git": {
          setRun((prev) => ({ ...prev, changedFiles: msg.changed }));
          setRefreshToken((n) => n + 1);
          return;
        }
        case "timeline": {
          const e = msg.event;
          setEvents((prev) => {
            const key = eventKey(e);
            if (prev.slice(-50).some((x) => eventKey(x) === key)) return prev;
            return [...prev, e];
          });
          if (e.type === "wait") {
            setRun((prev) => ({
              ...prev,
              status: e.status === "waiting" ? "needs_input" : "running",
            }));
          }
          return;
        }
        case "error": {
          setNotice(msg.message);
          return;
        }
        default:
          return;
      }
    };

    const connect = async () => {
      try {
        const res = await fetch("/api/runner/info", { cache: "no-store" });
        const info = (await res.json()) as RunnerInfo & { online?: boolean };
        if (closed) return;
        if (!info.online || !info.wsUrl || !info.token) {
          setOnline(false);
          setConnected(false);
          retryTimer = setTimeout(connect, 3000);
          return;
        }
        setOnline(true);
        ws = new WebSocket(`${info.wsUrl}?token=${encodeURIComponent(info.token)}`);
        wsRef.current = ws;

        ws.onopen = () => {
          if (closed) return;
          attempt = 0;
          setConnected(true);
          send({
            type: "attach",
            runId,
            lastSeq: lastSeq.current,
          });
          pingTimer = setInterval(() => send({ type: "ping" }), 25_000);
        };
        ws.onmessage = (ev: MessageEvent<string>) => {
          let msg: ServerMessage;
          try {
            msg = JSON.parse(ev.data) as ServerMessage;
          } catch {
            return;
          }
          if (msg.type === "pong") return;
          applyMessage(msg);
        };
        ws.onclose = () => {
          setConnected(false);
          if (pingTimer) clearInterval(pingTimer);
          pingTimer = null;
          if (closed) return;
          const delay = Math.min(10_000, 500 * 2 ** attempt);
          attempt += 1;
          retryTimer = setTimeout(connect, delay);
        };
        ws.onerror = () => {
          try {
            ws?.close();
          } catch {
            // ignore
          }
        };
      } catch {
        if (closed) return;
        setOnline(false);
        setConnected(false);
        retryTimer = setTimeout(connect, 3000);
      }
    };

    void connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (pingTimer) clearInterval(pingTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    };
  }, [runId]);

  // 进入终态后刷新一次服务端数据（任务轨迹由 settle 回调写回）
  useEffect(() => {
    const prev = lastStatus.current;
    lastStatus.current = run.status;
    if (prev !== run.status && !isLive(run.status) && isLive(prev)) {
      router.refresh();
    }
  }, [run.status, router]);

  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", runId, data } satisfies ClientMessage));
      return;
    }
    // WS 断开时退回 HTTP，输入不丢
    void fetch(`/api/runs/${encodeURIComponent(runId)}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data, submit: false }),
    }).catch(() => undefined);
  }, [runId]);

  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", runId, cols, rows } satisfies ClientMessage));
    }
  }, [runId]);

  const handleReady = useCallback((api: TerminalApi) => {
    termApi.current = api;
    if (pendingOutput.current) {
      api.write(pendingOutput.current);
      pendingOutput.current = "";
    }
  }, []);

  // ---------- 操作 ----------
  const act = async (kind: "accept" | "reject" | "redo" | "cancel") => {
    setNotice("");
    if (kind === "cancel" && !window.confirm("终止后本次会话的 PTY 会被杀掉，确定？")) return;
    if (kind === "reject" && selected.length === 0) return;
    setBusy(kind);
    try {
      let res: Response;
      if (kind === "accept") {
        res = await fetch(`/api/runs/${encodeURIComponent(runId)}/accept`, { method: "POST" });
      } else if (kind === "reject") {
        res = await fetch(`/api/runs/${encodeURIComponent(runId)}/reject`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paths: selected }),
        });
      } else if (kind === "redo") {
        res = await fetch(`/api/runs/${encodeURIComponent(runId)}/input`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: redoText }),
        });
      } else {
        res = await fetch(`/api/tasks/${encodeURIComponent(run.taskId)}/pipeline`, {
          method: "DELETE",
        });
      }
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        results?: { path: string; action: "deleted" | "restored" }[];
      };
      if (!res.ok) {
        setNotice(json.error ?? `操作失败（${res.status}）`);
        return;
      }
      if (kind === "accept") setNotice("已标记接受");
      if (kind === "reject") {
        lastRejected.current = selected;
        setNotice(`已驳回 ${json.results?.length ?? selected.length} 个文件`);
        setSelected([]);
        setRefreshToken((n) => n + 1);
      }
      if (kind === "redo") {
        setRedoText("");
        setRedoOpen(false);
        setNotice("已发送给会话");
      }
      if (kind === "cancel") {
        setNotice("已终止");
      }
      router.refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy("");
    }
  };

  const live = isLive(run.status);
  // 已收口但进程还在（claude 常驻交互）时也允许终止，否则这个任务无法重跑
  const canCancel = live || run.pid !== null;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-[560px] flex-col gap-2 p-3">
      {/* 头部 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button asChild variant="ghost" size="sm">
          <Link href="/">
            <CornerDownLeft className="h-3.5 w-3.5" />
            返回
          </Link>
        </Button>
        <span className="truncate text-sm font-medium" title={taskTitle}>
          {taskTitle}
        </span>
        <span className="truncate text-xs text-muted-foreground">{taskModule}</span>
        <RunStatusBadge status={run.status} />
        {live && (
          <span
            className={cn(
              "inline-flex items-center gap-1 text-xs",
              connected ? "text-muted-foreground" : "text-amber-600"
            )}
            title={connected ? "WS 已连接" : "WS 断开，正在重连"}
          >
            {!online ? (
              <>
                <WifiOff className="h-3 w-3" /> runner 离线
              </>
            ) : connected ? (
              <>已连接</>
            ) : (
              <>
                <Loader2 className="h-3 w-3 animate-spin" /> 重连中
              </>
            )}
          </span>
        )}
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {run.repoKey.split("/").pop()} @ {run.baseSha.slice(0, 8)}
        </span>
        {planPath && (
          <span className="truncate text-[11px] text-muted-foreground" title={planPath}>
            计划：{planPath}
          </span>
        )}
      </div>

      <Timeline events={events} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />

      {notice && (
        <div className="rounded-md border border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          {notice}
        </div>
      )}

      {/* 主体：终端 + diff */}
      <div className="grid min-h-0 flex-1 gap-2 grid-rows-[minmax(300px,1fr)_minmax(260px,1fr)] lg:grid-cols-[minmax(0,1fr)_420px] lg:grid-rows-1">
        <div className="min-h-0">
          <TerminalPane onData={sendInput} onResize={sendResize} onReady={handleReady} />
        </div>
        <DiffPanel
          runId={runId}
          refreshToken={refreshToken}
          selected={selected}
          onSelectedChange={setSelected}
          className="min-h-0"
        />
      </div>

      {/* 操作条 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2">
        <Button asChild variant="outline" size="sm">
          <Link href={`/runs/${encodeURIComponent(runId)}/review`}>
            <Maximize2 className="h-3.5 w-3.5" />
            全屏审阅
          </Link>
        </Button>

        <Button
          size="sm"
          variant="outline"
          disabled={busy !== "" || run.status === "cancelled"}
          onClick={() => void act("accept")}
          title="仅记录接受标记，不改工作区"
        >
          {busy === "accept" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          接受
        </Button>

        <Button
          size="sm"
          variant="destructive"
          disabled={busy !== "" || selected.length === 0}
          onClick={() => void act("reject")}
          title="把选中文件恢复到 baseSha，不动其他改动"
        >
          驳回{selected.length > 0 ? ` ${selected.length}` : ""}
        </Button>

        <Button
          size="sm"
          variant="secondary"
          disabled={busy !== "" || !live}
          onClick={() => {
            const next = !redoOpen;
            setRedoOpen(next);
            // 刚驳回过：把路径带进提示，省得用户再抄一遍
            if (next && !redoText && lastRejected.current.length > 0) {
              setRedoText(
                `以下文件已驳回：${lastRejected.current.join("、")}。请只重做这些文件，不要动其他改动。`
              );
            }
          }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          要求重做
        </Button>

        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-destructive"
          disabled={busy !== "" || !canCancel}
          onClick={() => void act("cancel")}
        >
          {busy === "cancel" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
          终止
        </Button>
      </div>

      {redoOpen && (
        <div className="rounded-lg border bg-card p-2">
          <textarea
            className="h-20 w-full resize-none rounded-md border bg-background p-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="输入给会话的指令，回车提交后会直接写入终端（例如：先只改 README，不要动业务代码）"
            value={redoText}
            onChange={(e) => setRedoText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (redoText.trim() && busy === "") void act("redo");
              }
            }}
          />
          <div className="mt-1 flex items-center justify-end gap-2">
            <span className="mr-auto text-[11px] text-muted-foreground">Ctrl/⌘ + Enter 发送</span>
            <Button variant="ghost" size="sm" onClick={() => setRedoOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={busy !== "" || redoText.trim() === ""}
              onClick={() => void act("redo")}
            >
              {busy === "redo" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              发送
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function eventKey(e: TimelineEvent): string {
  return [e.ts, e.type, e.stage ?? "", e.name ?? "", e.status ?? "", e.path ?? "", e.message ?? ""].join("|");
}
