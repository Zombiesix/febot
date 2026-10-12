# 发版看板（本地前端发版管理）- 版本管理

按后端人员分组，跟踪各前端项目的发版情况（打包状态、版本号、进度等）。纯本地运行，数据保存在 `om/data.json`（**本地生成，不入库**）。

## 启动

在仓库根目录执行：

```bash
yarn om
```

打开浏览器访问 http://localhost:3000

> `yarn dev` 会同时起本看板（:3000）与 xiaoqian-manager（:3010）。

## 目录结构

```
server.js    零依赖 Node 服务（静态托管 + /api/data 读写 + /api/current-week 拉协作平台）
index.html   页面（Tailwind + 原生 JS）
data.json    数据文件（本地生成，gitignore；缺失时按空看板渲染）
docs/        导出物（本地生成，gitignore）
```

## 配置

- **负责人列表 / 默认负责人 / 协作平台地址与凭据**：读仓库根的 `febot.config.json` 的 `teamwork` 段（`users` / `username` / `base` / `cookie` / `userTag` / `tableId` / `autograph`）。
- **账号密码**：`teamwork.cookie` 留空时，走 `.teamwork/auth.txt`（`loginName` / `password` / `host`）自动登录并刷新 cookie。
- 两者都没配 → 「一键更新」返回 502 并给出指引，页面其余部分照常。

> `om/docs/` 取消入库后，`server.js` 的 `latestDocStart()` 会从「上次导出日期」退化为「最近一次周五 00:00」。这只影响「一键更新」的时间起点，不报错。

## 使用

- 按负责人分组管理项目，每个项目可记录：项目名、打包状态（未开始/进行中/已完成）、版本号、本周新功能、本周修复问题、进度说明、备注
- 新增 / 重命名 / 删除负责人分组
- 新增 / 编辑 / 删除项目；点打包状态徽标可循环切换状态
- 顶部统计项目总数与各状态数量；可搜索过滤
- 所有修改即改即存；支持导出 JSON 备份、导入恢复
