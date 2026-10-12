// 验证 runDeployGit：对 scripts/git-test-fixture.sh 造的本地测试仓库跑全链路
// （拉取 → 提交 → 推源分支 → cherry-pick 到目标分支 → 推目标分支）。
// 用法: bash scripts/git-test-fixture.sh happy
//       GIT_REPOS_FILE=<仓库根>/.xq-git-test/repos.json yarn tsx scripts/probe-deploy.ts happy
import { buildDeployMessage, runDeployGit } from "../lib/server/git/deploy";
import { readGitOptions, resolveRepoPath } from "../lib/server/git/config";

// 白名单 / 目录穿越 / 分支白名单的守卫用例：每个都必须抛错
function checkGuards() {
  const cases: [string, () => unknown][] = [
    ["非白名单仓库", () => resolveRepoPath("not-in-list-repo")],
    ["目录穿越 ..", () => resolveRepoPath("../t-repo")],
    ["绝对路径", () => resolveRepoPath("/etc")],
    ["反斜杠", () => resolveRepoPath("..\\t-repo")],
    ["非法分支", () => runDeployGit({ repo: "t-repo", targetBranch: "master", message: "x" })],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      fn();
      console.error(`GUARD FAIL (未抛错): ${name}`);
      failed++;
    } catch (e) {
      console.log(`guard ok: ${name} -> ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failed) process.exit(1);
}

async function main() {
  console.log("options:", JSON.stringify(readGitOptions()));
  console.log("repo path:", resolveRepoPath("t-repo"));
  const phase = process.argv[2] ?? "happy";
  if (phase === "guards") {
    checkGuards();
    return;
  }
  const result = await runDeployGit({
    repo: "t-repo",
    targetBranch: "dev",
    message: buildDeployMessage("T-00000000000000000", `探针用例 ${phase}`),
  });
  console.log("OK", JSON.stringify(result));
}

main().catch((e) => {
  console.error("ERR " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
