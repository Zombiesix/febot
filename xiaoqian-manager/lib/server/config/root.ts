import fs from "node:fs";
import path from "node:path";

// febot.config.json 的唯一读取入口：本应用（服务端）与 git/teamwork 两个模块共用，
// 避免各处各写一份路径探测。
//
// 查找顺序（先命中先用）：
//   1. FEBOT_CONFIG 环境变量
//   2. cwd/febot.config.json           —— 从仓库根启动（yarn dev 在根、node om/server.js 在 om/ 除外）
//   3. cwd/../febot.config.json        —— `yarn --cwd xiaoqian-manager dev` 时 cwd 是子目录
//
// 配置文件本身不入库，由 `yarn setup` 从 example/febot.config.json 生成。

export interface RootConfig {
  /** 配置文件绝对路径 */
  path: string;
  /** 配置文件所在目录——相对 repoRoot 以此为基准解析 */
  dir: string;
  raw: Record<string, unknown>;
}

let cached: RootConfig | null = null;
let loaded = false;

function candidatePaths(): string[] {
  const list: string[] = [];
  const fromEnv = process.env.FEBOT_CONFIG;
  if (fromEnv && fromEnv.trim()) list.push(path.resolve(fromEnv.trim()));
  list.push(path.join(process.cwd(), "febot.config.json"));
  list.push(path.join(process.cwd(), "..", "febot.config.json"));
  return list;
}

export function readRootConfig(): RootConfig | null {
  if (loaded) return cached;
  loaded = true;
  for (const p of candidatePaths()) {
    if (!fs.existsSync(p)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      throw new Error(`febot.config.json 不是合法 JSON：${p}`);
    }
    cached = {
      path: p,
      dir: path.dirname(p),
      raw: raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {},
    };
    return cached;
  }
  cached = null;
  return cached;
}

/** 只打一次的告警，避免 dev server 每次请求都刷屏 */
let warned = false;
export function warnMissingConfig(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "[config] 未找到 febot.config.json，仓库/分支下拉为空；请先跑 yarn setup 并填写 febot.config.json",
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export interface TeamworkConfig {
  base: string;
  username: string;
  userTag: string;
  tableId: string;
  autograph: string;
  cookie: string;
  users: string[];
}

/** 协作平台配置。缺配置时全部为空串/空数组，调用方自行决定报错还是软降级。 */
export function readTeamworkConfig(): TeamworkConfig {
  const raw = readRootConfig()?.raw ?? {};
  const tw = (raw.teamwork ?? {}) as Record<string, unknown>;
  return {
    base: str(tw.base).replace(/\/+$/, ""),
    username: str(tw.username),
    userTag: str(tw.userTag),
    tableId: str(tw.tableId),
    autograph: str(tw.autograph),
    cookie: str(tw.cookie),
    users: Array.isArray(tw.users)
      ? tw.users.filter((u): u is string => typeof u === "string" && u.trim() !== "").map((u) => u.trim())
      : [],
  };
}

export function readNextDevOrigins(): string[] {
  const raw = readRootConfig()?.raw ?? {};
  const v = raw.nextDevOrigins;
  return Array.isArray(v)
    ? v.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim())
    : [];
}
