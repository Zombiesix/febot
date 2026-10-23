#!/usr/bin/env node
/**
 * locate - 确定性定位：仓库 → 模块 → 组件/文件
 *
 * 用法：node scripts/locate.mjs <别名> [--repo <仓名>] [--refresh] [--json]
 *
 * 产物（只写 docs/requirements/<别名>/ 与 .febot/，不改 state、不改仓库）：
 *   locate.md           锚点表 / 候选表 / file:line 片段 / 推荐轨道 / 确认清单
 *   locate.json         机器可读结果（confidence / recommendedTier / candidates …）
 *   selected-files.json 负责人可调整的候选清单（首生成；已存在且未 --refresh 不覆盖）
 *
 * 退出码：0 成功；1 indexer / 未预期失败；5 输入错误；6 配置 / 仓库解析错误。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ROOT,
  SENSITIVE_RE,
  ScriptError,
  TMP_DIR,
  displayPath,
  readConfig,
  reposRoot,
  splitKeywords,
  stripNoise,
  toPosix,
  writeJsonAtomic,
  writeTextAtomic,
} from "./lib/febot.mjs";
import { parseTasksRow, readRequirement } from "./lib/requirement.mjs";
import { loadRepoMap } from "./lib/repo-index.mjs";

const MAX_PATTERNS = 80;
const MAX_CANDIDATES = 12;
const EXPRESS_MAX_FILES = 5;

// ---------- 参数 ----------

function parseArgs(argv) {
  const out = { alias: null, repo: null, refresh: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--refresh") out.refresh = true;
    else if (a === "--json") out.json = true;
    else if (a === "--repo") {
      out.repo = argv[i + 1];
      if (!out.repo || out.repo.startsWith("--")) throw new ScriptError(5, "--repo 缺少参数值");
      i += 1;
    } else if (a.startsWith("--")) throw new ScriptError(5, `未知参数：${a}`);
    else if (!out.alias) out.alias = a;
    else throw new ScriptError(5, `多余参数：${a}`);
  }
  if (!out.alias) throw new ScriptError(5, "缺少别名，用法：node scripts/locate.mjs R-xxxxxx [--repo 仓名]");
  return out;
}

// ---------- 锚点抽取 ----------

function extractAnchors(text) {
  const anchors = [];
  const seen = new Set();
  const push = (type, value, weight = 1) => {
    const v = String(value ?? "").trim();
    if (!v || v.length < 2) return;
    const key = `${type}:${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    anchors.push({ type, value: v, weight, matched: false });
  };

  // 新参数 code：RY4.1.14.PBP.79605V
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]*(?:\.[A-Z0-9]+){2,}\b/g)) push("code", m[0], 3);

  // 路由：以 / 开头，排除 http(s)、//、src/、带文件扩展名的 token
  for (const token of text.split(/[^A-Za-z0-9_\-./{}:]+/)) {
    if (!token.startsWith("/") || token.length < 2) continue;
    if (token.includes("//")) continue;
    if (/^\/src\//i.test(token)) continue;
    if (/\.[A-Za-z0-9]{1,5}$/.test(token)) continue;
    if (/^\/+$/.test(token)) continue;
    push("route", token, 3);
  }

  // 引号词
  for (const re of [/"([^"\n]{1,40})"/g, /“([^”\n]{1,40})”/g, /「([^」\n]{1,40})」/g, /'([^'\n]{1,40})'/g]) {
    for (const m of text.matchAll(re)) push("quote", m[1], 2);
  }

  return anchors;
}

function cjkAnchors(text, limit) {
  const { cjk, ascii } = splitKeywords(stripNoise(text).slice(0, 1200));
  // 只留 4/3-gram：2-gram（护理、按钮、日期）在仓里到处命中，会把候选数推到十几个
  const ordered = [...cjk.filter((g) => g.length === 4), ...cjk.filter((g) => g.length === 3)];
  return { cjk: ordered.slice(0, limit), ascii };
}

// ---------- 匹配 ----------

function basenameOf(p) {
  return String(p ?? "").split("/").pop() ?? "";
}

function moduleOfRoute(modules, route) {
  return (
    modules.find((m) => m?.route?.path && m.route.path === route.path) ??
    modules.find((m) => route.name && m.name === route.name) ??
    modules.find((m) => m.dir && route.componentFile && route.componentFile.startsWith(`${m.dir}/`)) ??
    null
  );
}

/**
 * 结构命中（L1–L4/L6）建立候选骨架；L5 内容命中只补充打分。
 * `structuralDirs` 记录命中的模块目录：有结构命中时，模块外的纯内容命中不进入候选，
 * 否则一个常见中文词就能把候选数推到十几个，confidence 永远到不了 high。
 */
