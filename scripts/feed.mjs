#!/usr/bin/env node
/**
 * feed - 把 PM 计划文件 / 口头需求接入流水线
 *
 * 用法：
 *   node scripts/feed.mjs --plan <计划文件> [--alias R-xxxxxx] [--module <产品/模块>] [--json] [--dry-run]
 *
 * 职责：解析/校验计划文件 → 定仓库与基准分支 → 开工门禁 → 拷模板 → 写 context
 *       → upsert tasks.md → 最后写 state.json。所有操作确定性、可重跑。
 *
 * 默认写 tier=full / phase=init；tier 不再由 feed 判定，locate 后由
 * `advance set-tier` 决定 full | express。`--set-tier` 已移除（exit 5）。
 *
 * 退出码：0 成功（含已接入）；1 未预期异常；2 映射未命中；3 门禁失败；
 *         5 输入/格式不合契约；6 配置/环境错误。
 */
import fs from "node:fs";
import path from "node:path";
import {
  REQUIREMENTS_DIR,
  ROOT,
  ScriptError,
  TASKS_PATH,
  TEMPLATE_DIR,
  checkGate,
  displayPath,
  isPathInside,
  readConfig,
  readText,
  section,
  toPosix,
} from "./lib/febot.mjs";
import { resolveRepo as resolveRepoFromCfg } from "./lib/requirement.mjs";

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

默认 tier=full / phase=init；接入后用 node scripts/advance.mjs set-tier 选择 full|express。
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

/** lib 的 ScriptError（2/5/6）转成 feed 自己的业务退出码 */
function rethrowAsFeedError(e) {
  if (e instanceof FeedError) throw e;
  if (e instanceof ScriptError) throw new FeedError(e.code, e.message, e.details);
  throw e;
}

// ---------- 通用 ----------

function readTextOrFail(abs, code, label) {
  try {
    return readText(abs);
  } catch {
    fail(code, `${label} 不存在或不可读：${displayPath(abs)}`);
  }
}

function readJsonOrFail(abs, code, label) {
  const text = readTextOrFail(abs, code, label);
  try {
    return JSON.parse(text);
  } catch {
    fail(code, `${label} 不是合法 JSON：${displayPath(abs)}`);
  }
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").trim();
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
  const out = { plan: null, alias: null, module: null, json: false, dryRun: false, help: false };
  if (argv.includes("--set-tier")) {
    fail(
      5,
      "--set-tier 已移除：feed 默认 tier=full；tier 由 locate 结果决定，请用 " +
        "`node scripts/advance.mjs set-tier <别名> --tier full|express`",
    );
  }
  if (argv.includes("--tier") || argv.includes("--reason")) {
    fail(5, "--tier / --reason 已移除，请改用 `advance set-tier`");
  }
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
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        fail(5, `未知参数：${a}`);
    }
  }
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

function validatePlan(parsed) {
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
  let resolved;
  try {
    resolved = resolveRepoFromCfg(cfg, module, title);
  } catch (e) {
    rethrowAsFeedError(e);
  }

  const repoDir = resolved.repoDir;
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    fail(6, `仓库目录不存在：${displayPath(repoDir)}`, { repoDir: displayPath(repoDir) });
  }
  return resolved;
}

// ---------- 开工门禁 ----------

function gateOrFail(repoDir, branch) {
  let g;
  try {
    g = checkGate(repoDir, branch);
  } catch (e) {
    rethrowAsFeedError(e);
  }
  if (!g.branchOk) {
    fail(3, `分支不符：当前 ${g.branch}，期望 ${branch}`, {
      head: g.branch,
      expected: branch,
      status: g.status,
      repoDir: displayPath(repoDir),
    });
  }
  if (!g.clean) {
    fail(3, `工作区不干净（上一个需求可能还没提交）：\n${g.status}`, {
      head: g.branch,
      expected: branch,
      dirty: g.status,
      repoDir: displayPath(repoDir),
    });
  }
  return g;
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
    return JSON.parse(readTextOrFail(p, 6, "模板 state.json"));
  } catch (e) {
    if (e instanceof FeedError) throw e;
    fail(6, `模板 state.json 不是合法 JSON：${displayPath(p)}`);
  }
}

