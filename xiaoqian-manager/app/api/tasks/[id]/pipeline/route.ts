import { NextResponse } from "next/server";
import { readTasks } from "@/lib/server/store";
import {
  MissingPlannedDescriptionError,
  PipelineBusyError,
  cancelPipeline,
  startPipeline,
} from "@/lib/server/pipeline/runner";
import { RepoResolveError } from "@/lib/runner/repo-resolve";
import { RunnerOfflineError } from "@/lib/server/runner-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 启动会话：前置定仓 + 仓库门禁 + runner 受理，立即返回（不等 claude 跑完）
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = readTasks().tasks.find((t) => t.id === id);
    if (!existing) {
      return NextResponse.json({ error: "task not found" }, { status: 404 });
    }
    const result = await startPipeline(existing);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

// 终止会话
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const run = await cancelPipeline(id);
    return NextResponse.json({ run });
  } catch (e) {
    return errorResponse(e);
  }
}

function errorResponse(e: unknown): NextResponse {
  if (e instanceof PipelineBusyError) {
    return NextResponse.json(
      { error: e.message, code: "repo_busy", occupant: e.occupant },
      { status: 409 }
    );
  }
  if (e instanceof MissingPlannedDescriptionError) {
    return NextResponse.json({ error: e.message, code: "missing_plan" }, { status: 422 });
  }
  if (e instanceof RepoResolveError) {
    return NextResponse.json(
      { error: e.message, code: "repo_resolve", details: e.details },
      { status: 422 }
    );
  }
  if (e instanceof RunnerOfflineError) {
    return NextResponse.json({ error: e.message, code: "runner_offline" }, { status: 503 });
  }
  const status = typeof (e as { status?: number })?.status === "number" ? (e as { status: number }).status : 500;
  return NextResponse.json(
    { error: e instanceof Error ? e.message : "unknown error" },
    { status }
  );
}
