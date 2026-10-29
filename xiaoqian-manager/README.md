# xiaoqian-manager

febot 工作区里**研发流水线的宿主**：一个 Next.js 应用，承载「获取需求 → 规划 → AI 编码/审查/修复 → 提交合并 → 填写工时」这几步，并把 ②③ 步的 `/pipeline` 剧本拉起来。

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

### 流水线 runner（独立进程）

「写代码」节点的会话跑在 **runner** 里，它和 `yarn dev` **解耦**：Next 重启不影响正在跑的 PTY，runner 重启会无法热恢复（启动时把非终态的 run 置为 failed）。

```bash
yarn runner            # 等价于 yarn --cwd xiaoqian-manager runner，默认监听 127.0.0.1:3011
```

先起 runner 再用页面启动流水线；runner 不在线时任务列表会提示，启动接口返回 503。

runner 启动时在 `xiaoqian-manager/data/runner.json` 写入 `{pid,port,httpUrl,wsUrl,token}`，Next 与浏览器都从这里发现它（token 用于 WS 与内部回调鉴权）。

| 环境变量 | 默认值 | 说明 |
| -------- | ------ | ---- |
| `XQ_RUNNER_PORT` | `3011` | runner HTTP/WS 端口 |
| `XQ_RUNNER_TOKEN` | 随机 | 固定 token（多端调试时可指定） |
| `XQ_APP_URL` | `http://127.0.0.1:3010` | 收口/轨迹回调的 Next 地址 |
| `XQ_RUN_TIMEOUT_MS` | 6 小时 | 单次会话超时 |

健康检查：`curl http://127.0.0.1:3011/healthz`。

## 它读哪些本地配置

| 文件                          | 用途                                                             |
| ----------------------------- | ---------------------------------------------------------------- |
| `../febot.config.json`        | 仓库根 / 仓库列表 / 分支白名单 / Jenkins / 协作平台（`teamwork` 段，含 `loginName` / `password`） |
| `data/tasks.json`             | 同步下来的需求（本目录内，已 gitignore）                          |

两份配置都由仓库根的 `yarn setup` 生成模板，**不会自动覆盖**已存在的内容。
`teamwork` 段留空时功能软降级：仓库/分支下拉为空、同步接口返回 400 并提示去配置，其余页面照常。

## 功能与代码位置

| 步骤           | 触发点                              | 实现                                                              |
| -------------- | ----------------------------------- | ----------------------------------------------------------------- |
| ① 获取需求     | 右上角「同步」                      | `lib/server/teamwork/client.ts`（`fetchList`）+ `mapper.ts`       |
| ② 规划         | 「计划」节点弹框整理/修改需求描述   | `components/task/StageSheet.tsx`（`plannedDescription`）          |
| ③ 编码+审查+修复 | 「写代码」节点 ▶ → 在 runner 的 PTY 里跑 `claude /pipeline`，跳到 `/runs/<任务ID>` 会话页 | 前端 `components/pipeline/`；runner `scripts/runner.ts` + `lib/runner/`；剧本 `.claude/commands/pipeline.md` |
| ④ 提交合并     | deploy 阶段选仓库 + 目标分支点完成  | `lib/server/git/deploy.ts`（pull → commit → push → cherry-pick）  |
| ⑤ 填写工时     | 右上角「今日工时」                  | `components/timesheet/TimesheetEntry.tsx`（新标签页跳转协作平台工时页面） |

> 流程图只有三个节点：计划 → 写代码 → 上传部署（对应总流程 ②③④）。「人工测试」不再单列；人工验收在主仓工作区自行进行。

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
