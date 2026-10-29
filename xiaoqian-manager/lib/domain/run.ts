// 流水线会话（run）领域类型。前后端共享，禁止 import node 内置模块。
//
// run 与 task 一一对应，id 直接复用 taskId；一个 run 代表一次 `/pipeline` 会话。
// 状态机：starting → running ⇄ needs_input → (done | failed | cancelled)

export const RUN_STATUSES = [
  "starting",
  "running",
  "needs_input",
  "settling",
  "done",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: RunStatus[] = ["done", "failed", "cancelled"];

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export interface PipelineRun {
  /** 直接复用 taskId（同仓库内唯一） */
  id: string;
  taskId: string;
  /** 前置定仓解析出的目标仓（与剧本「定仓」同源） */
  repoRoot: string;
  /** 规范化键：realpath + 小写 + 正斜杠 */
  repoKey: string;
  /** 启动时目标仓 HEAD，diff 的基准 */
  baseSha: string;
  status: RunStatus;
  /** PTY 子进程 pid（排查用） */
  pid: number | null;
  cols: number;
  rows: number;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  error: string | null;
  /** 结构化事件文件绝对路径（advance.mjs 经 XQ_EVENTS_FILE 代写） */
  eventsFile: string;
  /** 最近一次 git 变更文件数（runner 监听工作区后更新） */
  changedFiles: number;
  /** 人工「接受」标记时间；只标记，不改工作区 */
  acceptedAt: string | null;
  /** runner 已把结果回调给 Next 的时间 */
  settledAt: string | null;
  /** 兜底超时时间（ISO） */
  timeoutAt: string | null;
}

export type TimelineEventType =
  | "stage"
  | "step"
  | "file"
  | "wait"
  | "notice"
  | "done"
  | "error";

export interface TimelineEvent {
  /** schema 版本 */
  v: number;
  ts: string;
  type: TimelineEventType;
  /** planer | coder | ... */
  stage?: string;
  /** 步骤 / 等待点名称 */
  name?: string;
  status?: "start" | "done" | "failed" | "waiting";
  /** type=file */
  path?: string;
  action?: "edit" | "create" | "delete";
  /** wait 操作人 */
  by?: string;
  message?: string;
}

export interface DiffFile {
  path: string;
  /** 重命名后的旧路径 */
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  additions: number;
  deletions: number;
  binary: boolean;
  /** > 2MB 不返回内容 */
  tooLarge: boolean;
}

export interface DiffSummary {
  baseSha: string;
  files: DiffFile[];
}

export interface FilePatch {
  path: string;
  patch: string;
  binary: boolean;
  tooLarge: boolean;
  /** runner 侧提示（如未跟踪文件的合成 patch） */
  note?: string;
}

/**
 * 任务 → 需求别名：R- + taskId 后 6 位。
 * 计划文件里的「别名」行与 feed 的解析都以此为准，两侧必须一致。
 */
export function aliasOfTask(taskId: string): string {
  return `R-${taskId.slice(-6)}`;
}

