#!/usr/bin/env node
/**
 * feed - 把 PM 计划文件 / 口头需求接入流水线
 *
 * 用法：
 *   node scripts/feed.mjs --plan <计划文件> [--alias R-xxxxxx] [--module <产品/模块>] [--json] [--dry-run]
 *   node scripts/feed.mjs --set-tier <别名> --tier light|full --reason "<理由>" [--json]
 *
 * 职责：解析/校验计划文件 → 定仓库与基准分支 → 开工门禁 → 拷模板 → 写 context
 *       → upsert tasks.md → 最后写 state.json。所有操作确定性、可重跑。
 *
 * 退出码：0 成功（含已接入）；1 未预期异常；2 映射未命中；3 门禁失败；
 *         5 输入/格式不合契约；6 配置/环境错误。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT, ConfigError, readConfig, reposRoot, section } from "./lib/febot.mjs";

const REQUIREMENTS_DIR = path.join(ROOT, "docs", "requirements");
const TEMPLATE_DIR = path.join(REQUIREMENTS_DIR, "_template");
const TASKS_PATH = path.join(ROOT, "tasks.md");
const ALIAS_RE = /^R-[A-Za-z0-9-]+$/;
const TEXT_EXT = new Set([".md", ".json", ".txt"]);

const META_KEYS = new Set([
  "任务ID",
  "查询ID",
  "别名",
  "产品/模块",
  "版本",
  "状态",
  "难度",
  "任务类型",
  "最大工时",
  "执行人",
  "创建人",
]);

const USAGE = `用法:
  node scripts/feed.mjs --plan <计划文件> [--alias R-xxxxxx] [--module <产品/模块>] [--json] [--dry-run]
  node scripts/feed.mjs --set-tier <别名> --tier light|full --reason "<理由>" [--json]

退出码: 0 成功/已接入, 1 异常, 2 映射未命中, 3 门禁失败, 5 输入错误, 6 配置错误
`;

class FeedError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "FeedError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new FeedError(code, message, details);
}

// ---------- 通用 ----------

function displayPath(abs) {
  const rel = path.relative(ROOT, abs);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.replace(/\\/g, "/");
  return String(abs).replace(/\\/g, "/");
}

function readText(abs, code, label) {
  try {
    return fs.readFileSync(abs, "utf8").replace(/^﻿/, "");
  } catch {
    fail(code, `${label} 不存在或不可读：${displayPath(abs)}`);
  }
}

function readJson(abs, code, label) {
  const text = readText(abs, code, label);
  try {
    return JSON.parse(text);
  } catch {
    fail(code, `${label} 不是合法 JSON：${displayPath(abs)}`);
  }
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").trim();
}

function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function walkTextFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTextFiles(abs, out);
    else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) out.push(abs);
  }
  return out;
}

// ---------- 参数 ----------

function parseArgs(argv) {
  const out = {
    plan: null,
    alias: null,
    module: null,
    json: false,
    dryRun: false,
    setTier: null,
    tier: null,
    reason: null,
    help: false,
  };
  const take = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) fail(5, `${name} 缺少参数值`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "--plan":
        out.plan = take(i, "--plan");
        i += 1;
        break;
      case "--alias":
        out.alias = take(i, "--alias");
        i += 1;
        break;
      case "--module":
        out.module = take(i, "--module");
        i += 1;
        break;
      case "--json":
        out.json = true;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--set-tier":
        out.setTier = take(i, "--set-tier");
        i += 1;
        break;
      case "--tier":
        out.tier = take(i, "--tier");
        i += 1;
        break;
      case "--reason":
        out.reason = take(i, "--reason");
        i += 1;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        fail(5, `未知参数：${a}`);
    }
  }
  if (out.setTier && out.plan) fail(5, "--set-tier 与 --plan 不能同时使用");
  if (!out.setTier && (out.tier || out.reason)) fail(5, "--tier / --reason 只能与 --set-tier 一起使用");
  return out;
}

// ---------- 计划文件解析 ----------

function parsePlan(md, planAbs, args) {
  const text = String(md).replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);

  let titleIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === "") continue;
    titleIndex = i;
    break;
  }
  if (titleIndex === -1) fail(5, "计划文件为空");
  const titleMatch = lines[titleIndex].match(/^#\s+(.+?)\s*$/);
  if (!titleMatch || !titleMatch[1].trim()) {
    fail(5, `计划文件首个非空行必须是 "# 标题"：${lines[titleIndex].slice(0, 80)}`);
  }
  const title = titleMatch[1].trim();

  const meta = {};
  for (let i = titleIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    const m = line.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    if (!META_KEYS.has(key)) continue;
    meta[key] = m[2].trim();
  }

  const description = section(text, "问题描述");
  const assignment = section(text, "分配任务说明");

  const base = path.basename(planAbs).replace(/\.md$/i, "");
  const fromFile = /^R-oral-/.test(base) ? base : "";
  const explicit = args.alias ? args.alias.trim() : "";
  const fromMeta = (meta["别名"] || "").trim();
  const taskId = (meta["任务ID"] || "").trim();
  const fromTask = taskId ? `R-${taskId.slice(-6)}` : "";
  const alias = explicit || fromMeta || fromFile || fromTask;

  if (!alias) {
    fail(5, "无法推导别名：缺少 任务ID / 别名，且文件名不是 R-oral-*", {
      missing: ["任务ID 或 别名"],
    });
  }
  if (!ALIAS_RE.test(alias)) {
    fail(5, `别名不合法：${alias}（只允许 "R-" 后接字母、数字、连字符）`, { alias });
  }
  if (explicit && fromMeta && explicit !== fromMeta) {
    process.stderr.write(`feed: 警告：--alias ${explicit} 与计划文件别名 ${fromMeta} 不一致，按 --alias 处理\n`);
  }

  const maxHourRaw = (meta["最大工时"] || "").trim();
  const maxHour =
    maxHourRaw !== "" && Number.isFinite(Number(maxHourRaw)) ? Number(maxHourRaw) : null;

  const attachments = [
    ...new Set((`${description}\n${assignment}`).match(/https?:\/\/\S+/g) || []),
  ].map((u) => u.replace(/[)\]）,，。;；、'"]+$/g, ""));

  return {
    title,
    meta,
    description,
    assignment,
    attachments,
    alias,
    module: (args.module || meta["产品/模块"] || "").trim() || null,
    taskType: (meta["任务类型"] || "").trim() || null,
    level: (meta["难度"] || "").trim() || null,
    maxHour,
  };
}

function validatePlan(parsed, args) {
  const description = parsed.description.trim();
  if (!description || description === "（空）") {
    fail(5, "缺少问题描述：计划文件的 ## 问题描述 不能为空，且不能是「（空）」", {
      missing: ["问题描述"],
    });
  }
  if (!parsed.module) {
    fail(5, "缺少产品/模块：计划文件需有「产品/模块: <module>」行，或显式传 --module", {
      missing: ["产品/模块"],
    });
  }
  parsed.description = description;
  return parsed;
}

// ---------- 定仓与分支 ----------

function resolveRepo(cfg, module, title) {
  const projectMap = cfg.raw.projectMap;
  if (!Array.isArray(projectMap)) {
    fail(6, "febot.config.json 缺少 projectMap 数组（请参考 example/febot.config.json）");
  }

  const candidates = projectMap.filter((e) => e && e.product === module);
  if (candidates.length === 0) {
    const known = [...new Set(projectMap.map((e) => e?.product).filter(Boolean))];
    fail(2, `projectMap 未命中：产品/模块 "${module}" 没有映射`, {
      module,
      knownProducts: known,
    });
  }

  const titleLower = title.toLowerCase();
  const keywordHits = candidates.filter(
    (e) =>
      Array.isArray(e.keywords) &&
      e.keywords.some((k) => String(k).trim() && titleLower.includes(String(k).trim().toLowerCase())),
  );
  let entry = keywordHits[0] ?? null;

  if (!entry) {
    const fallbacks = candidates.filter((e) => !Array.isArray(e.keywords) || e.keywords.length === 0);
    if (fallbacks.length === 0) {
      fail(2, `productMap 命中 "${module}" 但没有无关键词的兜底条目`, {
        module,
        candidates: candidates.map((e) => ({ keywords: e.keywords ?? [], repo: e.repo })),
      });
    }
    if (fallbacks.length > 1) {
      fail(6, `projectMap 配置歧义："${module}" 有 ${fallbacks.length} 条无关键词兜底条目`, {
        module,
        repos: fallbacks.map((e) => e.repo),
      });
    }
    entry = fallbacks[0];
  }

  const repo = typeof entry.repo === "string" ? entry.repo.trim() : "";
  if (!repo) fail(6, `projectMap 中 "${module}" 的条目缺少 repo`);

  const repos = Array.isArray(cfg.raw.repos) ? cfg.raw.repos : [];
  if (!repos.includes(repo)) {
    fail(6, `仓库 "${repo}" 不在 febot.config.json 的 repos 中`, { repo, repos });
  }

  let reposDir;
  try {
    reposDir = reposRoot(cfg);
  } catch (e) {
    fail(6, e instanceof ConfigError ? e.message : String(e.message));
  }
  const repoDir = path.join(reposDir, repo);
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    fail(6, `仓库目录不存在：${displayPath(repoDir)}`, { repoDir: displayPath(repoDir) });
  }

  const resolved = resolveBranch(cfg, entry, repo);
  return { repo, repoDir, branch: resolved.branch, branchSource: resolved.source };
}

function resolveBranch(cfg, entry, repo) {
  const branches = cfg.raw.branches;
  if (entry && typeof entry.branch === "string" && entry.branch.trim()) {
    return { branch: entry.branch.trim(), source: "projectMap" };
  }
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
  fail(6, `无法确定仓库 ${repo} 的基准分支：请配置 projectMap[].branch、branches.byRepo 或 branches.default`, {
    repo,
  });
}

// ---------- 开工门禁 ----------

function git(repoDir, gitArgs) {
  try {
    return execFileSync("git", ["-C", repoDir, ...gitArgs], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    const detail =
      (e.stdout && String(e.stdout).trim()) ||
      (e.stderr && String(e.stderr).trim()) ||
      e.message ||
      "unknown error";
    fail(3, `git ${gitArgs.join(" ")} 失败：${detail}`, {
      repoDir: displayPath(repoDir),
      command: `git ${gitArgs.join(" ")}`,
    });
  }
}

function checkGate(repoDir, expectedBranch) {
  const head = git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = git(repoDir, ["status", "--porcelain"]);
  const checkedAt = new Date().toISOString();
  if (head !== expectedBranch) {
    fail(3, `分支不符：当前 ${head}，期望 ${expectedBranch}`, {
      head,
      expected: expectedBranch,
      status,
      repoDir: displayPath(repoDir),
    });
  }
  if (status) {
    fail(3, `工作区不干净（上一个需求可能还没提交）：\n${status}`, {
      head,
      expected: expectedBranch,
      dirty: status,
      repoDir: displayPath(repoDir),
    });
  }
  return { head, expected: expectedBranch, clean: true, checkedAt };
}

// ---------- 脚手架 ----------

function replacePlaceholders(reqDir, alias) {
  for (const abs of walkTextFiles(reqDir)) {
    const text = fs.readFileSync(abs, "utf8");
    if (!text.includes("{REQUIREMENT_ID}")) continue;
    fs.writeFileSync(abs, text.replaceAll("{REQUIREMENT_ID}", alias), "utf8");
  }
}

function contextMarkdown({ alias, title, description, assignment, attachments, planDisplay, repo, branch }) {
  const attachmentBlock = attachments.length
    ? attachments.map((u) => `- ${u}`).join("\n")
    : "（无）";
  const lines = [
    `# ${alias} - 需求上下文`,
    "",
    "## 需求标题",
    "",
    title,
    "",
    "## 需求来源",
    "",
    `- PM 文件：${planDisplay}`,
    `- tasks.md 条目：${alias}`,
    `- 目标仓库：${repo}`,
    `- 基准分支：${branch}`,
    "",
    "## 需求描述（全文）",
    "",
    description,
  ];
  if (assignment) lines.push("", assignment);
  lines.push(
    "",
    "## 附件",
    "",
    attachmentBlock,
    "",
    "## 关联代码位置",
    "",
    "（空）",
    "",
    "## 历史参考（Hindsight）",
    "",
    "（空）",
    "",
  );
  return lines.join("\n");
}

function upsertTaskRow(alias, module, repo) {
  if (!fs.existsSync(TASKS_PATH)) {
    fail(6, `tasks.md 不存在：${displayPath(TASKS_PATH)}（请先跑 yarn setup 生成）`);
  }
  const lines = fs.readFileSync(TASKS_PATH, "utf8").split(/\r?\n/);
  const row = `| ${cell(alias)} | ${cell(module)} | 待定 | 待定 | ${cell(repo)} | 待开始 | /pipeline ${cell(alias)} |`;
  const idx = lines.findIndex(
    (l) => l.startsWith("|") && l.split("|").map((s) => s.trim())[1] === alias,
  );
  if (idx >= 0) {
    lines[idx] = row;
  } else {
    let insertAt = lines.length;
    while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt -= 1;
    lines.splice(insertAt, 0, row);
  }
  fs.writeFileSync(TASKS_PATH, lines.join("\n"), "utf8");
}

function templateState() {
  const p = path.join(TEMPLATE_DIR, "state.json");
  try {
    return JSON.parse(readText(p, 6, "模板 state.json"));
  } catch (e) {
    if (e instanceof FeedError) throw e;
    fail(6, `模板 state.json 不是合法 JSON：${displayPath(p)}`);
  }
}

function writeState(statePath, { base, alias, taskId, demandId, repo, branch, gate }) {
  const state = { ...base };
  state.requirement = alias;
  state.tier = "full";
  state.phase = "init";
  state.iteration = Number.isInteger(state.iteration) ? state.iteration : 0;
  state.maxIteration = Number.isInteger(state.maxIteration) ? state.maxIteration : 2;
  state.blockers = Array.isArray(state.blockers) ? state.blockers : [];
  state.questions = Array.isArray(state.questions) ? state.questions : [];
  state.lastAgent = null;
  state.taskId = taskId || null;
  state.demandId = demandId || null;
  state.repo = repo;
  state.baseBranch = branch;
  state.gate = { checkedAt: gate.checkedAt, branchOk: true, cleanOk: true };
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

// ---------- 主流程 ----------

function tierHint(parsed) {
  return {
    taskType: parsed.taskType,
    level: parsed.level,
    maxHour: parsed.maxHour,
  };
}

function successPayload(parsed, ctx) {
  return {
    ok: true,
    alias: parsed.alias,
    already: ctx.already,
    title: parsed.title,
    module: parsed.module ?? null,
    repo: ctx.repo,
    repoDir: ctx.repoDir ? displayPath(ctx.repoDir) : null,
    branch: ctx.branch,
    branchSource: ctx.branchSource,
    gate: ctx.gate ?? null,
    requirementDir: displayPath(ctx.reqDir),
    statePath: displayPath(ctx.statePath),
    description: parsed.description ?? "",
    assignment: parsed.assignment ?? "",
    tierHint: tierHint(parsed),
    files: ctx.files,
    dryRun: ctx.dryRun,
    actions: ctx.actions,
  };
}

function emit(args, payload) {
  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (payload.already) {
    process.stdout.write(
      `feed: ${payload.alias} 已接入，跳过（state=${payload.statePath}）\n`,
    );
    return;
  }
  const prefix = payload.dryRun ? "feed(dry-run)" : "feed";
  process.stdout.write(
    `${prefix}: ${payload.alias} -> ${payload.requirementDir} repo=${payload.repo} branch=${payload.branch}\n`,
  );
}

function runFeed(args) {
  if (!args.plan) fail(5, "缺少 --plan <计划文件>");
  const planAbs = path.resolve(ROOT, args.plan);
  const md = readText(planAbs, 5, "计划文件");
  const parsed = parsePlan(md, planAbs, args);

  const reqDir = path.join(REQUIREMENTS_DIR, parsed.alias);
  const statePath = path.join(reqDir, "state.json");

  // 幂等判断先于门禁：接入后仓库本来就会有未提交改动，重跑不能被 exit 3 拦住。
  if (fs.existsSync(statePath)) {
    const state = readJson(statePath, 6, "state.json");
    const currentTaskId = (parsed.meta["任务ID"] || "").trim() || null;
    const prevTaskId = state.taskId || null;
    if (currentTaskId && prevTaskId && currentTaskId !== prevTaskId) {
      fail(6, `别名 ${parsed.alias} 已被任务 ${prevTaskId} 占用（当前 ${currentTaskId}）`, {
        alias: parsed.alias,
        existingTaskId: prevTaskId,
        currentTaskId,
      });
    }
    return emit(
      args,
      successPayload(parsed, {
        already: true,
        repo: state.repo ?? null,
        repoDir: null,
        branch: state.baseBranch ?? null,
        branchSource: null,
        gate: state.gate ?? null,
        reqDir,
        statePath,
        files: listFiles(reqDir),
        dryRun: args.dryRun,
        actions: [],
      }),
    );
  }

  if (fs.existsSync(reqDir) && fs.readdirSync(reqDir).length > 0) {
    fail(5, `目录已存在但缺少 state.json：${displayPath(reqDir)}（上次接入未完成，请人工删除该目录后重跑）`);
  }

  validatePlan(parsed, args);

  let cfg;
  try {
    cfg = readConfig();
  } catch (e) {
    fail(6, e.message);
  }
  if (!cfg) {
    fail(6, "未找到 febot.config.json（请先跑 yarn setup，或从 example/febot.config.json 复制）");
  }

  const resolved = resolveRepo(cfg, parsed.module, parsed.title);
  const gate = checkGate(resolved.repoDir, resolved.branch);

  const planDisplay = displayPath(planAbs) + (parsed.alias.startsWith("R-oral-") ? "（口头流程为临时计划文件，done 时删除）" : "");
  const context = contextMarkdown({
    alias: parsed.alias,
    title: parsed.title,
    description: parsed.description,
    assignment: parsed.assignment,
    attachments: parsed.attachments,
    planDisplay,
    repo: resolved.repo,
    branch: resolved.branch,
  });

  const actions = [
    { action: "copy-template", from: displayPath(TEMPLATE_DIR), to: displayPath(reqDir) },
    { action: "replace-placeholder", dir: displayPath(reqDir), placeholder: "{REQUIREMENT_ID}", value: parsed.alias },
    { action: "write-context", file: displayPath(path.join(reqDir, "context.md")) },
    { action: "upsert-tasks", file: displayPath(TASKS_PATH), alias: parsed.alias },
    { action: "write-state", file: displayPath(statePath) },
  ];

  if (args.dryRun) {
    return emit(
      args,
      successPayload(parsed, {
        already: false,
        repo: resolved.repo,
        repoDir: resolved.repoDir,
        branch: resolved.branch,
        branchSource: resolved.branchSource,
        gate,
        reqDir,
        statePath,
        files: listFiles(TEMPLATE_DIR),
        dryRun: true,
        actions,
      }),
    );
  }

  if (!fs.existsSync(TEMPLATE_DIR)) {
    fail(6, `模板目录不存在：${displayPath(TEMPLATE_DIR)}`);
  }
  // state.json 是「接入完成」的幂等标记：不随模板先落盘，否则中途失败会让重跑误判 already。
  const stateBase = templateState();
  fs.cpSync(TEMPLATE_DIR, reqDir, {
    recursive: true,
    filter: (src) => path.basename(src) !== "state.json",
  });
  replacePlaceholders(reqDir, parsed.alias);
  fs.writeFileSync(path.join(reqDir, "context.md"), context, "utf8");
  upsertTaskRow(parsed.alias, parsed.module, resolved.repo);
  writeState(statePath, {
    base: stateBase,
    alias: parsed.alias,
    taskId: (parsed.meta["任务ID"] || "").trim() || null,
    demandId: (parsed.meta["查询ID"] || "").trim() || null,
    repo: resolved.repo,
    branch: resolved.branch,
    gate,
  });

  return emit(
    args,
    successPayload(parsed, {
      already: false,
      repo: resolved.repo,
      repoDir: resolved.repoDir,
      branch: resolved.branch,
      branchSource: resolved.branchSource,
      gate,
      reqDir,
      statePath,
      files: listFiles(reqDir),
      dryRun: false,
      actions,
    }),
  );
}

// ---------- --set-tier ----------

function updateTasksTier(alias, tier) {
  if (!fs.existsSync(TASKS_PATH)) {
    fail(6, `tasks.md 不存在：${displayPath(TASKS_PATH)}`);
  }
  const lines = fs.readFileSync(TASKS_PATH, "utf8").split(/\r?\n/);
  const idx = lines.findIndex(
    (l) => l.startsWith("|") && l.split("|").map((s) => s.trim())[1] === alias,
  );
  if (idx < 0) fail(6, `tasks.md 中找不到 ${alias} 的行，请先重跑 feed`);
  const cells = lines[idx].split("|");
  // | 需求ID | 项目 | 优先级 | tier | 仓库 | 状态 | 入口 |
  cells[4] = ` ${tier} `;
  lines[idx] = cells.join("|");
  fs.writeFileSync(TASKS_PATH, lines.join("\n"), "utf8");
}

function upsertDecision(reqDir, tier, reason) {
  const p = path.join(reqDir, "decisions.md");
  if (!fs.existsSync(p)) fail(6, `decisions.md 不存在：${displayPath(p)}`);
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  const row = `| ${fmtLocal(new Date())} | tier=${tier} | pipeline-feed | ${cell(reason)} |`;
  const idx = lines.findIndex(
    (l) => l.startsWith("|") && l.split("|").map((s) => s.trim())[2]?.startsWith("tier="),
  );
  if (idx >= 0) {
    lines[idx] = row;
  } else {
    let insertAt = lines.length;
    while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt -= 1;
    lines.splice(insertAt, 0, row);
  }
  fs.writeFileSync(p, lines.join("\n"), "utf8");
}

function runSetTier(args) {
  const alias = (args.setTier || "").trim();
  if (!ALIAS_RE.test(alias)) {
    fail(5, `别名不合法：${alias}（只允许 "R-" 后接字母、数字、连字符）`);
  }
  const tier = (args.tier || "").trim();
  if (!["light", "full"].includes(tier)) fail(5, "--tier 必须是 light 或 full");
  const reason = (args.reason || "").trim();
  if (!reason) fail(5, "缺少 --reason（tier 判定理由）");

  const reqDir = path.join(REQUIREMENTS_DIR, alias);
  const statePath = path.join(reqDir, "state.json");
  if (!fs.existsSync(statePath)) {
    fail(5, `未接入：${displayPath(statePath)} 不存在，请先跑 feed`);
  }
  const state = readJson(statePath, 6, "state.json");
  const phase = tier === "full" ? "planning" : "coding";

  upsertDecision(reqDir, tier, reason);
  updateTasksTier(alias, tier);

  state.tier = tier;
  state.phase = phase;
  state.lastAgent = "orchestrator";
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const payload = {
    ok: true,
    alias,
    tier,
    phase,
    tasksUpdated: true,
    decisionsUpdated: true,
  };
  if (args.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else process.stdout.write(`feed: ${alias} tier=${tier} phase=${phase}\n`);
}

// ---------- 入口 ----------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.setTier) runSetTier(args);
  else runFeed(args);
}

const wantsJson = process.argv.slice(2).includes("--json");
try {
  main();
} catch (e) {
  const code = e instanceof FeedError ? e.code : 1;
  const message = e instanceof Error ? e.message : String(e);
  const payload = { ok: false, code, error: message };
  if (e instanceof FeedError && e.details) payload.details = e.details;
  if (wantsJson) process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.stderr.write(`feed: ${message}\n`);
  process.exitCode = code;
}
