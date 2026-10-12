#!/usr/bin/env node
/**
 * recon - 需求 planning 前的确定性事实底稿生成器
 *
 * 用法：node scripts/recon.mjs <别名>      例：node scripts/recon.mjs R-371467
 *
 * 数据源：code-indexer 的 `scan`（一次调用拿全量 ProjectMap），
 *         扫的是主仓 <repoRoot>/<仓名>（改动也直接落在该仓工作区，不用 worktree）。
 * 产出：docs/requirements/<别名>/recon.md（覆盖式，幂等）
 *
 * 本脚本不含任何 LLM 判断：只做采集与渲染。空白 = 索引器无产出，
 * 不等于该仓没有这段代码。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEXER_DIR = path.join(ROOT, "code-indexer");
const INDEXER_CLI = path.join(INDEXER_DIR, "bin", "cli.mjs");

const MAX_ENDPOINTS_PER_DOMAIN = 40;
const SAMPLE_ROWS = 10;
const MAX_HIT_ROWS = 40;
const MAX_COMPONENTS_PER_MODULE = 40;
const MAX_IMPORTED_TOP = 15;

const fail = msg => {
  process.stderr.write(`recon: ${msg}\n`);
  process.exit(1);
};

// ---------- 配置 ----------

/** 读 febot.config.json（不入库，由 yarn setup 生成） */
function readConfig() {
  const candidates = [
    process.env.FEBOT_CONFIG ? path.resolve(process.env.FEBOT_CONFIG) : "",
    path.join(ROOT, "febot.config.json"),
    path.join(process.cwd(), "febot.config.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      fail(`febot.config.json 不是合法 JSON：${p}`);
    }
    return { dir: path.dirname(p), raw: raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {} };
  }
  return null;
}

/** 目标仓根目录：配置里的 repoRoot（相对路径按配置文件所在目录解析），缺配置时退回 <仓库根>/gitlab */
function reposRoot() {
  const cfg = readConfig();
  const raw = cfg?.raw?.repoRoot;
  if (cfg && typeof raw === "string" && raw.trim()) {
    const v = raw.trim();
    return path.isAbsolute(v) ? v : path.resolve(cfg.dir, v);
  }
  return path.join(ROOT, "gitlab");
}

// ---------- 输入解析 ----------

const alias = process.argv[2];
if (!alias) fail("usage: node scripts/recon.mjs <alias>  (e.g. R-371467)");

const reqDir = path.join(ROOT, "docs", "requirements", alias);
const contextPath = path.join(reqDir, "context.md");
if (!fs.existsSync(contextPath)) fail(`context.md not found: ${contextPath}`);

const context = fs.readFileSync(contextPath, "utf8");

/** 取某个 `## 标题` 到下一个 `## ` 之间的正文 */
function section(md, title) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex(l => l.trim() === `## ${title}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => l.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

const reqTitle = section(context, "需求标题");
const reqOneLiner = section(context, "需求描述（一句话）");

// 第 5 列 = 仓库（repoRoot 下的仓库目录名）。
// 2026-10-12 前这里存的是 worktree 名 `<仓名>-<别名>`，改用主仓工作区后已退化为裸仓名。
const tasksPath = path.join(ROOT, "tasks.md");
if (!fs.existsSync(tasksPath)) {
  fail(`tasks.md 不存在：${tasksPath}（请先跑 yarn setup 生成，或从 example/tasks.md 复制一份）`);
}
const tasksMd = fs.readFileSync(tasksPath, "utf8");
const row = tasksMd
  .split(/\r?\n/)
  .find(l => l.startsWith("|") && l.split("|").map(s => s.trim())[1] === alias);
if (!row) fail(`no row for ${alias} in tasks.md`);
const repoName = row.split("|").map(s => s.trim())[5];
if (!repoName || repoName === "-") fail(`empty repo column for ${alias} in tasks.md`);
if (repoName.endsWith(`-${alias}`))
  fail(`repo column for ${alias} still holds a worktree name "${repoName}" — put the bare repo dir name instead`);
const reposDir = reposRoot();
const repoRoot = path.join(reposDir, repoName);
if (!fs.existsSync(repoRoot)) fail(`repo dir not found: ${repoRoot}`);
const repoLabel = path.relative(ROOT, repoRoot).replace(/\\/g, "/") || repoName;

// ---------- 扫描 ----------

let map;
const t0 = Date.now();
try {
  const out = execFileSync(process.execPath, [INDEXER_CLI, "scan", repoRoot, "--compact"], {
    cwd: INDEXER_DIR,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  map = JSON.parse(out);
} catch (e) {
  fail(`indexer scan failed: ${String(e.message).slice(0, 300)}`);
}
const wallMs = Date.now() - t0;

const { stack, routes = [], modules = [], apiDomains = [], components = {}, warnings = [], stats = {} } = map;

// ---------- 判定 ----------

const serviceDir = stack.serviceDir ? path.join(repoRoot, stack.serviceDir) : null;
const endpointTotal = apiDomains.reduce((a, d) => a + (d.endpoints?.length ?? 0), 0);

let verdict;
if (stack.kind !== "vue3") {
  verdict = `不支持（stack=${stack.kind}，索引器只有 vue3 适配，路由/模块/端点均为空）`;
} else if (!stack.routerFile) {
  verdict = "可索引但路由未识别（routerFile=null，§1 为空）";
} else if (endpointTotal === 0) {
  verdict = "可索引但接口层未解析（endpoints=0，见 §3 失败原因与兜底）";
} else {
  verdict = "可索引";
}

// ---------- §3 兜底：service 目录粗提 ----------

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue"]);
const URL_RE = /['"`](\/[A-Za-z0-9_\-./{}:]+)['"`]/g;

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (CODE_EXT.has(path.extname(e.name).toLowerCase())) out.push(abs);
  }
  return out;
}

