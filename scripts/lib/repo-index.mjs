/**
 * 仓索引缓存：code-indexer 的 ProjectMap 落盘复用。
 *
 * 路径：`.febot/index/<仓>.json` + `.febot/index/<仓>.map.md`（只写本地，不进仓库）。
 * 缓存键：git HEAD + `git status --porcelain` 哈希 + indexer 版本。
 * 同一 HEAD 未改动的第二次定位直接读缓存（<1s）；recon / locate 共用同一份。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  INDEX_DIR,
  ScriptError,
  displayPath,
  git,
  readText,
  writeJsonAtomic,
  writeTextAtomic,
} from "./febot.mjs";

// indexer 随脚本走，不随 FEBOT_ROOT 走：fixture 根目录下通常没有 code-indexer
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEXER_DIR = path.join(SCRIPT_ROOT, "code-indexer");
const INDEXER_CLI = path.join(INDEXER_DIR, "bin", "cli.mjs");

/** code-indexer 版本；缺失时退回 "unknown"（仍参与缓存键） */
export function indexerVersion() {
  try {
    const pkg = JSON.parse(readText(path.join(INDEXER_DIR, "package.json")));
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/** 缓存键：HEAD + 工作区状态哈希 */
export function cacheKey(repoDir) {
  const head = git(repoDir, ["rev-parse", "HEAD"]);
  const status = git(repoDir, ["status", "--porcelain"]);
  return { head, statusHash: sha1(status) };
}

function indexPaths(repoDir) {
  const repo = path.basename(repoDir);
  return {
    repo,
    json: path.join(INDEX_DIR, `${repo}.json`),
    md: path.join(INDEX_DIR, `${repo}.map.md`),
  };
}

/** 人读映射表：路由 / 模块 / API 域 */
export function renderMapMd(repo, map) {
  const routes = Array.isArray(map.routes) ? map.routes : [];
  const modules = Array.isArray(map.modules) ? map.modules : [];
  const domains = Array.isArray(map.apiDomains) ? map.apiDomains : [];
  const lines = [
    `# ${repo} - 仓索引映射表`,
    "",
    `> 由 scripts/lib/repo-index.mjs 生成（code-indexer scan --compact）；只写本地。`,
    "",
    "## 路由",
    "",
    "| path | label | componentFile |",
    "| --- | --- | --- |",
    ...routes.map(
      (r) =>
        `| ${String(r.path ?? "").replace(/\|/g, "\\|")} | ${String(r.label ?? "").replace(/\|/g, "\\|")} | ${String(
          r.componentFile ?? "",
        ).replace(/\|/g, "\\|")} |`,
    ),
    "",
    "## 业务模块",
    "",
    "| name | label | dir | 组件数 |",
    "| --- | --- | --- | --- |",
    ...modules.map(
      (m) =>
        `| ${m.name ?? ""} | ${String(m.label ?? "").replace(/\|/g, "\\|")} | ${m.dir ?? ""} | ${
          m.components?.length ?? 0
        } |`,
    ),
    "",
    "## API 域",
    "",
    "| name | dir | 端点数 |",
    "| --- | --- | --- |",
    ...domains.map((d) => `| ${d.name ?? ""} | ${d.dir ?? ""} | ${d.endpoints?.length ?? 0} |`),
    "",
  ];
  return lines.join("\n");
}

function scan(repoDir) {
  try {
    const out = execFileSync(process.execPath, [INDEXER_CLI, "scan", repoDir, "--compact"], {
      cwd: INDEXER_DIR,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      timeout: 300000,
    });
    return JSON.parse(out);
  } catch (e) {
    throw new ScriptError(1, `indexer scan failed: ${String(e.message).slice(0, 300)}`, {
      repoDir: displayPath(repoDir),
    });
  }
}

/**
 * 读仓索引；缓存命中直接返回。
 * 返回 { map, repo, cached, head, scannedAt, indexerVersion, cachePath, statusHash }。
 */
export function loadRepoMap(repoDir, opts = {}) {
  const { refresh = false } = opts;
  const paths = indexPaths(repoDir);
  const version = indexerVersion();
  const key = cacheKey(repoDir);

  if (!refresh && fs.existsSync(paths.json)) {
    try {
      const cached = JSON.parse(readText(paths.json));
      if (
        cached.indexerVersion === version &&
        cached.head === key.head &&
        cached.statusHash === key.statusHash &&
        cached.map &&
        typeof cached.map === "object"
      ) {
        return {
          map: cached.map,
          repo: paths.repo,
          cached: true,
          head: cached.head,
          scannedAt: cached.scannedAt,
          indexerVersion: version,
          cachePath: displayPath(paths.json),
          statusHash: key.statusHash,
        };
      }
    } catch {
      // 缓存损坏 → 重新扫描
    }
  }

  const t0 = Date.now();
  const map = scan(repoDir);
  const scannedAt = new Date().toISOString();
  const record = {
    repo: paths.repo,
    indexerVersion: version,
    head: key.head,
    statusHash: key.statusHash,
    scannedAt,
    elapsedMs: Date.now() - t0,
    map,
  };
  writeJsonAtomic(paths.json, record);
  writeTextAtomic(paths.md, renderMapMd(paths.repo, map));

  return {
    map,
    repo: paths.repo,
    cached: false,
    head: key.head,
    scannedAt,
    indexerVersion: version,
    cachePath: displayPath(paths.json),
    statusHash: key.statusHash,
    elapsedMs: record.elapsedMs,
  };
}
