import { NextResponse } from "next/server";
import { readTasks } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
    const moduleFilter = url.searchParams.get("module")?.trim() ?? "";
    const data = readTasks();
    let tasks = data.tasks;
    const updatedAt = data.updatedAt;
    if (q) {
      tasks = tasks.filter((t) =>
        `${t.title} ${t.id} ${t.module}`.toLowerCase().includes(q)
      );
    }
    if (moduleFilter) {
      tasks = tasks.filter((t) => t.module === moduleFilter);
    }
    // 列表不返回 trajectory（体积大），展开时走 /api/tasks/[id]
    const list = tasks.map(
      ({ trajectory: _traj, description: _desc, assignDescription: _ad, attachments: _at, ...rest }) => rest
    );
    return NextResponse.json({ tasks: list, updatedAt });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 }
    );
  }
}