/** serviceDir 探测失败时，按常见命名兜底找接口目录 */
function guessServiceDirs() {
  const candidates = ["src/service", "src/services", "src/api", "src/apis", "src/common/api"];
  return candidates.filter(c => fs.existsSync(path.join(repoRoot, c)));
}

function fallbackScan() {
  const dirs = serviceDir ? [serviceDir] : guessServiceDirs().map(c => path.join(repoRoot, c));
  const rows = [];
  for (const dir of dirs) {
    for (const abs of walk(dir)) {
      let code;
      try {
        code = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const urls = [...new Set([...code.matchAll(URL_RE)].map(m => m[1]))];
      if (urls.length === 0) continue;
      rows.push({ file: path.relative(repoRoot, abs).replace(/\\/g, "/"), urls });
    }
  }
  rows.sort((a, b) => b.urls.length - a.urls.length || a.file.localeCompare(b.file));
  return { dirs: dirs.map(d => path.relative(repoRoot, d).replace(/\\/g, "/")), rows };
}

/** 索引器 UnresolvedReason 的中文说法。no-client-usage 是噪音，其余两类才值得看 */
const UNRESOLVED_REASON_LABEL = {
  "unsupported-call-form": "调用形态不支持（解构直调 / 二次封装 / 对象参数）",
  "unresolved-url": "URL 非字面量（变量 / 常量 / 拼接）",
  "no-client-usage": "纯工具函数（非提取失败）",
};

function endpointFailReason() {
  if (!stack.serviceDir) {
    const guessed = guessServiceDirs();
    return guessed.length
      ? `索引器的 serviceDir 探测为 null（它只认 src 下的 service / services / api 三个目录名）。已按常见命名兜底扫：${guessed.join("、")}`
      : "索引器的 serviceDir 探测为 null，且按 src/service|services|api|apis、src/common/api 兜底也没找到接口目录";
  }
  if (apiDomains.length === 0) return `探测到 serviceDir=${stack.serviceDir}，但未解析出任何 api 域`;
  // 原因由索引器带上（unresolvedFns[].reason），这里只做翻译，不再靠猜
  const all = apiDomains.flatMap(d => d.unresolvedFns ?? []);
  if (all.length) {
    const byReason = {};
    for (const u of all) byReason[u.reason] = (byReason[u.reason] ?? 0) + 1;
    const parts = [];
    for (const [reason, label] of Object.entries(UNRESOLVED_REASON_LABEL)) {
      if (byReason[reason]) parts.push(`${label} ${byReason[reason]} 个`);
    }
    for (const [reason, n] of Object.entries(byReason)) {
      if (!UNRESOLVED_REASON_LABEL[reason]) parts.push(`${reason} ${n} 个`);
    }
    return `api 域存在但端点为 0。未解析函数按原因分类：${parts.join("；")}`;
  }
  // 兼容旧版索引器（只有 nonEndpointFns 裸名字数组）
  const nonEmpty = apiDomains.filter(d => (d.nonEndpointFns?.length ?? 0) > 0);
  if (nonEmpty.length) {
    return `api 域存在但端点为 0，落在 nonEndpointFns 里，共 ${nonEmpty.length} 个域有此类函数（索引器版本较旧，未带原因分类）`;
  }
  return "api 域存在但端点为 0，且无未解析记录，原因需人工核查";
}

// ---------- §5 关键词候选命中 ----------

const STOP_GRAMS = new Set([
  "系统", "管理", "功能", "支持", "需要", "进行", "问题", "一个", "可以",
  "相关", "内容", "查看", "显示", "默认", "页面", "模块", "需求", "要求",
  "数据", "如下", "并且", "以及", "其他", "如果", "必须", "不能", "当前",
]);

function splitKeywords(text) {
  const ascii = [...new Set([...text.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)].map(m => m[0].toLowerCase()))];
  const grams = [];
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    for (const n of [2, 3, 4]) {
      for (let i = 0; i + n <= run.length; i++) grams.push(run.slice(i, i + n));
    }
  }
  const cjk = [...new Set(grams.filter(g => !(g.length === 2 && STOP_GRAMS.has(g))))];
  return { ascii, cjk, all: [...ascii, ...cjk] };
}

