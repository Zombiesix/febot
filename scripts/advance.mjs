#!/usr/bin/env node
/**
 * advance - 流水线状态的唯一机械写入器
 *
 * 用法：
 *   node scripts/advance.mjs status <别名> [--json]
 *   node scripts/advance.mjs gate <别名> [--init] [--enforce-clean] [--record]
 *   node scripts/advance.mjs set-phase <别名> --phase <p> [--agent a] [--note-file md]
 *        [--inc-iteration] [--blockers-file json] [--questions-file json]
 *        [--allow-conditional] [--force] [--dry-run]
 *   node scripts/advance.mjs set-tier <别名> --tier full|express [--files-file json]
 *        [--reason-file md] [--reason ascii] [--force] [--dry-run]
 *   node scripts/advance.mjs check <别名> [--files-file] [--no-whitelist] [--mode done|review]
 *   node scripts/advance.mjs review-input <别名> [--files-file] [--max-bytes n] [--max-file-bytes n]
 *   node scripts/advance.mjs approve-files <别名> --q Q1 [--reject]
 *   node scripts/advance.mjs timing <别名> --name <stage> --machine-ms <n> [--wait-ms <n>] [--add]
 *   node scripts/advance.mjs done <别名> [--task-id id] [--plan-file md] [--files-file json]
 *        [--no-whitelist] [--dry-run]
 *
 * 所有子命令始终输出一行 JSON（stdout）。
 * 退出码：0 成功/幂等；1 未预期异常；2 保留（feed 映射未命中）；3 门禁；
 *         5 参数或契约；6 配置 / state / marker 归属。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  ALIAS_RE,
  FILE_LOCK_PATH,
  PHASES,
  ROOT,
  SAFE_ID,
  ScriptError,
  TIERS,
  displayPath,
  expectedBranchOf,
  git,
  isPathInside,
  normalizeWhitelist,
  readConfig,
  readJson,
  readState,
  readText,
  readWhitelist,
  resolveRepoDir,
  toPosix,
  writeJsonAtomic,
  writeState,
  writeTextAtomic,
} from "./lib/febot.mjs";
import { allowedPlanDirs, requirementPaths, updateTasksTier } from "./lib/requirement.mjs";

// ---------- 参数 ----------

const VALUE_FLAGS = new Set([
  "--phase",
  "--agent",
  "--note",
  "--note-file",
  "--blockers-file",
  "--questions-file",
  "--tier",
  "--files-file",
  "--reason",
  "--reason-file",
  "--mode",
  "--q",
  "--name",
  "--machine-ms",
  "--wait-ms",
  "--task-id",
  "--plan-file",
  "--max-bytes",
  "--max-file-bytes",
]);

const BOOL_FLAGS = new Set([
  "--json",
  "--dry-run",
  "--force",
  "--inc-iteration",
  "--allow-conditional",
  "--init",
  "--enforce-clean",
  "--record",
  "--no-whitelist",
  "--reject",
  "--add",
  "--help",
]);

function parseArgs(argv) {
  const sub = argv[0];
  const out = { sub, alias: null, flags: {}, _: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (!out.alias) out.alias = a;
      else out._.push(a);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new ScriptError(5, `${a} 缺少参数值`);
      }
      out.flags[a.slice(2)] = v;
      i += 1;
    } else if (BOOL_FLAGS.has(a)) {
      out.flags[a.slice(2)] = true;
    } else {
      throw new ScriptError(5, `未知参数：${a}`);
    }
  }
  return out;
}

function requireAlias(alias) {
  if (!alias) throw new ScriptError(5, "缺少别名，用法：node scripts/advance.mjs <子命令> <别名>");
  if (!ALIAS_RE.test(alias)) {
    throw new ScriptError(5, `别名不合法：${alias}（只允许 "R-" 后接字母、数字、连字符）`);
  }
  return alias;
}

function readFlagFile(flags, key) {
  if (!flags[key]) return null;
  const abs = path.resolve(ROOT, flags[key]);
  if (!fs.existsSync(abs)) throw new ScriptError(5, `--${key} 不存在：${displayPath(abs)}`);
  return readText(abs).trim();
}

function assertAscii(value, flag) {
  if (/[^\x20-\x7E]/.test(value)) {
    throw new ScriptError(
      5,
      `${flag} 只允许 ASCII；含中文请写进文件并用 --${flag}-file（本机含中文的 Bash 命令会 exit 127）`,
    );
  }
}

// ---------- 输出 ----------

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function nowIso() {
  return new Date().toISOString();
}

function fmtLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function transitionKey(...parts) {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

// ---------- state 辅助 ----------

function loadState(alias) {
  const { reqDir } = requirementPaths(alias);
  const state = readState(reqDir);
  if (state.requirement && state.requirement !== alias) {
    throw new ScriptError(6, `state.requirement=${state.requirement} 与别名 ${alias} 不一致`, {
      alias,
      requirement: state.requirement,
    });
  }
  const phase = state.phase || "init";
  if (!PHASES.includes(phase)) {
    throw new ScriptError(6, `state.phase 非法：${phase}`, { phase, allowed: PHASES });
  }
  if (state.tier && !TIERS.includes(state.tier)) {
    throw new ScriptError(6, `state.tier 非法：${state.tier}（light 已删除；请用 advance set-tier 选择 full|express）`, {
      tier: state.tier,
    });
  }
  return { reqDir, state, phase };
}

function ensureTimings(state) {
  if (!state.timings || typeof state.timings !== "object") state.timings = {};
  if (!state.timings.phases || typeof state.timings.phases !== "object") state.timings.phases = {};
  if (!state.timings.machineMs || typeof state.timings.machineMs !== "object") state.timings.machineMs = {};
  if (!state.timings.waitMs || typeof state.timings.waitMs !== "object") state.timings.waitMs = {};
  return state.timings;
}

function enterPhaseTiming(state, phase, at = nowIso()) {
  const t = ensureTimings(state);
  t.phases[phase] = { enteredAt: at, exitedAt: null, wallMs: null };
}

function exitPhaseTiming(state, phase, at = nowIso()) {
  const t = ensureTimings(state);
  const p = t.phases[phase];
  if (!p) {
    t.phases[phase] = { enteredAt: null, exitedAt: at, wallMs: null };
    return;
  }
  p.exitedAt = at;
  p.wallMs = p.enteredAt ? Math.max(0, new Date(at).getTime() - new Date(p.enteredAt).getTime()) : null;
}

function readLocateJson(reqDir) {
  const p = path.join(reqDir, "locate.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(readText(p));
  } catch {
    return null;
  }
}

function locateSummary(loc) {
  if (!loc || typeof loc !== "object") return null;
  return {
    confidence: loc.confidence ?? null,
    recommendedTier: loc.recommendedTier ?? null,
    candidateCount: Array.isArray(loc.candidates) ? loc.candidates.length : 0,
    indexHead: loc.index?.head ?? null,
    generatedAt: loc.generatedAt ?? null,
  };
}

// ---------- log / decisions ----------

function logLine(key, text) {
  return `- ${fmtLocal()} ${text} <!-- key:${key} -->`;
}

/**
 * 追加 orchestrator-log.md；同 key 已存在则跳过（重试只补缺失行）。
 * 失败不阻塞 —— 返回 warning。
 */
