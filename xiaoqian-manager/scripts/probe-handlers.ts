// 验证任务处理人链路：fetchDemandTasks -> rowToTask.handlers，只读不写。
// 用法: yarn tsx scripts/probe-handlers.ts <任务ID>
import fs from "node:fs";
import path from "node:path";
import {
  fetchDemandTasks,
  fetchDetail,
  fetchRecord,
} from "../lib/server/teamwork/client";
import { hasCredentials } from "../lib/server/teamwork/credentials";
import { rowToTask } from "../lib/server/teamwork/mapper";
import type { TwRow } from "../lib/server/teamwork/client";

const TASK_ID = process.argv[2] ?? "";
if (!TASK_ID) {
  console.error("usage: yarn tsx scripts/probe-handlers.ts <任务ID>");
  process.exit(1);
}

function findRow(taskId: string): { row: TwRow; demandId: string } {
  const file = path.join(process.cwd(), "data", "tasks.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as {
    tasks: Array<{ id: string; demandId: string }>;
  };
  const t = json.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error(`tasks.json 里没有任务 ${taskId}`);
  return {
    demandId: t.demandId,
    row: { id: t.id, demand_id: t.demandId } as TwRow,
  };
}

async function main() {
  if (!hasCredentials()) {
    console.error("NO AUTH: 请在 febot.config.json 的 teamwork.loginName / teamwork.password 填写");
    process.exit(1);
  }
  const { row, demandId } = findRow(TASK_ID);
  const [detail, traj, demandTasks] = await Promise.all([
    fetchDetail(TASK_ID),
    fetchRecord(demandId),
    fetchDemandTasks(demandId),
  ]);
  console.log(`demand ${demandId}: getByDemand rows=${demandTasks.length}`);
  const task = rowToTask(row, detail, traj, demandTasks);
  console.log("handlers:", JSON.stringify(task.handlers, null, 1));
  console.log(
    "all demand rows:",
    demandTasks.map((r) => `${String(r.id)} ${String(r.username)} max=${String(r.max_hour)} st=${String(r.status)}`)
  );
}

main().catch((e) => {
  console.error("ERR " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
