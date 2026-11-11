// 项目级 swagger-multi 的固定启动器。
//
// .mcp.json 只登记这个脚本；它启动时读 swagger-mcp-server/services.conf，
// 把每行 `服务名=URL` 转成上游 server 需要的 argv。这样改 febot.config.json
// 后只需要重跑 yarn swagger，不用改 .mcp.json，也不用重建 MCP 注册。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICES = path.join(ROOT, "swagger-mcp-server", "services.conf");
const SERVER = path.join(
  ROOT,
  "swagger-mcp-server",
  "node_modules",
  "@aike1202",
  "swagger-mcp-server",
  "build",
  "index.js",
);

function fail(message) {
  console.error(`[swagger-multi] ${message}`);
  process.exit(1);
}

function serviceArgs() {
  if (!fs.existsSync(SERVICES)) {
    fail(`找不到 ${SERVICES}：先运行 yarn swagger`);
  }
  const args = fs
    .readFileSync(SERVICES, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const invalid = args.filter((line) => !line.includes("="));
  if (invalid.length) {
    fail(`services.conf 有非法行（应为 服务名=URL）：${invalid.join(" / ")}`);
  }
  if (!args.length) {
    fail(
      "services.conf 里没有服务：在 febot.config.json 的 repositories[].swagger 配置后运行 yarn swagger",
    );
  }
  return args;
}

if (!fs.existsSync(SERVER)) {
  fail(`找不到 MCP server：${SERVER}（先运行 yarn setup 安装依赖）`);
}

const child = spawn(process.execPath, [SERVER, ...serviceArgs()], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});

const forward = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGINT", forward);
process.on("SIGTERM", forward);
process.on("exit", () => {
  if (!child.killed) child.kill();
});
child.on("error", (e) => fail(`启动失败：${e.message}`));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