function appendLog(reqDir, key, text) {
  const p = path.join(reqDir, "orchestrator-log.md");
  try {
    const existing = fs.existsSync(p) ? readText(p) : "";
    if (existing.includes(`<!-- key:${key} -->`)) return null;
    const body = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
    fs.writeFileSync(p, `${body}${logLine(key, text)}\n`, "utf8");
    return null;
  } catch (e) {
    return `log 写入失败（可重试补齐）：${e.message}`;
  }
}

function appendDecision(reqDir, decision, who, reason) {
  const p = path.join(reqDir, "decisions.md");
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, "# 决策审计链\n\n| 时间 | 决策 | 谁拍板 | 原因 |\n| ---- | ---- | ------ | ---- |\n", "utf8");
  }
  const existing = readText(p);
  const row = `| ${fmtLocal()} | ${cell(decision)} | ${cell(who)} | ${cell(reason)} |`;
  const body = existing.endsWith("\n") ? existing : `${existing}\n`;
  fs.writeFileSync(p, `${body}${row}\n`, "utf8");
}

// ---------- status ----------

const NEXT_BY_PHASE = {
  init: "locating",
  planning: "planner",
  plan_confirm: "human",
  coding: "coder",
  code_review: "reviewer",
  fixing: "coder",
  verify: "coder",
  done: "none",
};

function tailLines(file, n = 20) {
  if (!fs.existsSync(file)) return "";
  const lines = readText(file).split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join("\n").trim();
}

