"use client";

import { useMemo } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, Circle, Clock, XCircle } from "lucide-react";
import type { TimelineEvent } from "@/lib/domain/run";
import { cn } from "@/lib/utils";

// 步骤时间线：数据只来自事件流（advance.mjs 代写），不解析终端输出。

function labelOf(e: TimelineEvent): string {
  switch (e.type) {
    case "stage":
      return `${e.stage ?? "阶段"}${e.status === "done" ? " 完成" : " 开始"}`;
    case "step":
      return e.name ?? "步骤";
    case "wait":
      return `${e.status === "waiting" ? "等待" : "已处理"}：${e.name ?? "人工"}`;
    case "file":
      return e.path ?? "文件";
    case "notice":
      return e.message || e.name || "提示";
    case "done":
      return "流水线完成";
    case "error":
      return e.message || "异常";
    default:
      return e.type;
  }
}

function iconOf(e: TimelineEvent) {
  if (e.type === "done" || e.status === "done") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />;
  if (e.type === "error" || e.status === "failed") return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  if (e.status === "waiting") return <Clock className="h-3.5 w-3.5 text-amber-600" />;
  return <Circle className="h-3 w-3 text-muted-foreground/60" />;
}

export default function Timeline({
  events,
  expanded,
  onToggle,
}: {
  events: TimelineEvent[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const recent = useMemo(() => events.slice(-40), [events]);
  const visible = expanded ? recent : recent.slice(-8);

  return (
    <div className={cn("rounded-lg border bg-card", expanded ? "p-3" : "px-3 py-1.5")}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">时间线</span>
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3 overflow-hidden",
            expanded ? "flex-wrap gap-y-1" : "whitespace-nowrap"
          )}
        >
          {visible.length === 0 && (
            <span className="text-xs text-muted-foreground/70">暂无事件（等待剧本写入）</span>
          )}
          {visible.map((e, i) => (
            <span
              key={`${e.ts}-${i}-${e.type}`}
              className="inline-flex max-w-[240px] shrink-0 items-center gap-1 text-xs text-muted-foreground"
              title={`${e.ts} ${e.type}${e.message ? ` · ${e.message}` : ""}`}
            >
              {iconOf(e)}
              <span className="truncate">{labelOf(e)}</span>
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {expanded ? "收起" : "展开"}
        </button>
      </div>
    </div>
  );
}
