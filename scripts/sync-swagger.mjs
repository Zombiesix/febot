// 从 febot.config.json 的 repositories[].swagger 汇总生成
// swagger-mcp-server/services.conf，打 loader 补丁，并确保项目级 .mcp.json
// 指向 scripts/swagger-mcp-launcher.mjs（启动时再读 services.conf）。
//
// 用法：
//   node scripts/sync-swagger.mjs            生成 + 补丁 + 确保项目级 MCP 配置
//   node scripts/sync-swagger.mjs --dry-run  只打印将生成的清单，不落盘
//   node scripts/sync-swagger.mjs --check    只检查配置/生成物/补丁/.mcp.json 是否一致
//   node scripts/sync-swagger.mjs --no-register  生成 + 补丁，不碰 .mcp.json
//   node scripts/sync-swagger.mjs --json     机器可读输出（一行 JSON）
//
// 退出码：
//   0 成功 / 已一致
//   1 --check 未一致（或补丁未打）
//   6 配置错误、补丁模式失配、.mcp.json 非法

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { ROOT, readConfig, writeTextAtomic, displayPath, ScriptError } from "./lib/febot.mjs";
import { collectSwaggerServices, renderServicesConf } from "./lib/swagger.mjs";

const SERVICES_CONF = path.join(ROOT, "swagger-mcp-server", "services.conf");
const PATCH_SCRIPT = path.join(ROOT, "scripts", "patch-swagger-mcp.mjs");
const MCP_FILE = path.join(ROOT, ".mcp.json");
const LOCAL_SETTINGS = path.join(ROOT, ".claude", "settings.local.json");
const MCP_SERVER_NAME = "swagger-multi";
// 固定指向 launcher：服务清单在启动时从 services.conf 读，改配置不需要改这里。
const MCP_SERVER = {
  type: "stdio",
  command: "node",
  args: ["scripts/swagger-mcp-launcher.mjs"],
  env: {},
};