function runStatus(alias) {
  const { reqDir, state, phase } = loadState(alias);
  const warnings = [];

  const cfg = readConfig();
  let repoInfo = null;
  try {
    repoInfo = resolveRepoDir(state, cfg);
  } catch (e) {
    warnings.push(e.message);
  }

  let branch = null;
  let expected = expectedBranchOf(state);
  if (repoInfo) {
    try {
      const current = git(repoInfo.repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const head = git(repoInfo.repoDir, ["rev-parse", "HEAD"]);
      const status = git(repoInfo.repoDir, ["status", "--porcelain"]);
      branch = {
        expected,
        current,
        head,
        branchOk: expected ? current === expected : null,
        clean: status === "",
        dirty: status,
      };
      if (expected && current !== expected) warnings.push(`分支不符：当前 ${current}，期望 ${expected}`);
      if (state.gate?.head && state.gate.head !== head) {
        warnings.push(`HEAD 与 state.gate.head 不一致：${head} != ${state.gate.head}`);
      }
      if (!state.gate?.head) warnings.push("state.gate.head 缺失（旧 state；check/done 会拒绝，请重跑 feed 或人工补齐）");
    } catch (e) {
      warnings.push(e.message);
    }
  }

  const locate = readLocateJson(reqDir);
  const whitelist = (() => {
    try {
      const w = readWhitelist(reqDir, state, { allowMissing: true });
      if (w.source === "none") warnings.push("缺少 plan.files.json（check 需 --no-whitelist）");
      if (
        state.tier === "express" &&
        Array.isArray(state.selectedFiles) &&
        w.files.length &&
        JSON.stringify([...state.selectedFiles].sort()) !== JSON.stringify([...w.files].sort())
      ) {
        warnings.push("state.selectedFiles 与 plan.files.json 漂移；以 plan.files.json 为准");
      }
      return {
        source: w.source,
        files: w.files,
        deleted: w.deleted,
        conditional: w.conditional,
        exempt: w.exempt,
      };
    } catch (e) {
      warnings.push(`白名单读取失败：${e.message}`);
      return { source: "error", files: [], deleted: [], conditional: [], exempt: [] };
    }
  })();

  let next;
  if (phase === "locating") {
    if (!locate) next = "locate";
    else if (locate.confidence === "high") next = "human";
    else next = "set-tier full";
  } else {
    next = NEXT_BY_PHASE[phase] ?? null;
  }

  return {
    ok: true,
    alias,
    requirement: state.requirement,
    tier: state.tier ?? null,
    phase,
    iteration: state.iteration ?? 0,
    maxIteration: state.maxIteration ?? 2,
    lastAgent: state.lastAgent ?? null,
    repo: repoInfo?.repo ?? state.repo ?? null,
    branch,
    whitelist,
    locate: state.locate ?? (locate ? locateSummary(locate) : null),
    features: { hindsight: cfg?.raw?.features?.hindsight === true },
    timings: state.timings ?? null,
    next,
    progressTail: tailLines(path.join(reqDir, "progress.md"), 20),
    statePath: displayPath(path.join(reqDir, "state.json")),
    warnings,
  };
}

// ---------- gate ----------

function runGate(alias, flags) {
  const { state, phase } = loadState(alias);
  const cfg = readConfig();
  const { repo, repoDir } = resolveRepoDir(state, cfg);
  const expected = expectedBranchOf(state);
  if (!expected) throw new ScriptError(6, "state 缺少 baseBranch / branch，无法校验开工门禁", { alias });

  const g = gitGate(repoDir, expected);
  const enforceClean = Boolean(flags.init || flags["enforce-clean"]);
  const problems = [];
  if (!g.branchOk) problems.push(`分支不符：当前 ${g.branch}，期望 ${expected}`);
  if (enforceClean && !g.clean) problems.push(`工作区不干净：\n${g.status}`);

  if (problems.length) {
    throw new ScriptError(3, problems.join("；"), {
      repo,
      expected,
      branch: g.branch,
      dirty: g.status,
      checkedAt: g.checkedAt,
    });
  }

  if (flags.record && !flags["dry-run"]) {
    writeState(requirementPaths(alias).reqDir, (s) => {
      s.gate = {
        checkedAt: g.checkedAt,
        branch: g.branch,
        head: g.commit,
        branchOk: true,
        cleanOk: g.clean,
      };
    });
  }

  return {
    ok: true,
    alias,
    phase,
    repo,
    branch: g.branch,
    expected,
    head: g.commit,
    branchOk: true,
    clean: g.clean,
    enforced: enforceClean,
    recorded: Boolean(flags.record && !flags["dry-run"]),
  };
}

function gitGate(repoDir, expected) {
  const branch = git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = git(repoDir, ["rev-parse", "HEAD"]);
  const status = git(repoDir, ["status", "--porcelain"]);
  return {
    branch,
    commit,
    status,
    branchOk: branch === expected,
    clean: status === "",
    checkedAt: nowIso(),
  };
}

// ---------- 转移表 ----------

const TRANSITIONS = {
  "init>locating": { tier: null },
  "locating>planning": { tier: "full" },
  "locating>coding": { tier: "express" },
  "planning>plan_confirm": { tier: "full" },
  "plan_confirm>coding": { tier: "full" },
  "coding>code_review": { tier: "full" },
  "coding>verify": { tier: "express" },
  "code_review>fixing": { tier: "full" },
  "code_review>verify": { tier: "full" },
  "fixing>verify": { tier: "full" },
  "verify>coding": { tier: null },
  "verify>fixing": { tier: "full" },
};

const EXPRESS_MAX_ROUNDS = 2;

// ---------- set-phase ----------

function parseJsonArrayFile(flags, key, reqDir) {
  if (!flags[key]) return undefined;
  const text = readFlagFile(flags, key);
  let val;
  try {
    val = JSON.parse(text);
  } catch {
    throw new ScriptError(5, `--${key} 不是合法 JSON：${flags[key]}`);
  }
  if (!Array.isArray(val)) throw new ScriptError(5, `--${key} 必须是 JSON 数组`);
  return val;
}

function runSetPhase(alias, flags) {
  const target = flags.phase;
  if (!target) throw new ScriptError(5, "缺少 --phase <阶段>");
  if (target === "done") {
    throw new ScriptError(5, "done 只能由 `advance done <别名>` 写入；set-phase --phase done 永远拒绝");
  }
  if (!PHASES.includes(target)) {
    throw new ScriptError(5, `非法 phase：${target}（允许：${PHASES.filter((p) => p !== "done").join("|")}）`);
  }
  if (flags["inc-iteration"] && target !== "fixing") {
    throw new ScriptError(5, "--inc-iteration 只能与 --phase fixing 一起使用");
  }
  if (flags["allow-conditional"] && !(target === "coding")) {
    throw new ScriptError(5, "--allow-conditional 只允许用于进入 coding（plan_confirm → coding）");
  }

  const { reqDir, state, phase } = loadState(alias);
  const current = phase;
  const tkey = `${current}>${target}`;
  const rule = TRANSITIONS[tkey];
  const force = Boolean(flags.force);

  if (!force) {
    if (current === "done") throw new ScriptError(5, "已 done：重开必须人工 --force");
    if (!rule) {
      throw new ScriptError(5, `非法转移：${tkey}（未列出的转移需要人工 --force）`, {
        from: current,
        to: target,
      });
    }
    if (rule.tier && state.tier !== rule.tier) {
      throw new ScriptError(5, `转移 ${tkey} 需要 tier=${rule.tier}，当前 tier=${state.tier ?? "null"}`);
    }
  }

  // 白名单 / conditional 门禁
  let whitelist = null;
  if (target === "coding") {
    whitelist = readWhitelist(reqDir, state, { allowMissing: true });
    if (state.tier === "full" && whitelist.source === "none") {
      throw new ScriptError(5, "full 进入 coding 前必须存在合法的 plan.files.json（--allow-conditional 只放宽 conditional）");
    }
    if (state.tier === "full" && whitelist.conditional.length && !flags["allow-conditional"]) {
      throw new ScriptError(
        5,
        `还有 ${whitelist.conditional.length} 个未处理的 conditional：` +
          whitelist.conditional.map((c) => `${c.path}${c.question ? `(${c.question})` : ""}`).join(", ") +
          "；请先 approve-files，或显式 --allow-conditional（不碰这些文件）",
      );
    }
  }

  const note = flags["note-file"] ? readFlagFile(flags, "note-file") : flags.note ?? "";
  if (flags.note) assertAscii(flags.note, "--note");
  const agent = flags.agent ?? "orchestrator";
  const blockers = parseJsonArrayFile(flags, "blockers-file");
  const questions = parseJsonArrayFile(flags, "questions-file");
  const key = transitionKey(current, target, agent, note);

  const already = current === target && state.lastTransitionKey === key;

  const at = nowIso();
  let iteration = state.iteration ?? 0;
  let iterationNote = null;
  if (target === "fixing" && flags["inc-iteration"]) iteration += 1;
  // express 复验未全绿 → 回 coding，自动计数，最多 2 轮
  if (current === "verify" && target === "coding" && state.tier === "express") {
    if (iteration >= EXPRESS_MAX_ROUNDS) {
      throw new ScriptError(5, `express 已回退 ${iteration} 轮，达到上限 ${EXPRESS_MAX_ROUNDS}；转人工`, {
        iteration,
      });
    }
    iteration += 1;
    iterationNote = `express retry ${iteration}/${EXPRESS_MAX_ROUNDS}`;
  }

  const payload = {
    ok: true,
    alias,
    from: current,
    to: target,
    tier: state.tier ?? null,
    agent,
    iteration,
    key,
    already,
  };

  if (flags["dry-run"]) {
    return { ...payload, dryRun: true, planned: { blockers, questions, note: note || null } };
  }

  const warnings = [];
  if (!already) {
    writeState(reqDir, (s) => {
      // 时间：离开旧阶段、进入新阶段
      if (current !== target) {
        exitPhaseTiming(s, current, at);
        if (current === "plan_confirm") {
          ensureTimings(s);
          const entered = s.timings.phases.plan_confirm?.enteredAt;
          s.timings.waitMs.planConfirm = entered ? new Date(at).getTime() - new Date(entered).getTime() : null;
        }
        if (current === "locating") {
          const loc = readLocateJson(reqDir);
          const summary = locateSummary(loc);
          if (summary) s.locate = summary;
        }
        enterPhaseTiming(s, target, at);
      }
      s.phase = target;
      s.lastAgent = agent;
      s.iteration = iteration;
      s.lastTransitionKey = key;
      if (blockers !== undefined) s.blockers = blockers;
      if (questions !== undefined) s.questions = questions;
    });

    const bits = [target === "done" ? "" : `${current} -> ${target}`, `agent=${agent}`];
    if (note) bits.push(`note=${note.replace(/\s+/g, " ").slice(0, 300)}`);
    if (iterationNote) bits.push(iterationNote);
    if (whitelist && whitelist.source !== "none") bits.push(`whitelist=${whitelist.source}`);
    const w = appendLog(reqDir, key, bits.filter(Boolean).join(" "));
    if (w) warnings.push(w);
  } else {
    const w = appendLog(reqDir, key, `${current} -> ${target} agent=${agent}（幂等重试补 log）`);
    if (w) warnings.push(w);
  }

  return { ...payload, iterationNote, warnings };
}

// ---------- set-tier ----------

function targetPhaseForTier(tier) {
  return tier === "express" ? "coding" : "planning";
}

function runSetTier(alias, flags) {
  const tier = flags.tier;
  if (!tier) throw new ScriptError(5, "缺少 --tier full|express");
  if (!TIERS.includes(tier)) {
    throw new ScriptError(5, `非法 tier：${tier}（只允许 full | express；light 已删除）`);
  }
  const { reqDir, state, phase } = loadState(alias);
  const targetPhase = targetPhaseForTier(tier);

  if (flags.reason) assertAscii(flags.reason, "--reason");

  // 幂等：已是目标 tier + phase（express 还要文件一致）
  const loc = readLocateJson(reqDir);

  let files = null;
  if (tier === "express") files = resolveExpressFiles(alias, reqDir, loc, flags);

  if (state.tier === tier && state.phase === targetPhase) {
    if (tier === "full") {
      return { ok: true, alias, tier, phase: targetPhase, already: true };
    }
    const current = readWhitelist(reqDir, state, { allowMissing: true });
    if (JSON.stringify(current.files) === JSON.stringify(files)) {
      return { ok: true, alias, tier, phase: targetPhase, files, already: true };
    }
  }

  if (phase !== "locating") {
    throw new ScriptError(5, `set-tier 只允许在 phase=locating 时使用（当前 ${phase}）`);
  }

  const reasonFile = flags["reason-file"] ? readFlagFile(flags, "reason-file") : null;
  let reason = reasonFile || flags.reason || "";
  if (!reason) {
    if (loc && loc.confidence) {
      reason =
        `locate: confidence=${loc.confidence} recommended=${loc.recommendedTier ?? "-"} ` +
        `candidates=${Array.isArray(loc.candidates) ? loc.candidates.length : 0}`;
    } else if (tier === "full") {
      throw new ScriptError(5, "locate.json 缺失：--tier full 必须提供 --reason-file 或 --reason 记录原因");
    }
  }

  const summary = locateSummary(loc);
  const at = nowIso();
  const key = transitionKey("locating", targetPhase, "set-tier", tier);
  const expressFiles = tier === "express" ? files : null;

  // express 覆盖已有 planner 产物必须 --force
  if (tier === "express") {
    const existing = readWhitelist(reqDir, state, { allowMissing: true });
    if (existing.source === "plan.files.json") {
      const same =
        JSON.stringify(existing.files) === JSON.stringify(expressFiles) &&
        existing.deleted.length === 0 &&
        existing.conditional.length === 0;
      if (!same && !flags.force) {
        throw new ScriptError(
          5,
          "plan.files.json 已存在且文件列表不同；覆盖需 --force（避免冲掉 planner 的产物）",
          { existing: existing.files, next: expressFiles },
        );
      }
    }
  }

  const payload = {
    ok: true,
    alias,
    tier,
    phase: targetPhase,
    from: phase,
    files: expressFiles,
    reason,
    locate: summary,
    key,
    already: false,
  };

  if (flags["dry-run"]) return { ...payload, dryRun: true };

  // 1) express：写权威白名单
  if (tier === "express") {
    writeJsonAtomic(path.join(reqDir, "plan.files.json"), {
      files: expressFiles,
      deleted: [],
      conditional: [],
      exempt: Array.isArray(loc?.exempt) ? loc.exempt : [],
    });
  }

  // 2) state
  writeState(reqDir, (s) => {
    exitPhaseTiming(s, "locating", at);
    enterPhaseTiming(s, targetPhase, at);
    s.tier = tier;
    s.phase = targetPhase;
    s.lastAgent = "orchestrator";
    s.lastTransitionKey = key;
    if (summary) s.locate = summary;
    if (tier === "express") {
      s.selectedFiles = expressFiles;
      ensureTimings(s);
      const generatedAt = loc?.generatedAt;
      s.timings.waitMs.expressConfirm = generatedAt
        ? Math.max(0, new Date(at).getTime() - new Date(generatedAt).getTime())
        : null;
    }
    if (!loc) s.locateMissing = true;
  });

  // 3) decisions / tasks / log
  appendDecision(reqDir, `tier=${tier}`, "advance", reason);
  let tasksUpdated = false;
  try {
    updateTasksTier(alias, tier);
    tasksUpdated = true;
  } catch (e) {
    payload.warnings = [`tasks.md 更新失败：${e.message}`];
  }
  const logMsg =
    `locating -> ${targetPhase} set-tier ${tier}` +
    (expressFiles ? ` files=${expressFiles.length}` : "") +
    (loc ? "" : " locate.missing");
  const w = appendLog(reqDir, key, logMsg);
  if (w) payload.warnings = [...(payload.warnings ?? []), w];

  return { ...payload, tasksUpdated, decisionsUpdated: true };
}

function resolveExpressFiles(alias, reqDir, loc, flags) {
  let raw = null;
  let source = null;

  if (flags["files-file"]) {
    raw = readJson(path.resolve(ROOT, flags["files-file"]));
    source = "--files-file";
  } else {
    const manual = path.join(reqDir, "selected-files.json");
    if (fs.existsSync(manual)) {
      raw = readJson(manual);
      source = "selected-files.json";
    } else if (loc && Array.isArray(loc.selectedFiles) && loc.selectedFiles.length) {
      raw = { files: loc.selectedFiles, exempt: loc.exempt ?? [] };
      source = "locate.json";
    }
  }

  if (!raw) {
    throw new ScriptError(
      5,
      "express 没有可用文件清单：请提供 --files-file，或先跑 locate.mjs 生成 selected-files.json",
      { alias },
    );
  }
  const w = normalizeWhitelist(Array.isArray(raw) ? { files: raw } : raw);
  if (w.files.length === 0) {
    throw new ScriptError(5, "express 的文件清单为空：候选确认失败，请走 full 或调整 selected-files.json", {
      source,
    });
  }
  return w.files;
}

// ---------- check ----------

function parsePorcelainZ(raw) {
  const parts = raw.split("\0");
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const seg = parts[i];
    if (!seg) continue;
    const status = seg.slice(0, 2);
    const p = seg.slice(3);
    const entry = { status, path: toPosix(p) };
    if (status[0] === "R" || status[0] === "C") {
      const orig = parts[i + 1];
      if (orig) {
        entry.oldPath = toPosix(orig);
        i += 1;
      }
    }
    entries.push(entry);
  }
  return entries;
}

