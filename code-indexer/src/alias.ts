import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { fileExists, toRepoRel } from "./ignore";

/**
 * 路径别名表。
 *
 * 过去 `resolveSpecifier` 硬编码「`@/` → srcDir」，结果 repo-d 的
 * `@service`（→ src/service/api）、repo-e 的 `@treatment` / `@nurse`
 * 全部解析不出来，被静默丢弃 —— 那些仓的 import 关系有系统性缺口。
 *
 * 这里真读配置：tsconfig 的 `compilerOptions.paths`（全仓都有）+ vite 的
 * `resolve.alias`（对象式与数组式都要认）。
 */

export interface AliasEntry {
  /** 无尾部 `/*`，如 `"@"`、`"@service"` */
  prefix: string;
  /** repo 相对路径，无尾部斜杠，如 `"src"`、`"src/service/api"` */
  target: string;
}

export interface AliasMap {
  entries: AliasEntry[];
  /** 配置来源，便于诊断（如 `["tsconfig.json", "vite.config.ts"]`） */
  sources: string[];
  /** 认得出形态但求值失败的别名 —— 铁律二：说不清必须带原因和 evidence */
  unresolved: { prefix: string; reason: string; evidence: string[] }[];
}

const TSCONFIG_CANDIDATES = ["tsconfig.json", "tsconfig.app.json"];
const VITE_CANDIDATES = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
];

/** 去掉尾部 `/*` 或 `/` */
function stripWildcard(s: string): string {
  return s.replace(/\/\*$/, "").replace(/\/+$/, "");
}

/** `./src` → `src`；再拼到 repo 相对 */
function normalizeTarget(repoRoot: string, abs: string): string {
  return toRepoRel(repoRoot, abs);
}

/** 键里带 `/*` 表示前缀匹配；不带则要求精确或 `prefix/` 边界 */
function prefixOf(key: string): string {
  return stripWildcard(key);
}

// ---------------------------------------------------------------- tsconfig

function readTsconfigAliases(
  repoRoot: string,
): Pick<AliasMap, "entries" | "unresolved"> & { source: string | null } {
  const entries: AliasEntry[] = [];
  const unresolved: AliasMap["unresolved"] = [];

  for (const name of TSCONFIG_CANDIDATES) {
    const abs = path.join(repoRoot, name);
    if (!fileExists(abs)) continue;

    // tsconfig 允许注释，用 TS 自己的 JSONC 解析
    const read = ts.readConfigFile(abs, f => fs.readFileSync(f, "utf8"));
    if (read.error || !read.config) {
      unresolved.push({
        prefix: "*",
        reason: "tsconfig 解析失败",
        evidence: [name],
      });
      continue;
    }

    const opts = read.config.compilerOptions ?? {};
    const paths = opts.paths as Record<string, string[]> | undefined;
    if (!paths) continue;

    // TS 4.4+ 起 paths 可相对 tsconfig 自身；有 baseUrl 时以 baseUrl 为基准
    const baseAbs = opts.baseUrl
      ? path.resolve(path.dirname(abs), opts.baseUrl)
      : path.dirname(abs);

    for (const [key, values] of Object.entries(paths)) {
      const first = values?.[0];
      if (!first) continue;
      const prefix = prefixOf(key);
      if (!prefix) continue;
      entries.push({
        prefix,
        target: normalizeTarget(repoRoot, path.resolve(baseAbs, stripWildcard(first))),
      });
    }

    return { entries, unresolved, source: name };
  }

  return { entries, unresolved, source: null };
}

// ---------------------------------------------------------------- vite

/**
 * 求值一个 vite 配置里的路径表达式。
 * 只认这几种写法（覆盖实测到的全部形态），认不出返回 null —— 不硬猜。
 */
function evalPathExpr(node: ts.Node, configDir: string): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return path.resolve(configDir, node.text);
  }

  if (ts.isIdentifier(node)) {
    // __dirname 在 vite.config 里就是仓根
    if (node.text === "__dirname" || node.text === "__filename") return configDir;
    return null;
  }

  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : null;

    // fileURLToPath(new URL("./src", import.meta.url))
    if (name === "fileURLToPath") {
      const arg = node.arguments[0];
      if (arg && ts.isNewExpression(arg)) {
        const inner = arg.arguments?.[0];
        if (inner && ts.isStringLiteral(inner)) return path.resolve(configDir, inner.text);
      }
      return null;
    }

    // path.resolve(__dirname, "src") / path.join(...) / resolve(...)
    if (name === "resolve" || name === "join") {
      const parts: string[] = [];
      for (const arg of node.arguments) {
        const v = evalPathExpr(arg, configDir);
        if (v === null) return null; // 有一段认不出，整条作废，别猜
        parts.push(v);
      }
      return parts.length > 0 ? path.resolve(configDir, ...parts) : null;
    }

    // process.cwd()
    if (name === "cwd") return configDir;
    return null;
  }

  return null;
}

