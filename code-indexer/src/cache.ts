import path from "node:path";
import { clearAliasCache } from "./alias";
import { clearSourceCache } from "./ast";
import { scanRepo } from "./index";
import { clearLiteralCache } from "./literals";
import type { ProjectMap } from "./types";

/** 进程内缓存：同一进程里避免重复全仓扫描（~550ms/次）。XIAOYOU_TTL_MS=0 可禁用缓存 */
const DEFAULT_TTL_MS = 300_000;

const cache = new Map<string, { map: ProjectMap; scannedAt: number }>();

function ttlMs(): number {
  const raw = Number(process.env.XIAOYOU_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
}

export function getScan(repoPath: string): ProjectMap {
  const key = path.resolve(repoPath);
  const ttl = ttlMs();
  const hit = cache.get(key);
  if (hit && (ttl === 0 || Date.now() - hit.scannedAt < ttl)) return hit.map;
  const map = scanRepo(key);
  cache.set(key, { map, scannedAt: Date.now() });
  return map;
}

export function clearScanCache(): void {
  cache.clear();
  clearAliasCache(); // 目标仓的 tsconfig/vite 配置可能变了，别名表一并失效
  clearLiteralCache(); // 常量表同理
  clearSourceCache(); // 文件可能改了，AST 缓存必须一起失效
}
