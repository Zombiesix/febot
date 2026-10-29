import { execFileSync } from "node:child_process";
import path from "node:path";
import { aliasOfTask } from "../domain/run";
import { repoKeyOf } from "./repo-key";

export { repoKeyOf };

// 前置定仓：app 在启动会话前解析任务的目标仓。
//
// 不重复实现 projectMap 规则，而是调 febot 的 scripts/resolve-repo.mjs —— 它直接复用
// feed / recon / advance 共用的 lib/requirement.mjs，所以与剧本「定仓」同源，不会漂移。
//
// 解析失败（projectMap 未命中 / 仓库目录不存在 / 配置缺失）在 app 层直接拒绝，
// 不再白开一个注定死在 feed 门禁上的窗口。

const FEBOT_ROOT = path.resolve(process.cwd(), "..");
const RESOLVE_SCRIPT = path.join(FEBOT_ROOT, "scripts", "resolve-repo.mjs");

export interface ResolvedRepo {
  alias: string;
  module: string;
  repo: string;
  repoRoot: string;
  branch: string;
  branchSource: string;
}

export class RepoResolveError extends Error {
  code: number;
  details: unknown;
  constructor(message: string, code = 6, details?: unknown) {
    super(message);
    this.name = "RepoResolveError";
    this.code = code;
    this.details = details;
  }
}

interface ScriptPayload {
  ok?: boolean;
  code?: number;
  error?: string;
  details?: unknown;
  alias?: string | null;
  module?: string;
  repo?: string;
  repoDir?: string;
  branch?: string;
  branchSource?: string;
}

/**
 * @throws RepoResolveError code 2 = projectMap 未命中；5 = 输入；6 = 配置/环境
 */
export function resolveTargetRepo(task: {
  id: string;
  module: string;
  title: string;
}): ResolvedRepo {
  const alias = aliasOfTask(task.id);
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [RESOLVE_SCRIPT, "--json"], {
      cwd: FEBOT_ROOT,
      input: JSON.stringify({ module: task.module, title: task.title, alias }),
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
  } catch (e) {
    // execFileSync 在非 0 退出时抛错，但脚本已经把 JSON 写到 stdout 了
    const err = e as { stdout?: string; message?: string };
    if (!err.stdout || !String(err.stdout).trim()) {
      throw new RepoResolveError(
        `无法定位目标仓库（resolve-repo.mjs 执行失败）：${err.message ?? "unknown"}`,
        6,
      );
    }
    stdout = String(err.stdout);
  }

  const lastLine = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!lastLine) {
    throw new RepoResolveError("无法定位目标仓库：resolve-repo.mjs 没有输出", 6);
  }

  let payload: ScriptPayload;
  try {
    payload = JSON.parse(lastLine) as ScriptPayload;
  } catch {
    throw new RepoResolveError(`无法解析定仓结果：${lastLine.slice(0, 200)}`, 6);
  }
  if (!payload.ok) {
    throw new RepoResolveError(payload.error ?? "无法定位目标仓库", payload.code ?? 6, payload.details);
  }
  if (!payload.repoDir || !payload.repo) {
    throw new RepoResolveError("定仓结果缺少 repo/repoDir", 6);
  }

  return {
    alias: payload.alias ?? alias,
    module: payload.module ?? task.module,
    repo: payload.repo,
    repoRoot: payload.repoDir,
    branch: payload.branch ?? "",
    branchSource: payload.branchSource ?? "",
  };
}