function readJsonObject(file, label) {
  if (!fs.existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new ScriptError(6, `${label} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ScriptError(6, `${label} 顶层必须是 JSON 对象`);
  }
  return parsed;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * 项目级 .mcp.json：配置或移除 swagger-multi。
 * enabled=false（没有服务）时移除条目，避免会话里挂一个必然失败的 server。
 */
function syncProjectMcp(write, enabled) {
  let doc;
  try {
    doc = readJsonObject(MCP_FILE, displayPath(MCP_FILE));
  } catch (e) {
    if (e instanceof ScriptError) throw e;
    throw new ScriptError(6, String(e));
  }

  const servers = objectOrEmpty(doc.mcpServers);
  const current = servers[MCP_SERVER_NAME];
  const same = enabled ? JSON.stringify(current) === JSON.stringify(MCP_SERVER) : current === undefined;

  if (!same && write) {
    const nextServers = { ...servers };
    if (enabled) nextServers[MCP_SERVER_NAME] = MCP_SERVER;
    else delete nextServers[MCP_SERVER_NAME];
    const next = { ...doc, mcpServers: nextServers };
    writeTextAtomic(MCP_FILE, `${JSON.stringify(next, null, 2)}\n`);
  }

  return { changed: !same, configured: enabled && (same || write) };
}

/**
 * .claude/settings.local.json：把 swagger-multi 加入 enabledMcpjsonServers，
 * 让 pipeline 这类无人值守会话不用弹“批准项目 MCP”而卡住。解析失败只警告，不改用户文件。
 */
function syncApproval(write, enabled) {
  if (!enabled) return { changed: false, configured: false, warning: null };

  let doc;
  try {
    doc = readJsonObject(LOCAL_SETTINGS, displayPath(LOCAL_SETTINGS));
  } catch (e) {
    return {
      changed: false,
      configured: false,
      warning:
        `${displayPath(LOCAL_SETTINGS)} 解析失败，未自动预授权：${e instanceof Error ? e.message : String(e)}；` +
        "请在 febot 目录启动 claude 后批准一次 swagger-multi。",
    };
  }

  const list = Array.isArray(doc.enabledMcpjsonServers) ? doc.enabledMcpjsonServers.slice() : [];
  const configured = list.includes(MCP_SERVER_NAME);
  if (!configured && write) {
    list.push(MCP_SERVER_NAME);
    doc.enabledMcpjsonServers = list;
    writeTextAtomic(LOCAL_SETTINGS, `${JSON.stringify(doc, null, 2)}\n`);
  }
  return { changed: !configured, configured: configured || write, warning: null };
}

function fail(json, code, message, extra = {}) {
  if (json) console.log(JSON.stringify({ ok: false, code, message, ...extra }));
  else console.error(message);
  process.exit(code);
}

function runPatch(checkOnly) {
  const args = [PATCH_SCRIPT];
  if (checkOnly) args.push("--check");
  try {
    const out = execFileSync(process.execPath, args, { encoding: "utf8" });
    return { code: 0, output: out.trim() };
  } catch (e) {
    return {
      code: typeof e.status === "number" ? e.status : 1,
      output: String(e.stdout || e.stderr || e.message).trim(),
    };
  }
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const dryRun = argv.includes("--dry-run");
  const checkOnly = argv.includes("--check");
  const noRegister = argv.includes("--no-register");

  let cfg;
  try {
    cfg = readConfig();
  } catch (e) {
    fail(json, 6, e instanceof Error ? e.message : String(e));
  }
  if (!cfg) {
    fail(json, 6, "未找到 febot.config.json：先运行 yarn setup，或把 swagger 服务配置写进仓库根的 febot.config.json。");
  }

  let result;
  try {
    result = collectSwaggerServices(cfg);
  } catch (e) {
    if (e instanceof ScriptError) fail(json, e.code, e.message, { details: e.details });
    fail(json, 6, e instanceof Error ? e.message : String(e));
  }

  const { services, repoMap, errors, warnings } = result;

  if (errors.length) {
    fail(json, 6, `swagger 配置有 ${errors.length} 处错误，未写入/未注册：\n- ${errors.join("\n- ")}`, {
      errors,
      warnings,
    });
  }

  const content = renderServicesConf(services);
  const repoSummary = Array.from(repoMap.entries())
    .filter(([, list]) => list.length)
    .map(([repo, list]) => ({ repo, services: list.map((s) => s.name) }));

  if (dryRun) {
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          dryRun: true,
          config: displayPath(cfg.path),
          services,
          repos: repoSummary,
          warnings,
        }),
      );
    } else {
      console.log(`配置：${displayPath(cfg.path)}`);
      console.log(`服务：${services.length} 条（写入 ${displayPath(SERVICES_CONF)}）`);
      for (const s of services) console.log(`  ${s.name} = ${s.url}`);
      if (repoSummary.length) {
        console.log("仓库映射：");
        for (const r of repoSummary) console.log(`  ${r.repo}: ${r.services.join("、")}`);
      }
      if (warnings.length) {
        console.log(`提示（${warnings.length}）：`);
        for (const w of warnings) console.log(`  - ${w}`);
      }
    }
    return;
  }

  if (checkOnly) {
    let exists = false;
    let current = "";
    try {
      current = fs.readFileSync(SERVICES_CONF, "utf8");
      exists = true;
    } catch {
      exists = false;
    }
    const patch = runPatch(true);
    const confOk = exists && current === content;

    if (patch.code === 6) {
      fail(json, 6, `loader 补丁模式失配：\n${patch.output}`, { patchCode: 6 });
    }

    const enabled = services.length > 0;
    const mcp = syncProjectMcp(false, enabled);
    const approval = syncApproval(false, enabled);
    const reasons = [
      !exists && "services.conf 不存在",
      exists && current !== content && "services.conf 与配置生成的清单不一致",
      patch.code !== 0 && "loader.js 未打补丁",
      enabled && !mcp.configured && ".mcp.json 未配置 swagger-multi（或未指向 launcher）",
      !enabled && mcp.changed && ".mcp.json 仍有 swagger-multi，但当前没有任何服务",
    ].filter(Boolean);

    if (reasons.length) {
      if (json) {
        console.log(
          JSON.stringify({
            ok: false,
            code: 1,
            reasons,
            services,
            warnings,
            mcp: mcp.configured,
            approval: approval.configured,
          }),
        );
      } else {
        console.error(`未一致：${reasons.join("；")}。运行 yarn swagger 同步。`);
        if (enabled && !approval.configured) {
          console.error(
            `提示：${displayPath(LOCAL_SETTINGS)} 未预授权 ${MCP_SERVER_NAME}，pipeline 首次会弹批准。`,
          );
        }
      }
      process.exit(1);
    }

    if (json) {
      console.log(
        JSON.stringify({ ok: true, check: true, services, warnings, mcp: mcp.configured, approval: approval.configured }),
      );
    } else {
      console.log(`已一致：${services.length} 条服务，loader 已打补丁，.mcp.json 已指向 launcher。`);
      if (approval.warning) console.log(approval.warning);
      else if (enabled && !approval.configured) {
        console.log(`提示：${displayPath(LOCAL_SETTINGS)} 未预授权 ${MCP_SERVER_NAME}，pipeline 首次会弹批准。`);
      }
    }
    return;
  }

  writeTextAtomic(SERVICES_CONF, content);

  const patch = runPatch(false);
  if (patch.code !== 0) {
    fail(json, 6, `loader 补丁失败：\n${patch.output}`, { patchCode: patch.code });
  }

  if (!services.length) {
    const mcp = syncProjectMcp(!noRegister, false);
    const message = noRegister
      ? "没有配置任何 swagger 服务：已写入占位 services.conf，按 --no-register 未改 .mcp.json。"
      : "没有配置任何 swagger 服务：已写入占位 services.conf，并从 .mcp.json 移除 swagger-multi。\n" +
        "在 febot.config.json 的 repositories[].swagger 里补服务后重新运行 yarn swagger。";
    if (json) {
      console.log(JSON.stringify({ ok: true, registered: false, services: [], warnings, mcp: mcp.configured, message }));
    } else {
      console.log(message);
      if (warnings.length) for (const w of warnings) console.log(`- ${w}`);
    }
    return;
  }

  if (noRegister) {
    if (json) console.log(JSON.stringify({ ok: true, registered: false, services, warnings }));
    else {
      console.log(
        `已写入 ${displayPath(SERVICES_CONF)}（${services.length} 条），loader 已打补丁；按 --no-register 跳过 .mcp.json。`,
      );
      for (const w of warnings) console.log(`- ${w}`);
    }
    return;
  }

  let mcp;
  let approval;
  try {
    mcp = syncProjectMcp(true, true);
    approval = syncApproval(true, true);
  } catch (e) {
    fail(json, 6, `项目级 MCP 配置失败：${e instanceof Error ? e.message : String(e)}`, { services });
  }

  if (json) {
    console.log(
      JSON.stringify({
        ok: true,
        registered: mcp.configured,
        services,
        warnings,
        mcp: { file: displayPath(MCP_FILE), configured: mcp.configured, changed: mcp.changed },
        approval: { file: displayPath(LOCAL_SETTINGS), configured: approval.configured },
      }),
    );
  } else {
    console.log(`已写入 ${displayPath(SERVICES_CONF)}（${services.length} 条），loader 已打补丁。`);
    console.log(
      `项目级 MCP：${displayPath(MCP_FILE)} ${
        mcp.changed ? "已配置" : "已是最新"
      } ${MCP_SERVER_NAME} → scripts/swagger-mcp-launcher.mjs（启动时读 services.conf）。`,
    );
    if (approval.configured) {
      console.log(
        `预授权：${displayPath(LOCAL_SETTINGS)} 已允许 ${MCP_SERVER_NAME}，pipeline 不会弹批准。`,
      );
    } else {
      console.log(
        `预授权未配置：pipeline 首次会在会话里弹一次批准（也可以手动把 ${MCP_SERVER_NAME} 加进 ${displayPath(LOCAL_SETTINGS)} 的 enabledMcpjsonServers）。`,
      );
    }
    if (approval.warning) console.log(approval.warning);
    console.log("改完服务只需重跑 yarn swagger；重启 Claude Code 后会话生效。");
    if (warnings.length) {
      console.log(`提示（${warnings.length}）：`);
      for (const w of warnings) console.log(`  - ${w}`);
    }
  }
}

main();
