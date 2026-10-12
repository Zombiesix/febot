import fs from "node:fs";
import path from "node:path";
import type { GitOptions } from "@/lib/domain/git";
import { readRootConfig, warnMissingConfig, type RootConfig } from "@/lib/server/config/root";

// 部署节点可选的仓库与目标分支，来自 febot.config.json（不入库，见 .gitignore）。
// 形状：
//   {
//     "repoRoot": "./gitlab",
//     "repos": ["<仓名>", ...],
//     "branches": { "candidates": ["dev"], "default": "dev" },
//     "jenkins": { "base": "https://jenkins.example.com/jenkins/job", "jobs": { "<仓名>": "<job>" } }
//   }
// 同时兼容旧形状（xiaoqian-manager/data/repos.json）：
//   { "root": "...", "repos": [...], "branches": ["dev"], "jenkins": { "<仓名>": "<完整URL>" } }
// 读不到配置时退回**空**列表（不再内置任何仓库名），并打一次告警。

interface GitConfig extends GitOptions {
  root: string;
}

const EMPTY_CONFIG: GitConfig = { root: "", repos: [], branches: [], jenkins: {} };

let cached: GitConfig | null = null;

function nonEmptyStrings(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const list = value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
  return list.length ? list : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** branches 支持两种形状：数组（旧）= 候选；对象（新）= { candidates, default } */
function branchesOf(value: unknown): { candidates: string[]; fallback: string } {
  if (Array.isArray(value)) {
    const list = nonEmptyStrings(value, []);
    return { candidates: list, fallback: list[0] ?? "" };
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const candidates = nonEmptyStrings(obj.candidates, []);
    const fallback = str(obj.default);
    // default 必须出现在候选里，否则下拉框选不到基准分支
    if (fallback && !candidates.includes(fallback)) candidates.unshift(fallback);
    return { candidates, fallback: fallback || candidates[0] || "" };
  }
  return { candidates: [], fallback: "" };
}

/** jenkins 支持两种形状：完整 URL map（旧）或 { base, jobs }（新） */
function jenkinsOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  const base = str(obj.base);
  if (base) {
    const jobs = (obj.jobs && typeof obj.jobs === "object" && !Array.isArray(obj.jobs)
      ? obj.jobs
      : {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [repo, job] of Object.entries(jobs)) {
      const j = str(job);
      if (repo.trim() && j) out[repo.trim()] = `${base.replace(/\/+$/, "")}/${j}/build?delay=0sec`;
    }
    return out;
  }
  // 旧形状：仓库名 -> 完整 URL
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const url = str(v);
    if (k.trim() && url) out[k.trim()] = url;
  }
  return out;
}

function fromRootConfig(rc: RootConfig): GitConfig {
  const repoRootRaw = str(rc.raw.repoRoot);
  // 相对路径以配置文件所在目录为基准，这样 cwd 是仓库根还是 xiaoqian-manager/ 都成立
  const root = repoRootRaw
    ? path.isAbsolute(repoRootRaw)
      ? repoRootRaw
      : path.resolve(rc.dir, repoRootRaw)
    : "";
  return {
    root,
    repos: nonEmptyStrings(rc.raw.repos, []),
    branches: branchesOf(rc.raw.branches).candidates,
    jenkins: jenkinsOf(rc.raw.jenkins),
  };
}

function fromLegacyFile(file: string): GitConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`配置文件不是合法 JSON：${file}`);
  }
  const obj = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  return {
    root: str(obj.root),
    repos: nonEmptyStrings(obj.repos, []),
    branches: branchesOf(obj.branches).candidates,
    jenkins: jenkinsOf(obj.jenkins),
  };
}

function loadConfig(): GitConfig {
  if (cached) return cached;

  // 1. GIT_REPOS_FILE：测试夹具显式指定，优先级最高
  const fromEnv = str(process.env.GIT_REPOS_FILE);
  if (fromEnv) {
    const p = path.resolve(fromEnv);
    if (fs.existsSync(p)) {
      cached = fromLegacyFile(p);
      return cached;
    }
  }

  // 2~4. febot.config.json（FEBOT_CONFIG 环境变量 → cwd → cwd/..）
  const rootCfg = readRootConfig();
  if (rootCfg) {
    cached = fromRootConfig(rootCfg);
    return cached;
  }

  // 5. 旧路径：xiaoqian-manager/data/repos.json
  const legacy = path.join(process.cwd(), "data", "repos.json");
  if (fs.existsSync(legacy)) {
    cached = fromLegacyFile(legacy);
    return cached;
  }

  warnMissingConfig();
  cached = { ...EMPTY_CONFIG };
  return cached;
}

export function readGitOptions(): GitOptions {
  const { repos, branches, jenkins } = loadConfig();
  return { repos, branches, jenkins };
}

// 仓库名必须来自配置白名单，且不含路径分隔符 —— 两道锁一起挡目录穿越。
export function resolveRepoPath(repo: string): string {
  const cfg = loadConfig();
  if (!cfg.root) {
    throw new Error("未配置仓库根目录：请在 febot.config.json 填写 repoRoot（或 repos.json 的 root）");
  }
  if (!cfg.repos.includes(repo)) {
    throw new Error(`仓库不在配置列表中：${repo}`);
  }
  if (/[\\/:]|\.\./.test(repo)) {
    throw new Error(`仓库名不合法：${repo}`);
  }
  const root = path.resolve(cfg.root);
  const full = path.join(root, repo);
  if (path.dirname(full) !== root) {
    throw new Error(`仓库路径越界：${repo}`);
  }
  if (!fs.existsSync(path.join(full, ".git"))) {
    throw new Error(`不是 git 仓库或目录不存在：${full}`);
  }
  return full;
}

export function assertBranch(branch: string): void {
  const cfg = loadConfig();
  if (!cfg.branches.includes(branch)) {
    throw new Error(`目标分支不在配置列表中：${branch}`);
  }
}
