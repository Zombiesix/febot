import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Task } from "@/lib/domain/schema";
import { updateTask } from "@/lib/server/store";

// 「写代码」节点的 ▶：弹一个新终端窗口在 febot 根目录跑交互式 claude `/pipeline <任务ID>`。
// 启动只动「写代码」节点（coder → active）；第 ② 步「计划」的状态由人工在弹框里自行标记，▶ 不代劳。
//
// 收尾判据不依赖窗口退出码（实测 `start /wait` 不会把子进程退出码传回 Node，外层恒 0）：
//   ① 包装脚本在 claude 进程结束后写 `<任务ID>.exit`（纯数字，127 = 未找到 claude）；
//   ② /pipeline 剧本走到 done 时写 `<任务ID>.done.json`（phase=done）——这是唯一成功判据；
//   ③ 服务端每 2s 轮询这两个文件：见到完成标记 → coder done；只见 exit → coder failed；
//      窗口在两者都没出现前关闭 → coder failed（视为取消）。
// 窗口用 `cmd /k` 保活，用户仍可回看输出；状态不再等窗口关闭才收口。
//
// 已知边界：仅单进程有效（与 store.ts 同一前提）；dev server 重启会丢轮询与 exit 回调，
// 阶段停在 active，用 StageSheet 手动收尾。

// claude 的工作目录固定为 febot 根（本应用的上级目录）
const FEBOT_ROOT = path.resolve(process.cwd(), "..");
// 临时文件目录：计划文件、包装脚本、退出码、完成标记都放这里，读完即弃
const TEMP_DIR = path.join(process.cwd(), "data", "temp");

// 完成标记轮询间隔：marker 由 advance done 在收尾最后一刻写入，2s 足够且不再白等
const POLL_MS = 2 * 1000;

const running = new Map<string, ChildProcess>();
// 启动中的占位：忙位检查与 await 之间不能留窗口，否则并发 POST 会弹两个窗口
const starting = new Set<string>();

// task.id 会进文件名与 bat 内容，只放行安全字符（当前平台 ID 为纯数字）
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export class PipelineBusyError extends Error {
  constructor() {
    super("该任务的流水线已在运行");
  }
}

// 严格必填：没有「计划」节点整理过的描述就不允许开跑，源头上不生成 `（空）` 计划文件。
export class MissingPlannedDescriptionError extends Error {
  constructor() {
    super("计划描述为空：请先在「计划」节点填写并保存描述，再启动写代码");
    this.name = "MissingPlannedDescriptionError";
  }
}

interface TempFiles {
  plan: string;
  wrapper: string;
  exit: string;
  done: string;
}

