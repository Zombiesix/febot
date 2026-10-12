import fs from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// allowedDevOrigins 来自仓库根的 febot.config.json（不入库）。
// 这里就地读而不是 import lib/server/config/root：next.config 的加载上下文里
// 路径别名不可靠，且它只需要这一个字段。
function readNextDevOrigins(): string[] {
  const candidates = [
    process.env.FEBOT_CONFIG ? path.resolve(process.env.FEBOT_CONFIG) : "",
    path.join(process.cwd(), "febot.config.json"),
    path.join(process.cwd(), "..", "febot.config.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { nextDevOrigins?: unknown };
      const v = raw.nextDevOrigins;
      if (Array.isArray(v)) {
        return v.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim());
      }
      return [];
    } catch {
      // 配置读不了就当没配，不阻塞 dev server 启动
    }
  }
  return [];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: readNextDevOrigins(),
};

export default nextConfig;
