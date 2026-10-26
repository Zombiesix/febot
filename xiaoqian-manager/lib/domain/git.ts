// 部署节点可选的仓库 / 目标分支，以及「任务 → 默认仓库/分支」的解析。
// 纯类型 + 纯函数，浏览器端可安全 import
// （服务端读取实现见 lib/server/git/config.ts，那里面用 node:fs，不能进客户端包）。

/** projectMap 的一条映射：产品/模块 → 目标仓库 */
export interface GitProjectEntry {
  product: string;
  /** 标题命中任一关键词时优先用这条（多条按数组顺序取第一条） */
  keywords?: string[];
  repo: string;
  /** 该产品线专用的基准分支；不填则按 byRepo / default 解析 */
  branch?: string;
}

export interface GitOptions {
  repos: string[];
  branches: string[];
  // 仓库目录名 -> Jenkins 构建地址
  jenkins: Record<string, string>;
  /** 产品/模块 → 目标仓库（定仓的唯一依据） */
  projectMap: GitProjectEntry[];
  /** 全局基准分支 */
  defaultBranch: string;
  /** 按仓库覆盖的基准分支 */
  branchByRepo: Record<string, string>;
}

export interface GitDefault {
  repo: string;
  branch: string;
}

export const EMPTY_GIT_OPTIONS: GitOptions = {
  repos: [],
  branches: [],
  jenkins: {},
  projectMap: [],
  defaultBranch: "",
  branchByRepo: {},
};

/**
 * 按 projectMap 定仓：产品/模块精确匹配 → 标题关键词 → 无关键词兜底。
 * 未命中或多条兜底（歧义）时返回 null —— 不猜，留给用户手选。
 */
function resolveProjectEntry(
  options: GitOptions,
  module: string,
  title: string,
): GitProjectEntry | null {
  const candidates = options.projectMap.filter((e) => e.product === module);
  if (candidates.length === 0) return null;

  const titleLower = String(title ?? "").toLowerCase();
  const keywordHit = candidates.find((e) =>
    e.keywords?.some((k) => {
      const keyword = k.trim().toLowerCase();
      return keyword !== "" && titleLower.includes(keyword);
    }),
  );
  if (keywordHit) return keywordHit;

  const fallbacks = candidates.filter((e) => !e.keywords?.length);
  return fallbacks.length === 1 ? fallbacks[0] : null;
}

/** 分支解析：projectMap[].branch > branches.byRepo[repo] > branches.default */
export function resolveBranchForRepo(
  options: GitOptions,
  repo: string,
): string {
  const fromProject = options.projectMap.find(
    (e) => e.repo === repo && e.branch?.trim(),
  )?.branch;
  const branch =
    fromProject?.trim() ||
    options.branchByRepo[repo]?.trim() ||
    options.defaultBranch.trim();
  // 不在候选里的分支下拉框选不到，宁可不填
  return branch && options.branches.includes(branch) ? branch : "";
}

/** 打开部署节点时回填的默认仓库与目标分支；任务数据不足以判定时返回 null。 */
export function resolveGitDefault(
  options: GitOptions,
  module: string,
  title: string,
): GitDefault | null {
  const entry = resolveProjectEntry(options, module, title);
  const repo = entry?.repo.trim() ?? "";
  // 仓库必须在配置的仓库列表里，否则下拉框没有对应选项
  if (!repo || !options.repos.includes(repo)) return null;
  // projectMap 条目写了自己的分支就用它，否则按仓库解析
  const own = entry?.branch?.trim();
  const branch =
    own && options.branches.includes(own)
      ? own
      : resolveBranchForRepo(options, repo);
  return { repo, branch };
}
