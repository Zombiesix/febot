import { NextResponse } from "next/server";
import { runnerFetch } from "@/lib/server/runner-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 文件列表；带 ?path= 时懒加载单文件 patch
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const p = new URL(req.url).searchParams.get("path");
  const pathname = `/runs/${encodeURIComponent(id)}/diff${
    p ? `?path=${encodeURIComponent(p)}` : ""
  }`;
  try {
    const data = await runnerFetch<unknown>(pathname);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: (e as { status?: number })?.status ?? 503 }
    );
  }
}