function buildCandidates(map, anchors) {
  const routes = Array.isArray(map.routes) ? map.routes : [];
  const modules = Array.isArray(map.modules) ? map.modules : [];
  const domains = Array.isArray(map.apiDomains) ? map.apiDomains : [];
  const components = map.components && typeof map.components === "object" ? map.components : {};

  const scores = new Map();
  const structuralDirs = new Map(); // dir -> module name

  const add = (file, points, evidence, structural = false) => {
    if (!file) return;
    const f = toPosix(file);
    const cur = scores.get(f) ?? { score: 0, evidence: [], structural: false };
    cur.score += points;
    if (evidence && !cur.evidence.includes(evidence)) cur.evidence.push(evidence);
    if (structural) cur.structural = true;
    scores.set(f, cur);
  };

  const markModule = (mod) => {
    if (mod?.dir) structuralDirs.set(toPosix(mod.dir), mod.name ?? toPosix(mod.dir));
  };

  const routeAnchors = anchors.filter((a) => a.type === "route");
  const labelAnchors = anchors.filter((a) => a.type === "quote" || a.type === "code");
  const nameAnchors = anchors.filter((a) => a.type === "route" || a.type === "quote" || a.type === "code");

  for (const a of routeAnchors) {
    for (const r of routes) {
      const p = String(r.path ?? "");
      if (!p || p === "/") continue;
      const hit = p === a.value || p.startsWith(`${a.value}/`) || a.value.startsWith(`${p}/`);
      if (!hit) continue;
      a.matched = true;
      add(r.componentFile, 100, `L1 route ${a.value}`, true);
      markModule(moduleOfRoute(modules, r));
    }
  }

  for (const a of labelAnchors) {
    const v = a.value.toLowerCase();
    for (const r of routes) {
      const label = String(r.label ?? "");
      if (!label) continue;
      const l = label.toLowerCase();
      const hit = l === v || (v.length >= 2 && (l.includes(v) || v.includes(l)));
      if (!hit) continue;
      a.matched = true;
      add(r.componentFile, 70, `L2 route label ${label}`, true);
      markModule(moduleOfRoute(modules, r));
    }
  }

  for (const a of nameAnchors) {
    const v = a.value.toLowerCase();
    for (const m of modules) {
      const name = String(m.name ?? "").toLowerCase();
      const label = String(m.label ?? "").toLowerCase();
      if (!(name === v || label === v || (v.length >= 3 && (name.includes(v) || label.includes(v))))) continue;
      a.matched = true;
      markModule(m);
      // 模块级锚点本身就很强：替代方案是列出模块全部组件，会撑爆候选数
      for (const c of m.components ?? []) add(c, 40, `L3 module ${m.name}`, true);
    }
  }

  for (const a of nameAnchors) {
    if (a.type !== "route" && a.type !== "code") continue;
    const v = a.value.toLowerCase();
    for (const m of modules) {
      for (const c of m.components ?? []) {
        if (basenameOf(c).toLowerCase().includes(v)) {
          a.matched = true;
          markModule(m);
          add(c, 25, `L4 component name ~ ${a.value}`, true);
        }
      }
    }
  }

  for (const a of nameAnchors) {
    const v = a.value.toLowerCase();
    for (const d of domains) {
      const name = String(d.name ?? "").toLowerCase();
      if (!(name === v || (v.length >= 3 && name.includes(v)))) continue;
      a.matched = true;
      for (const e of d.endpoints ?? []) add(e.file, 30, `L6 api domain ${d.name}`, true);
    }
  }

  return { scores, structuralDirs, routes, modules, domains, components };
}

