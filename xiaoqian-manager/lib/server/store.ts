import fs from "node:fs";
import path from "node:path";
import { TasksFile, type Task } from "@/lib/domain/schema";

// 仅服务端可用（node:fs）。浏览器端严禁 import 本文件。
//
// 并发约定：模块级 Promise 链串行化所有写操作，读-改-写必须在同一
// 临界区内完成。仅适配单进程（next dev 或 next start 二选一），同时
// 跑两个实例会互相覆盖。

const DATA_DIR = path.join(process.cwd(), "data");
const TASKS_FILE = path.join(DATA_DIR, "tasks.json");

let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(job: () => T | Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function writePayload(tasks: Task[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload: TasksFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    tasks,
  };
  const tmp = TASKS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, TASKS_FILE);
}

export function readTasks(): { tasks: Task[]; updatedAt: string } {
  if (!fs.existsSync(TASKS_FILE)) return { tasks: [], updatedAt: "" };
  const raw = fs.readFileSync(TASKS_FILE, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`tasks.json is not valid JSON: ${TASKS_FILE}`);
  }
  const parsed = TasksFile.safeParse(json);
  if (!parsed.success) {
    throw new Error(`tasks.json failed schema validation: ${TASKS_FILE}`);
  }
  return { tasks: parsed.data.tasks, updatedAt: parsed.data.updatedAt };
}

export function writeTasks(tasks: Task[]): Promise<void> {
  return serialize(() => {
    writePayload(tasks);
  });
}

export function updateTask(
  id: string,
  mutate: (task: Task) => Task
): Promise<Task | null> {
  return serialize(() => {
    const { tasks } = readTasks();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    tasks[idx] = mutate(tasks[idx]);
    writePayload(tasks);
    return tasks[idx];
  });
}

export interface MergeResult {
  created: number;
  updated: number;
  removed: number;
}

// 本次同步的筛选范围：范围内但远程未返回的本地任务视为平台侧已变化，予以删除
export interface MergeScope {
  user: string;
  statuses: string[]; // 平台状态码，如 ["1","2"]
  module: string;
}

const STATUS_LABELS: Record<string, string> = { "1": "待处理", "2": "处理中" };

// 本地任务是否落在同步范围内（与 fetchList 的 qqConObj 筛选口径一致）
function inScope(t: Task, scope: MergeScope): boolean {
  if (scope.module && t.module !== scope.module) return false;
  // 平台侧 username 用 CL（包含）匹配，这里保持同样口径
  if (scope.user && !t.assignee.includes(scope.user)) return false;
  if (scope.statuses.length) {
    const labels = scope.statuses.map((c) => STATUS_LABELS[c] || c);
    if (!labels.includes(t.twStatus)) return false;
  }
  return true;
}

// 合并同步结果：以远程数据为准——已存在的任务保留本地 stages（用户手动改过的
// 进度不覆盖），其余平台侧字段刷新；新任务整体插入；范围内远程未返回的任务删除。
// keepIds：平台侧确认仍存在但本次拉详情失败的 id，跳过删除以免误伤。
export function mergeTasks(
  incoming: Task[],
  opts?: { scope?: MergeScope; keepIds?: string[] }
): Promise<MergeResult> {
  return serialize(() => {
    const { tasks } = readTasks();
    const incomingIds = new Set(incoming.map((t) => t.id));
    const keepIds = new Set(opts?.keepIds ?? []);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    let created = 0;
    let updated = 0;
    let removed = 0;
    for (const inc of incoming) {
      const existing = byId.get(inc.id);
      if (existing) {
        byId.set(inc.id, { ...inc, stages: existing.stages });
        updated++;
      } else {
        byId.set(inc.id, inc);
        created++;
      }
    }
    if (opts?.scope) {
      for (const t of tasks) {
        if (incomingIds.has(t.id) || keepIds.has(t.id)) continue;
        if (inScope(t, opts.scope)) {
          byId.delete(t.id);
          removed++;
        }
      }
    }
    writePayload([...byId.values()]);
    return { created, updated, removed };
  });
}
