/**
 * febot 脚本共用件：仓库根、配置读取、git / state / 白名单等确定性工具。
 *
 * 只放确定性工具函数，不含业务判断；recon.mjs / feed.mjs / locate.mjs /
 * advance.mjs 共用，避免多份配置路径解析与 state 语义各自漂移。
 *
 * 根目录可被 FEBOT_ROOT 覆盖（优先于脚本所在的仓库根），仅用于 fixture 与
 * 隔离测试；REQUIREMENTS_DIR / TASKS_PATH 等全部由它派生。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 仓库根；FEBOT_ROOT 优先（fixture / 隔离测试用） */
export const ROOT = process.env.FEBOT_ROOT
  ? path.resolve(process.env.FEBOT_ROOT)
  : DEFAULT_ROOT;

export const REQUIREMENTS_DIR = path.join(ROOT, "docs", "requirements");
export const TEMPLATE_DIR = path.join(REQUIREMENTS_DIR, "_template");
export const TASKS_PATH = path.join(ROOT, "tasks.md");
export const FILE_LOCK_PATH = path.join(ROOT, "file-lock.md");
export const FEBOT_DATA_DIR = path.join(ROOT, ".febot");
export const INDEX_DIR = path.join(FEBOT_DATA_DIR, "index");
export const TMP_DIR = path.join(FEBOT_DATA_DIR, "tmp");

/** 别名契约：R- 后接字母、数字、连字符 */
export const ALIAS_RE = /^R-[A-Za-z0-9-]+$/;

/** 任务 ID / 标记文件名安全字符集 */
export const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** 合法的 tier：light 已删除，不读取、不写入 */
export const TIERS = ["full", "express"];

/** 状态机 phase 全集 */
export const PHASES = [
  "init",
  "locating",
  "planning",
  "plan_confirm",
  "coding",
  "code_review",
  "fixing",
  "verify",
  "done",
];

/** 敏感文件：命中即不允许 express 自动快轨 */
export const SENSITIVE_RE = /(^|\/)(\.env(\..*)?|febot\.config\.json|hindsight\.env)$/i;

/** 配置错误：调用方按自己的退出码契约转换为 FeedError / fail */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * 脚本错误：区分退出码。
 * 3 = 门禁 / 白名单 / 暂存 / HEAD / 分支；5 = 参数或契约；6 = 配置 / state / 归属。
 */
export class ScriptError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ScriptError";
    this.code = code;
    this.details = details;
  }
}

/**
 * 读 febot.config.json（不入库，由 yarn setup 生成）。
 * 查找顺序：FEBOT_CONFIG > <仓库根>/febot.config.json > <cwd>/febot.config.json。
 * 返回 { path, dir, raw }；找不到返回 null；JSON 非法抛 ConfigError。
 */
export function readConfig() {
  const candidates = [
    process.env.FEBOT_CONFIG ? path.resolve(process.env.FEBOT_CONFIG) : "",
    path.join(ROOT, "febot.config.json"),
    path.join(process.cwd(), "febot.config.json"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
    } catch {
      throw new ConfigError(`febot.config.json 不是合法 JSON：${p}`);
    }
    return {
      path: p,
      dir: path.dirname(p),
      raw: raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {},
    };
  }
  return null;
}

/**
 * 目标仓根目录：配置里的 repoRoot（相对路径按配置文件所在目录解析），
 * 缺配置时退回 <仓库根>/gitlab。
 */
export function reposRoot(cfg = readConfig()) {
  const raw = cfg?.raw?.repoRoot;
  if (cfg && typeof raw === "string" && raw.trim()) {
    const v = raw.trim();
    return path.isAbsolute(v) ? v : path.resolve(cfg.dir, v);
  }
  return path.join(ROOT, "gitlab");
}

