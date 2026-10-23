/**
 * 需求 / 仓库 / 分支解析。
 *
 * 从 feed.mjs / recon.mjs 抽出，避免两套 tasks.md 与 projectMap 语义漂移。
 * 纯函数优先；调用方（feed / recon / locate / advance）按自己的退出码契约
 * 把 ScriptError 转换出去。
 */
import fs from "node:fs";
import path from "node:path";
import {
  ALIAS_RE,
  REQUIREMENTS_DIR,
  ROOT,
  ScriptError,
  TASKS_PATH,
  displayPath,
  readText,
  reposRoot,
  section,
} from "./febot.mjs";

/** 需求目录与 state 路径 */
export function requirementPaths(alias) {
  const reqDir = path.join(REQUIREMENTS_DIR, alias);
  return {
    alias,
    reqDir,
    contextPath: path.join(reqDir, "context.md"),
    statePath: path.join(reqDir, "state.json"),
  };
}

function assertAlias(alias) {
  if (!alias || !ALIAS_RE.test(alias)) {
    throw new ScriptError(5, `别名不合法：${alias ?? "（空）"}（只允许 "R-" 后接字母、数字、连字符）`);
  }
}

/**
 * 读需求：context.md 全文 + 标题 + 描述 + state（可能不存在）。
 * 不跑 git、不改任何文件。
 */
export function readRequirement(alias) {
  assertAlias(alias);
  const paths = requirementPaths(alias);
  if (!fs.existsSync(paths.contextPath)) {
    throw new ScriptError(5, `context.md 不存在：${displayPath(paths.contextPath)}（请先跑 feed）`, {
      contextPath: displayPath(paths.contextPath),
    });
  }
  const context = readText(paths.contextPath);
  let state = null;
  if (fs.existsSync(paths.statePath)) {
    try {
      state = JSON.parse(readText(paths.statePath));
    } catch {
      throw new ScriptError(6, `state.json 不是合法 JSON：${displayPath(paths.statePath)}`);
    }
  }
  return {
    ...paths,
    context,
    title: section(context, "需求标题"),
    description: section(context, "需求描述（全文）"),
    state,
  };
}

/**
 * 解析 tasks.md 中该别名的行。
 * 列：| 需求ID | 项目 | 优先级 | tier | 仓库 | 状态 | 入口 |
 */
export function parseTasksRow(alias) {
  if (!fs.existsSync(TASKS_PATH)) {
    throw new ScriptError(6, `tasks.md 不存在：${displayPath(TASKS_PATH)}（请先跑 yarn setup 生成）`);
  }
  const lines = fs.readFileSync(TASKS_PATH, "utf8").split(/\r?\n/);
  const idx = lines.findIndex(
    (l) => l.startsWith("|") && l.split("|").map((s) => s.trim())[1] === alias,
  );
  if (idx < 0) throw new ScriptError(6, `tasks.md 中找不到 ${alias} 的行，请先重跑 feed`);
  const cells = lines[idx].split("|").map((s) => s.trim());
  return {
    line: idx,
    cells,
    project: cells[2] || null,
    priority: cells[3] || null,
    tier: cells[4] || null,
    repo: cells[5] && cells[5] !== "-" ? cells[5] : null,
    status: cells[6] || null,
    entry: cells[7] || null,
  };
}

/** 分支解析：projectMap[].branch > branches.byRepo[repo] > branches.default */
export function resolveBranch(cfg, entry, repo) {
  if (entry && typeof entry.branch === "string" && entry.branch.trim()) {
    return { branch: entry.branch.trim(), source: "projectMap" };
  }
  const branches = cfg?.raw?.branches;
  if (
    branches &&
    typeof branches === "object" &&
    !Array.isArray(branches) &&
    branches.byRepo &&
    typeof branches.byRepo[repo] === "string" &&
    branches.byRepo[repo].trim()
  ) {
    return { branch: branches.byRepo[repo].trim(), source: "branches.byRepo" };
  }
  if (
    branches &&
    typeof branches === "object" &&
    !Array.isArray(branches) &&
    typeof branches.default === "string" &&
    branches.default.trim()
  ) {
    return { branch: branches.default.trim(), source: "branches.default" };
  }
  throw new ScriptError(
    6,
    `无法确定仓库 ${repo} 的基准分支：请配置 projectMap[].branch、branches.byRepo 或 branches.default`,
    { repo },
  );
}