function tempFiles(id: string): TempFiles {
  return {
    plan: path.join(TEMP_DIR, `${id}.md`),
    wrapper: path.join(TEMP_DIR, `${id}.run.cmd`),
    exit: path.join(TEMP_DIR, `${id}.exit`),
    done: path.join(TEMP_DIR, `${id}.done.json`),
  };
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
export function renderPlanFile(task: Task): string {
  const title = task.title.trim();
  if (!title) throw new Error("任务标题为空，无法生成计划文件");
  // 只认研发人员在「计划」节点整理后的描述；不回退平台原文，也不写占位符。
  const description = task.plannedDescription.trim();
  if (!description) throw new MissingPlannedDescriptionError();

  const alias = `R-${task.id.slice(-6)}`;
  const meta = [
    `任务ID: ${task.id}`,
    `查询ID: ${task.demandId}`,
    `别名: ${alias}`,
    `产品/模块: ${task.module}`,
    `版本: ${task.version}`,
    `状态: ${task.twStatus}`,
    `难度: ${task.demandLevel}`,
    `任务类型: ${task.taskType}`,
    `最大工时: ${task.maxHour ?? ""}`,
    `执行人: ${task.assignee}`,
    `创建人: ${task.createdName}`,
  ]
    .filter((l) => !l.endsWith(": "))
    .join("\n");
  return `# ${title}\n\n${meta}\n\n## 问题描述\n\n${description}\n\n## 分配任务说明\n\n${task.assignDescription.trim()}\n`;
}

function writePlanFile(content: string, file: string): void {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

// 包装脚本：先做启动自检，再跑 claude，最后把退出码落盘。
// 退出码不能靠 start /wait 传回 Node，所以必须由它自己写文件（127 = 未找到 claude）。
function writeWrapper(id: string, file: string): void {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const lines = [
    "@echo off",
    "where claude >nul 2>nul",
    "if errorlevel 1 (",
    `  >"%~dp0${id}.exit" echo 127`,
    "  echo [xiaoqian] 未找到 claude 命令，流水线未启动。",
    "  exit /b 127",
    ")",
    // 必须 call：claude 在 Windows 上常是 .cmd 垫片，不 call 会直接链走、后面的落盘不执行
    `call claude "/pipeline ${id}"`,
    `>"%~dp0${id}.exit" echo %ERRORLEVEL%`,
    "",
  ];
  fs.writeFileSync(file, lines.join("\r\n"), "utf8");
}

function rmQuiet(files: string[]): void {
  for (const f of files) {
    try {
      fs.rmSync(f, { force: true });
    } catch (e) {
      console.error("[pipeline] 清理临时文件失败", f, e);
    }
  }
}

function readDoneMarker(file: string): boolean {
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as { phase?: string };
    return json.phase === "done";
  } catch {
    // 不存在 / 正在写（半截 JSON）→ 下一轮再看
    return false;
  }
}

function readExitCode(file: string): number | null {
  try {
    const code = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isFinite(code) ? code : null;
  } catch {
    return null;
  }
}

function noteForExit(code: number | null): string {
  if (code === 127) return "未找到 claude 命令（窗口内启动失败）";
  if (code === null) return "Claude 已退出，退出码无法解析，且未产出完成标记";
  return `Claude 退出码 ${code}，且未产出完成标记（流水线未走到 done）`;
}

// 收口一次运行：只在阶段仍为 active 时动库与轨迹，避免覆盖人工收尾。
// 返回是否真的写入了这次结果。
async function settleStage(id: string, ok: boolean, note: string): Promise<boolean> {
  const finishedAt = new Date().toISOString();
  let applied = false;
  try {
    const updated = await updateTask(id, (t) => {
      const stage = t.stages.find((s) => s.key === "coder");
      if (!stage || stage.status !== "active") return t;
      applied = true;
      return {
        ...t,
        stages: t.stages.map((s) => {
          if (s.key !== "coder") return s;
          return ok
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
            action: ok ? "流水线完成" : "流水线异常",
            content: ok ? "已确认完成标记" : note,
          },
        ],
      };
    });
    if (!updated) console.error("[pipeline] 收口写任务失败：任务不存在", id);
  } catch (e) {
    console.error("[pipeline] 收口写任务失败", id, e);
  }
  return applied;
}

// 轮询 + exit 兜底：窗口可能一直开着，所以不能等 exit 才收口。
function watchRun(id: string, child: ChildProcess, files: TempFiles): void {
  let settled = false;
  let timer: NodeJS.Timeout | null = null;

  const stopPolling = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const settle = async (ok: boolean, note: string) => {
    if (settled) return;
    settled = true;
    stopPolling();
    await settleStage(id, ok, note);
    if (ok) {
      // 完成标记与计划文件都是一次性产物；包装脚本/退出码留到窗口退出再清
      rmQuiet([files.done, files.plan]);
    }
  };

  const poll = () => {
    if (settled) return;
    if (readDoneMarker(files.done)) {
      void settle(true, "");
      return;
    }
    if (fs.existsSync(files.exit)) {
      void settle(false, noteForExit(readExitCode(files.exit)));
    }
  };

  timer = setInterval(poll, POLL_MS);
  // 立即看一次，避免短命运行等一个完整周期
  poll();

  child.on("error", (e) => {
    if (running.get(id) === child) running.delete(id);
    void settle(false, `无法启动流水线窗口：${e.message}`);
    rmQuiet([files.wrapper, files.exit, files.done, files.plan]);
  });

  child.on("exit", () => {
    const current = running.get(id) === child;
    if (current) running.delete(id);
    stopPolling();

    if (!settled) {
      // 关窗前的最后判定：完成标记 > 包装脚本退出码 > 用户提前关窗
      if (readDoneMarker(files.done)) {
        void settle(true, "");
      } else if (fs.existsSync(files.exit)) {
        void settle(false, noteForExit(readExitCode(files.exit)));
      } else {
        void settle(false, "窗口在流水线完成前被关闭（未产出完成标记）");
      }
    }

    // 只有仍是当前运行才清理，避免误删用户新开一轮生成的同名文件
    if (current) rmQuiet([files.wrapper, files.exit, files.done]);
  });
}

export async function startPipeline(task: Task): Promise<Task> {
  if (running.has(task.id) || starting.has(task.id)) throw new PipelineBusyError();
  starting.add(task.id);
  try {
    if (!SAFE_ID.test(task.id)) {
      throw new Error(`任务 ID 含不支持的字符，无法启动流水线：${task.id}`);
    }

    const files = tempFiles(task.id);
    // 上一轮可能因 dev 重启/异常残留：先清掉，避免旧完成标记直接判成功
    rmQuiet([files.done, files.exit, files.wrapper, files.plan]);

    // 先渲染（标题/描述校验都在这里），再置 active：校验失败时任务状态原样不动。
    const planContent = renderPlanFile(task);

    // 先置状态，再 spawn：轮询/exit 回调里依赖「coder 已是 active」做守卫。
    // 只碰 coder：planer 的状态由人工决定，这里不替用户收口。
    const now = new Date().toISOString();
    const active = await updateTask(task.id, (t) => ({
      ...t,
      stages: t.stages.map((s) => {
        if (s.key === "coder") {
          return {
            ...s,
            status: "active",
            startedAt: s.startedAt ?? now,
            finishedAt: null,
            note: "",
          };
        }
        return s;
      }),
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

    // 计划文件与包装脚本都只在 spawn 前一刻落盘；任一步失败都回滚 coder，别留虚假进行中
    let child: ChildProcess;
    try {
      writePlanFile(planContent, files.plan);
      writeWrapper(task.id, files.wrapper);
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
          // 不要手拼引号：交给 Node 按是否需要来处理，避免 cmd 收到字面 \"
          files.wrapper,
        ],
        { cwd: FEBOT_ROOT, windowsHide: false, stdio: "ignore" }
      );
    } catch (e) {
      rmQuiet([files.plan, files.wrapper, files.exit, files.done]);
      await updateTask(task.id, (t) => ({
        ...t,
        stages: t.stages.map((s) =>
          s.key === "coder"
            ? { ...s, status: "pending", startedAt: null, finishedAt: null, note: "" }
            : s
        ),
      }));
      throw e;
    }

    running.set(task.id, child);
    child.unref();
    watchRun(task.id, child, files);

    return active;
  } finally {
    starting.delete(task.id);
  }
}
