// swagger 配置的共享解析/校验/渲染。
//
// 唯一手填源是 febot.config.json 的 repositories[].swagger：
//   [{ "name": "cssd-default", "url": "http://host/appswagger/v2/api-docs?group=..." }]
// services.conf 由 scripts/sync-swagger.mjs 生成，不再手改。

import { repositoryEntries } from "./requirement.mjs";

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** 单仓原始 swagger 数组（不做合法性判断，保留 name/url 半截值） */
export function swaggerServicesOf(entry) {
  const list = Array.isArray(entry?.swagger) ? entry.swagger : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!name && !url) continue;
    out.push({ name, url });
  }
  return out;
}

/** 单个服务的严格校验；返回 { errors, warnings } */
export function validateSwaggerService(service) {
  const errors = [];
  const warnings = [];
  const name = String(service?.name ?? "").trim();
  const url = String(service?.url ?? "").trim();

  if (!name) errors.push("服务名为空");
  else {
    if (name.startsWith("#")) errors.push("服务名不能以 # 开头（会被 services.conf 当注释）");
    if (name === "auth") errors.push("服务名不能是 auth（会被 MCP loader 当成账号密码参数）");
    if (name.includes("=")) errors.push("服务名不能包含 =（会破坏 name=url 行格式）");
    if (CONTROL_RE.test(name)) errors.push("服务名含控制字符 / 换行");
    if (name.length > 100) errors.push("服务名过长（建议 ≤ 100 字符）");
  }

  if (!url) errors.push("URL 为空");
  else {
    if (CONTROL_RE.test(url)) errors.push("URL 含控制字符 / 换行");
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      errors.push("URL 不是合法地址");
    }
    if (parsed && !["http:", "https:"].includes(parsed.protocol)) {
      errors.push(`URL 协议只允许 http/https（当前 ${parsed.protocol}）`);
    }
    if (parsed && (parsed.username || parsed.password)) {
      warnings.push("URL 含账号密码，会写入本地 services.conf 并传给 MCP；建议改用无鉴权的 api-docs 地址");
    }
    if (/\/v2\/api-docs/i.test(url) && !/group=/.test(url)) {
      warnings.push("v2/api-docs 未带 group= 参数，部分网关会 404");
    }
  }

  return { errors, warnings };
}

/** 某仓的可用服务；非法条目被剔除并放进 errors，不阻塞调用方 */
export function servicesForRepo(cfg, repo) {
  const entry = repositoryEntries(cfg).find((r) => String(r.name).trim() === repo) ?? null;
  const raw = entry ? swaggerServicesOf(entry) : [];
  const services = [];
  const errors = [];
  const warnings = [];
  const seen = new Set();

  for (const service of raw) {
    const result = validateSwaggerService(service);
    const label = service.name || "（未命名）";
    errors.push(...result.errors.map((e) => `${label}：${e}`));
    warnings.push(...result.warnings.map((w) => `${label}：${w}`));
    if (result.errors.length) continue;
    if (seen.has(service.name)) {
      errors.push(`${label}：同一仓库内服务名重复`);
      continue;
    }
    seen.add(service.name);
    services.push(service);
  }

  return { repo, entry, services, errors, warnings };
}

/**
 * 汇总所有仓库的服务并跨仓去重。
 * - 同名同 URL：合并，只注册一次
 * - 同名不同 URL：错误（全局 MCP 以 name 为 key，会互相覆盖）
 */
export function collectSwaggerServices(cfg) {
  const services = [];
  const repoMap = new Map();
  const errors = [];
  const warnings = [];
  const byName = new Map();

  for (const entry of repositoryEntries(cfg)) {
    const repo = String(entry.name).trim();
    const perRepo = servicesForRepo(cfg, repo);
    repoMap.set(repo, perRepo.services);
    errors.push(...perRepo.errors.map((e) => `${repo} / ${e}`));
    warnings.push(...perRepo.warnings.map((w) => `${repo} / ${w}`));

    for (const service of perRepo.services) {
      const existing = byName.get(service.name);
      if (!existing) {
        byName.set(service.name, { ...service, repos: new Set([repo]) });
        services.push(byName.get(service.name));
        continue;
      }
      if (existing.url !== service.url) {
        errors.push(
          `服务名 ${service.name} 在 ${repo} 与 ${Array.from(existing.repos).join("、")} 配置了不同 URL，请在配置里改名`,
        );
        continue;
      }
      existing.repos.add(repo);
    }
  }

  return {
    services: services.map(({ name, url }) => ({ name, url })),
    repoMap,
    errors,
    warnings,
  };
}

/** 生成 services.conf；URL 转成 ASCII，避免 Node http 拒收中文 */
export function renderServicesConf(services) {
  const header = [
    "# swagger-multi 服务清单（生成物，请勿手改）",
    "#",
    "# 由 `yarn swagger` 从 febot.config.json 的 repositories[].swagger 汇总生成。",
    "# 要增删服务：改 febot.config.json（或启动 xiaoqian-manager 在设置弹窗里填），",
    "# 再跑 `yarn swagger`。",
    "#",
    "# 一行一条：服务名=api-docs 地址",
  ].join("\n");
  if (!services.length) return `${header}\n`;
  const lines = services.map((s) => `${s.name}=${encodeURI(s.url)}`);
  return `${header}\n\n${lines.join("\n")}\n`;
}

/** 生成 requirements/<别名>/swagger.md */
export function renderSwaggerMd({ repo, services, errors = [], warnings = [], generatedAt }) {
  const lines = [
    "# 接口契约来源（自动生成）",
    "",
    "> 由 `node scripts/swagger.mjs <别名>` 生成，请勿手改。",
    "> 配置在 `febot.config.json` 的 `repositories[].swagger`；改完跑 `yarn swagger` 同步 MCP。",
    "",
    `- 目标仓库：\`${repo}\``,
    `- 生成时间：${generatedAt}`,
    "",
  ];

  if (services.length) {
    lines.push("## 本仓 swagger 服务", "", "| service_name | api-docs |", "|---|---|");
    for (const s of services) lines.push(`| \`${s.name}\` | ${s.url} |`);
    lines.push(
      "",
      "## 查询顺序（必须遵守）",
      "",
      "1. **先在本仓找**：`recon-endpoints.txt`、`src/service|services|api` 下的文件、URL 字面量、调用点。",
      "2. 项目内没有，或入参/出参/schema 不完整时，才用 `mcp__swagger-multi__*` 查上表服务：",
      "   - 调用必须显式传 `service_name`，且**只能**用上表列出的名字；",
      "   - 推荐顺序：`search_apis` → `get_endpoint_details` / `get_schema` / `list_schemas`。",
      "3. 仍查不到 → 写 `questions.md` 的编号 Q（修复轮写进返回 note），**不凭字段名猜**。",
      "",
      "- swagger 与代码冲突时以代码现状为准，并把差异写进 `plan.md` / `test-report.md`。",
      "- 不要用其它仓库的服务名，也不要用 `debug_endpoint` 改真实数据；只读契约。",
    );
  } else {
    lines.push(
      "## 未配置",
      "",
      "本仓未配置 swagger 服务：**不要调用 swagger 工具**。",
      "接口契约只能从项目源码/需求推断；缺失或不确定的字段写 `questions.md`（编号 Q），不要猜。",
    );
  }

  const notes = [...errors.map((e) => `- 配置错误：${e}`), ...warnings.map((w) => `- 配置提示：${w}`)];
  if (notes.length) lines.push("", "## 配置问题", "", ...notes);

  return `${lines.join("\n")}\n`;
}