/** 给命中模块内的既有候选 +20；不凭空把整个模块拉进候选 */
function applyModuleBonus(bundle) {
  if (bundle.structuralDirs.size === 0) return;
  for (const [file, info] of bundle.scores) {
    if (info.evidence.some((e) => e.includes("高置信模块"))) continue;
    for (const [dir, name] of bundle.structuralDirs) {
      if (file.startsWith(`${dir}/`)) {
        info.score += 20;
        info.evidence.push(`L1 高置信模块 ${name}`);
        break;
      }
    }
  }
}

/** 有结构命中时，丢掉模块外的纯内容命中（它们只是同词巧合） */
function filterCandidates(bundle) {
  const anyStructural = [...bundle.scores.values()].some((v) => v.structural);
  if (!anyStructural || bundle.structuralDirs.size === 0) return bundle;
  for (const [file, info] of [...bundle.scores]) {
    if (info.structural) continue;
    if ([...bundle.structuralDirs.keys()].some((dir) => file.startsWith(`${dir}/`))) continue;
    bundle.scores.delete(file);
  }
  return bundle;
}

// ---------- 内容检索（L5） ----------

function grepRepo(repoDir, patterns, alias) {
  const dir = TMP_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${alias}.patterns`);
  fs.writeFileSync(file, `${patterns.join("\n")}\n`, "utf8");

  try {
    const out = execFileSync(
      "git",
      [
        "-C",
        repoDir,
        "grep",
        "-n",
        "-I",
        "-F",
        "-f",
        file,
        "--",
        "*.vue",
        "*.ts",
        "*.tsx",
        "*.js",
        "*.jsx",
      ],
      { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
    return out;
  } catch (e) {
    // git grep 无命中 exit 1：是空结果，不是脚本失败
    if (e.status === 1) return "";
    const detail = (e.stderr && String(e.stderr).trim()) || e.message;
    throw new ScriptError(1, `git grep 失败：${String(detail).slice(0, 300)}`);
  }
}

function parseGrep(output) {
  const hits = [];
  for (const line of String(output).split(/\r?\n/)) {
    if (!line) continue;
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    hits.push({ file: toPosix(m[1]), line: Number(m[2]), text: m[3].trim().slice(0, 200) });
  }
  return hits;
}

// ---------- 打分与定级 ----------

const LOW_WEIGHT_RE = /(\.d\.ts$|\/test\/|\.(spec|test)\.[jt]sx?$|\/dict\.json$)/;

function scoreContent(hits, anchors, bundle) {
  const perFile = new Map();
  for (const h of hits) {
    const entry = perFile.get(h.file) ?? { anchors: new Set(), lines: [] };
    const matchedAnchor = anchors.find((a) => h.text.includes(a.value));
    if (matchedAnchor) {
      entry.anchors.add(matchedAnchor.value);
      matchedAnchor.matched = true;
    }
    if (entry.lines.length < 3) entry.lines.push({ line: h.line, text: h.text });
    perFile.set(h.file, entry);
  }
  for (const [file, entry] of perFile) {
    const points = Math.min(30, entry.anchors.size * 10);
    if (points > 0) {
      addTo(bundle, file, points, `L5 content ${[...entry.anchors].slice(0, 2).join(" / ")}`);
    }
  }
  return perFile;
}

function extractCodeHint(text) {
  const m = text.match(/\b[A-Z][A-Z0-9]*(?:\.[A-Z0-9]+){2,}\b/);
  if (!m) return null;
  const parts = m[0].split(".");
  return { code: m[0], prefix: parts.slice(0, 3).join(".") };
}

// ---------- 渲染 ----------

function mdTable(headers, rows) {
  if (rows.length === 0) return "（空）";
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (r) => `| ${r.map((c) => String(c ?? "").replace(/\|/g, "\\|") || " ").join(" | ")} |`,
  );
  return [head, sep, ...body].join("\n");
}

function renderLocateMd({ alias, repo, branch, index, anchors, candidates, snippets, confidence, recommendedTier, reasons }) {
  const L = [];
  L.push(`# ${alias} - 确定性定位（locate）`);
  L.push("");
  L.push(`> 由 \`node scripts/locate.mjs ${alias}\` 生成（确定性产出，无 LLM 判断）。`);
  L.push(`> 仓库：\`${repo}\`（${branch ?? "分支未知"}）；索引 HEAD：\`${String(index.head).slice(0, 12)}\`，缓存命中：${index.cached ? "是" : "否"}。`);
  L.push("");
  L.push("## 结论");
  L.push("");
  L.push(`- confidence：**${confidence}**`);
  L.push(`- recommendedTier：**${recommendedTier ?? "full"}**`);
  L.push(`- 候选数：${candidates.length}`);
  if (reasons.length) {
    L.push(`- 理由：`);
    for (const r of reasons) L.push(`  - ${r}`);
  }
  L.push("");
  L.push("## 锚点表");
  L.push("");
  L.push(
    mdTable(
      ["类型", "锚点", "命中"],
      anchors.map((a) => [a.type, a.value, a.matched ? "是" : "否"]),
    ),
  );
  L.push("");
  L.push("## 候选文件");
  L.push("");
  L.push(
    mdTable(
      ["文件", "分数", "证据", "建议动作", "备注"],
      candidates.map((c) => [
        c.file,
        c.score,
        c.evidence.join("；"),
        c.action,
        [c.sensitive ? "敏感文件" : "", c.note ?? ""].filter(Boolean).join("；") || "-",
      ]),
    ),
  );
  L.push("");
  L.push("## file:line 片段");
  L.push("");
  if (snippets.length === 0) {
    L.push("（无内容命中）");
  } else {
    for (const s of snippets) L.push(`- \`${s.file}:${s.line}\` ${s.text}`);
  }
  L.push("");
  L.push("## 推荐轨道");
  L.push("");
  L.push(
    recommendedTier === "express"
      ? "→ **express 快轨**：候选 ≤5、置信度高、无敏感文件，经负责人确认后可跳过 planning / code_review。"
      : "→ **full 全轨**：置信度不足 / 候选过多 / 含敏感文件，走 planner 全量规划。",
  );
  L.push("");
  L.push("## 确认清单");
  L.push("");
  if (candidates.length === 0) {
    L.push("（无候选；请走 full 或补充需求描述）");
  } else {
    for (const c of candidates.slice(0, EXPRESS_MAX_FILES)) L.push(`- [ ] \`${c.file}\``);
  }
  L.push("");
  return L.join("\n");
}

