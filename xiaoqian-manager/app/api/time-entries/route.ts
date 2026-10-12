import { NextResponse } from "next/server";
import { hasCredentials } from "@/lib/server/teamwork/credentials";
import { saveWorkHours, type WorkHourRow } from "@/lib/server/teamwork/client";

// 今日工时入口：透传给协作平台 /process/workHours/saveBatch。
// 请求形状：POST { date: "YYYY-MM-DD", workHours: WorkHourRow[] }
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { error: "工时接口仅支持 POST" },
    { status: 405 }
  );
}

export async function POST(req: Request) {
  try {
    if (!hasCredentials()) {
      return NextResponse.json(
        { error: "未找到协作平台凭证 auth.txt" },
        { status: 400 }
      );
    }
    let body: { date?: string; workHours?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
    }
    const date = body.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: "缺少合法的 date（YYYY-MM-DD）" }, { status: 400 });
    }
    // workHoursList 字段由前端传入，本期未接任务源可留空；平台要求的不确定字段由前端空着。
    const workHours: WorkHourRow[] = Array.isArray(body.workHours)
      ? (body.workHours as WorkHourRow[])
      : [];
    await saveWorkHours({
      id: "",
      businessDate: date,
      workHoursList: workHours,
      jsonField: "{\"aiTag\":1}"
    });
    return NextResponse.json({ ok: true, date, count: workHours.length });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 }
    );
  }
}