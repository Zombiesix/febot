"use client";

import { memo, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  CheckCircle2,
  ClipboardList,
  Code2,
  FlaskConical,
  Loader2,
  Play,
  Rocket,
} from "lucide-react";
import type { Stage } from "@/lib/domain/schema";
import { stageVisual } from "@/lib/domain/stage-visual";
import { Badge } from "@/components/ui/badge";
import { fmtDateTime } from "@/lib/ui/format";

export type StageNodeData = {
  stage: Stage;
  onOpen: (stage: Stage) => void;
  onStartPipeline?: () => void;
};
export type StageNodeType = Node<StageNodeData, "stage">;

const ICONS = {
  planer: ClipboardList,
  coder: Code2,
  test: FlaskConical,
  deploy: Rocket,
} as const;

function StageNode({ data }: NodeProps<StageNodeType>) {
  const { stage, onOpen, onStartPipeline } = data;
  const [starting, setStarting] = useState(false);
  const v = stageVisual(stage.status);
  const Icon = ICONS[stage.key];
  const canStart =
    stage.key === "planer" && stage.status === "pending" && !!onStartPipeline;

  const subtitle =
    stage.status === "done" && stage.finishedAt
      ? fmtDateTime(stage.finishedAt)
      : stage.owner || "未指派";

  return (
    <div
      className={`relative h-[92px] w-[220px] cursor-pointer select-none rounded-xl border bg-card shadow-sm transition-colors ${v.card}`}
      onClick={() => onOpen(stage)}
    >
      <div className={`absolute inset-x-0 top-0 h-[3px] rounded-t-xl bg-gradient-to-r ${v.bar}`} />
      {stage.status === "done" && (
        <CheckCircle2 className="absolute -right-2 -top-2 h-5 w-5 rounded-full bg-background text-primary" />
      )}
      {stage.status === "active" && (
        <span className="absolute right-3 top-3 flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
      )}
      <div className="flex h-full items-center gap-3 px-4 pt-[3px]">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${v.icon}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className={`truncate text-sm font-medium ${v.text}`}>{stage.name}</div>
          <div className="truncate text-xs tabular-nums text-muted-foreground">{subtitle}</div>
          <div className="mt-1">
            <Badge variant={v.badge} className="px-1.5 py-0 text-[10px]">
              {v.badgeLabel}
            </Badge>
          </div>
        </div>
      </div>
      {canStart && (
        <button
          type="button"
          title="开始流水线：弹出新窗口跑 Claude Code（计划+写代码）"
          disabled={starting}
          className="absolute bottom-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-opacity hover:opacity-85 disabled:opacity-60"
          onClick={(e) => {
            e.stopPropagation();
            if (!onStartPipeline || starting) return;
            setStarting(true);
            try {
              onStartPipeline();
            } finally {
              setStarting(false);
            }
          }}
        >
          {starting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
        </button>
      )}
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: "var(--muted-foreground)", opacity: 0.5, border: "none" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: "var(--muted-foreground)", opacity: 0.5, border: "none" }}
      />
    </div>
  );
}

export default memo(StageNode);
