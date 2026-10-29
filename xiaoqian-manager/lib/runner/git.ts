import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DiffFile, FilePatch } from "../domain/run";

// 目标仓上的 git 操作：baseline / diff / 整文件驳回。
//
// 全部命令都带 `-c core.quotepath=false`，中文路径原样返回；解析一律用 `-z`，
// 避免空格、制表符、换行把路径拆坏。
// 本机 git 2.20（`git restore` 需 2.23+），驳回走两段式：checkout + reset。

const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
}

export function headSha(repoRoot: string): string {
  return git(repoRoot, ["rev-parse", "HEAD"]).trim();
}

export function currentBranch(repoRoot: string): string {
  return git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

interface StatusEntry {
  path: string;
  oldPath?: string;
  /** added | modified | deleted | renamed | untracked */
  status: DiffFile["status"];
}

/** 解析 `git status --porcelain=v2 -z --untracked-files=all` */
function parseStatus(repoRoot: string): StatusEntry[] {
  const raw = git(repoRoot, [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
  ]);
  const tokens = raw.split("\0");
  const entries: StatusEntry[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    if (token.startsWith("# ")) continue; // header 行（-z 下一般不会出现，保险）

    if (token.startsWith("? ")) {
      entries.push({ path: token.slice(2), status: "untracked" });
      continue;
    }

    if (token.startsWith("u ")) {
      // 未解决冲突：按 modified 处理
      const parts = token.split(" ");
      const p = parts.slice(10).join(" ");
      if (p) entries.push({ path: p, status: "modified" });
      continue;
    }

    if (token.startsWith("1 ")) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = token.split(" ");
      const xy = parts[1] ?? "..";
      const p = parts.slice(8).join(" ");
      if (!p) continue;
      const x = xy[0];
      const y = xy[1];
      let status: DiffFile["status"] = "modified";
      if (x === "A") status = "added";
      else if (x === "D" || y === "D") status = "deleted";
      entries.push({ path: p, status });
      continue;
    }

    if (token.startsWith("2 ")) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
      const parts = token.split(" ");
      const p = parts.slice(9).join(" ");
      const oldPath = tokens[i + 1];
      i += 1; // 吃掉 origPath 记录
      if (p) entries.push({ path: p, oldPath, status: "renamed" });
      continue;
    }
  }
  return entries;
}

interface NumStat {
  additions: number;
  deletions: number;
  binary: boolean;
}

/** 解析 `git diff --numstat --find-renames -z <base>`，按新路径建索引。 */
function parseNumstat(repoRoot: string, baseSha: string): Map<string, NumStat> {
  const map = new Map<string, NumStat>();
  let raw: string;
  try {
    raw = git(repoRoot, ["diff", "--numstat", "--find-renames", "-z", baseSha]);
  } catch {
    return map;
  }
  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    // 不用 /s 标志：tsconfig target 低于 es2018
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);
    if (!m) continue;
    const binary = m[1] === "-" || m[2] === "-";
    const additions = binary ? 0 : Number.parseInt(m[1], 10);
    const deletions = binary ? 0 : Number.parseInt(m[2], 10);
    let filePath = m[3];
    if (filePath === "") {
      // rename：路径被拆成两段 NUL 记录（旧 → 新）
      const oldPath = tokens[i + 1] ?? "";
      const newPath = tokens[i + 2] ?? "";
      i += 2;
      filePath = newPath || oldPath;
    }
    if (!filePath) continue;
    map.set(filePath, { additions, deletions, binary });
  }
  return map;
}

