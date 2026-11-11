// 为单个需求生成本仓的接口契约来源清单：
//   docs/requirements/<别名>/swagger.md
//
// 内容来自 febot.config.json 的 repositories[].swagger（只列本仓服务），
// 并写明「先项目源码 → 再本仓 swagger → 仍无写 Q」的查询规则。
// 本仓未配置 swagger 时仍写文件（明确写“未配置”），流水线照常继续，exit 0。
//
// 用法：
//   node scripts/swagger.mjs <别名> [--repo <仓名>] [--json]
//
// 退出码：5 = 参数/需求不存在；6 = 配置/state 问题。

import fs from "node:fs";
import path from "node:path";

import { readConfig, readState, resolveRepoDir, writeTextAtomic, displayPath, ScriptError } from "./lib/febot.mjs";
import { requirementPaths, parseTasksRow } from "./lib/requirement.mjs";
import { servicesForRepo, renderSwaggerMd } from "./lib/swagger.mjs";

function fail(json, code, message) {
  if (json) console.log(JSON.stringify({ ok: false, code, message }));
  else console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { alias: "", repo: "", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--repo") {
      out.repo = String(argv[i + 1] ?? "").trim();
      i += 1;
    } else if (a.startsWith("--repo=")) out.repo = a.slice("--repo=".length).trim();
    else if (!a.startsWith("-") && !out.alias) out.alias = a;
    else fail(out.json, 5, `无法识别的参数：${a}`);
  }
  return out;
}

function main() {
  const { alias, repo: repoArg, json } = parseArgs(process.argv.slice(2));
  if (!alias) fail(json, 5, "用法：node scripts/swagger.mjs <别名> [--repo <仓名>] [--json]");

  const paths = requirementPaths(alias);
  if (!fs.existsSync(paths.contextPath)) {
    fail(json, 5, `需求不存在：${displayPath(paths.contextPath)}（请先跑 feed）`);
  }

  let cfg;
  try {
    cfg = readConfig();
  } catch (e) {
    fail(json, 6, e instanceof Error ? e.message : String(e));
  }
  if (!cfg) fail(json, 6, "未找到 febot.config.json（请先运行 yarn setup）");

  let repo = repoArg;
  if (!repo) {
    let state = null;
    try {
      state = readState(paths.reqDir);
    } catch {
      state = null;
    }
    try {
      repo = state ? resolveRepoDir(state, cfg).repo : parseTasksRow(alias).repo || "";
    } catch (e) {
      if (e instanceof ScriptError) fail(json, e.code, e.message);
      fail(json, 6, e instanceof Error ? e.message : String(e));
    }
  }
  if (!repo) fail(json, 6, `无法确定 ${alias} 的目标仓库：state.repo 与 tasks.md 第 5 列都为空`);

  const { entry, services, errors, warnings } = servicesForRepo(cfg, repo);
  const notes = [...errors];
  if (!entry) notes.push(`仓库 ${repo} 不在 febot.config.json 的 repositories[] 中，按未配置处理`);

  const md = renderSwaggerMd({
    repo,
    services,
    errors: notes,
    warnings,
    generatedAt: new Date().toISOString(),
  });

  const outPath = path.join(paths.reqDir, "swagger.md");
  writeTextAtomic(outPath, md);

  if (json) {
    console.log(
      JSON.stringify({
        ok: true,
        alias,
        repo,
        path: displayPath(outPath),
        services,
        errors: notes,
        warnings,
      }),
    );
    return;
  }

  if (services.length) {
    console.log(`已生成 ${displayPath(outPath)}：${repo} → ${services.map((s) => s.name).join("、")}`);
  } else {
    console.log(`已生成 ${displayPath(outPath)}：${repo} 未配置 swagger（不调用 swagger 工具）`);
  }
  for (const note of notes) console.log(`- 配置错误：${note}`);
  for (const w of warnings) console.log(`- 配置提示：${w}`);
}

main();
