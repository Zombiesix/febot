// 验证 pushDevOperation：对真实任务写一条操作，前后对比平台轨迹。
// 用法: yarn tsx scripts/probe-op.ts
import {
  fetchRecord,
  pushDevOperation,
} from "../lib/server/teamwork/client";
import { readCredentials } from "../lib/server/teamwork/credentials";
import { readTeamworkConfig } from "../lib/server/config/root";
import fs from "node:fs";
import path from "node:path";

// 临时：直接裸调 operation 接口，打印原始返回。mode 组合不同 header/body 变体。
async function rawOperation(taskId: string, mode: string) {
  const cookieFile = path.join(process.cwd(), "data", ".tw-cookie.json");
  const cookie = JSON.parse(fs.readFileSync(cookieFile, "utf8")).cookie as string;
  const cred = readCredentials();
  const base = `https://${cred.host}`;
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json;charset=UTF-8",
    cookie,
    origin: base,
  };
  if (!mode.includes("no-ua")) headers["user-agent"] = ua;
  if (mode.includes("usertag")) {
    const tag = readTeamworkConfig().userTag;
    if (tag) headers["user-tag"] = tag;
  }
  if (mode.includes("referer")) headers["referer"] = `${base}/`;
  if (mode.includes("xreq")) headers["x-requested-with"] = "XMLHttpRequest";
  let body: string;
  if (mode.includes("dup")) {
    // 复刻原始 curl：description 出现两次
    body = `{"id":"${taskId}","description":"","operationAction":"js","taskFj":"[]","description":"<p>1</p>"}`;
  } else if (mode.includes("empty")) {
    body = JSON.stringify({ id: taskId, description: "", operationAction: "js", taskFj: "[]" });
  } else {
    body = JSON.stringify({ id: taskId, description: "<p>1</p>", operationAction: "js", taskFj: "[]" });
  }
  const resp = await fetch(`${base}/process/developmentPerson/operation`, {
    method: "POST",
    headers,
    body,
  });
  const text = await resp.text();
  console.log(`MODE=${mode} status=${resp.status} body=${text.slice(0, 200)}`);
}

async function matrix(taskId: string) {
  const modes = [
    "plain",          // 当前实现：无 UA / user-tag / referer
    "no-ua+usertag",  // 加 user-tag（现网其他接口的用法）
    "no-ua+xreq",     // 加 X-Requested-With
    "no-ua+referer",  // 加 referer
    "dup",            // 复刻原始 curl 的重复 description
    "empty",          // description 为空串
  ];
  for (const m of modes) {
    try {
      await rawOperation(taskId, m);
    } catch (e) {
      console.log(`MODE=${m} ERR ${e instanceof Error ? e.message : e}`);
    }
  }
}

// 任务ID / 需求ID 必填（内部数据，不内置默认值）：yarn tsx scripts/probe-op.ts <任务ID> <需求ID>
const TASK_ID = process.argv[2] ?? "";
const DEMAND_ID = process.argv[3] ?? "";
if (!TASK_ID || !DEMAND_ID) {
  console.error("usage: yarn tsx scripts/probe-op.ts <任务ID> <需求ID> [--matrix|--raw <mode>]");
  process.exit(1);
}

function brief(rows: unknown[]) {
  return rows.map((r) => {
    const o = r as Record<string, unknown>;
    return `${String(o.created_time)} | ${String(o.follow_pname)} | ${String(o.operation_action)} | ${String(o.description ?? "").slice(0, 60)}`;
  });
}

async function main() {
  if (process.argv.includes("--matrix")) {
    await matrix(TASK_ID);
    return;
  }
  if (process.argv.includes("--raw")) {
    await rawOperation(TASK_ID, process.argv[process.argv.indexOf("--raw") + 1] ?? "plain");
    return;
  }
  const before = await fetchRecord(DEMAND_ID);
  console.log(`BEFORE: ${before.length} records`);
  await pushDevOperation(TASK_ID);
  console.log("pushDevOperation: OK");
  const after = await fetchRecord(DEMAND_ID);
  console.log(`AFTER: ${after.length} records`);
  const last = brief(after).pop();
  console.log("LAST RECORD:", last ?? "(none)");
}

main().catch((e) => {
  console.error("ERR " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
