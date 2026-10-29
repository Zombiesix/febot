import { updateTask } from "@/lib/server/store";

// runner 收口回调的落库逻辑。任务数据只有 Next 写，runner 只回调。

function fmtLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

export interface SettleInput {
  ok: boolean;
  note: string;
  exitCode: number | null;
}

/**
 * 收口一次运行：只在 coder 仍为 active 时动库与轨迹，避免覆盖人工收尾。
 * 返回是否真的写入了这次结果。
 */
export async function settleRun(taskId: string, input: SettleInput): Promise<boolean> {
  const finishedAt = new Date().toISOString();
  let applied = false;
  const note =
    input.note ||
    (input.ok
      ? "已确认完成标记"
      : input.exitCode === null
        ? "会话结束但未产出完成标记"
        : `Claude 退出码 ${input.exitCode}，且未产出完成标记（流水线未走到 done）`);

  try {
    const updated = await updateTask(taskId, (t) => {
      const stage = t.stages.find((s) => s.key === "coder");
      if (!stage || stage.status !== "active") return t;
      applied = true;
      return {
        ...t,
        stages: t.stages.map((s) => {
          if (s.key !== "coder") return s;
          return input.ok
            ? { ...s, status: "done", finishedAt: s.finishedAt ?? finishedAt }
            : {
                ...s,
                status: "failed",
                note: s.note || note,
                finishedAt: s.finishedAt ?? finishedAt,
              };
        }),
        trajectory: [
          ...t.trajectory,
          {
            time: fmtLocal(new Date()),
            operator: "系统",
            action: input.ok ? "流水线完成" : "流水线异常",
            content: note,
          },
        ],
      };
    });
    if (!updated) console.error("[settle] 收口写任务失败：任务不存在", taskId);
  } catch (e) {
    console.error("[settle] 收口写任务失败", taskId, e);
  }
  return applied;
}

/** 人工介入（驳回等）写入任务轨迹；不改变阶段状态。 */
export async function appendTrajectory(
  taskId: string,
  item: { operator: string; action: string; content: string }
): Promise<boolean> {
  const updated = await updateTask(taskId, (t) => ({
    ...t,
    trajectory: [
      ...t.trajectory,
      {
        time: fmtLocal(new Date()),
        operator: item.operator || "人工",
        action: item.action || "操作",
        content: item.content || "",
      },
    ],
  }));
  return Boolean(updated);
}
