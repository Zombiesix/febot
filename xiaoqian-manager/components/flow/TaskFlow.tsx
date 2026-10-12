"use client";

import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Stage } from "@/lib/domain/schema";
import { STAGE_EDGES } from "@/lib/domain/stage-visual";
import StageNode from "./StageNode";

const nodeTypes = { stage: StageNode };
const NODE_W = 260;

export default function TaskFlow({
  stages,
  onOpen,
  onStartPipeline,
}: {
  stages: Stage[];
  onOpen: (s: Stage) => void;
  onStartPipeline?: () => void;
}) {
  const nodes = useMemo<Node[]>(
    () =>
      stages.map((s, i) => ({
        id: s.key,
        type: "stage",
        position: { x: i * NODE_W, y: 0 },
        data: { stage: s, onOpen, onStartPipeline },
        draggable: false,
        connectable: false,
      })),
    [stages, onOpen, onStartPipeline]
  );

  const edges = useMemo<Edge[]>(
    () =>
      STAGE_EDGES.map((e) => {
        const source = stages.find((s) => s.key === e.source);
        const target = stages.find((s) => s.key === e.target);
        const reached = source?.status === "done";
        const flowing = source?.status === "active" || target?.status === "active";
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "smoothstep",
          animated: flowing,
          style: reached
            ? { stroke: "var(--primary)", strokeWidth: 1.5 }
            : {
                stroke: "var(--muted-foreground)",
                strokeWidth: 1.25,
                strokeDasharray: "4 3",
                opacity: 0.5,
              },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: reached ? "var(--primary)" : "var(--muted-foreground)",
            width: 18,
            height: 18,
          },
        };
      }),
    [stages]
  );

  return (
    <div className="h-[180px] w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.4}
        maxZoom={1.25}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: false }}
        colorMode="system"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