function gitHeadInfo(repoDir) {
  return {
    branch: git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    head: git(repoDir, ["rev-parse", "HEAD"]),
  };
}

function computeCheck(alias, flags, opts = {}) {
  const { reqDir, state, phase } = loadState(alias);
  const cfg = readConfig();
  const { repo, repoDir } = resolveRepoDir(state, cfg);
  const expected = expectedBranchOf(state);
  const mode = flags.mode === "review" ? "review" : "done";
  const warnings = [];

  let whitelist;
  if (flags["no-whitelist"] === true) {
    whitelist = { source: "none", files: [], deleted: [], conditional: [], exempt: [], warnings: [] };
    warnings.push("--no-whitelist：跳过了白名单，只报告 git 实际改动");
  } else {
    whitelist = readWhitelist(reqDir, state, { allowMissing: true });
    if (whitelist.source === "none") {
      throw new ScriptError(
        5,
        "缺少 plan.files.json：full / express 必须有白名单；确实要跳过请显式 --no-whitelist",
        { alias },
      );
    }
  }
  warnings.push(...(whitelist.warnings ?? []));

  const { branch, head } = gitHeadInfo(repoDir);
  const entries = parsePorcelainZ(
    git(repoDir, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-uall", "-z"], { raw: true }),
  );
  const staged = [
    ...new Set(
      git(repoDir, ["-c", "core.quotepath=false", "diff", "--cached", "--name-only", "-z"], { raw: true })
        .split("\0")
        .map(toPosix)
        .filter(Boolean),
    ),
  ];

  const changedSet = new Set();
  for (const e of entries) {
    changedSet.add(e.path);
    if (e.oldPath) changedSet.add(e.oldPath);
  }
  const changed = [...changedSet].sort();

  const allowed = new Set([...whitelist.files, ...whitelist.deleted]);
  const exemptSet = new Set(whitelist.exempt);
  // 白名单为 none 时无法判断越界：只报告 changed，不报 foreign
  const foreign =
    whitelist.source === "none" ? [] : changed.filter((p) => !allowed.has(p) && !exemptSet.has(p));
  const exemptChanged = changed.filter((p) => exemptSet.has(p));
  const missing = [...allowed].filter((p) => !changedSet.has(p)).sort();

  const gateHead = state.gate?.head ?? null;
  if (!gateHead) {
    throw new ScriptError(6, "state.gate.head 缺失（旧 state 契约）；请重跑 feed 或人工补齐后再检查", {
      alias,
      gate: state.gate ?? null,
    });
  }
  const headOk = gateHead === head;
  const branchOk = expected ? branch === expected : null;

  const problems = [];
  if (!headOk) problems.push(`HEAD 变了：现在 ${head.slice(0, 12)}，state.gate.head ${gateHead.slice(0, 12)}（禁止 coder 自行 commit）`);
  if (expected && branch !== expected) problems.push(`分支不符：当前 ${branch}，期望 ${expected}`);
  if (staged.length) problems.push(`有暂存内容（必须为空）：${staged.join(", ")}`);
  if (foreign.length) problems.push(`出现白名单外改动：${foreign.join(", ")}`);
  if (whitelist.source === "none") {
    // 没有白名单时无法判断越界；只报告
  }

  const ok = problems.length === 0;
  return {
    ok,
    alias,
    phase,
    mode,
    repo,
    source: whitelist.source,
    branch,
    expected,
    branchOk,
    head,
    expectedHead: gateHead,
    headOk,
    changed,
    staged,
    foreign,
    exemptChanged,
    missing,
    whitelist: {
      files: whitelist.files,
      deleted: whitelist.deleted,
      conditional: whitelist.conditional,
      exempt: whitelist.exempt,
    },
    problems,
    warnings,
  };
}

function runCheck(alias, flags) {
  const result = computeCheck(alias, flags);
  if (flags["dry-run"]) return { ...result, dryRun: true };
  return result;
}

// ---------- review-input ----------

const TEXT_HEAD_BYTES = 8192;
const MAX_FILE_BYTES_DEFAULT = 64 * 1024;
const MAX_BYTES_DEFAULT = 256 * 1024;

function isProbablyText(buf) {
  return !buf.subarray(0, TEXT_HEAD_BYTES).includes(0);
}

function runReviewInput(alias, flags) {
  const { reqDir, state, phase } = loadState(alias);
  const cfg = readConfig();
  const { repoDir } = resolveRepoDir(state, cfg);
  const expected = expectedBranchOf(state);
  const { branch, head } = gitHeadInfo(repoDir);

  if (expected && branch !== expected) {
    throw new ScriptError(3, `分支不符：当前 ${branch}，期望 ${expected}`, { branch, expected });
  }
  const gateHead = state.gate?.head;
  if (gateHead && gateHead !== head) {
    throw new ScriptError(3, `HEAD 变了：现在 ${head.slice(0, 12)}，state.gate.head ${gateHead.slice(0, 12)}`, {
      head,
      expectedHead: gateHead,
    });
  }

  const whitelist = readWhitelist(reqDir, state, { allowMissing: Boolean(flags["no-whitelist"]) });
  const allowed = [...new Set([...whitelist.files, ...whitelist.deleted, ...whitelist.exempt])];
  const maxBytes = Number(flags["max-bytes"] ?? MAX_BYTES_DEFAULT);
  const maxFileBytes = Number(flags["max-file-bytes"] ?? MAX_FILE_BYTES_DEFAULT);

  const entries = parsePorcelainZ(
    git(repoDir, ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-uall", "-z"], { raw: true }),
  );
  const changed = new Set();
  for (const e of entries) {
    changed.add(e.path);
    if (e.oldPath) changed.add(e.oldPath);
  }

  const sections = [];
  const omitted = [];
  let bytes = 0;
  const push = (text, file) => {
    if (bytes + Buffer.byteLength(text) > maxBytes) {
      omitted.push({ file, reason: "global-max-bytes" });
      return false;
    }
    sections.push(text);
    bytes += Buffer.byteLength(text);
    return true;
  };

  const header = [
    `# review-input - ${alias}`,
    "",
    `> 由 \`advance review-input\` 生成；head=${head.slice(0, 12)} branch=${branch} phase=${phase}`,
    `> 白名单来源：${whitelist.source}（files=${whitelist.files.length} deleted=${whitelist.deleted.length} exempt=${whitelist.exempt.length}）`,
    "",
    "",
  ].join("\n");
  sections.push(header);
  bytes += Buffer.byteLength(header);

  if (allowed.length) {
    const stat = git(repoDir, ["-c", "core.quotepath=false", "diff", "--stat", "HEAD", "--", ...allowed], {
      timeout: 60000,
      raw: true,
    });
    push(`## diff --stat\n\n\`\`\`text\n${stat.trim() || "（无改动）"}\n\`\`\`\n\n`, "(stat)");
  }

  for (const file of allowed) {
    if (whitelist.exempt.includes(file)) {
      push(`## ${file}\n\n> exempt 文件（自动生成 / 忽略），仅展示不计入越界。\n\n`, file);
    }

    const isUntracked = entries.some((e) => e.path === file && e.status === "??");
    if (isUntracked) {
      const abs = path.join(repoDir, file);
      let buf;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        omitted.push({ file, reason: "unreadable" });
        continue;
      }
      if (!isProbablyText(buf)) {
        omitted.push({ file, reason: "binary" });
        continue;
      }
      if (buf.length > maxFileBytes) {
        omitted.push({ file, reason: "too-large" });
        continue;
      }
      push(`## 新文件：${file}\n\n\`\`\`\n${buf.toString("utf8")}\n\`\`\`\n\n`, file);
      continue;
    }

    if (!changed.has(file)) continue;
    const diff = git(
      repoDir,
      ["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-color", "HEAD", "--", file],
      { timeout: 60000, raw: true },
    );
    if (!diff.trim()) continue;
    push(`## diff：${file}\n\n\`\`\`diff\n${diff.trimEnd()}\n\`\`\`\n\n`, file);
  }

  const foreign = [...changed].filter((p) => !allowed.includes(p)).sort();
  if (foreign.length) {
    push(`## 白名单外文件（未纳入评审）\n\n${foreign.map((p) => `- ${p}`).join("\n")}\n\n`, "(foreign)");
  }
  if (omitted.length) {
    push(
      `## omitted（整文件跳过，未按字节截断）\n\n${omitted.map((o) => `- ${o.file}（${o.reason}）`).join("\n")}\n\n`,
      "(omitted)",
    );
  }

  const outPath = path.join(reqDir, "review-input.txt");
  const text = sections.join("");
  if (!flags["dry-run"]) writeTextAtomic(outPath, text);

  return {
    ok: true,
    alias,
    path: displayPath(outPath),
    bytes: Buffer.byteLength(text),
    head,
    branch,
    source: whitelist.source,
    included: allowed.filter((f) => !omitted.some((o) => o.file === f)),
    omitted,
    truncated: omitted.some((o) => o.reason === "global-max-bytes"),
    foreign,
    dryRun: Boolean(flags["dry-run"]),
  };
}

// ---------- approve-files ----------

function runApproveFiles(alias, flags) {
  const q = (flags.q || "").trim();
  if (!q) throw new ScriptError(5, "缺少 --q Q1");
  const { reqDir } = loadState(alias);
  const planFiles = path.join(reqDir, "plan.files.json");
  if (!fs.existsSync(planFiles)) {
    throw new ScriptError(5, "plan.files.json 不存在：approve-files 只处理 planner 产出的白名单", {
      path: displayPath(planFiles),
    });
  }
  const raw = readJson(planFiles);
  const normalized = normalizeWhitelist(raw);

  const matches = normalized.conditional.filter((c) => (c.question || "").toUpperCase() === q.toUpperCase());
  if (matches.length === 0) {
    return {
      ok: true,
      alias,
      question: q,
      already: true,
      moved: [],
      rejected: [],
      files: normalized.files,
    };
  }

  const reject = Boolean(flags.reject);
  const moved = matches.map((m) => m.path);
  const nextFiles = reject ? normalized.files : [...new Set([...normalized.files, ...moved])];
  const nextConditional = normalized.conditional.filter(
    (c) => (c.question || "").toUpperCase() !== q.toUpperCase(),
  );

  const payload = {
    ok: true,
    alias,
    question: q,
    rejected: reject ? moved : [],
    moved: reject ? [] : moved,
    files: nextFiles,
    remainingConditional: nextConditional.map((c) => c.path),
  };

  if (flags["dry-run"]) return { ...payload, dryRun: true };

  writeJsonAtomic(planFiles, {
    files: nextFiles,
    deleted: normalized.deleted,
    conditional: nextConditional,
    exempt: normalized.exempt,
  });

  const reason = flags.reason ?? (reject ? `reject ${q}` : `approve ${q}`);
  appendDecision(
    reqDir,
    `conditional ${q} ${reject ? "reject" : "approve"}`,
    "负责人",
    `${reason}：${moved.join(", ")}`,
  );
  appendLog(
    reqDir,
    transitionKey(alias, "approve-files", q, String(reject)),
    `approve-files ${q} ${reject ? "reject" : "approve"} -> ${moved.join(", ")}`,
  );
  return payload;
}

// ---------- timing ----------

function runTiming(alias, flags) {
  const name = (flags.name || "").trim();
  if (!name) throw new ScriptError(5, "缺少 --name <stage>");
  const machineMs = flags["machine-ms"] !== undefined ? Number(flags["machine-ms"]) : null;
  const waitMs = flags["wait-ms"] !== undefined ? Number(flags["wait-ms"]) : null;
  if (machineMs === null && waitMs === null) {
    throw new ScriptError(5, "至少提供 --machine-ms 或 --wait-ms");
  }
  if ((machineMs !== null && !Number.isFinite(machineMs)) || (waitMs !== null && !Number.isFinite(waitMs))) {
    throw new ScriptError(5, "--machine-ms / --wait-ms 必须是数字");
  }
  const { reqDir } = loadState(alias);
  const add = Boolean(flags.add);

  const payload = { ok: true, alias, name, add, machineMs: null, waitMs: null };
  if (flags["dry-run"]) return { ...payload, dryRun: true };

  writeState(reqDir, (s) => {
    const t = ensureTimings(s);
    if (machineMs !== null) {
      t.machineMs[name] = add ? (t.machineMs[name] ?? 0) + machineMs : machineMs;
      payload.machineMs = t.machineMs[name];
    }
    if (waitMs !== null) {
      t.waitMs[name] = add ? (t.waitMs[name] ?? 0) + waitMs : waitMs;
      payload.waitMs = t.waitMs[name];
    }
  });
  return payload;
}

// ---------- done ----------

function markerDir() {
  return path.join(ROOT, "xiaoqian-manager", "data", "temp");
}

function safeTaskId(taskId) {
  if (!taskId) return null;
  if (!SAFE_ID.test(taskId)) {
    throw new ScriptError(5, `taskId 不合法：${taskId}（只允许字母、数字、下划线、连字符）`);
  }
  return taskId;
}

function resolvePlanFile(alias, flags, state) {
  const raw = flags["plan-file"] ?? state.planFile ?? null;
  if (!raw) return { path: null, warning: null };
  const abs = path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
  const allowed = allowedPlanDirs(alias);
  if (!allowed.some((d) => isPathInside(d, abs))) {
    throw new ScriptError(5, `计划文件不在允许目录（xiaoqian-manager/data/temp 或需求目录）：${displayPath(abs)}`, {
      planFile: displayPath(abs),
      allowed: allowed.map(displayPath),
    });
  }
  return { path: abs, warning: fs.existsSync(abs) ? null : `计划文件不存在：${displayPath(abs)}` };
}

function clearFileLock(alias) {
  if (!fs.existsSync(FILE_LOCK_PATH)) return 0;
  const lines = readText(FILE_LOCK_PATH).split(/\r?\n/);
  let removed = 0;
  const kept = lines.filter((l) => {
    if (!l.startsWith("|")) return true;
    const cells = l.split("|").map((s) => s.trim());
    // | 文件 | 占用需求 | 状态 |
    if (cells[2] === alias) {
      removed += 1;
      return false;
    }
    return true;
  });
  if (removed) fs.writeFileSync(FILE_LOCK_PATH, kept.join("\n"), "utf8");
  return removed;
}

function deletePlanTemps(alias, planPath) {
  const deleted = [];
  if (!planPath || !fs.existsSync(planPath)) return deleted;
  const name = path.basename(planPath);
  if (name === "plan.md" || name === "plan.files.json") return deleted;
  const inTemp = isPathInside(markerDir(), planPath);
  const inReq = isPathInside(requirementPaths(alias).reqDir, planPath) && /^R-oral-.*\.md$/.test(name);
  if (!inTemp && !inReq) return deleted;
  fs.unlinkSync(planPath);
  deleted.push(displayPath(planPath));
  return deleted;
}

function runDone(alias, flags) {
  const { reqDir, state, phase } = loadState(alias);
  const taskId = safeTaskId(flags["task-id"] ?? state.taskId ?? null);
  const markerPath = taskId ? path.join(markerDir(), `${taskId}.done.json`) : null;

  // 1) marker 归属预检：必须在任何写操作之前
  if (markerPath && fs.existsSync(markerPath)) {
    let marker = null;
    try {
      marker = JSON.parse(readText(markerPath));
    } catch {
      throw new ScriptError(6, `完成标记不是合法 JSON：${displayPath(markerPath)}`, {
        marker: displayPath(markerPath),
      });
    }
    if (marker.taskId && marker.taskId !== taskId) {
      throw new ScriptError(6, `完成标记属于其他任务：${marker.taskId}（当前 ${taskId}）`, {
        marker: displayPath(markerPath),
        markerTaskId: marker.taskId,
        taskId,
      });
    }
    if (marker.requirement && marker.requirement !== alias) {
      throw new ScriptError(6, `完成标记属于其他需求：${marker.requirement}（当前 ${alias}）`, {
        marker: displayPath(markerPath),
        markerRequirement: marker.requirement,
        alias,
      });
    }
    return {
      ok: true,
      alias,
      taskId,
      already: true,
      phase,
      marker: displayPath(markerPath),
      actions: [],
    };
  }

  const plan = resolvePlanFile(alias, flags, state);
  const warnings = plan.warning ? [plan.warning] : [];

  // 2) 收尾校验（state 已经是 done 且 marker 缺失 → 恢复流程，跳过 check）
  let check = null;
  if (phase !== "done") {
    check = computeCheck(alias, { ...flags, mode: "done" });
    if (!check.ok) {
      return {
        ok: false,
        alias,
        taskId,
        already: false,
        code: 3,
        check,
        actions: [],
        warnings,
      };
    }
  }

  const actions = [];
  if (flags["dry-run"]) {
    actions.push({ action: "state-done" }, { action: "clear-file-lock", alias });
    if (plan.path) actions.push({ action: "delete-plan-temp", file: displayPath(plan.path) });
    if (markerPath) actions.push({ action: "write-marker", file: displayPath(markerPath) });
    return { ok: true, alias, taskId, already: false, dryRun: true, check, actions, warnings };
  }

  // 3) state -> done
  if (phase !== "done") {
    const key = transitionKey(phase, "done", "advance", taskId ?? "");
    const at = nowIso();
    writeState(reqDir, (s) => {
      exitPhaseTiming(s, phase, at);
      enterPhaseTiming(s, "done", at);
      s.phase = "done";
      s.lastAgent = "orchestrator";
      s.lastTransitionKey = key;
    });
    const w = appendLog(reqDir, key, `done（taskId=${taskId ?? "-"}）`);
    if (w) warnings.push(w);
    actions.push({ action: "state-done", phase: "done" });
  }

  // 4) file-lock
  const removed = clearFileLock(alias);
  actions.push({ action: "clear-file-lock", removed });

  // 5) 临时计划文件（plan.md / plan.files.json 永不删除）
  const deleted = deletePlanTemps(alias, plan.path);
  actions.push({ action: "delete-plan-temp", files: deleted });

  // 6) marker 最后写
  if (markerPath) {
    writeJsonAtomic(markerPath, {
      taskId,
      requirement: alias,
      phase: "done",
      finishedAt: nowIso(),
    });
    actions.push({ action: "write-marker", file: displayPath(markerPath) });
  }

  return {
    ok: true,
    alias,
    taskId,
    already: false,
    phase: "done",
    check,
    marker: markerPath ? displayPath(markerPath) : null,
    actions,
    warnings,
  };
}

// ---------- 入口 ----------

const USAGE = `用法: node scripts/advance.mjs <子命令> <别名> [参数]
子命令: status | gate | set-phase | set-tier | check | review-input | approve-files | timing | done
退出码: 0 成功/幂等, 1 异常, 3 门禁, 5 参数/契约, 6 配置/state/marker
`;

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const args = parseArgs(argv);
  const alias = requireAlias(args.alias);
  const flags = args.flags;

  switch (args.sub) {
    case "status":
      return emit(runStatus(alias));
    case "gate":
      return emit(runGate(alias, flags));
    case "set-phase":
      return emit(runSetPhase(alias, flags));
    case "set-tier":
      return emit(runSetTier(alias, flags));
    case "check": {
      const result = runCheck(alias, flags);
      emit(result);
      // --mode review 只报告，永远 exit 0
      if (!result.ok && result.mode !== "review") process.exitCode = 3;
      return;
    }
    case "review-input":
      return emit(runReviewInput(alias, flags));
    case "approve-files":
      return emit(runApproveFiles(alias, flags));
    case "timing":
      return emit(runTiming(alias, flags));
    case "done": {
      const result = runDone(alias, flags);
      emit(result);
      if (!result.ok) process.exitCode = result.code ?? 3;
      return;
    }
    default:
      throw new ScriptError(5, `未知子命令：${args.sub ?? "（空）"}`);
  }
}

try {
  main();
} catch (e) {
  const code = e instanceof ScriptError ? e.code : 1;
  const payload = { ok: false, code, error: e instanceof Error ? e.message : String(e) };
  if (e instanceof ScriptError && e.details) payload.details = e.details;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.stderr.write(`advance: ${payload.error}\n`);
  process.exitCode = code;
}
