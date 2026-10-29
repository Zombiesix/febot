import { notFound } from "next/navigation";
import AppHeader from "@/components/layout/AppHeader";
import SessionView from "@/components/pipeline/SessionView";
import { readTasks } from "@/lib/server/store";
import { getRun } from "@/lib/server/pipeline/runner";
import { readTeamworkConfig } from "@/lib/server/config/root";

export const dynamic = "force-dynamic";

// 会话页：run 数据以 runner 为准，任务信息从 tasks.json 补；任一缺失都不该让整页 500。
export default async function RunSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();

  let taskTitle = `任务 ${run.taskId}`;
  let taskModule = "";
  let updatedAt = "";
  let defaultUser = "";
  try {
    const { tasks, updatedAt: at } = readTasks();
    updatedAt = at;
    const task = tasks.find((t) => t.id === run.taskId);
    if (task) {
      taskTitle = task.title;
      taskModule = task.module;
    }
  } catch {
    // 任务数据读不到时仍展示会话
  }
  try {
    defaultUser = readTeamworkConfig().username;
  } catch {
    // 保持空
  }

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader updatedAt={updatedAt} defaultUser={defaultUser} />
      <main className="flex-1">
        <SessionView
          initialRun={run}
          taskTitle={taskTitle}
          taskModule={taskModule}
          planPath={`data/temp/${run.taskId}.md`}
        />
      </main>
    </div>
  );
}
