#!/usr/bin/env node
/**
 * resolve-repo - 只读定仓（xiaoqian-manager 启动前置门禁）
 *
 * 与 feed / recon / advance 共用同一套 projectMap 与分支解析（lib/requirement.mjs），
 * 不重复实现、不会漂移。只读：不写 state、不写 tasks.md、不跑 git。
 *
 * 用法：
 *   node scripts/resolve-repo.mjs --json < payload.json
 *
 * stdin（UTF-8 JSON）：
 *   { "module": "iHO-病理系统", "title": "需求标题", "alias": "R-123456" }
 *   alias 可选，仅回显。
 *
 * stdout（一行 JSON）：
 *   {"ok":true,"alias":...,"repo":"iho-pathology-ui","repoDir":"D:\\febot\\gitlab\\iho-pathology-ui",
 *    "branch":"dev","branchSource":"branches.default"}
 *
 * 退出码：0 成功；2 projectMap 未命中；5 输入；6 配置 / 仓库解析错误。
 */
import fs from "node:fs";
import path from "node:path";
import { ScriptError, displayPath, readConfig } from "./lib/febot.mjs";
import { resolveRepo } from "./lib/requirement.mjs";

function readPayload() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (e) {
    throw new ScriptError(5, `读取 stdin 失败：${e.message}`);
  }
  if (!raw.trim()) throw new ScriptError(5, "stdin 为空：需要 {module,title} JSON");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new ScriptError(5, "stdin 不是合法 JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ScriptError(5, "stdin 必须是 JSON 对象");
  }
  const module = String(payload.module ?? "").trim();
  const title = String(payload.title ?? "").trim();
  if (!module) throw new ScriptError(5, "module 为空：无法定仓");
  return { module, title, alias: payload.alias ? String(payload.alias) : null };
}

function main() {
  const { module, title, alias } = readPayload();
  const cfg = readConfig();
  if (!cfg) throw new ScriptError(6, "未找到 febot.config.json");

  const resolved = resolveRepo(cfg, module, title);
  if (!fs.existsSync(resolved.repoDir) || !fs.statSync(resolved.repoDir).isDirectory()) {
    throw new ScriptError(6, `仓库目录不存在：${displayPath(resolved.repoDir)}`, {
      repo: resolved.repo,
      repoDir: displayPath(resolved.repoDir),
    });
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      alias,
      module,
      repo: resolved.repo,
      repoDir: path.resolve(resolved.repoDir),
      branch: resolved.branch,
      branchSource: resolved.branchSource,
    })}\n`,
  );
}

try {
  main();
} catch (e) {
  const code = e instanceof ScriptError ? e.code : 1;
  const payload = { ok: false, code, error: e instanceof Error ? e.message : String(e) };
  if (e instanceof ScriptError && e.details) payload.details = e.details;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.stderr.write(`resolve-repo: ${payload.error}\n`);
  process.exitCode = code;
}
