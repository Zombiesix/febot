import fs from "node:fs";

/**
 * 仓库规范化键：realpath + 小写 + 正斜杠。
 * 大小写不敏感是 Windows 语义；realpath 用来消除短路径/符号链接造成的重复。
 * repoKey 只作为注册表键，不落进 git 命令。
 */
export function repoKeyOf(root: string): string {
  const real = fs.realpathSync(root);
  return real.replace(/\\/g, "/").toLowerCase();
}
