import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "febot-req-test-"));
export const tempConfigPath = path.join(tempRoot, "febot.config.json");

process.env.FEBOT_ROOT = tempRoot;
process.env.FEBOT_CONFIG = tempConfigPath;

export function makeCfg(raw = {}, dir = tempRoot) {
  return {
    path: path.join(dir, "febot.config.json"),
    dir,
    raw,
  };
}

export function writeTempTasks(content) {
  const tasksPath = path.join(tempRoot, "tasks.md");
  fs.writeFileSync(tasksPath, content, "utf8");
  return tasksPath;
}

export function cleanupTempRoot() {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