function isBinaryFile(absPath: string): boolean {
  try {
    const fd = fs.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(8000);
      const n = fs.readSync(fd, buf, 0, 8000, 0);
      for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function countLines(absPath: string): number {
  try {
    const text = fs.readFileSync(absPath, "utf8");
    if (text === "") return 0;
    const lines = text.split(/\r?\n/);
    // 末尾换行产生的空串不算一行
    return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  } catch {
    return 0;
  }
}

function fileSize(absPath: string): number {
  try {
    return fs.statSync(absPath).size;
  } catch {
    return 0;
  }
}

export function listDiff(repoRoot: string, baseSha: string): DiffFile[] {
  const entries = parseStatus(repoRoot);
  const stat = parseNumstat(repoRoot, baseSha);
  const out: DiffFile[] = [];

  for (const entry of entries) {
    const abs = path.join(repoRoot, entry.path);
    const s = stat.get(entry.path);
    const untracked = entry.status === "untracked";
    const binary = untracked ? isBinaryFile(abs) : (s?.binary ?? false);
    const additions = untracked
      ? binary
        ? 0
        : countLines(abs)
      : (s?.additions ?? 0);
    const deletions = untracked ? 0 : (s?.deletions ?? 0);
    const size = fileSize(abs);
    out.push({
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      additions,
      deletions,
      binary,
      tooLarge: size > MAX_CONTENT_BYTES,
    });
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function countChanged(repoRoot: string, baseSha: string): number {
  return listDiff(repoRoot, baseSha).length;
}

function synthUntrackedPatch(relPath: string, text: string): string {
  const lines = text.split(/\r?\n/);
  const trailingNewline = lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();
  const body = lines.map((l) => `+${l}`).join("\n");
  const noNewline = trailingNewline || lines.length === 0 ? "" : "\n\\ No newline at end of file";
  return [
    `diff --git a/${relPath} b/${relPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body + noNewline,
    "",
  ].join("\n");
}

export function readPatch(
  repoRoot: string,
  baseSha: string,
  relPath: string,
  file?: DiffFile
): FilePatch {
  assertSafeRelPath(relPath);
  const abs = path.join(repoRoot, relPath);
  const size = fileSize(abs);
  if (size > MAX_CONTENT_BYTES) {
    return { path: relPath, patch: "", binary: false, tooLarge: true, note: "文件超过 2MB，请在本地查看" };
  }
  if (file?.status === "untracked" || file?.status === "added") {
    if (isBinaryFile(abs)) {
      return { path: relPath, patch: "", binary: true, tooLarge: false };
    }
    const text = fs.readFileSync(abs, "utf8");
    const note = file.status === "untracked" ? "未跟踪文件：整文件按新增展示" : undefined;
    return { path: relPath, patch: synthUntrackedPatch(relPath, text), binary: false, tooLarge: false, note };
  }

  const paths = [relPath];
  if (file?.oldPath && file.oldPath !== relPath) paths.unshift(file.oldPath);
  let patch: string;
  try {
    patch = git(repoRoot, [
      "diff",
      "--unified=3",
      "--no-color",
      "--find-renames",
      baseSha,
      "--",
      ...paths,
    ]);
  } catch (e) {
    return {
      path: relPath,
      patch: "",
      binary: false,
      tooLarge: false,
      note: `git diff 失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (/^Binary files /m.test(patch)) {
    return { path: relPath, patch: "", binary: true, tooLarge: false };
  }
  return { path: relPath, patch, binary: false, tooLarge: false };
}

function assertSafeRelPath(p: string): void {
  const s = String(p ?? "").trim();
  if (!s) throw new Error("路径为空");
  if (s.includes("\\")) throw new Error(`路径不能含反斜杠：${s}`);
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s)) throw new Error(`路径必须是仓库相对路径：${s}`);
  if (s.split("/").includes("..")) throw new Error(`路径不能含 ..：${s}`);
}

function ensureIndexCleanFor(repoRoot: string, relPath: string): void {
  const staged = git(repoRoot, ["diff", "--cached", "--name-only", "-z", "--", relPath])
    .split("\0")
    .filter(Boolean);
  if (staged.length) {
    throw new Error(`该路径有暂存内容，拒绝驳回（请先清空索引）：${relPath}`);
  }
}

function existsInHead(repoRoot: string, relPath: string): boolean {
  try {
    git(repoRoot, ["cat-file", "-e", `HEAD:${relPath}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 整文件驳回：把工作区该路径恢复成 baseSha 的版本，并保证 index 恢复干净。
 * 不自动 commit。
 *
 * - 未跟踪 / base 中不存在的文件 → 直接删除
 * - 其余 → `git checkout <base> -- <path>` 写 index + 工作区，再 `git reset -q -- <path>`
 *   把 index 还原成 HEAD 版本，让驳回只表现为未暂存改动
 */
export function rejectFile(
  repoRoot: string,
  baseSha: string,
  file: DiffFile
): { action: "deleted" | "restored" } {
  const head = headSha(repoRoot);
  if (head !== baseSha) {
    throw new Error(
      `HEAD 已变化（${head.slice(0, 12)} ≠ base ${baseSha.slice(0, 12)}），禁止驳回：可能抹掉基准之后的改动`
    );
  }

  const relPath = file.path;
  assertSafeRelPath(relPath);
  ensureIndexCleanFor(repoRoot, relPath);

  const abs = path.join(repoRoot, relPath);
  const untracked = file.status === "untracked" || !existsInHead(repoRoot, relPath);

  if (untracked) {
    fs.rmSync(abs, { force: true });
    // rename 的新路径属于这种情况；旧路径另行恢复
    if (file.oldPath && file.oldPath !== relPath) {
      restoreFromBase(repoRoot, baseSha, file.oldPath);
    }
    return { action: "deleted" };
  }

  restoreFromBase(repoRoot, baseSha, relPath);
  return { action: "restored" };
}

function restoreFromBase(repoRoot: string, baseSha: string, relPath: string): void {
  assertSafeRelPath(relPath);
  ensureIndexCleanFor(repoRoot, relPath);
  try {
    git(repoRoot, ["checkout", baseSha, "--", relPath]);
  } catch {
    // baseSha 中不存在该路径：说明是会话期间新增，删掉即可
    fs.rmSync(path.join(repoRoot, relPath), { force: true });
    return;
  }
  git(repoRoot, ["reset", "-q", "--", relPath]);
}
