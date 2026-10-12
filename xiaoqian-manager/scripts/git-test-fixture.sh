#!/usr/bin/env bash
# 一次性脚手架：在 <仓库根>/.xq-git-test 造一个带「本地裸远程」的测试仓库，
# 用来验证 runDeployGit 的 拉取/提交/推送/cherry-pick 全链路，不碰真实远程。
# 用法: bash scripts/git-test-fixture.sh [happy|conflict]
set -euo pipefail

BASE="$(cd "$(dirname "$0")/../.." && pwd)/.xq-git-test"
PHASE=${1:-happy}
REPO="$BASE/repos/t-repo"

rm -rf "$BASE"
mkdir -p "$REPO"

git init -q "$REPO"
git -C "$REPO" config user.email t@t.local
git -C "$REPO" config user.name tester
git -C "$REPO" config commit.gpgsign false

printf 'one\n' > "$REPO/a.txt"
printf 'shared-line\n' > "$REPO/b.txt"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "init dev-x"
git -C "$REPO" branch -M dev-x

# dev 从 dev-x 分叉，且把 b.txt 改成不同内容 —— 供 conflict 用例制造冲突
git -C "$REPO" checkout -q -b dev
printf 'dev-only-line\n' > "$REPO/b.txt"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "init dev"
git -C "$REPO" checkout -q dev-x

git init -q --bare "$BASE/remote.git"
git -C "$REPO" remote add origin "$BASE/remote.git"
git -C "$REPO" push -q origin dev dev-x
git -C "$REPO" branch --set-upstream-to=origin/dev-x dev-x >/dev/null
git -C "$REPO" checkout -q dev
git -C "$REPO" branch --set-upstream-to=origin/dev dev >/dev/null
git -C "$REPO" checkout -q dev-x

# 未提交改动：happy 改 a.txt（两分支一致，可干净 cherry-pick）
#             conflict 改 b.txt（两分支内容不同，cherry-pick 必冲突）
if [ "$PHASE" = "conflict" ]; then
  printf 'local-change\n' > "$REPO/b.txt"
else
  printf 'two\n' >> "$REPO/a.txt"
fi

cat > "$BASE/repos.json" <<EOF
{"root":"$BASE/repos","repos":["t-repo"],"branches":["dev","dev-x"]}
EOF

echo "fixture ready: $BASE (phase=$PHASE, on $(git -C "$REPO" rev-parse --abbrev-ref HEAD))"
