// runner ⇄ 浏览器 / Next 的消息契约。禁止 import node 内置模块。
import type {
  DiffFile,
  DiffSummary,
  FilePatch,
  PipelineRun,
  RunStatus,
  TimelineEvent,
} from "../domain/run";

export type { DiffFile, DiffSummary, FilePatch, PipelineRun, RunStatus, TimelineEvent };

/**
 * 服务端 → 客户端。所有类型共享同一单调 seq（按 run 递增），
 * attach 时按 lastSeq 补发全部类型。
 */
export type ServerEvent = (
  | { type: "output"; data: string; replay?: boolean }
  | { type: "status"; status: RunStatus; pid?: number | null; changedFiles?: number }
  | { type: "exit"; exitCode: number | null }
  | { type: "git"; changed: number }
  | { type: "timeline"; event: TimelineEvent }
  | { type: "error"; message: string }
) & { runId: string; seq: number };

/** attach 无 lastSeq 时的全量快照（输出回放走 256KB 环形缓冲） */
export interface SnapshotEvent {
  type: "snapshot";
  runId: string;
  seq: number;
  run: PipelineRun;
  /** 输出已滚出缓冲时为 true */
  truncated: boolean;
}

export type ServerMessage = ServerEvent | SnapshotEvent | { type: "pong" };

/**
 * 写事件时的入参：seq 由 emit 统一分配。
 * 直接对联合类型做 Omit 会把分支塌缩成公共字段，这里用分发形式保住各分支字段。
 */
export type ServerEventInput = ServerEvent extends infer T
  ? T extends { seq: number }
    ? Omit<T, "seq"> & { seq?: number }
    : never
  : never;

export type ClientMessage =
  | { type: "attach"; runId: string; lastSeq?: number }
  | { type: "detach"; runId: string }
  | { type: "input"; runId: string; data: string }
  | { type: "resize"; runId: string; cols: number; rows: number }
  | { type: "ping" };

// ---------- runner 内部 HTTP ----------

export interface StartRunRequest {
  taskId: string;
  repoRoot: string;
  repoKey: string;
  cols: number;
  rows: number;
  /** xiaoqian-manager 渲染好的计划文件内容，runner 落盘到 data/temp/<taskId>.md */
  planContent: string;
}

export interface StartRunResponse {
  run: PipelineRun;
}

export interface RepoStatusResponse {
  repoKey: string;
  status: "static" | "busy";
  runId: string | null;
}

export interface SettledCallback {
  ok: boolean;
  note: string;
  exitCode: number | null;
}

export interface TrajectoryCallback {
  operator: string;
  action: string;
  content: string;
}

export interface RunnerInfo {
  pid: number;
  port: number;
  httpUrl: string;
  wsUrl: string;
  token: string;
  startedAt: string;
}
