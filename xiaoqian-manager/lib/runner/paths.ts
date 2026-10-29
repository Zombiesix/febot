import path from "node:path";
import { fileURLToPath } from "node:url";

// runner 侧的固定路径。全部从本文件位置推导，避免依赖启动时的 cwd。
// lib/runner/paths.ts → 项目根 = ../..
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(HERE, "..", "..");
/** 本应用的上级目录（feib bot 根），PTY 的固定工作目录 */
export const FEBOT_ROOT = path.resolve(PROJECT_ROOT, "..");

export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const RUNS_DIR = path.join(DATA_DIR, "runs");
export const TEMP_DIR = path.join(DATA_DIR, "temp");
export const REPOS_FILE = path.join(DATA_DIR, "repos.json");
export const RUNNER_INFO_FILE = path.join(DATA_DIR, "runner.json");

export function runFile(taskId: string): string {
  return path.join(RUNS_DIR, `${taskId}.json`);
}

export function eventsFile(taskId: string): string {
  return path.join(RUNS_DIR, `${taskId}.events.jsonl`);
}

export function doneMarker(taskId: string): string {
  return path.join(TEMP_DIR, `${taskId}.done.json`);
}

export function planFile(taskId: string): string {
  return path.join(TEMP_DIR, `${taskId}.md`);
}

export function wrapperFile(taskId: string): string {
  return path.join(TEMP_DIR, `${taskId}.run.cmd`);
}

/** taskId 会进文件名与批处理内容，只放行安全字符 */
export const SAFE_ID = /^[A-Za-z0-9_-]+$/;