/** 取某个 `## 标题` 到下一个 `## ` 之间的正文 */
export function section(md, title) {
  const lines = String(md).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${title}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * 关键词抽取前的去噪：去掉 fenced code block、行内代码、URL 与 markdown 链接地址。
 * 长描述直接做 2/3/4-gram 会产生大量噪声，recon / locate 只用去噪后的前 1200 字。
 */
export function stripNoise(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 中文关键词停用词（recon / locate 共用，避免两套启发式漂移） */
export const STOP_GRAMS = new Set([
  "系统", "管理", "功能", "支持", "需要", "进行", "问题", "一个", "可以",
  "相关", "内容", "查看", "显示", "默认", "页面", "模块", "需求", "要求",
  "数据", "如下", "并且", "以及", "其他", "如果", "必须", "不能", "当前",
]);

/**
 * 关键词切分：ASCII 词 + 中文 2/3/4-gram（去停用词）。
 * 与 recon.mjs §5 同语义，locate 复用同一套。
 */
export function splitKeywords(text) {
  const ascii = [
    ...new Set([...String(text).matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)].map((m) => m[0].toLowerCase())),
  ];
  const grams = [];
  for (const run of String(text).match(/[一-鿿]+/g) ?? []) {
    for (const n of [2, 3, 4]) {
      for (let i = 0; i + n <= run.length; i++) grams.push(run.slice(i, i + n));
    }
  }
  const cjk = [...new Set(grams.filter((g) => !(g.length === 2 && STOP_GRAMS.has(g))))];
  return { ascii, cjk, all: [...ascii, ...cjk] };
}

// ---------- 路径 ----------

/** Windows 反斜杠统一成 POSIX */
export function toPosix(p) {
  return String(p ?? "").replace(/\\/g, "/");
}

/**
 * 相对 ROOT 的展示路径；不在 ROOT 内则返回绝对路径（POSIX 分隔）。
 */
export function displayPath(abs) {
  const rel = path.relative(ROOT, abs);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return toPosix(rel);
  return toPosix(abs);
}

/** child 是否位于 parent 目录内（含自身） */
export function isPathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// ---------- 读写 ----------

/** 读文本并去 BOM（Windows / Excel 导出的计划文件常见） */
export function readText(abs) {
  return fs.readFileSync(abs, "utf8").replace(/^﻿/, "");
}

export function readJson(abs) {
  try {
    return JSON.parse(readText(abs));
  } catch (e) {
    throw new ScriptError(5, `不是合法 JSON：${displayPath(abs)}（${e.message}）`, {
      path: displayPath(abs),
    });
  }
}

/** 同目录 tmp-<pid> 落盘后 rename，避免写到一半留下半个 JSON */
export function writeJsonAtomic(abs, obj) {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `tmp-${process.pid}-${Date.now()}-${path.basename(abs)}`);
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, abs);
}

/** 文本原子写（用于 lastTransitionKey 同级的 markdown / marker） */
export function writeTextAtomic(abs, text) {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `tmp-${process.pid}-${Date.now()}-${path.basename(abs)}`);
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, abs);
}

// ---------- git ----------

/**
 * 执行 git，无 shell。失败抛 ScriptError(3)。
 * opts.raw 为真时返回未 trim 的原始输出（`-z` 输出必须以 NUL 解析，不能 trim）。
 */
export function git(repoDir, args, opts = {}) {
  try {
    const out = execFileSync("git", ["-C", repoDir, ...args], {
      encoding: "utf8",
      timeout: opts.timeout ?? 30000,
      maxBuffer: opts.maxBuffer ?? 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return opts.raw ? out : out.trim();
  } catch (e) {
    const detail =
      (e.stdout && String(e.stdout).trim()) ||
      (e.stderr && String(e.stderr).trim()) ||
      e.message ||
      "unknown error";
    throw new ScriptError(3, `git ${args.join(" ")} 失败：${detail}`, {
      repoDir: toPosix(repoDir),
      command: `git ${args.join(" ")}`,
    });
  }
}

/**
 * 门禁探测：**返回结果，不自己抛门禁错误**。
 * 调用方（feed / advance）按自己的退出码契约决定 3 还是 0。
 */
export function checkGate(repoDir, expectedBranch) {
  const branch = git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = git(repoDir, ["rev-parse", "HEAD"]);
  const status = git(repoDir, ["status", "--porcelain"]);
  return {
    branch,
    commit,
    expected: expectedBranch,
    status,
    branchOk: branch === expectedBranch,
    clean: status === "",
    dirty: status,
    checkedAt: new Date().toISOString(),
  };
}

// ---------- state / 白名单 ----------

const STATE_FILE = "state.json";

export function statePathOf(reqDir) {
  return path.join(reqDir, STATE_FILE);
}

export function readState(reqDir) {
  const p = statePathOf(reqDir);
  if (!fs.existsSync(p)) {
    throw new ScriptError(6, `state.json 不存在：${displayPath(p)}（请先跑 feed）`, {
      statePath: displayPath(p),
    });
  }
  const state = readJson(p);
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new ScriptError(6, `state.json 不是对象：${displayPath(p)}`);
  }
  return state;
}

/**
 * 原子读改写 state，保留未知字段。patch 可为对象或 (state) => void。
 * 返回写入后的 state。
 */
export function writeState(reqDir, patch) {
  const state = readState(reqDir);
  if (typeof patch === "function") patch(state);
  else Object.assign(state, patch);
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(statePathOf(reqDir), state);
  return state;
}

/** 期望分支统一为 baseBranch ?? branch */
export function expectedBranchOf(state) {
  return state?.baseBranch ?? state?.branch ?? null;
}

/** 从 tasks.md 第 5 列取仓库名；找不到返回 null */
export function repoFromTasks(alias) {
  if (!fs.existsSync(TASKS_PATH)) return null;
  const row = fs
    .readFileSync(TASKS_PATH, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("|") && l.split("|").map((s) => s.trim())[1] === alias);
  if (!row) return null;
  const repo = row.split("|").map((s) => s.trim())[5];
  return repo && repo !== "-" ? repo : null;
}

/**
 * 解析需求仓库目录：state.repo → tasks.md 第 5 列 → ScriptError(6)。
 * 返回绝对路径（不做存在性校验，调用方自己报更具体的错）。
 */
export function resolveRepoDir(state, cfg = readConfig()) {
  const repo = state?.repo || repoFromTasks(state?.requirement);
  if (!repo) {
    throw new ScriptError(6, `无法确定仓库：state.repo 与 tasks.md 第 5 列都为空`, {
      requirement: state?.requirement ?? null,
    });
  }
  return { repo, repoDir: path.join(reposRoot(cfg), repo) };
}

const GLOB_RE = /[*?[\]{}]/;

/** 校验单条白名单路径：仓库相对 POSIX、无 ..、无绝对路径、无反斜杠、无 glob */
export function assertSafeRelPath(p, label = "path") {
  const s = String(p ?? "").trim();
  if (!s) throw new ScriptError(5, `白名单 ${label} 为空`);
  if (s.includes("\\")) throw new ScriptError(5, `白名单 ${label} 含反斜杠：${s}`);
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s)) throw new ScriptError(5, `白名单 ${label} 是绝对路径：${s}`);
  if (s.split("/").includes("..")) throw new ScriptError(5, `白名单 ${label} 含 ..：${s}`);
  if (GLOB_RE.test(s)) throw new ScriptError(5, `白名单 ${label} 含 glob：${s}`);
  return s;
}

