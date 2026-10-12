import { NextResponse } from "next/server";
import { readTasks } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { tasks } = readTasks();
    const task = tasks.find((t) => t.id === id);
    if (!task) {
      return NextResponse.json({ error: "task not found" }, { status: 404 });
    }
    return NextResponse.json({ task });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 }
    );
  }
}
