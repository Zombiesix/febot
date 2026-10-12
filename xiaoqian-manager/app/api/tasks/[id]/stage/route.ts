import { NextResponse } from "next/server";
import { z } from "zod";
import { STAGE_KEYS, StageStatus } from "@/lib/domain/schema";
import { readTasks, updateTask } from "@/lib/server/store";
import { pushDevOperation } from "@/lib/server/teamwork/client";
import { buildDeployMessage, runDeployGit } from "@/lib/server/git/deploy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    stageKey: z.enum(STAGE_KEYS),
    status: StageStatus,
    owner: z.string().optional(),
    note: z.string().optional(),
    repo: z.string().optional(),
    targetBranch: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    // 部署节点完成要动代码，必须先选好仓库与目标分支
    if (v.stageKey === "deploy" && v.status === "done") {
      if (!v.repo) {
        ctx.addIssue({ code: "custom", message: "部署节点需要选择仓库", path: ["repo"] });
      }
      if (!v.targetBranch) {
        ctx.addIssue({
          code: "custom",
          message: "部署节点需要选择目标分支",
          path: ["targetBranch"],
        });
      }
    }
  });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let id = "";
  try {
    id = (await params).id;
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      console.warn(`[stage] ${id} 请求体不是合法 JSON`);
      return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[stage] ${id} 请求体校验失败`, parsed.error.issues);
      return NextResponse.json({ error: "请求体校验失败" }, { status: 400 });
    }
    const { stageKey, status, owner, note, repo, targetBranch } = parsed.data;
    console.log(`[stage] ${id} 收到请求`, { stageKey, status, repo, targetBranch });
    const existing = readTasks().tasks.find((t) => t.id === id);
    if (!existing) {
      console.warn(`[stage] ${id} 任务不存在`);
      return NextResponse.json({ error: "task not found" }, { status: 404 });
    }
    // 部署节点完成：先把该任务的代码提交/推送/cherry-pick 到目标分支；协作平台任务点完成
    if (stageKey === "deploy" && status === "done") {
      console.log(`[stage] ${id} 进入部署流程`);
      // 已部署过就拒绝重复提交，避免重跑 commit/push/cherry-pick
      const deployStage = existing.stages.find((s) => s.key === "deploy");
      if (deployStage?.status === "done") {
        console.warn(`[stage] ${id} 已部署完成，拒绝重复提交`);
        return NextResponse.json(
          { error: "该任务已部署完成，不能重复提交" },
          { status: 409 }
        );
      }
      // 任一步失败就中断 —— 不写协作平台，也不落本地 tasks.json
      console.log(`[stage] ${id} 步骤1/3 提交/推送/cherry-pick 开始`, {
        repo,
        targetBranch,
      });
      const gitResult = await runDeployGit({
        repo: repo as string,
        targetBranch: targetBranch as string,
        message: buildDeployMessage(id, existing.title),
      });
      console.log(`[stage] ${id} 步骤1/3 提交/推送/cherry-pick 完成`, gitResult);
      // 先写协作平台；失败（含登录失效）则中断，不落本地 tasks.json
      console.log(`[stage] ${id} 步骤2/3 回写协作平台 开始`);
      await pushDevOperation(id);
      console.log(`[stage] ${id} 步骤2/3 回写协作平台 完成`);
    }
    const now = new Date().toISOString();
    console.log(`[stage] ${id} 步骤3/3 更新本地任务状态 开始`, { stageKey, status });
    const task = await updateTask(id, (t) => ({
      ...t,
      stages: t.stages.map((s) => {
        if (s.key !== stageKey) return s;
        return {
          ...s,
          status,
          owner: owner ?? s.owner,
          note: note ?? s.note,
          startedAt:
            status === "pending" ? null : (s.startedAt ?? now),
          finishedAt:
            status === "done" ? (s.finishedAt ?? now) : null,
        };
      }),
    }));
    if (!task) {
      console.warn(`[stage] ${id} 更新失败：任务不存在`);
      return NextResponse.json({ error: "task not found" }, { status: 404 });
    }
    console.log(`[stage] ${id} 步骤3/3 更新本地任务状态 完成`);
    return NextResponse.json({ task });
  } catch (e) {
    console.error(`[stage] ${id} PATCH 执行失败`, e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 }
    );
  }
}
