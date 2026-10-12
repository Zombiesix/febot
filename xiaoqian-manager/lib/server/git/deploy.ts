import { execFileSync } from "node:child_process";
import { assertBranch, resolveRepoPath } from "./config";

// 部署节点：在主仓 checkout 上「拉取最新 → 提交改动 → 推源分支 → 把这一个提交
// cherry-pick 到目标分支 → 推目标分支」。
//
// 用 cherry-pick 而不是 merge：只搬本次刚产生的那个提交，不产生合并提交。
// 这同时绕开了仓里的 post-merge 守卫（有些仓的钩子会在合并来源分支名含
// "feat" 时 git reset --keep HEAD~1 撤销合并，而 git 忽略 post-merge 的退出码，
// 会造成「看起来成功、实际被撤销」）。cherry-pick 没有 MERGE_HEAD，钩子不触发。

export interface DeployGitResult {
  source: string;
  committed: boolean;
  cherryPicked: boolean;
}

interface GitRunOptions {
  timeout?: number;
  input?: string;
}

const DEFAULT_TIMEOUT = 120_000;
const COMMIT_TIMEOUT = 300_000; // 提交会跑 husky/lint-staged，慢
const NET_TIMEOUT = 60_000;

function git(cwd: string, args: string[], opts: GitRunOptions = {}): string {
  const { timeout = DEFAULT_TIMEOUT, input } = opts;
  const cmd = `git ${args.join(" ")}`;
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      input,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // 凭证过期时快速失败，别把 Next 服务端挂死在一个等输入的进程上
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        CI: "1",
      },
    });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string; killed?: boolean; signal?: string };
    if (err.killed || err.signal) throw new Error(`${cmd} 超时`);
    const detail = String(err.stderr || err.stdout || err.message || "").trim().slice(0, 600);
    throw new Error(`${cmd} 失败：${detail}`);
  }
}

function safeStatus(cwd: string): string {
  try {
    return git(cwd, ["status", "--porcelain"]).trim().slice(0, 300);
  } catch {
    return "";
  }
}

// 同一仓库串行执行，避免并发操作撞 index.lock；不同仓库互不阻塞。
// 不放进 store.ts 的串行链里 —— 提交可能跑几分钟，会卡住所有 tasks.json 写操作。
const chains = new Map<string, Promise<unknown>>();

function serializeRepo<T>(key: string, job: () => T | Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(job, job);
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

// feat(R-<任务ID后6位>): <标题>，单行 —— 对齐 pipeline.md 的别名约定与 commitlint 的单行要求。
export function buildDeployMessage(taskId: string, title: string): string {
  const alias = `R-${taskId.slice(-6)}`;
  const subject =
    title
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.。]+$/, "") || alias;
  return `feat(${alias}): ${subject}`.slice(0, 100);
}

export function runDeployGit(opts: {
  repo: string;
  targetBranch: string;
  message: string;
}): Promise<DeployGitResult> {
  const cwd = resolveRepoPath(opts.repo);
  assertBranch(opts.targetBranch);
  return serializeRepo(cwd, () => deploy(cwd, opts.targetBranch, opts.message));
}

function deploy(cwd: string, targetBranch: string, message: string): DeployGitResult {
  const source = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (!source || source === "HEAD") {
    throw new Error("当前处于分离头指针状态，拒绝提交");
  }

  // 工作区此时是脏的：git 2.20 的 --autostash 只对 --rebase 生效，
  // 用 --rebase --autostash 一次完成「暂存改动 → 拉取最新 → 恢复改动」。
  git(cwd, ["pull", "--rebase", "--autostash"], { timeout: NET_TIMEOUT });

  const dirty = git(cwd, ["status", "--porcelain"]).trim();
  const dirtyLines = dirty ? dirty.split("\n").length : 0;
  if (dirtyLines > 200) {
    throw new Error(`待提交改动过多（${dirtyLines} 个文件），疑似误提交，已中止`);
  }

  let committed = false;
  let commitSha = "";
  if (dirtyLines > 0) {
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-F", "-"], { input: message, timeout: COMMIT_TIMEOUT });
    commitSha = git(cwd, ["rev-parse", "HEAD"]).trim();
    committed = true;
  }

  git(cwd, ["push"], { timeout: NET_TIMEOUT });

  let cherryPicked = false;
  if (committed && targetBranch !== source) {
    cherryPicked = cherryPickTo(cwd, source, targetBranch, commitSha);
  }

  return { source, committed, cherryPicked };
}

function cherryPickTo(cwd: string, source: string, targetBranch: string, commitSha: string): boolean {
  git(cwd, ["checkout", targetBranch], { timeout: NET_TIMEOUT });
  try {
    // 此刻工作区是干净的（改动刚提交完），--ff-only 足够；共享分支上分叉就报错，不重写历史
    git(cwd, ["pull", "--ff-only"], { timeout: NET_TIMEOUT });
    try {
      git(cwd, ["cherry-pick", commitSha]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 该提交此前已搬过一次：cherry-pick 得到空提交，按「已合并」处理
      if (/nothing to commit|now empty|previous cherry-pick/i.test(msg)) {
        try {
          git(cwd, ["cherry-pick", "--abort"]);
        } catch {
          // 已无进行中的 cherry-pick
        }
        return false;
      }
      try {
        git(cwd, ["cherry-pick", "--abort"]);
      } catch {
        // 忽略 abort 自身的失败
      }
      const status = safeStatus(cwd);
      throw new Error(`cherry-pick 到 ${targetBranch} 失败：${msg}${status ? `；${status}` : ""}`);
    }
    git(cwd, ["push"], { timeout: NET_TIMEOUT });
    return true;
  } finally {
    try {
      git(cwd, ["checkout", source], { timeout: NET_TIMEOUT });
    } catch {
      // 已在原分支，或 checkout 失败 —— 不再掩盖上面的真实错误
    }
  }
}