/** 与 src/query/search.ts 同语义：小写化后子串包含 */
function findHits(words) {
  const hits = [];
  for (const w of words) {
    const k = w.toLowerCase();
    for (const r of routes) {
      if (r.path?.toLowerCase().includes(k)) hits.push({ kind: "route", target: r.path, field: "path", keyword: w });
      else if (r.label?.toLowerCase().includes(k)) hits.push({ kind: "route", target: r.path, field: "label", keyword: w });
    }
    for (const m of modules) {
      if (m.name?.toLowerCase().includes(k)) hits.push({ kind: "module", target: m.name, field: "name", keyword: w });
      else if (m.label?.toLowerCase().includes(k)) hits.push({ kind: "module", target: m.name, field: "label", keyword: w });
    }
  }
  // 同一 target 保留最长的命中词（越长越具体）
  const best = new Map();
  for (const h of hits) {
    const key = `${h.kind}:${h.target}`;
    const prev = best.get(key);
    if (!prev || h.keyword.length > prev.keyword.length) best.set(key, h);
  }
  return [...best.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.target.localeCompare(b.target));
}

// ---------- 组装关键词并求命中 ----------

const kws = splitKeywords(`${reqTitle}\n${reqOneLiner}`);
const keywordHits = kws.all.length ? findHits(kws.all).slice(0, MAX_HIT_ROWS) : [];

// ---------- §6 组件反向引用：命中模块里被谁引用 ----------

function reverseRefsFor(hitModules) {
  const { importedBy } = components;
  const rows = [];
  for (const mod of hitModules) {
    for (const comp of mod.components ?? []) {
      const importers = importedBy?.[comp] ?? [];
      rows.push({ component: comp, module: mod.name, importers });
    }
  }
  // 被引用多的排前面：波及面大 = 改动风险高
  rows.sort((a, b) => b.importers.length - a.importers.length || a.component.localeCompare(b.component));
  return rows;
}

const hitModules = keywordHits.filter(h => h.kind === "module").map(h => modules.find(m => m.name === h.target)).filter(Boolean);
const revRefs = reverseRefsFor(hitModules);

// ---------- 渲染 ----------

