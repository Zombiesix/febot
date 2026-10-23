/**
 * febot 脚本共用件：仓库根、配置读取、markdown 小节解析、文本去噪。
 *
 * 只放确定性工具函数，不含任何业务判断；recon.mjs / feed.mjs 共用，
 * 避免两份配置路径解析与 section 语义各自漂移。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（scripts/lib 的上两级） */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 配置错误：调用方按自己的退出码契约转换为 FeedError / fail */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * 读 febot.config.json（不入库，由 yarn setup 生成）。
 * 查找顺序：FEBOT_CONFIG > <仓库根>/febot.config.json > <cwd>/febot.config.json。
 * 返回 { path, dir, raw }；找不到返回 null；JSON 非法抛 ConfigError。
 */
export function readConfig() {
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
      throw new ConfigError(`febot.config.json 不是合法 JSON：${p}`);
    }
    return {
      path: p,
      dir: path.dirname(p),
      raw: raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {},
    };
  }
  return null;
}

/**
 * 目标仓根目录：配置里的 repoRoot（相对路径按配置文件所在目录解析），
 * 缺配置时退回 <仓库根>/gitlab。
 */
export function reposRoot(cfg = readConfig()) {
  const raw = cfg?.raw?.repoRoot;
  if (cfg && typeof raw === "string" && raw.trim()) {
    const v = raw.trim();
    return path.isAbsolute(v) ? v : path.resolve(cfg.dir, v);
  }
  return path.join(ROOT, "gitlab");
}

/** 取某个 `## 标题` 到下一个 `## ` 之间的正文 */
export function section(md, title) {
  const lines = String(md).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${title}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * 关键词抽取前的去噪：去掉 fenced code block、行内代码、URL 与 markdown 链接地址。
 * 长描述直接做 2/3/4-gram 会产生大量噪声，recon 只用去噪后的前 1200 字。
 */
export function stripNoise(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
