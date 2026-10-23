#!/usr/bin/env node
/**
 * index-query - 复用 .febot/index 缓存的 code-indexer 查询入口
 *
 * 用法：
 *   node scripts/index-query.mjs <cmd> <repo> [args] [--kind K] [--limit N]
 *        [--refresh] [--json] [--timings]
 *
 * cmd：map | trace | trace-event | trace-state | channels | modules | warnings | search | stats
 * <repo>：仓目录（绝对/相对路径），或仓名（按 config.repoRoot 拼接）。
 *
 * 与直接跑 code-indexer CLI 的区别：ProjectMap 从 `.febot/index/<仓>.json` 读取，
 * 缓存键 = HEAD + git status 哈希 + indexer 版本，与 recon / locate 共用同一份。
 * 未命中才扫描一次并回写，之后的查询都是几十毫秒级。
 * 注意：`git status` 只记路径不记内容，文件改过又继续改时哈希不变；需要确保最新时加 `--refresh`。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ScriptError, displayPath, readConfig, reposRoot } from "./lib/febot.mjs";
import { loadRepoMap } from "./lib/repo-index.mjs";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEXER_DIR = path.join(SCRIPT_ROOT, "code-indexer");
const INDEXER_CLI = path.join(INDEXER_DIR, "bin", "cli.mjs");

const QUERY_CMDS = new Set([
  "map",
  "trace",
  "trace-event",
  "trace-state",
  "channels",
  "modules",
  "warnings",
  "search",
  "stats",
]);

const VALUE_FLAGS = new Set(["--kind", "--limit"]);

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const positional = [];
  const flags = {};
  const passthrough = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      flags[a] = rest[i + 1] ?? "";
      passthrough.push(a, rest[i + 1] ?? "");
      i += 1;
    } else if (a === "--refresh" || a === "--json" || a === "--timings") {
      flags[a] = true;
    } else if (a === "--help") {
      flags[a] = true;
    } else {
      // 未知参数原样透传（如 --compact）
      passthrough.push(a);
    }
  }
  return { cmd, positional, flags, passthrough };
}

function resolveRepoDir(repoArg) {
  const direct = path.resolve(repoArg);
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
  let cfg;
  try {
    cfg = readConfig();
  } catch {
    cfg = null;
  }
  if (cfg) {
    const joined = path.join(reposRoot(cfg), repoArg);
    if (fs.existsSync(joined) && fs.statSync(joined).isDirectory()) return joined;
  }
  throw new ScriptError(6, `仓库目录不存在：${repoArg}`, { repo: repoArg });
}

function usage() {
  process.stderr.write(
    "usage: node scripts/index-query.mjs <map|trace|trace-event|trace-state|channels|modules|warnings|search|stats> " +
      "<repo> [args] [--kind K] [--limit N] [--refresh] [--json] [--timings]\n",
  );
}

function run(argv) {
  const { cmd, positional, flags, passthrough } = parseArgs(argv);
  if (flags["--help"]) {
    usage();
    return 0;
  }
  if (!cmd || !QUERY_CMDS.has(cmd)) {
    usage();
    throw new ScriptError(5, `不支持的命令：${cmd ?? "(空)"}`);
  }
  const repoArg = positional[0];
  if (!repoArg) throw new ScriptError(5, "缺少 <repo> 参数");

  const repoDir = resolveRepoDir(repoArg);
  const t0 = Date.now();
  const loaded = loadRepoMap(repoDir, { refresh: Boolean(flags["--refresh"]) });
  const loadMs = Date.now() - t0;

  const args = [
    INDEXER_CLI,
    cmd,
    repoDir,
    ...positional.slice(1),
    ...passthrough,
    "--map-file",
    loaded.cacheFilePath,
  ];
  const t1 = Date.now();
  let output;
  try {
    output = execFileSync(process.execPath, args, {
      cwd: INDEXER_DIR,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    throw new ScriptError(typeof e.status === "number" ? e.status : 1, `code-indexer ${cmd} 失败`, {
      repo: path.basename(repoDir),
    });
  }
  const queryMs = Date.now() - t1;

  if (flags["--json"]) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        cmd,
        repo: path.basename(repoDir),
        repoDir: displayPath(repoDir),
        cached: loaded.cached,
        head: loaded.head,
        indexElapsedMs: loaded.elapsedMs ?? null,
        loadMs,
        queryMs,
        output,
      })}\n`,
    );
  } else {
    process.stdout.write(output);
  }

  if (flags["--timings"]) {
    process.stderr.write(
      `index-query: repo=${path.basename(repoDir)} cached=${loaded.cached ? 1 : 0} ` +
        `index=${loaded.elapsedMs ?? 0}ms load=${loadMs}ms query=${queryMs}ms\n`,
    );
  }
  return 0;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (e) {
  if (e instanceof ScriptError) {
    process.stderr.write(`${e.message}\n`);
    if (e.details && Object.keys(e.details).length) process.stderr.write(`${JSON.stringify(e.details)}\n`);
    process.exitCode = e.code;
  } else {
    process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 1;
  }
}
