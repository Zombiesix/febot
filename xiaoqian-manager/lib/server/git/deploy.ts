import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
  targetBranch: string;
  committed: boolean;
  cherryPicked: boolean;
  /** 本次新产生的提交；工作区本来干净时为空串 */
  commitSha: string;
}

interface GitRunOptions {
  timeout?: number;
  input?: string;
}

const DEFAULT_TIMEOUT = 120_000;
const COMMIT_TIMEOUT = 300_000; // 提交会跑 husky/lint-staged，慢
const NET_TIMEOUT = 60_000;

const MAX_OUTPUT = 16 * 1024 * 1024;

/**
 * 异步执行 git（原来是 execFileSync）。
 *
 * 为什么必须是异步：提交链路（pull / commit 跑 husky / push / cherry-pick）动辄几十
 * 秒到几分钟。同步调用会把 Next 进程的事件循环整个堵死，其间 undici 无法处理
 * runner 连接上已到达的 FIN —— runner 的 keep-alive 只有 5s，等 git 返回后
 * `submit-code` 末尾的「自动接受」POST 会复用一条已被对端关闭的连接，
 * 拿到 ECONNRESET 后被误报成「runner 未启动」。改成异步后事件循环不被阻塞，
 * 连接池能正常淘汰旧连接，提交期间整个 Next 服务也不会卡住。
 */
function git(cwd: string, args: string[], opts: GitRunOptions = {}): Promise<string> {
  const { timeout = DEFAULT_TIMEOUT, input } = opts;
  const cmd = `git ${args.join(" ")}`;
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        // 凭证过期时快速失败，别把 Next 服务端挂死在一个等输入的进程上
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        CI: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        child.kill();
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} 失败：${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} 超时`));
        return;
      }
      if (code !== 0) {
        const detail = String(stderr || stdout || `退出码 ${code}`).trim().slice(0, 600);
        reject(new Error(`${cmd} 失败：${detail}`));
        return;
      }
      resolve(stdout);
    });
    // 进程提前退出时写 stdin 可能 EPIPE，错误统一由 close 事件回传
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
}

async function safeStatus(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ["status", "--porcelain"])).trim().slice(0, 300);
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

// 审阅页「代码提交」：工作目录直接取 run.repoRoot（定仓结果），不经过仓库名白名单；
// 仓库名只用于查合并分支配置，由调用方解析。
export function submitCode(opts: {
  repoRoot: string;
  targetBranch: string;
  message: string;
}): Promise<DeployGitResult> {
  const cwd = path.resolve(opts.repoRoot);
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    throw new Error(`工作目录不是 git 仓库：${cwd}`);
  }
  assertBranch(opts.targetBranch);
  return serializeRepo(cwd, () => deploy(cwd, opts.targetBranch, opts.message));
}

async function deploy(cwd: string, targetBranch: string, message: string): Promise<DeployGitResult> {
  const source = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (!source || source === "HEAD") {
    throw new Error("当前处于分离头指针状态，拒绝提交");
  }

  // 工作区此时是脏的：git 2.20 的 --autostash 只对 --rebase 生效，
  // 用 --rebase --autostash 一次完成「暂存改动 → 拉取最新 → 恢复改动」。
  await git(cwd, ["pull", "--rebase", "--autostash"], { timeout: NET_TIMEOUT });

  const dirty = (await git(cwd, ["status", "--porcelain"])).trim();
  const dirtyLines = dirty ? dirty.split("\n").length : 0;
  if (dirtyLines > 200) {
    throw new Error(`待提交改动过多（${dirtyLines} 个文件），疑似误提交，已中止`);
  }

  let committed = false;
  let commitSha = "";
  if (dirtyLines > 0) {
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-F", "-"], { input: message, timeout: COMMIT_TIMEOUT });
    commitSha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    committed = true;
  }

  await git(cwd, ["push"], { timeout: NET_TIMEOUT });
  // 工作区本来就干净（改动已被手工提交过）时，提交记录仍指向当前 HEAD
  if (!commitSha) commitSha = (await git(cwd, ["rev-parse", "HEAD"])).trim();

  let cherryPicked = false;
  if (committed && targetBranch !== source) {
    cherryPicked = await cherryPickTo(cwd, source, targetBranch, commitSha);
  }

  return { source, targetBranch, committed, cherryPicked, commitSha };
}

async function cherryPickTo(
  cwd: string,
  source: string,
  targetBranch: string,
  commitSha: string
): Promise<boolean> {
  await git(cwd, ["checkout", targetBranch], { timeout: NET_TIMEOUT });
  try {
    // 此刻工作区是干净的（改动刚提交完），--ff-only 足够；共享分支上分叉就报错，不重写历史
    await git(cwd, ["pull", "--ff-only"], { timeout: NET_TIMEOUT });
    try {
      await git(cwd, ["cherry-pick", commitSha]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 该提交此前已搬过一次：cherry-pick 得到空提交，按「已合并」处理
      if (/nothing to commit|now empty|previous cherry-pick/i.test(msg)) {
        try {
          await git(cwd, ["cherry-pick", "--abort"]);
        } catch {
          // 已无进行中的 cherry-pick
        }
        return false;
      }
      try {
        await git(cwd, ["cherry-pick", "--abort"]);
      } catch {
        // 忽略 abort 自身的失败
      }
      const status = await safeStatus(cwd);
      throw new Error(`cherry-pick 到 ${targetBranch} 失败：${msg}${status ? `；${status}` : ""}`);
    }
    await git(cwd, ["push"], { timeout: NET_TIMEOUT });
    return true;
  } finally {
    try {
      await git(cwd, ["checkout", source], { timeout: NET_TIMEOUT });
    } catch {
      // 已在原分支，或 checkout 失败 —— 不再掩盖上面的真实错误
    }
  }
}
