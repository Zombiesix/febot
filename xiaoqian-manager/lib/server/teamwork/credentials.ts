import fs from "node:fs";
import path from "node:path";

// 协作平台登录凭证。password 是前端 JS 加密后的密文，原样透传给登录接口，
// 不要解密、不要尝试明文（会累计失败次数）。
// 凭证只留在服务端，绝不进入任何返回给浏览器的 JSON。

export interface TwCredentials {
  loginName: string;
  password: string;
  host: string;
}

let cached: { file: string; cred: TwCredentials } | null = null;

function resolveAuthFile(): string | null {
  const fromEnv = process.env.TW_AUTH_FILE;
  if (fromEnv && fs.existsSync(path.resolve(fromEnv))) {
    return path.resolve(fromEnv);
  }
  const candidates = [
    path.join(process.cwd(), ".teamwork", "auth.txt"),
    path.join(process.cwd(), "..", ".teamwork", "auth.txt"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function parseAuthFile(file: string): TwCredentials {
  const raw = fs.readFileSync(file, "utf8");
  const cred = Object.fromEntries(
    raw
      .trim()
      .split("\n")
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  ) as Record<string, string>;
  if (!cred.loginName || !cred.password || !cred.host) {
    throw new Error("auth.txt 缺少 loginName / password / host");
  }
  return { loginName: cred.loginName, password: cred.password, host: cred.host };
}

export function hasCredentials(): boolean {
  return resolveAuthFile() !== null;
}

export function readCredentials(): TwCredentials {
  const file = resolveAuthFile();
  if (!file) {
    throw new Error(
      "未找到 auth.txt，试过 TW_AUTH_FILE 环境变量、.teamwork/auth.txt、../.teamwork/auth.txt"
    );
  }
  if (cached && cached.file === file) return cached.cred;
  const cred = parseAuthFile(file);
  cached = { file, cred };
  return cred;
}
