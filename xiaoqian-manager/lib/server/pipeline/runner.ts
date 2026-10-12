import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Task } from "@/lib/domain/schema";
import { updateTask } from "@/lib/server/store";

// 计划节点「开始」：弹一个新终端窗口在 febot 根目录跑交互式 claude `/pipeline <任务ID>`，
// 一次覆盖 计划+写代码 两个阶段，并在正常收工时接续置完成 人工测试。窗口关闭（进程退出）即收尾：
// exit 0 → 计划/写代码/人工测试 三阶段自动 done；非 0 → 保留 active 并写错误 note。
//
// 已知边界：仅单进程有效（与 store.ts 同一前提）；dev server 重启会丢 exit 回调，
// 阶段停在 active，用 StageSheet 手动收尾。

// claude 的工作目录固定为 febot 根（本应用的上级目录）
const FEBOT_ROOT = path.resolve(process.cwd(), "..");
// 计划文件是临时文件：xiaoqian-manager 生成、流水线读完即弃，正常结束自动删除
const TEMP_PLAN_DIR = path.join(process.cwd(), "data", "temp");

const running = new Map<string, ChildProcess>();

export class PipelineBusyError extends Error {
  constructor() {
    super("该任务的流水线已在运行");
  }
}

// trajectory.time 与协作平台轨迹一致：本地时间 YYYY-MM-DD HH:mm:ss
function fmtLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// 字段格式对齐 pipeline-feed 的抽取契约：首行 `# ` 标题 + 元信息行 + 问题描述/分配任务说明
function renderPlanFile(task: Task): string {
  const alias = `R-${task.id.slice(-6)}`;
  const meta = [
    `任务ID: ${task.id}`,
    `查询ID: ${task.demandId}`,
    `别名: ${alias}`,
    `产品/模块: ${task.module}`,
    `版本: ${task.version}`,
    `状态: ${task.twStatus}`,
    `难度: ${task.demandLevel}`,
    `最大工时: ${task.maxHour ?? ""}`,
    `执行人: ${task.assignee}`,
    `创建人: ${task.createdName}`,
  ]
    .filter((l) => !l.endsWith(": "))
    .join("\n");
  const attachments =
    task.attachments.length > 0
      ? task.attachments.map((a) => `- ${a}`).join("\n")
      : "（无）";
  return `# ${task.title}\n\n${meta}\n\n## 问题描述\n\n${task.description || "（空）"}\n\n## 分配任务说明\n\n${task.assignDescription || "（空）"}\n\n## 附件\n\n${attachments}\n`;
}

function writePlanFile(task: Task): string {
  fs.mkdirSync(TEMP_PLAN_DIR, { recursive: true });
  const file = path.join(TEMP_PLAN_DIR, `${task.id}.md`);
  fs.writeFileSync(file, renderPlanFile(task), "utf8");
  return file;
}

export async function startPipeline(task: Task): Promise<Task> {
  if (running.has(task.id)) throw new PipelineBusyError();

  const planFile = writePlanFile(task);

  // 先置 active，再 spawn：exit 回调里依赖「阶段已是 active」做守卫，顺序不能反
  const now = new Date().toISOString();
  const active = await updateTask(task.id, (t) => ({
    ...t,
    stages: t.stages.map((s) =>
      s.key === "planer" || s.key === "coder"
        ? { ...s, status: "active", startedAt: s.startedAt ?? now, finishedAt: null }
        : s
    ),
    trajectory: [
      ...t.trajectory,
      {
        time: fmtLocal(new Date()),
        operator: "系统",
        action: "启动流水线",
        content: `/pipeline ${task.id}`,
      },
    ],
  }));
  if (!active) throw new Error(`task not found: ${task.id}`);

  // start /wait：外层 cmd 挂到终端窗口关闭那一刻，exit 事件即「用户收工」
  let child: ChildProcess;
  try {
    child = spawn(
      "cmd.exe",
      [
        "/d",
        "/c",
        "start",
        `"pipeline-${task.id}"`,
        "/wait",
        "cmd",
        "/k",
        "claude",
        `/pipeline ${task.id}`,
      ],
      { cwd: FEBOT_ROOT, windowsHide: false, stdio: "ignore" }
    );
  } catch (e) {
    // 窗口没弹起来：把两个阶段退回未开始，别留一个虚假的进行中
    await updateTask(task.id, (t) => ({
      ...t,
      stages: t.stages.map((s) =>
        s.key === "planer" || s.key === "coder"
          ? { ...s, status: "pending", startedAt: null }
          : s
      ),
    }));
    throw e;
  }
  running.set(task.id, child);
  child.unref();

  child.on("exit", (code) => {
    running.delete(task.id);
    const ok = code === 0;
    const finishedAt = new Date().toISOString();
    updateTask(task.id, (t) => ({
      ...t,
      stages: t.stages.map((s) => {
        if (s.key === "planer" || s.key === "coder") {
          if (s.status !== "active") return s;
          return ok
            ? { ...s, status: "done", finishedAt: s.finishedAt ?? finishedAt }
            : { ...s, note: s.note || `Claude 退出码 ${code}` };
        }
        // 人工测试：流水线正常收工（exit 0）时一并置完成；异常退出不动它
        if (s.key === "test" && ok && s.status !== "done") {
          return { ...s, status: "done", finishedAt: s.finishedAt ?? finishedAt };
        }
        return s;
      }),
      trajectory: [
        ...t.trajectory,
        {
          time: fmtLocal(new Date()),
          operator: "系统",
          action: ok ? "流水线完成" : "流水线异常退出",
          content: `exit=${code}`,
        },
      ],
    })).catch((e) => console.error("[pipeline] exit 回调写任务失败", e));
    if (ok) fs.rmSync(planFile, { force: true });
  });

  return active;
}