// ---------- 主流程 ----------

function run(alias, flags) {
  const req = readRequirement(alias);
  const cfg = readConfig();
  let repo = flags.repo || req.state?.repo || null;
  if (!repo) {
    try {
      repo = parseTasksRow(alias).repo;
    } catch {
      repo = null;
    }
  }
  if (!repo) {
    throw new ScriptError(6, `无法确定仓库：--repo、state.repo、tasks.md 第 5 列都为空`, { alias });
  }

  const repoDir = path.join(reposRoot(cfg), repo);
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new ScriptError(6, `仓库目录不存在：${displayPath(repoDir)}`, { repo, repoDir: displayPath(repoDir) });
  }

  const t0 = Date.now();
  const loaded = loadRepoMap(repoDir, { refresh: flags.refresh });
  const map = loaded.map;
  const cachedMs = Date.now() - t0;

  const text = `${req.title}\n${stripNoise(req.description)}`;
  const anchors = extractAnchors(text);
  const { cjk, ascii } = cjkAnchors(text, MAX_PATTERNS);

  // 内容检索锚点 = 引号词 / code + 中文 n-gram；中文只用来打分，不进 locate.json 的锚点表。
  // 路由锚点不进：模块内每个文件都在 import 路径里含它，只会把整目录染成候选。
  const contentAnchors = [
    ...anchors.filter((a) => a.type === "code" || a.type === "quote"),
    ...cjk.map((value) => ({ type: "cjk", value, weight: 1, matched: false })),
  ];

  // 引号词 / code 在前，中文 n-gram 在后；路由锚点已在 L1 精确匹配，
  // 放进内容检索只会命中满仓 import 路径
  const patterns = [
    ...new Set([
      ...anchors.filter((a) => a.type === "code" || a.type === "quote").map((a) => a.value),
      ...ascii,
      ...cjk,
    ]),
  ]
    .filter((v) => v && v.length >= 2)
    .slice(0, MAX_PATTERNS);

  const routeBundle = buildCandidates(map, anchors);

  // L5 内容检索：中文只进 patterns 文件，不进命令行
  const rawGrep = grepRepo(repoDir, patterns, alias);
  const hits = parseGrep(rawGrep);
  const perFileSnippets = scoreContent(hits, contentAnchors, routeBundle);

  // code 精确 / 前缀
  const hint = extractCodeHint(req.description);
  let codeNote = null;
  if (hint) {
    const exact = hits.filter((h) => h.text.includes(hint.code));
    if (exact.length) {
      for (const h of exact) addTo(routeBundle, h.file, 50, `code ${hint.code}`);
    } else {
      const sameFamily = hits.filter((h) => h.text.includes(hint.prefix));
      codeNote = sameFamily.length
        ? `新 code ${hint.code} 未命中；同类前缀 ${hint.prefix} 已有写法：${[
            ...new Set(sameFamily.map((h) => h.file)),
          ].slice(0, 5).join(", ")}`
        : `新 code ${hint.code} 与前缀 ${hint.prefix} 均未命中`;
    }
  }

  // 模块加成 + 丢掉模块外的纯内容巧合
  applyModuleBonus(routeBundle);
  filterCandidates(routeBundle);

  // 组装候选
  const candidates = [];
  for (const [file, info] of routeBundle.scores) {
    if (!file) continue;
    let score = info.score;
    let note = null;
    if (LOW_WEIGHT_RE.test(file)) {
      score = Math.floor(score / 2);
      note = "低权重（.d.ts / test / dict）";
    }
    candidates.push({
      file,
      score,
      evidence: info.evidence,
      action: "edit",
      sensitive: SENSITIVE_RE.test(file),
      note,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const top = candidates.slice(0, MAX_CANDIDATES);

  const structuralCount = top.filter((c) =>
    c.evidence.some((e) => /^L[1-3]\b/.test(e)),
  ).length;

  let confidence;
  if (anchors.length === 0 || top.length === 0) confidence = "low";
  else if (structuralCount > 0 && top.length <= 5) confidence = "high";
  else if (top.length >= 6 && top.length <= 8) confidence = "medium";
  else if (top.length > 8) confidence = "low";
  else confidence = structuralCount > 0 ? "high" : "medium";

  const reasons = [];
  if (anchors.length === 0) reasons.push("没有可用锚点（路由 / 引号词 / code 均未识别）");
  else reasons.push(`识别锚点 ${anchors.length} 个，命中 ${anchors.filter((a) => a.matched).length} 个`);
  reasons.push(`候选 ${top.length} 个，其中 L1–L3 结构化命中 ${structuralCount} 个`);
  if (codeNote) reasons.push(codeNote);

  const sensitiveHit = top.some((c) => c.sensitive);
  const hasStructuralAnchor = anchors.some((a) => a.matched && ["route", "quote", "code"].includes(a.type));
  const express =
    confidence === "high" &&
    top.length > 0 &&
    top.length <= EXPRESS_MAX_FILES &&
    !sensitiveHit &&
    hasStructuralAnchor;
  const recommendedTier = express ? "express" : "full";
  if (sensitiveHit) reasons.push("候选含敏感文件 → 必须 full");

  const selectedFiles = top.filter((c) => !c.sensitive).slice(0, EXPRESS_MAX_FILES).map((c) => c.file);

  // 片段：按候选顺序取前 12 条
  const snippets = [];
  for (const c of top) {
    const lines = perFileSnippets.get(c.file)?.lines ?? [];
    for (const l of lines) {
      if (snippets.length >= 12) break;
      snippets.push({ file: c.file, line: l.line, text: l.text });
    }
  }

  const branch = req.state?.baseBranch ?? req.state?.branch ?? null;
  const generatedAt = new Date().toISOString();
  const payload = {
    requirement: alias,
    repo,
    branch,
    index: {
      head: loaded.head,
      scannedAt: loaded.scannedAt,
      cached: loaded.cached,
      indexerVersion: loaded.indexerVersion,
    },
    confidence,
    recommendedTier,
    anchors: anchors.map((a) => ({ type: a.type, value: a.value, matched: a.matched })),
    candidates: top,
    selectedFiles,
    exempt: [],
    unmatchedAnchors: anchors.filter((a) => !a.matched).map((a) => a.value),
    codeHint: hint ? { code: hint.code, prefix: hint.prefix, note: codeNote } : null,
    generatedAt,
    elapsedMs: Date.now() - t0,
    cachedMs,
    indexElapsedMs: loaded.elapsedMs ?? null,
  };

  // 落盘
  const md = renderLocateMd({
    alias,
    repo,
    branch,
    index: payload.index,
    anchors: payload.anchors,
    candidates: top,
    snippets,
    confidence,
    recommendedTier,
    reasons,
  });
  writeTextAtomic(path.join(req.reqDir, "locate.md"), md);
  writeJsonAtomic(path.join(req.reqDir, "locate.json"), payload);

  const selectedPath = path.join(req.reqDir, "selected-files.json");
  if (!fs.existsSync(selectedPath) || flags.refresh) {
    writeJsonAtomic(selectedPath, { files: selectedFiles });
  }

  return payload;
}

function addTo(bundle, file, points, evidence) {
  if (!file) return;
  const f = toPosix(file);
  const cur = bundle.scores.get(f) ?? { score: 0, evidence: [], structural: false };
  cur.score += points;
  if (evidence && !cur.evidence.includes(evidence)) cur.evidence.push(evidence);
  bundle.scores.set(f, cur);
}

// ---------- 入口 ----------

try {
  const flags = parseArgs(process.argv.slice(2));
  const payload = run(flags.alias, flags);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stdout.write(
      `locate: ${payload.requirement} -> locate.md (confidence=${payload.confidence} ` +
        `recommended=${payload.recommendedTier} candidates=${payload.candidates.length} ` +
        `repo=${payload.repo} cached=${payload.index.cached ? 1 : 0} elapsed=${payload.elapsedMs}ms)\n`,
    );
  }
} catch (e) {
  const code = e instanceof ScriptError ? e.code : 1;
  const msg = e instanceof Error ? e.message : String(e);
  if (process.argv.includes("--json")) {
    const payload = { ok: false, code, error: msg };
    if (e instanceof ScriptError && e.details) payload.details = e.details;
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  process.stderr.write(`locate: ${msg}\n`);
  process.exitCode = code;
}
