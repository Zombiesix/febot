import type { PipelineRun, Task } from "@/lib/domain/schema";
import { updateTask } from "@/lib/server/store";
import {
  RunnerOfflineError,
  readRunnerInfo,
  runnerFetch,
} from "@/lib/server/runner-client";
import { repoKeyOf, resolveTargetRepo } from "@/lib/runner/repo-resolve";
import type {
  RepoStatusResponse,
  StartRunResponse,
} from "@/lib/runner/protocol";

// 「写代码」节点的 ▶：在 runner 的 PTY 里跑交互式 claude `/pipeline <任务ID>`。
//
// 启动链路（拒绝模型，全程不排队）：
//   ① 前置定仓：调 febot scripts/resolve-repo.mjs（与剧本同源），未命中直接拒绝；
//   ② 前置门禁：runner 查仓库状态注册表，busy 直接 409；
//   ③ runner POST /runs 原子受理并起 PTY；
//   ④ 本地任务只把 coder 置 active；收口由 runner 回调 /api/internal 完成。
//
// app 不再做工作区干净检查（归剧本开工门禁），也不再 spawn 外部窗口。

export class PipelineBusyError extends Error {
  occupant: string;
  constructor(occupant: string) {
    super(`仓库正被 #${occupant} 占用`);
    this.name = "PipelineBusyError";
    this.occupant = occupant;
  }
}

// 严格必填：没有「计划」节点整理过的描述就不允许开跑，源头上不生成 `（空）` 计划文件。
export class MissingPlannedDescriptionError extends Error {
  constructor() {
    super("计划描述为空：请先在「计划」节点填写并保存描述，再启动写代码");
    this.name = "MissingPlannedDescriptionError";
  }
}

function fmtLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// 字段格式对齐 pipeline-feed 的抽取契约：首行 `# ` 标题 + 元信息行 + 问题描述/分配任务说明
export function renderPlanFile(task: Task): string {
  const title = task.title.trim();
  if (!title) throw new Error("任务标题为空，无法生成计划文件");
  // 只认研发人员在「计划」节点整理后的描述；不回退平台原文，也不写占位符。
  const description = task.plannedDescription.trim();
  if (!description) throw new MissingPlannedDescriptionError();

  const alias = `R-${task.id.slice(-6)}`;
  const meta = [
    `任务ID: ${task.id}`,
    `查询ID: ${task.demandId}`,
    `别名: ${alias}`,
    `产品/模块: ${task.module}`,
    `版本: ${task.version}`,
    `状态: ${task.twStatus}`,
    `难度: ${task.demandLevel}`,
    `任务类型: ${task.taskType}`,
    `最大工时: ${task.maxHour ?? ""}`,
    `执行人: ${task.assignee}`,
    `创建人: ${task.createdName}`,
  ]
    .filter((l) => !l.endsWith(": "))
    .join("\n");
  return `# ${title}\n\n${meta}\n\n## 问题描述\n\n${description}\n\n## 分配任务说明\n\n${task.assignDescription.trim()}\n`;
}

export interface StartPipelineResult {
  task: Task;
  run: PipelineRun;
  repo: { repo: string; repoRoot: string; branch: string };
}

export async function startPipeline(task: Task): Promise<StartPipelineResult> {
  // 先渲染：标题/描述校验失败时，仓库与任务状态都不动
  const planContent = renderPlanFile(task);

  // ① 前置定仓
  const resolved = resolveTargetRepo(task);
  const repoKey = repoKeyOf(resolved.repoRoot);

  if (!readRunnerInfo()) throw new RunnerOfflineError();

  // ② 前置门禁（快速失败；真正的原子受理在 runner 的 POST /runs）
  const repoState = await runnerFetch<RepoStatusResponse>(
    `/repos?key=${encodeURIComponent(repoKey)}`
  );
  if (repoState.status === "busy" && repoState.runId) {
    throw new PipelineBusyError(repoState.runId);
  }

  // ③ 原子受理
  let response: StartRunResponse;
  try {
    response = await runnerFetch<StartRunResponse>("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: task.id,
        repoRoot: resolved.repoRoot,
        repoKey,
        cols: 120,
        rows: 32,
        planContent,
      }),
      timeoutMs: 60_000,
    });
  } catch (e) {
    if (isConflict(e)) {
      const occupant = readOccupant(e) ?? "unknown";
      throw new PipelineBusyError(occupant);
    }
    throw e;
  }

  // ④ 本地任务只动 coder；planer 的状态由人工决定，这里不替用户收口
  const now = new Date().toISOString();
  const active = await updateTask(task.id, (t) => ({
    ...t,
    stages: t.stages.map((s) => {
      if (s.key === "coder") {
        return {
          ...s,
          status: "active",
          startedAt: s.startedAt ?? now,
          finishedAt: null,
          note: "",
        };
      }
      return s;
    }),
    trajectory: [
      ...t.trajectory,
      {
        time: fmtLocal(new Date()),
        operator: "系统",
        action: "启动流水线",
        content: `/pipeline ${task.id} · ${resolved.repo}（${resolved.branch || "基准分支未知"}）`,
      },
    ],
  }));
  if (!active) throw new Error(`task not found: ${task.id}`);

  return {
    task: active,
    run: response.run,
    repo: { repo: resolved.repo, repoRoot: resolved.repoRoot, branch: resolved.branch },
  };
}

export async function cancelPipeline(taskId: string): Promise<PipelineRun> {
  const response = await runnerFetch<{ run: PipelineRun }>(
    `/runs/${encodeURIComponent(taskId)}`,
    { method: "DELETE" }
  );
  return response.run;
}

export async function getRun(taskId: string): Promise<PipelineRun | null> {
  try {
    const response = await runnerFetch<{ run: PipelineRun }>(
      `/runs/${encodeURIComponent(taskId)}`
    );
    return response.run;
  } catch {
    return null;
  }
}

function isConflict(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { status?: number }).status === 409);
}

function readOccupant(e: unknown): string | null {
  const payload = (e as { payload?: unknown }).payload;
  if (payload && typeof payload === "object" && "occupant" in payload) {
    const v = (payload as { occupant?: unknown }).occupant;
    return typeof v === "string" ? v : null;
  }
  return null;
}
