"use client";

import { memo, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  CheckCircle2,
  ClipboardList,
  Code2,
  Loader2,
  Play,
  Rocket,
  XCircle,
} from "lucide-react";
import type { Stage } from "@/lib/domain/schema";
import { stageVisual } from "@/lib/domain/stage-visual";
import { Badge } from "@/components/ui/badge";
import { fmtDateTime } from "@/lib/ui/format";

export type StageNodeData = {
  stage: Stage;
  onOpen: (stage: Stage) => void;
  onStartPipeline?: () => void;
  /** 计划描述为空时禁用「写代码」▶，避免点下去才被 API 422 拦回 */
  startDisabled?: boolean;
};
export type StageNodeType = Node<StageNodeData, "stage">;

const ICONS = {
  planer: ClipboardList,
  coder: Code2,
  deploy: Rocket,
} as const;

function StageNode({ data }: NodeProps<StageNodeType>) {
  const { stage, onOpen, onStartPipeline, startDisabled } = data;
  const [starting, setStarting] = useState(false);
  const v = stageVisual(stage.status);
  const Icon = ICONS[stage.key];
  const canStart =
    stage.key === "coder" &&
    (stage.status === "pending" || stage.status === "failed") &&
    !!onStartPipeline;
  const blocked = !!startDisabled;

  const subtitle =
    stage.status === "done" && stage.finishedAt
      ? fmtDateTime(stage.finishedAt)
      : stage.status === "failed"
        ? stage.note || "流水线未完成"
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
      {stage.status === "failed" && (
        <XCircle className="absolute -right-2 -top-2 h-5 w-5 rounded-full bg-background text-destructive" />
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
          title={
            blocked
              ? "请先在「计划」节点填写并保存描述，再启动写代码"
              : "开始流水线：弹出新窗口跑 Claude Code（AI 规划 + 编码 + 审查 + 修复）"
          }
          disabled={starting || blocked}
          className={`absolute bottom-2 right-2 flex h-6 w-6 items-center justify-center rounded-full shadow-sm transition-opacity disabled:opacity-60 ${
            blocked
              ? "cursor-not-allowed bg-muted text-muted-foreground"
              : "bg-primary text-primary-foreground hover:opacity-85"
          }`}
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