function asPathList(v, label) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ScriptError(5, `plan.files.json 的 ${label} 必须是数组`);
  return [...new Set(v.map((x) => assertSafeRelPath(x, label)))];
}

/**
 * 归一化 plan.files.json（A 超集）：
 * {files, deleted, conditional:[{path,reason,question}], exempt}
 * 兼容历史 conditional:string[]，升级并 warning。
 */
export function normalizeWhitelist(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ScriptError(5, "plan.files.json 必须是对象");
  }
  const warnings = [];
  const files = asPathList(raw.files, "files");
  const deleted = asPathList(raw.deleted, "deleted");
  const exempt = asPathList(raw.exempt, "exempt");

  const conditional = [];
  const rawCond = raw.conditional ?? [];
  if (!Array.isArray(rawCond)) throw new ScriptError(5, "plan.files.json 的 conditional 必须是数组");
  for (const item of rawCond) {
    if (typeof item === "string") {
      warnings.push(`conditional 旧格式（字符串）已升级：${item}`);
      conditional.push({ path: assertSafeRelPath(item, "conditional"), reason: null, question: null });
      continue;
    }
    if (!item || typeof item !== "object") {
      throw new ScriptError(5, "conditional 条目必须是对象 {path,reason,question}");
    }
    conditional.push({
      path: assertSafeRelPath(item.path, "conditional"),
      reason: typeof item.reason === "string" ? item.reason : null,
      question: typeof item.question === "string" ? item.question : null,
    });
  }

  const seen = new Map();
  for (const [list, label] of [
    [files, "files"],
    [deleted, "deleted"],
    [conditional.map((c) => c.path), "conditional.path"],
  ]) {
    for (const p of list) {
      if (seen.has(p)) {
        throw new ScriptError(5, `${p} 同时出现在 ${seen.get(p)} 与 ${label}（三者互斥）`);
      }
      seen.set(p, label);
    }
  }

  return { files, deleted, conditional, exempt, warnings };
}

/**
 * 读改动白名单。来源顺序：
 *   1. opts.filesFile（JSON 文件路径，不是内联 JSON）
 *   2. docs/requirements/<别名>/plan.files.json
 *   3. state.whitelist（可选快照）
 *   4. 报错并提示 --no-whitelist
 * 空数组表示「明确不允许改动」，与文件缺失区分。
 */
export function readWhitelist(reqDir, state, opts = {}) {
  if (opts.filesFile) {
    const abs = path.resolve(ROOT, opts.filesFile);
    if (!fs.existsSync(abs)) throw new ScriptError(5, `--files-file 不存在：${displayPath(abs)}`);
    return { ...normalizeWhitelist(readJson(abs)), source: "files-file", path: displayPath(abs) };
  }
  const planFiles = path.join(reqDir, "plan.files.json");
  if (fs.existsSync(planFiles)) {
    return { ...normalizeWhitelist(readJson(planFiles)), source: "plan.files.json", path: displayPath(planFiles) };
  }
  if (state && state.whitelist && typeof state.whitelist === "object") {
    return { ...normalizeWhitelist(state.whitelist), source: "state.whitelist", path: "state.json" };
  }
  if (opts.allowMissing) return { source: "none", path: null, files: [], deleted: [], conditional: [], exempt: [], warnings: [] };
  throw new ScriptError(5, "缺少 plan.files.json（可用 --files-file 指定，或 --no-whitelist 跳过白名单）", {
    planFiles: displayPath(planFiles),
  });
}
