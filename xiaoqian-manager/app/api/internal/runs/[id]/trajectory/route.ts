import { NextResponse } from "next/server";
import { appendTrajectory } from "@/lib/server/pipeline/settle";
import { verifyInternalToken } from "@/lib/server/runner-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// runner 回调：人工介入（驳回文件等）写入任务轨迹
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!verifyInternalToken(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  let body: { operator?: string; action?: string; content?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  try {
    const applied = await appendTrajectory(id, {
      operator: body.operator ?? "人工",
      action: body.action ?? "操作",
      content: body.content ?? "",
    });
    return NextResponse.json({ ok: true, applied });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 }
    );
  }
}
