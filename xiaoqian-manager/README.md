# xiaoqian-manager

febot 工作区里**研发流水线的宿主**：一个 Next.js 应用，承载「获取需求 → 人工测试 → 提交合并 → 填工时」这几步，并把 ②③ 步的 `/pipeline` 剧本拉起来。

整体定位见仓库根 [README.md](../README.md) 第一部分。

## 跑起来

从**仓库根**跑（推荐，会同时起 om 看板）：

```bash
yarn dev
```

只跑本应用：

```bash
yarn xiaoqian          # 等价于 yarn --cwd xiaoqian-manager dev
```

端口 **3010**（om 看板占 3000，两者可同时跑）。打开 http://localhost:3010。

## 它读哪些本地配置

| 文件                          | 用途                                                             |
| ----------------------------- | ---------------------------------------------------------------- |
| `../febot.config.json`        | 仓库根 / 仓库列表 / 分支白名单 / Jenkins / 协作平台（`teamwork` 段） |
| `../.teamwork/auth.txt`       | 协作平台账号密码（`loginName` / `password` / `host`）             |
| `data/tasks.json`             | 同步下来的需求（本目录内，已 gitignore）                          |

两份配置都由仓库根的 `yarn setup` 生成模板，**不会自动覆盖**已存在的内容。
`teamwork` 段留空时功能软降级：仓库/分支下拉为空、同步接口返回 400 并提示去配置，其余页面照常。

## 功能与代码位置

| 步骤           | 触发点                              | 实现                                                              |
| -------------- | ----------------------------------- | ----------------------------------------------------------------- |
| ① 获取需求     | 右上角「同步」                      | `lib/server/teamwork/client.ts`（`fetchList`）+ `mapper.ts`       |
| ②③ 规划/编码   | 卡片「开始」→ 拉起 `claude /pipeline` | 只传任务 ID + 临时计划 md，剧本在 `.claude/commands/pipeline.md`  |
| ④ 人工测试     | test 阶段点完成                     | `components/task/StageSheet.tsx`                                  |
| ⑤ 提交合并     | deploy 阶段选仓库 + 目标分支点完成  | `lib/server/git/deploy.ts`（pull → commit → push → cherry-pick）  |
| ⑥ 填工时       | 工时入口                            | `lib/server/teamwork/client.ts` 的 `saveWorkHours`                |

## 调试脚本

```bash
yarn probe-sync              # 只登录协作平台 + 拉列表打印条数，不写盘
yarn probe-sync <用户名>      # 指定执行人（默认取 febot.config.json 的 teamwork.username）
yarn probe-op <任务ID> <需求ID>  # 对真实任务写一条操作，前后对比平台轨迹
yarn probe-deploy            # 走一遍 deploy 的 git 流程（fixture 仓）
```

> Git Bash 下以 `/` 开头的参数会被 MSYS 转成 Windows 路径，需要时加 `MSYS_NO_PATHCONV=1`。

## 环境要求

- Node.js **20.19+**、yarn **1.22.19**（v1）
- 仓库自带铁律：**禁止更改 node / npm / yarn 版本**
