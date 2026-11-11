import type { GitOptions, GitProjectEntry } from "./git";

// 可视化设置的领域类型与派生规则。纯类型 + 纯函数，前后端都能 import。
//
// 配置只维护一份 `repositories[]` 登记表：仓库名、开发/合并分支、Jenkins Job、
// 项目名（可多个）都挂在同一条记录上。`repos` / `projectMap` / `branches` /
// `jenkins.jobs` 都是内存派生结果，不落配置。
//
// `devplatform.appNames` / `codeNameMap` 属 om/ 系统，本文件不读取、不改写。

export interface RepositoryProject {
  name: string;
  /** 同名项目映射到多个仓库时用于标题消歧 */
  keywords?: string[];
}

export interface SwaggerService {
  /** MCP 里的 service_name，跨仓全局唯一；建议带业务分组，如 cssd-default */
  name: string;
  /** swagger v2 api-docs 地址（可带 ?group=...） */
  url: string;
}

export interface RepositoryEntry {
  name: string;
  /** 覆盖 defaults.devBranch；为空时用全局默认 */
  devBranch?: string;
  /** 覆盖 defaults.mergeBranch；为空时用全局默认 */
  mergeBranch?: string;
  /** 只填 job 路径，地址由 jenkinsBase 拼 */
  jenkinsJob?: string;
  /** 本仓可用的 swagger 服务；由 yarn swagger 汇总进项目级 MCP */
  swagger?: SwaggerService[];
  projects: RepositoryProject[];
}

export interface SettingsDefaults {
  devBranch: string;
  mergeBranch: string;
}

export interface AppSettings {
  repoRoot: string;
  jenkinsBase: string;
  defaults: SettingsDefaults;
  repositories: RepositoryEntry[];
  features: { hindsight: boolean };
  nextDevOrigins: string[];
}

export interface SanitizedTeamworkSettings {
  base: string;
  username: string;
  loginName: string;
  userTag: string;
  tableId: string;
  users: string[];
  hasCredentials: boolean;
}

/** 可以安全返回给浏览器的设置（不回传 password / autograph / cookie） */
export interface SanitizedSettings {
  repoRoot: string;
  jenkinsBase: string;
  defaults: SettingsDefaults;
  repositories: RepositoryEntry[];
  teamwork: SanitizedTeamworkSettings;
  features: { hindsight: boolean };
  nextDevOrigins: string[];
}

/** PUT /api/settings 允许修改的字段（其余顶层键原样保留，om/ 的段落不动） */
export interface ConfigPatch {
  repoRoot?: string;
  jenkinsBase?: string;
  defaults?: Partial<SettingsDefaults>;
  repositories?: RepositoryEntry[];
  features?: { hindsight?: boolean };
  nextDevOrigins?: string[];
}

export const EMPTY_SETTINGS: AppSettings = {
  repoRoot: "",
  jenkinsBase: "",
  defaults: { devBranch: "", mergeBranch: "" },
  repositories: [],
  features: { hindsight: false },
  nextDevOrigins: [],
};

export function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim());
}

export function parseSwaggerServices(value: unknown): SwaggerService[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: SwaggerService[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const url = typeof obj.url === "string" ? obj.url.trim() : "";
    if (!name || !url) continue;
    // 服务名不能含 = / 换行：服务清单是 `name=url` 行格式
    if (name.includes("=") || /[\r\n]/.test(name) || /[\r\n]/.test(url)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, url });
  }
  return out;
}