/**
 * projectMap 定仓：产品/模块精确匹配 + 标题 keywords + 无关键词兜底。
 * 返回 { repo, repoDir, branch, branchSource }；未命中抛 2，配置歧义抛 6。
 */
export function resolveRepo(cfg, module, title) {
  const projectMap = cfg?.raw?.projectMap;
  if (!Array.isArray(projectMap)) {
    throw new ScriptError(6, "febot.config.json 缺少 projectMap 数组（请参考 example/febot.config.json）");
  }

  const candidates = projectMap.filter((e) => e && e.product === module);
  if (candidates.length === 0) {
    const known = [...new Set(projectMap.map((e) => e?.product).filter(Boolean))];
    throw new ScriptError(2, `projectMap 未命中：产品/模块 "${module}" 没有映射`, {
      module,
      knownProducts: known,
    });
  }

  const titleLower = String(title ?? "").toLowerCase();
  const keywordHits = candidates.filter(
    (e) =>
      Array.isArray(e.keywords) &&
      e.keywords.some((k) => String(k).trim() && titleLower.includes(String(k).trim().toLowerCase())),
  );
  let entry = keywordHits[0] ?? null;

  if (!entry) {
    const fallbacks = candidates.filter((e) => !Array.isArray(e.keywords) || e.keywords.length === 0);
    if (fallbacks.length === 0) {
      throw new ScriptError(2, `projectMap 命中 "${module}" 但没有无关键词的兜底条目`, {
        module,
        candidates: candidates.map((e) => ({ keywords: e.keywords ?? [], repo: e.repo })),
      });
    }
    if (fallbacks.length > 1) {
      throw new ScriptError(6, `projectMap 配置歧义："${module}" 有 ${fallbacks.length} 条无关键词兜底条目`, {
        module,
        repos: fallbacks.map((e) => e.repo),
      });
    }
    entry = fallbacks[0];
  }

  const repo = typeof entry.repo === "string" ? entry.repo.trim() : "";
  if (!repo) throw new ScriptError(6, `projectMap 中 "${module}" 的条目缺少 repo`);

  const repos = Array.isArray(cfg?.raw?.repos) ? cfg.raw.repos : [];
  if (!repos.includes(repo)) {
    throw new ScriptError(6, `仓库 "${repo}" 不在 febot.config.json 的 repos 中`, { repo, repos });
  }

  let reposDir;
  try {
    reposDir = reposRoot(cfg);
  } catch (e) {
    throw new ScriptError(6, e.message);
  }

  const resolved = resolveBranch(cfg, entry, repo);
  return {
    repo,
    repoDir: path.join(reposDir, repo),
    branch: resolved.branch,
    branchSource: resolved.source,
  };
}

/**
 * 只改 tasks.md 的 tier 列（第 4 列），供 advance set-tier 使用。
 * 找不到行抛 6；幂等（相同值也重写）。
 */
export function updateTasksTier(alias, tier) {
  const row = parseTasksRow(alias);
  const lines = fs.readFileSync(TASKS_PATH, "utf8").split(/\r?\n/);
  const cells = lines[row.line].split("|");
  // | 需求ID | 项目 | 优先级 | tier | 仓库 | 状态 | 入口 |
  cells[4] = ` ${tier} `;
  lines[row.line] = cells.join("|");
  fs.writeFileSync(TASKS_PATH, lines.join("\n"), "utf8");
  return { file: displayPath(TASKS_PATH), alias, tier };
}

/** 计划文件必须位于这些目录之一（相对 ROOT） */
export function allowedPlanDirs(alias) {
  return [path.join(ROOT, "xiaoqian-manager", "data", "temp"), requirementPaths(alias).reqDir];
}
