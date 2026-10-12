// 验证协作平台登录取数：只登录 + 拉列表打印条数，不写盘。
// 用法: yarn probe-sync
import { fetchList } from "../lib/server/teamwork/client";
import { hasCredentials, readCredentials } from "../lib/server/teamwork/credentials";
import { readTeamworkConfig } from "../lib/server/config/root";

async function main() {
  if (!hasCredentials()) {
    console.error("NO AUTH: auth.txt not found");
    process.exit(1);
  }
  const cred = readCredentials();
  console.log(`auth ok, loginName=${cred.loginName}, host=${cred.host}`);
  const user = (process.argv[2] || "").trim() || readTeamworkConfig().username;
  if (!user) {
    console.error("未指定执行人：传参 `yarn probe-sync <用户名>`，或在 febot.config.json 配置 teamwork.username");
    process.exit(1);
  }
  const rows = await fetchList({
    statuses: ["1", "2"],
    user,
    module: "",
    pageSize: 50,
  });
  console.log(`HIT ${rows.length} rows`);
  for (const r of rows.slice(0, 8)) {
    console.log(` - ${String(r.id)}  ${String(r.title ?? "")}`);
  }
}

main().catch((e) => {
  console.error("ERR " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
