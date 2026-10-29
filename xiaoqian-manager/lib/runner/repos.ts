import fs from "node:fs";
import path from "node:path";
import { REPOS_FILE, RUNS_DIR } from "./paths";

// 仓库状态注册表：repoKey → 占用中的 runId。
//
// 单 runner 进程 + 单事件循环，读写全部同步完成，因此「查 static → 置 busy」
// 天然原子；第二个并发请求一定会看到 busy 并拿到 409。不做文件锁/心跳/TTL。
//
// 注册表只是 app 层的快速失败；系统层面的互斥仍由剧本的 file-lock 兜底。

export interface RepoEntry {
  repoRoot: string;
  runId: string;
  status: "busy";
  updatedAt: string;
}

export type ReposFile = Record<string, RepoEntry>;

export function readRepos(): ReposFile {
  try {
    const raw = fs.readFileSync(REPOS_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ReposFile;
  } catch {
    return {};
  }
}

function writeRepos(repos: ReposFile): void {
  fs.mkdirSync(path.dirname(REPOS_FILE), { recursive: true });
  const tmp = `${REPOS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(repos, null, 2), "utf8");
  fs.renameSync(tmp, REPOS_FILE);
}

export interface AcquireResult {
  ok: boolean;
  occupant?: string;
}

/** 原子登记占用。busy 时返回占用者 runId，不排队。 */
export function acquireRepo(
  repoKey: string,
  repoRoot: string,
  runId: string
): AcquireResult {
  const repos = readRepos();
  const current = repos[repoKey];
  if (current && current.runId !== runId) {
    return { ok: false, occupant: current.runId };
  }
  repos[repoKey] = {
    repoRoot,
    runId,
    status: "busy",
    updatedAt: new Date().toISOString(),
  };
  writeRepos(repos);
  return { ok: true };
}

/** 释放占用：只有登记方本人能释放，避免误清别人的忙位。 */
export function releaseRepo(repoKey: string, runId: string): void {
  const repos = readRepos();
  const current = repos[repoKey];
  if (!current || current.runId !== runId) return;
  delete repos[repoKey];
  writeRepos(repos);
}

export function repoStatus(repoKey: string): { status: "static" | "busy"; runId: string | null } {
  const current = readRepos()[repoKey];
  return current
    ? { status: "busy", runId: current.runId }
    : { status: "static", runId: null };
}

/**
 * 启动清扫：runner 不能热恢复 ConPTY 会话，所有非终态 run 一律置 failed，
 * 注册表从零重建（此时没有任何进行中的 run，全部 static）。
 */
export function rebuildRegistry(runs: { repoKey: string; runId: string }[]): void {
  const repos: ReposFile = {};
  const now = new Date().toISOString();
  for (const r of runs) {
    repos[r.repoKey] = {
      repoRoot: "",
      runId: r.runId,
      status: "busy",
      updatedAt: now,
    };
  }
  writeRepos(repos);
}

/** 供启动清扫读取 runs 目录；解析失败的文件跳过。 */
export function listRunFiles(): string[] {
  try {
    return fs
      .readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(RUNS_DIR, f));
  } catch {
    return [];
  }
}
