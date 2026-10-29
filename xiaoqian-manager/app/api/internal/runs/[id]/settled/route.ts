import { NextResponse } from "next/server";
import { settleRun } from "@/lib/server/pipeline/settle";
import { verifyInternalToken } from "@/lib/server/runner-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// runner 收口回调：把运行结果写回任务阶段与轨迹（任务数据的唯一写入方仍是 Next）
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!verifyInternalToken(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  let body: { ok?: boolean; note?: string; exitCode?: number | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  try {
    const applied = await settleRun(id, {
      ok: Boolean(body.ok),
      note: typeof body.note === "string" ? body.note : "",
      exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
    });
    return NextResponse.json({ ok: true, applied });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 }
    );
  }
}
