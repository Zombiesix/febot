// 部署节点可选的仓库 / 目标分支。纯类型，浏览器端可安全 import
// （服务端读取实现见 lib/server/git/config.ts，那里面用 node:fs，不能进客户端包）。

export interface GitOptions {
  repos: string[];
  branches: string[];
  // 仓库目录名 -> Jenkins 构建地址
  jenkins: Record<string, string>;
}
