import { NextResponse } from "next/server";
import type { Task } from "@/lib/domain/schema";
import { mergeTasks } from "@/lib/server/store";
import {
  fetchDetail,
  fetchList,
  fetchRecord,
  TwLoginError,
} from "@/lib/server/teamwork/client";
import { hasCredentials } from "@/lib/server/teamwork/credentials";
import { rowToTask } from "@/lib/server/teamwork/mapper";
import { readTeamworkConfig } from "@/lib/server/config/root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    if (!hasCredentials()) {
      return NextResponse.json(
        { error: "未找到协作平台凭证 auth.txt" },
        { status: 400 }
      );
    }
    let body: { user?: string; statuses?: string[]; module?: string } = {};
    try {
      body = await req.json();
    } catch {
      // 空 body 走默认筛选
    }
    const statuses = body.statuses?.length ? body.statuses : ["1", "2"];
    const user = (body.user || "").trim() || readTeamworkConfig().username;
    if (!user) {
      return NextResponse.json(
        { error: "未指定执行人：请在 febot.config.json 的 teamwork.username 配置默认值，或在同步弹窗里填写" },
        { status: 400 }
      );
    }
    const moduleName = body.module ?? "";

    const rows = await fetchList({ statuses, user, module: moduleName, pageSize: 50 });

    const tasks: Task[] = [];
    let failed = 0;
    const errors: string[] = [];
    // 平台侧确认仍存在、但拉详情失败的 id，合并时跳过删除
    const failedIds: string[] = [];
    for (const row of rows) {
      const id = String(row.id ?? "").trim();
      try {
        if (!id) throw new Error("该行没有 id 字段");
        const [detail, traj] = await Promise.all([
          fetchDetail(id),
          fetchRecord(String(row.demand_id ?? "")),
        ]);
        tasks.push(rowToTask(row, detail, traj));
      } catch (e) {
        failed++;
        errors.push(`${id}: ${e instanceof Error ? e.message : "unknown"}`);
        if (id) failedIds.push(id);
      }
    }

    const merged = await mergeTasks(tasks, {
      scope: { user, statuses, module: moduleName },
      keepIds: failedIds,
    });
    return NextResponse.json({
      synced: tasks.length,
      created: merged.created,
      updated: merged.updated,
      removed: merged.removed,
      failed,
      errors,
    });
  } catch (e) {
    if (e instanceof TwLoginError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 }
    );
  }
}
