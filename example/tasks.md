# tasks

> 需求元信息表。tier 在 init 阶段由人拍板，写进该需求 decisions.md。
> **仓库**列 = `febot.config.json` 里 `repoRoot` 下的仓库目录名（不是 worktree 名——改动直接落在该仓 `branches.default` 分支的工作区）。`scripts/recon.mjs` 靠这一列定位仓库。
> 本文件由 `yarn setup` 从 `example/tasks.md` 生成，每个团队各填各的，不入库。

| 需求ID | 项目 | 优先级 | tier | 仓库 | 状态 | 入口 |
| ------ | ---- | ------ | ---- | ---- | ---- | ---- |
| A-001  | 示例项目 | P0 | full | example-repo | 待开始 | /pipeline A-001 |