export function parseRepositoryEntries(value: unknown): RepositoryEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: RepositoryEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name || seen.has(name)) continue;
    // 仓库名必须是单层目录名，挡掉路径穿越与嵌套路径
    if (/[\\/:]|\.\./.test(name)) continue;
    seen.add(name);

    const projects: RepositoryProject[] = [];
    if (Array.isArray(obj.projects)) {
      for (const p of obj.projects) {
        if (!p || typeof p !== "object" || Array.isArray(p)) continue;
        const po = p as Record<string, unknown>;
        const pname = typeof po.name === "string" ? po.name.trim() : "";
        if (!pname) continue;
        const keywords = nonEmptyStrings(po.keywords);
        projects.push(keywords.length ? { name: pname, keywords } : { name: pname });
      }
    }

    const entry: RepositoryEntry = { name, projects };
    const devBranch = typeof obj.devBranch === "string" ? obj.devBranch.trim() : "";
    const mergeBranch = typeof obj.mergeBranch === "string" ? obj.mergeBranch.trim() : "";
    const jenkinsJob = typeof obj.jenkinsJob === "string" ? obj.jenkinsJob.trim() : "";
    if (devBranch) entry.devBranch = devBranch;
    if (mergeBranch) entry.mergeBranch = mergeBranch;
    if (jenkinsJob) entry.jenkinsJob = jenkinsJob;
    const swagger = parseSwaggerServices(obj.swagger);
    if (swagger.length) entry.swagger = swagger;
    out.push(entry);
  }
  return out;
}

export function deriveProjectMap(repositories: RepositoryEntry[]): GitProjectEntry[] {
  const out: GitProjectEntry[] = [];
  for (const repo of repositories) {
    for (const project of repo.projects) {
      out.push({
        product: project.name,
        repo: repo.name,
        ...(project.keywords?.length ? { keywords: project.keywords } : {}),
      });
    }
  }
  return out;
}

export function deriveBranchCandidates(repositories: RepositoryEntry[], defaults: SettingsDefaults): string[] {
  const set = new Set<string>();
  for (const b of [defaults.devBranch, defaults.mergeBranch]) {
    if (b.trim()) set.add(b.trim());
  }
  for (const repo of repositories) {
    const dev = repo.devBranch?.trim();
    const merge = repo.mergeBranch?.trim();
    if (dev) set.add(dev);
    if (merge) set.add(merge);
  }
  return [...set];
}

export function jenkinsJobUrl(base: string, job: string): string {
  const b = base.trim().replace(/\/+$/, "");
  const j = job.trim().replace(/^\/+/, "");
  if (!b || !j) return "";
  return `${b}/${j}/build?delay=0sec`;
}

export function deriveGitOptions(settings: AppSettings): GitOptions {
  const devByRepo: Record<string, string> = {};
  const mergeByRepo: Record<string, string> = {};
  const jenkins: Record<string, string> = {};
  for (const repo of settings.repositories) {
    if (repo.devBranch?.trim()) devByRepo[repo.name] = repo.devBranch.trim();
    if (repo.mergeBranch?.trim()) mergeByRepo[repo.name] = repo.mergeBranch.trim();
    if (repo.jenkinsJob?.trim()) {
      const url = jenkinsJobUrl(settings.jenkinsBase, repo.jenkinsJob);
      if (url) jenkins[repo.name] = url;
    }
  }
  return {
    repos: settings.repositories.map((r) => r.name),
    branches: deriveBranchCandidates(settings.repositories, settings.defaults),
    jenkins,
    projectMap: deriveProjectMap(settings.repositories),
    devDefault: settings.defaults.devBranch.trim(),
    devByRepo,
    mergeDefault: settings.defaults.mergeBranch.trim(),
    mergeByRepo,
  };
}

/** 任务「模块」下拉与新增任务表单可选的已配置项目名 */
export function deriveProjectNames(settings: AppSettings): string[] {
  const set = new Set<string>();
  for (const repo of settings.repositories) {
    for (const p of repo.projects) {
      if (p.name.trim()) set.add(p.name.trim());
    }
  }
  return [...set].sort();
}

/** 首次启动初始化必填项校验：仓库根 + 至少一个仓库 + 开发/合并分支 + 至少一个项目 */
export function isSettingsInitialized(settings: AppSettings): boolean {
  if (!settings.repoRoot.trim()) return false;
  if (settings.repositories.length === 0) return false;
  const hasProject = settings.repositories.some((r) => r.projects.some((p) => p.name.trim()));
  if (!hasProject) return false;
  const hasDev = Boolean(settings.defaults.devBranch.trim()) || settings.repositories.some((r) => r.devBranch?.trim());
  const hasMerge =
    Boolean(settings.defaults.mergeBranch.trim()) || settings.repositories.some((r) => r.mergeBranch?.trim());
  return hasDev && hasMerge;
}