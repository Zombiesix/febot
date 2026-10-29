import { NextResponse } from "next/server";
import type { TimelineEvent } from "@/lib/domain/run";
import { runnerFetch } from "@/lib/server/runner-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 时间线首屏加载与历史回看（不依赖 WS 是否已连上）
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const data = await runnerFetch<{ events: TimelineEvent[] }>(
      `/runs/${encodeURIComponent(id)}/events`
    );
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: (e as { status?: number })?.status ?? 503 }
    );
  }
}
