# example / 模板目录

这里放的是**入库的公共样板**。每个团队拉下仓库后跑一次 `yarn setup`，脚本会把这里的模板复制一份到实际位置，再由各团队填自己的值。

**不要直接改这里的文件。** 生成物全部 gitignore，改模板对已经装好的工作区没有影响；而且模板是共享的，改完下次 `git pull` 会和上游冲突。要改就去改生成出来的那一份。

| 模板                    | `yarn setup` 生成到                 |
| ----------------------- | ----------------------------------- |
| `febot.config.json`     | `febot.config.json`                 |
| `tasks.md`              | `tasks.md`                          |
| `project-map.md`        | `project-map.md`                    |
| `file-lock.md`          | `file-lock.md`                      |
| `om-data.json`          | `om/data.json`                      |
| `claude-settings.json`  | `.claude/settings.json`             |
| `teamwork-auth.txt`     | `.teamwork/auth.txt`                |
| `swagger-services.conf` | `swagger-mcp-server/services.conf`  |
| `hindsight.env`         | `scripts/hindsight.env`             |

生成逻辑见 [scripts/ensure-config.mjs](../scripts/ensure-config.mjs)：**目标已存在则跳过，绝不覆盖**，所以重复跑 `yarn setup` 是安全的，也不会冲掉你填过的内容。

> `teamwork-auth.txt` 与 `hindsight.env` 里只放占位值。真实的账号、cookie、API key 一律只留在生成出来的本地文件里，**不要提交回这里**。