function readViteAliases(
  repoRoot: string,
): Pick<AliasMap, "entries" | "unresolved"> & { source: string | null } {
  const entries: AliasEntry[] = [];
  const unresolved: AliasMap["unresolved"] = [];

  for (const name of VITE_CANDIDATES) {
    const abs = path.join(repoRoot, name);
    if (!fileExists(abs)) continue;

    const code = fs.readFileSync(abs, "utf8");
    const kind = name.endsWith(".ts") || name.endsWith(".mts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(abs, code, ts.ScriptTarget.Latest, true, kind);

    // 找 resolve: { alias: <object|array> }
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "alias") {
        const init = node.initializer;

        if (ts.isObjectLiteralExpression(init)) {
          for (const p of init.properties) {
            if (!ts.isPropertyAssignment(p)) continue;
            const key = ts.isIdentifier(p.name)
              ? p.name.text
              : ts.isStringLiteral(p.name)
                ? p.name.text
                : null;
            if (!key) continue;
            const target = evalPathExpr(p.initializer, repoRoot);
            if (target === null) {
              unresolved.push({
                prefix: key,
                reason: "别名值是认不出的表达式",
                evidence: [`${name}:${lineOf(sf, p)}`],
              });
              continue;
            }
            entries.push({ prefix: prefixOf(key), target: normalizeTarget(repoRoot, target) });
          }
        } else if (ts.isArrayLiteralExpression(init)) {
          // [{ find: "@", replacement: path.resolve(...) }]
          for (const el of init.elements) {
            if (!ts.isObjectLiteralExpression(el)) continue;
            const findProp = findPropByName(el, "find");
            const replProp = findPropByName(el, "replacement");
            if (!findProp) continue;
            const key = literalOrRegexSource(findProp.initializer);
            if (!key) {
              unresolved.push({
                prefix: "?",
                reason: "数组式别名的 find 不是字面量或正则",
                evidence: [`${name}:${lineOf(sf, findProp)}`],
              });
              continue;
            }
            const target = replProp ? evalPathExpr(replProp.initializer, repoRoot) : null;
            if (target === null) {
              // 实测 repo-b / repo-c 的数组式只有 axios 去重，不是路径别名 —— 正常，不报噪音
              continue;
            }
            entries.push({ prefix: prefixOf(key), target: normalizeTarget(repoRoot, target) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sf);
    return { entries, unresolved, source: name };
  }

  return { entries, unresolved, source: null };
}

function findPropByName(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | null {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    if (ts.isIdentifier(p.name) && p.name.text === name) return p;
  }
  return null;
}

/** `"@"` 或 `/^@\//` 都能取到前缀；正则里的 `$`/`^` 去掉 */
function literalOrRegexSource(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isRegularExpressionLiteral(node)) {
    const raw = node.getText();
    const m = raw.match(/^\/(.*)\/[a-z]*$/);
    if (!m) return null;
    return m[1].replace(/[\^$]/g, "").replace(/\\\//g, "/").replace(/\/$/, "");
  }
  return null;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

// ---------------------------------------------------------------- 汇总

const cache = new Map<string, AliasMap>();

export function getAliasMap(repoRoot: string): AliasMap {
  const key = path.resolve(repoRoot);
  const hit = cache.get(key);
  if (hit) return hit;

  const tsRes = readTsconfigAliases(key);
  const viteRes = readViteAliases(key);

  // vite 优先（构建期真生效的是它），同前缀去重
  const entries: AliasEntry[] = [];
  const seen = new Set<string>();
  for (const e of [...viteRes.entries, ...tsRes.entries]) {
    if (seen.has(e.prefix)) continue;
    seen.add(e.prefix);
    entries.push(e);
  }
  // 最长前缀优先
  entries.sort((a, b) => b.prefix.length - a.prefix.length);

  const sources = [viteRes.source, tsRes.source].filter((s): s is string => s !== null);

  const map: AliasMap = {
    entries,
    sources,
    unresolved: [...viteRes.unresolved, ...tsRes.unresolved],
  };
  cache.set(key, map);
  return map;
}

export function clearAliasCache(): void {
  cache.clear();
}

/**
 * 别名匹配：前缀必须落在边界上（精确相等，或后跟 `/`）。
 * 返回 repo 相对路径（未做文件解析，可能是目录或无扩展名）。
 */
export function applyAlias(map: AliasMap, spec: string): string | null {
  for (const e of map.entries) {
    if (spec === e.prefix) return e.target;
    if (spec.startsWith(`${e.prefix}/`)) {
      const rest = spec.slice(e.prefix.length + 1);
      return rest ? `${e.target}/${rest}` : e.target;
    }
  }
  return null;
}
