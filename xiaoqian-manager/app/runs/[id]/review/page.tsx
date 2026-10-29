import { notFound } from "next/navigation";
import AppHeader from "@/components/layout/AppHeader";
import ReviewView from "@/components/pipeline/ReviewView";
import { readTasks } from "@/lib/server/store";
import { getRun } from "@/lib/server/pipeline/runner";
import { readTeamworkConfig } from "@/lib/server/config/root";

export const dynamic = "force-dynamic";

export default async function RunReviewPage({
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
    const r = readTasks();
    updatedAt = r.updatedAt;
    const task = r.tasks.find((t) => t.id === run.taskId);
    if (task) {
      taskTitle = task.title;
      taskModule = task.module;
    }
  } catch {
    // ignore
  }
  try {
    defaultUser = readTeamworkConfig().username;
  } catch {
    // ignore
  }

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader updatedAt={updatedAt} defaultUser={defaultUser} />
      <main className="flex-1">
        <ReviewView initialRun={run} taskTitle={taskTitle} taskModule={taskModule} />
      </main>
    </div>
  );
}
