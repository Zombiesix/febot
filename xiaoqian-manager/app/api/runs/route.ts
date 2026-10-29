import { NextResponse } from "next/server";
import type { PipelineRun } from "@/lib/domain/run";
import {
  RunnerOfflineError,
  isRunnerOnline,
  runnerFetch,
} from "@/lib/server/runner-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 任务列表 / 待审队列用的 run 汇总。runner 未启动不报错，返回 online:false。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  if (!(await isRunnerOnline())) {
    return NextResponse.json({ online: false, runs: [] satisfies PipelineRun[] });
  }
  try {
    const data = await runnerFetch<{ runs: PipelineRun[] }>(
      `/runs${status ? `?status=${encodeURIComponent(status)}` : ""}`
    );
    return NextResponse.json({ online: true, runs: data.runs });
  } catch (e) {
    if (e instanceof RunnerOfflineError) {
      return NextResponse.json({ online: false, runs: [] });
    }
    return NextResponse.json(
      { online: true, runs: [], error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 }
    );
  }
}