function mdTable(headers, rows) {
  if (rows.length === 0) return "（空）";
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map(r => `| ${r.map(c => String(c ?? "").replace(/\|/g, "\\|") || " ").join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

const L = [];
L.push(`# ${alias} - 事实底稿（recon）`);
L.push("");
L.push(`> 由 \`node scripts/recon.mjs ${alias}\` 覆盖生成（确定性产出，无 LLM 判断）。`);
L.push(`> 数据源：code-indexer scan 主仓 \`${repoLabel}\`。**空白 = 索引器无产出，不等于该仓没有这段代码。**`);
L.push("> 完整接口清单见同目录 `recon-endpoints.txt`（一行一条 `文件<TAB>METHOD<TAB>URL<TAB>fn`），本文件只放样例。");
L.push("");
L.push("## §0 探活与可索引判定");
L.push("");
L.push(`- 仓名：${repoName}`);
L.push(`- stack：kind=${stack.kind} vue=${stack.vueVersion ?? "?"} builder=${stack.builder} qiankunChild=${stack.isQiankunChild}`);
L.push(`- 目录：src=${stack.srcDir ?? "?"} router=${stack.routerFile ?? "?"} page=${stack.pageDir ?? "?"} service=${stack.serviceDir ?? "?"}`);
L.push(`- 判定：**${verdict}**`);
L.push(`- 扫描：${wallMs}ms，files=${stats.filesScanned} ignored=${stats.filesIgnored} sfc=${components.stats?.sfcCount ?? "?"}`);
L.push("");
L.push("## §1 路由表");
L.push("");
L.push(mdTable(["path", "label", "componentFile", "sider"], routes.map(r => [r.path, r.label, r.componentFile, r.isSiderMenu])));
L.push("");
L.push("## §2 业务模块");
L.push("");
L.push(
  mdTable(
    ["模块", "label", "dir", "组件数", "api 引用"],
    modules.map(m => [m.name, m.label, m.dir, m.components?.length ?? 0, (m.api ?? []).map(a => a.domain).join(",")]),
  ),
);
L.push("");
L.push("## §3 接口清单（按域）");
L.push("");
if (endpointTotal === 0) {
  L.push(`解析失败原因：${endpointFailReason()}`);
  const fb = fallbackScan();
  L.push("");
  L.push(`兜底扫描目录：${fb.dirs.length ? fb.dirs.join("、") : "（无）"}，命中文件 ${fb.rows.length} 个（URL 字符串粗提，样例 ${Math.min(SAMPLE_ROWS, fb.rows.length)} 条）：`);
  L.push("");
  for (const r of fb.rows.slice(0, SAMPLE_ROWS)) L.push(`- \`${r.file}\`：${r.urls.slice(0, 5).join("、")}${r.urls.length > 5 ? " …" : ""}`);
} else {
  for (const d of apiDomains) {
    const eps = d.endpoints ?? [];
    L.push(`### ${d.name}（${d.dir}，${eps.length} 端点${(d.usedByModules ?? []).length >= 3 ? "，共享基础域" : ""}）`);
    L.push("");
    for (const e of eps.slice(0, MAX_ENDPOINTS_PER_DOMAIN)) L.push(`- \`${e.method.toUpperCase()}\` \`${e.url}\` — ${e.fn}() @ ${e.file}:${e.line}`);
    if (eps.length > MAX_ENDPOINTS_PER_DOMAIN) L.push(`- … 其余 ${eps.length - MAX_ENDPOINTS_PER_DOMAIN} 条见 recon-endpoints.txt`);
    const uf = d.unresolvedFns ?? [];
    if (uf.length) {
      const byReason = {};
      for (const u of uf) (byReason[u.reason] ??= []).push(u.fn);
      const segs = Object.entries(byReason).map(([reason, fns]) => {
        const label = UNRESOLVED_REASON_LABEL[reason] ?? reason;
        // 纯工具函数只报数，不铺名字 —— 那是噪音
        if (reason === "no-client-usage") return `${label} ${fns.length} 个`;
        const shown = fns.slice(0, 8).join("、");
        return `${label} ${fns.length} 个：${shown}${fns.length > 8 ? " …" : ""}`;
      });
      L.push(`- 未解析函数 ${uf.length} 个 — ${segs.join("；")}`);
    } else if ((d.nonEndpointFns ?? []).length) {
      L.push(`- 非直调函数 ${d.nonEndpointFns.length} 个（可能二次封装）：${d.nonEndpointFns.slice(0, 10).join("、")}${d.nonEndpointFns.length > 10 ? " …" : ""}`);
    }
    L.push("");
  }
}
L.push("## §4 静态告警");
L.push("");
L.push(warnings.length ? warnings.map(w => `- **${w.kind}**：${w.message}`).join("\n") : "（无）");
L.push("");
L.push("## §5 关键词候选命中（启发式，非结论）");
L.push("");
L.push(`关键词：${kws.all.slice(0, 30).join("、")}${kws.all.length > 30 ? " …" : ""}`);
L.push("");
L.push(
  mdTable(
    ["类型", "目标", "命中字段", "关键词"],
    keywordHits.map(h => [h.kind, h.target, h.field, h.keyword]),
  ),
);
L.push("");
L.push("## §6 组件反向引用（改动波及面）");
L.push("");
if (revRefs.length === 0) {
  L.push("（命中模块为空或其组件无反向引用）");
} else {
  L.push(
    mdTable(
      ["组件", "所属模块", "被引用数", "引用方（前几名）"],
      revRefs.slice(0, MAX_IMPORTED_TOP).map(r => [
        r.component,
        r.module,
        r.importers.length,
        r.importers.slice(0, 5).join("、") || "（无）",
      ]),
    ),
  );
  if (revRefs.length > MAX_IMPORTED_TOP) L.push(`\n（其余 ${revRefs.length - MAX_IMPORTED_TOP} 个组件反向引用从略）`);
}
L.push("");

// ---------- 落盘 ----------

const outMd = L.join("\n");
fs.writeFileSync(path.join(reqDir, "recon.md"), outMd);

const epLines = [];
for (const d of apiDomains) {
  for (const e of d.endpoints ?? []) epLines.push(`${e.file}\t${e.method}\t${e.url}\t${e.fn}`);
}
fs.writeFileSync(path.join(reqDir, "recon-endpoints.txt"), epLines.join("\n") + (epLines.length ? "\n" : ""));

process.stdout.write(
  `recon: ${alias} -> ${path.relative(ROOT, path.join(reqDir, "recon.md"))} （${verdict}；routes=${routes.length} modules=${modules.length} endpoints=${endpointTotal} hits=${keywordHits.length}）\n`,
);