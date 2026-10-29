import { NextResponse } from "next/server";
import { runnerFetch } from "@/lib/server/runner-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 「要求重做」等场景：把提示写进当前 PTY stdin
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: { data?: unknown; submit?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  if (typeof body.data !== "string" || !body.data.trim()) {
    return NextResponse.json({ error: "data 不能为空" }, { status: 400 });
  }
  try {
    const data = await runnerFetch<unknown>(`/runs/${encodeURIComponent(id)}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: body.data, submit: body.submit !== false }),
    });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: (e as { status?: number })?.status ?? 503 }
    );
  }
}
