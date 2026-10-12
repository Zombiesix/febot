import AppHeader from "@/components/layout/AppHeader";
import TaskBoard from "@/components/task/TaskBoard";
import { readTasks } from "@/lib/server/store";
import { readGitOptions } from "@/lib/server/git/config";
import { readTeamworkConfig } from "@/lib/server/config/root";
import type { Task } from "@/lib/domain/schema";
import type { GitOptions } from "@/lib/domain/git";

export const dynamic = "force-dynamic";

export default function Home() {
  let tasks: Task[] = [];
  let updatedAt = "";
  let error = "";
  try {
    const r = readTasks();
    tasks = r.tasks;
    updatedAt = r.updatedAt;
  } catch (e) {
    error = e instanceof Error ? e.message : "读取任务数据失败";
  }

  // 配置缺失不影响任务列表渲染，部署时下拉框会是空的
  let gitOptions: GitOptions = { repos: [], branches: [], jenkins: {} };
  try {
    gitOptions = readGitOptions();
  } catch {
    // 保持空选项
  }

  // 同步弹窗的默认执行人，来自配置；配置坏了也不该让整页挂掉
  let defaultUser = "";
  try {
    defaultUser = readTeamworkConfig().username;
  } catch {
    // 保持空
  }

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader updatedAt={updatedAt} defaultUser={defaultUser} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <TaskBoard initialTasks={tasks} error={error} gitOptions={gitOptions} />
      </main>
    </div>
  );
}
