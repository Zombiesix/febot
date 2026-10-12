import { NextResponse } from "next/server";
import { readTasks } from "@/lib/server/store";
import { PipelineBusyError, startPipeline } from "@/lib/server/pipeline/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 计划节点「开始」：弹终端窗口跑 `claude "/pipeline <id>"`，立即返回（不等 claude 跑完）
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
    const task = await startPipeline(existing);
    return NextResponse.json({ task });
  } catch (e) {
    if (e instanceof PipelineBusyError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 }
    );
  }
}
