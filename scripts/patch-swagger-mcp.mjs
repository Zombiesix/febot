// 给 @aike1202/swagger-mcp-server@1.2.0 打持久补丁（幂等）。
//
// 1) parseArgs 里 `arg.split("=", 2)` 会把 URL 第二个 = 之后的内容截掉，
//    导致 ?group=xxx 变成 ?group → 404。
// 2) 部分网关返回的 swagger 文档含单引号 example 数组（非法 JSON），
//    axios 的 JSON.parse 失败后返回字符串，后续工具直接崩。
//
// 用法：
//   node scripts/patch-swagger-mcp.mjs           打补丁（幂等）
//   node scripts/patch-swagger-mcp.mjs --check   只检查
//   node scripts/patch-swagger-mcp.mjs --json    机器可读输出
//
// 退出码（--check）：
//   0 已打补丁
//   1 未打补丁（可直接运行本脚本）
//   6 文件不存在或代码模式失配（包版本变了，需要更新补丁）
// 打补丁模式失败同样返回 1 / 6。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOADER = path.join(
  ROOT,
  "swagger-mcp-server",
  "node_modules",
  "@aike1202",
  "swagger-mcp-server",
  "build",
  "services",
  "loader.js",
);

const MARKER = "feBot-patch: swagger-mcp";
const PATCHED_PARSE = `const eqIdx = arg.indexOf("=");
                const name = arg.slice(0, eqIdx);
                const url = arg.slice(eqIdx + 1);`;
const ORIGINAL_PARSE = `const [name, url] = arg.split("=", 2);`;
const ORIGINAL_FETCH = `                doc = response.data;\n`;
const PATCHED_FETCH = `                doc = feBotParseSwaggerDoc(response.data);\n`;
const HELPER = `
// ${MARKER} — 单引号 example 数组不是合法 JSON，先修复再解析。
function feBotParseSwaggerDoc(data) {
    if (typeof data !== "string") return data;
    try {
        return JSON.parse(data);
    }
    catch {
        const repaired = data.replace(/"example"\\s*:\\s*\\[[^\\]]*?\\]/g, (m) => m.replace(/'/g, '"'));
        return JSON.parse(repaired);
    }
}
`;

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function inspect(source) {
  const hasMarker = source.includes(MARKER);
  const hasParse = source.includes(PATCHED_PARSE);
  const fetchCount = count(source, PATCHED_FETCH);
  const originalFetchCount = count(source, ORIGINAL_FETCH);
  const hasHelper = source.includes("function feBotParseSwaggerDoc");

  if (hasMarker && hasParse && fetchCount === 2 && hasHelper) {
    return { state: "patched" };
  }
  if (!hasMarker && count(source, ORIGINAL_PARSE) === 1 && originalFetchCount === 2) {
    return { state: "unpatched" };
  }
  return {
    state: "mismatch",
    detail: {
      hasMarker,
      hasParse,
      patchedFetchCount: fetchCount,
      originalFetchCount,
      hasHelper,
      originalParseCount: count(source, ORIGINAL_PARSE),
    },
  };
}

function patch(source) {
  let next = source;
  const applied = [];

  if (count(next, ORIGINAL_PARSE) === 1) {
    next = next.replace(
      ORIGINAL_PARSE,
      `// ${MARKER} — 只按第一个 = 切分，保留 URL 里的 ?group=...\n                ${PATCHED_PARSE}`,
    );
    applied.push("url-split");
  }

  const originalFetchCount = count(next, ORIGINAL_FETCH);
  if (originalFetchCount === 2) {
    next = next.split(ORIGINAL_FETCH).join(PATCHED_FETCH);
    applied.push("fetch-repair");
  }

  if (!next.includes("function feBotParseSwaggerDoc")) {
    next = next.replace(/\s*$/, "\n") + HELPER;
    applied.push("helper");
  }

  return { next, applied };
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const json = process.argv.includes("--json");
  const emit = (obj, code) => {
    if (json) console.log(JSON.stringify(obj));
    else console.log(obj.message);
    process.exit(code);
  };

  if (!fs.existsSync(LOADER)) {
    emit(
      {
        path: LOADER,
        state: "missing",
        message: `未找到 ${path.relative(ROOT, LOADER)}；先运行 yarn install（在 swagger-mcp-server/ 下）。`,
      },
      6,
    );
  }

  const source = fs.readFileSync(LOADER, "utf8");
  const before = inspect(source);

  if (before.state === "patched") {
    emit({ path: LOADER, state: "patched", message: "已是最新补丁，无需改动。" }, 0);
  }

  if (before.state === "mismatch") {
    emit(
      {
        path: LOADER,
        state: "mismatch",
        detail: before.detail,
        message:
          "loader.js 的代码模式与补丁不匹配（可能是 @aike1202/swagger-mcp-server 版本变了）。\n" +
          "请检查官方包是否已修复，或更新 scripts/patch-swagger-mcp.mjs 的匹配串。",
      },
      6,
    );
  }

  if (checkOnly) {
    emit(
      {
        path: LOADER,
        state: "unpatched",
        message: "未打补丁：运行 `yarn swagger:patch`（或 `yarn setup`）可自动修复。",
      },
      1,
    );
  }

  const { next, applied } = patch(source);
  const after = inspect(next);
  if (after.state !== "patched") {
    emit(
      {
        path: LOADER,
        state: "failed",
        detail: after.detail,
        message: "补丁写入后自检失败，请检查 loader.js。",
      },
      1,
    );
  }

  fs.writeFileSync(LOADER, next);
  emit(
    {
      path: LOADER,
      state: "patched",
      applied,
      message: `已打补丁：${applied.join("、")}。`,
    },
    0,
  );
}

main();
