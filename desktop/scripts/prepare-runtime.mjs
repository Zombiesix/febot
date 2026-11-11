#!/usr/bin/env node
/**
 * 装配桌面端运行时资产。
 *
 *   node scripts/prepare-runtime.mjs [--source <febot 仓根>] [--out resources]
 *        [--skip-build] [--skip-node] [--node-version 24.22.2]
 *
 * 产物布局（与计划书 §3.1/§9.1 对齐）：
 *   resources/next       Next standalone + static + public
 *   resources/runner     esbuild 单文件 + node-pty
 *   resources/runtime    复制到工作区的受管资产
 *   resources/node       内置 Node 24 win-x64
 *   resources/runtime-manifest.json
 *
 * 安全断言：安装包里绝不允许出现构建机的 data/、runner.json、.tw-cookie.json，
 * 也不允许出现用户所有的配置/密钥文件。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));

function parseArgs(argv) {
  const args = { skipBuild: false, skipNode: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--skip-build") args.skipBuild = true;
    else if (token === "--skip-node") args.skipNode = true;
    else if (token === "--source") args.source = argv[++i];
    else if (token === "--out") args.out = argv[++i];
    else if (token === "--node-version") args.nodeVersion = argv[++i];
    else if (token.startsWith("--source=")) args.source = token.slice("--source=".length);
    else if (token.startsWith("--out=")) args.out = token.slice("--out=".length);
    else if (token.startsWith("--node-version="))
      args.nodeVersion = token.slice("--node-version=".length);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
// desktop/ 位于 febot 仓内，源码根默认就是上两级；独立部署时可用
// FEBOT_SOURCE_ROOT 或 --source 覆盖。
const SOURCE = path.resolve(
  args.source || process.env.FEBOT_SOURCE_ROOT || path.join(PROJECT_ROOT, ".."),
);
const OUT = path.resolve(args.out || path.join(PROJECT_ROOT, "resources"));
const CACHE = path.join(PROJECT_ROOT, ".cache");
const NODE_VERSION = args.nodeVersion || process.env.FEBOT_NODE_VERSION || "24.22.2";
const XQ = path.join(SOURCE, "xiaoqian-manager");

function log(message) {
  console.log(`[prepare-runtime] ${message}`);
}

function fail(message) {
  console.error(`[prepare-runtime] ✗ ${message}`);
  process.exit(1);
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(srcRoot, destRoot, filter) {
  if (!fs.existsSync(srcRoot)) return 0;
  let count = 0;
  const stack = [srcRoot];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, entry.name);
      const rel = path.relative(srcRoot, src).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (filter && !filter(rel, true)) continue;
        fs.mkdirSync(path.join(destRoot, rel), { recursive: true });
        stack.push(src);
      } else if (entry.isFile()) {
        if (filter && !filter(rel, false)) continue;
        copyFile(src, path.join(destRoot, rel));
        count += 1;
      }
    }
  }
  return count;
}

function walk(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(command, commandArgs, options = {}) {
  log(`$ ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
    shell: options.shell ?? process.platform === "win32",
  });
  if (result.status !== 0) {
    fail(`命令失败（exit ${result.status}）：${command} ${commandArgs.join(" ")}`);
  }
}

function assertAbsent(file, why) {
  if (fs.existsSync(file)) fail(`${why}：产物中出现 ${file}`);
}

function assertNoSecrets(root) {
  const forbiddenNames = new Set(["runner.json", ".tw-cookie.json"]);
  const hits = walk(root).filter((file) => forbiddenNames.has(path.basename(file)));
  if (hits.length) {
    fail(`安装包可能泄露构建机凭据，命中：\n${hits.join("\n")}`);
  }
  assertAbsent(path.join(root, "data"), "Next standalone 不应包含构建机 data/");
  assertAbsent(path.join(root, "xiaoqian-manager", "data"), "Next standalone 不应包含 data/");
}

// ---------- 0. 前置检查 ----------

if (!fs.existsSync(path.join(XQ, "package.json"))) {
  fail(`找不到源码仓库：${XQ}（用 --source 指定 febot 仓库根）`);
}
rm(OUT);
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

// ---------- 1. Next standalone ----------

if (!args.skipBuild) {
  log("构建 xiaoqian-manager（next build，output=standalone）…");
  run("yarn", ["build"], {
    cwd: XQ,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
}

const standaloneSrc = path.join(XQ, ".next", "standalone");
const nextOut = path.join(OUT, "next");
if (!fs.existsSync(path.join(standaloneSrc, "server.js"))) {
  fail(`未找到 standalone 产物：${path.join(standaloneSrc, "server.js")}`);
}
copyDir(standaloneSrc, nextOut);
copyDir(path.join(XQ, ".next", "static"), path.join(nextOut, ".next", "static"));
copyDir(path.join(XQ, "public"), path.join(nextOut, "public"));
log(`Next standalone 已复制：${nextOut}`);

assertNoSecrets(nextOut);

// ---------- 2. runner bundle ----------

const esbuildBin = path.join(XQ, "node_modules", "esbuild", "bin", "esbuild");
if (!fs.existsSync(esbuildBin)) fail(`找不到 esbuild：${esbuildBin}（先 yarn --cwd xiaoqian-manager install）`);

const runnerOut = path.join(OUT, "runner");
fs.mkdirSync(runnerOut, { recursive: true });
const banner =
  'import{createRequire as __febotCreateRequire}from"node:module";const require=__febotCreateRequire(import.meta.url);';
run(process.execPath, [
  esbuildBin,
  path.join(XQ, "scripts", "runner.ts"),
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node24",
  `--outfile=${path.join(runnerOut, "server.mjs")}`,
  "--external:node-pty",
  "--external:bufferutil",
  "--external:utf-8-validate",
  `--banner:js=${banner}`,
], { shell: false });

function copyNodeModule(name) {
  const src = path.join(XQ, "node_modules", name);
  if (!fs.existsSync(src)) {
    log(`警告：${name} 不存在，跳过`);
    return;
  }
  copyDir(src, path.join(runnerOut, "node_modules", name), (rel) =>
    !rel.endsWith(".pdb") && !rel.endsWith(".map") && !rel.startsWith("src/") && !rel.startsWith("deps/")
  );
}
copyNodeModule("node-pty");
copyNodeModule("node-addon-api");
log(`runner bundle 已生成：${path.join(runnerOut, "server.mjs")}`);

// ---------- 3. 运行时资产（复制到工作区） ----------

const runtimeOut = path.join(OUT, "runtime");
fs.mkdirSync(runtimeOut, { recursive: true });

const copiedScripts = copyDir(path.join(SOURCE, "scripts"), path.join(runtimeOut, "scripts"), (rel) => {
  if (rel === "hindsight.env") return false;
  if (rel.endsWith(".env")) return false;
  if (rel.includes("__pycache__")) return false;
  if (rel.endsWith(".log")) return false;
  return true;
});
log(`scripts：${copiedScripts} 个文件`);

const mcpConfig = path.join(SOURCE, ".mcp.json");
if (fs.existsSync(mcpConfig)) {
  copyFile(mcpConfig, path.join(runtimeOut, ".mcp.json"));
  log("项目级 .mcp.json 已复制");
}

const copiedIndexer = copyDir(
  path.join(SOURCE, "code-indexer"),
  path.join(runtimeOut, "code-indexer"),
  (rel) => !rel.includes("__pycache__") && !rel.endsWith(".log") && !rel.includes(".cache/")
);
log(`code-indexer：${copiedIndexer} 个文件`);

for (const dir of ["commands", "agents", "skills"]) {
  const count = copyDir(
    path.join(SOURCE, ".claude", dir),
    path.join(runtimeOut, ".claude", dir)
  );
  log(`.claude/${dir}：${count} 个文件`);
}

copyDir(path.join(SOURCE, "example"), path.join(runtimeOut, "example"));
copyDir(
  path.join(SOURCE, "docs", "requirements", "_template"),
  path.join(runtimeOut, "docs", "requirements", "_template")
);

const swaggerSrc = path.join(SOURCE, "swagger-mcp-server");
const swaggerOut = path.join(runtimeOut, "swagger-mcp-server");
const SWAGGER_FILES = new Set([
  "package.json",
  "yarn.lock",
  "README.md",
  ".npmrc",
  "update_global_mcp.sh",
]);
if (fs.existsSync(swaggerSrc)) {
  for (const name of fs.readdirSync(swaggerSrc)) {
    const full = path.join(swaggerSrc, name);
    if (SWAGGER_FILES.has(name) && fs.statSync(full).isFile()) {
      copyFile(full, path.join(swaggerOut, name));
    }
  }
  copyDir(path.join(swaggerSrc, "node_modules"), path.join(swaggerOut, "node_modules"));
  log("swagger-mcp-server 已复制（services.conf 除外）");
}

// 用户所有文件绝不能进入安装包
for (const rel of [
  "febot.config.json",
  "tasks.md",
  "file-lock.md",
  ".claude/settings.json",
  ".claude/settings.local.json",
  "scripts/hindsight.env",
  "swagger-mcp-server/services.conf",
]) {
  assertAbsent(path.join(runtimeOut, rel), "运行时资产不应包含用户文件");
}

// ---------- 4. 内置 Node ----------

const nodeOut = path.join(OUT, "node");
fs.mkdirSync(nodeOut, { recursive: true });
if (!args.skipNode) {
  await installNode();
} else {
  log("跳过内置 Node 下载（--skip-node）");
  fs.writeFileSync(path.join(nodeOut, "README.txt"), "内置 Node 未装配（--skip-node）。\n", "utf8");
}

async function fetchWithRedirect(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res;
}

async function installNode() {
  const zipName = `node-v${NODE_VERSION}-win-x64.zip`;
  const cacheFile = path.join(CACHE, zipName);
  const mirrors = [
    `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${zipName}`,
    `https://nodejs.org/dist/v${NODE_VERSION}/${zipName}`,
  ];

  if (!fs.existsSync(cacheFile)) {
    let lastError = "";
    for (const url of mirrors) {
      try {
        log(`下载 ${url}`);
        const res = await fetchWithRedirect(url);
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(cacheFile, buffer);
        log(`已缓存 ${cacheFile}（${(buffer.length / 1024 / 1024).toFixed(1)} MB）`);
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        log(`下载失败：${lastError}`);
      }
    }
    if (!fs.existsSync(cacheFile)) fail(`内置 Node 下载失败：${lastError}`);
  } else {
    log(`命中缓存 ${cacheFile}`);
  }

  // 校验 sha256（拿不到 SHASUMS 时只告警）
  try {
    const sumsUrl = `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/SHASUMS256.txt`;
    const res = await fetchWithRedirect(sumsUrl);
    const text = await res.text();
    const line = text.split(/\r?\n/).find((l) => l.endsWith(zipName));
    if (line) {
      const expected = line.trim().split(/\s+/)[0];
      const actual = sha256(cacheFile);
      if (expected !== actual) fail(`Node zip 校验失败：expected ${expected} actual ${actual}`);
      log("Node zip sha256 校验通过");
    } else {
      log("警告：SHASUMS256.txt 中未找到该 zip，跳过校验");
    }
  } catch (e) {
    log(`警告：无法校验 Node zip（${e instanceof Error ? e.message : e}）`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "febot-node-"));
  try {
    log("解压内置 Node…");
    const tar = spawnSync("tar", ["-xf", cacheFile, "-C", tmp], { stdio: "inherit" });
    if (tar.status !== 0) {
      const ps = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${cacheFile}' -DestinationPath '${tmp}' -Force`],
        { stdio: "inherit" }
      );
      if (ps.status !== 0) fail("解压 Node zip 失败（tar 与 Expand-Archive 都不可用）");
    }
    const extracted = path.join(tmp, `node-v${NODE_VERSION}-win-x64`);
    if (!fs.existsSync(extracted)) fail(`解压目录不存在：${extracted}`);
    copyDir(extracted, nodeOut);
    log(`内置 Node 已装配：${path.join(nodeOut, "node.exe")}`);
  } finally {
    rm(tmp);
  }
}

// ---------- 5. manifest ----------

const files = {};
for (const file of walk(runtimeOut)) {
  files[path.relative(runtimeOut, file).split(path.sep).join("/")] = sha256(file);
}
const manifest = { version: PKG.version, files };
fs.writeFileSync(
  path.join(OUT, "runtime-manifest.json"),
  JSON.stringify(manifest, null, 2),
  "utf8"
);
log(`runtime-manifest.json：${Object.keys(files).length} 个受管文件，version=${PKG.version}`);

log("完成 ✓");
log(`产物目录：${OUT}`);