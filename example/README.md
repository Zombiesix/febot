# example / 模板目录

这里放的是**入库的公共样板**。每个团队拉下仓库后跑一次 `yarn setup`，脚本会把这里的模板复制一份到实际位置，再由各团队填自己的值。

**不要直接改这里的文件。** 生成物全部 gitignore，改模板对已经装好的工作区没有影响；而且模板是共享的，改完下次 `git pull` 会和上游冲突。要改就去改生成出来的那一份。

| 模板                    | `yarn setup` 生成到                 |
| ----------------------- | ----------------------------------- |
| `febot.config.json`     | `febot.config.json`                 |
| `tasks.md`              | `tasks.md`                          |
| `file-lock.md`          | `file-lock.md`                      |
| `claude-settings.json`  | `.claude/settings.json`             |
| `swagger-services.conf` | `swagger-mcp-server/services.conf`（生成物占位，真源是 `febot.config.json` 的 `repositories[].swagger`；用 `yarn swagger` 覆盖生成） |
| `hindsight.env`         | `scripts/hindsight.env`             |

另外两个目录不参与 `yarn setup`，只给演示模式用：

| 目录 | 用途 |
| --- | --- |
| `demo/` | `yarn demo` 的静态夹具（任务、run、diff、终端快照），详见 [demo/README.md](demo/README.md) |
| `demo-repo/` | 最小 Vue 3 示例仓模板；`yarn demo:repo` 会复制到 `.febot/demo-repo` 并初始化 git |

生成逻辑见 [scripts/ensure-config.mjs](../scripts/ensure-config.mjs)：**目标已存在则跳过，绝不覆盖**，所以重复跑 `yarn setup` 是安全的，也不会冲掉你填过的内容。

> `febot.config.json` 与 `hindsight.env` 里只放占位值。真实的账号、cookie、API key 一律只留在生成出来的本地文件里，**不要提交回这里**。