/**
 * 计划文件相对 ROOT 的路径；只接受 xiaoqian-manager/data/temp 与需求目录内的文件。
 * 不在允许目录 → null + stderr 警告（不阻塞旧用法）。
 */
function computePlanFile(alias, planAbs) {
  const allowed = [
    path.join(ROOT, "xiaoqian-manager", "data", "temp"),
    path.join(REQUIREMENTS_DIR, alias),
  ];
  if (allowed.some((d) => isPathInside(d, planAbs))) return toPosix(displayPath(planAbs));
  process.stderr.write(
    `feed: 警告：计划文件不在 xiaoqian-manager/data/temp 或 docs/requirements/${alias} 内，state.planFile 置空\n`,
  );
  return null;
}

function writeState(statePath, { base, alias, taskId, demandId, repo, branch, gate, planFile }) {
  const state = { ...base };
  state.requirement = alias;
  state.tier = "full";
  state.phase = "init";
  state.iteration = Number.isInteger(state.iteration) ? state.iteration : 0;
  state.maxIteration = Number.isInteger(state.maxIteration) ? state.maxIteration : 2;
  state.blockers = Array.isArray(state.blockers) ? state.blockers : [];
  state.questions = Array.isArray(state.questions) ? state.questions : [];
  state.lastAgent = "orchestrator";
  state.taskId = taskId || null;
  state.demandId = demandId || null;
  state.repo = repo;
  state.baseBranch = branch;
  state.planFile = planFile;
  state.gate = {
    checkedAt: gate.checkedAt,
    branch: gate.branch,
    head: gate.commit,
    branchOk: true,
    cleanOk: true,
  };
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
    planFile: ctx.planFile ?? null,
    requirementDir: displayPath(ctx.reqDir),
    statePath: displayPath(ctx.statePath),
    description: parsed.description ?? "",
    assignment: parsed.assignment ?? "",
    tierHint: tierHint(parsed),
    files: ctx.files,
    dryRun: ctx.dryRun,
    elapsedMs: ctx.elapsedMs ?? null,
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
    `${prefix}: ${payload.alias} -> ${payload.requirementDir} repo=${payload.repo} branch=${payload.branch} tier=full phase=init\n`,
  );
}

function runFeed(args) {
  const t0 = Date.now();
  if (!args.plan) fail(5, "缺少 --plan <计划文件>");
  const planAbs = path.resolve(ROOT, args.plan);
  const md = readTextOrFail(planAbs, 5, "计划文件");
  const parsed = parsePlan(md, planAbs, args);

  const reqDir = path.join(REQUIREMENTS_DIR, parsed.alias);
  const statePath = path.join(reqDir, "state.json");

  // 幂等判断先于门禁：接入后仓库本来就会有未提交改动，重跑不能被 exit 3 拦住。
  if (fs.existsSync(statePath)) {
    const state = readJsonOrFail(statePath, 6, "state.json");
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
        branch: state.baseBranch ?? state.branch ?? null,
        branchSource: null,
        gate: state.gate ?? null,
        planFile: state.planFile ?? null,
        reqDir,
        statePath,
        files: listFiles(reqDir),
        dryRun: args.dryRun,
        elapsedMs: Date.now() - t0,
        actions: [],
      }),
    );
  }

  if (fs.existsSync(reqDir) && fs.readdirSync(reqDir).length > 0) {
    fail(5, `目录已存在但缺少 state.json：${displayPath(reqDir)}（上次接入未完成，请人工删除该目录后重跑）`);
  }

  validatePlan(parsed);

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
  const gate = gateOrFail(resolved.repoDir, resolved.branch);
  const planFile = computePlanFile(parsed.alias, planAbs);

  const planDisplay =
    displayPath(planAbs) + (parsed.alias.startsWith("R-oral-") ? "（口头流程为临时计划文件，done 时删除）" : "");
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
        planFile,
        reqDir,
        statePath,
        files: listFiles(TEMPLATE_DIR),
        dryRun: true,
        elapsedMs: Date.now() - t0,
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
    planFile,
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
      planFile,
      reqDir,
      statePath,
      files: listFiles(reqDir),
      dryRun: false,
      elapsedMs: Date.now() - t0,
      actions,
    }),
  );
}

// ---------- 入口 ----------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  runFeed(args);
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
