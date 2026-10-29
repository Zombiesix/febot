import AppHeader from "@/components/layout/AppHeader";
import ReviewQueue, { type TaskBrief } from "@/components/pipeline/ReviewQueue";
import { readTasks } from "@/lib/server/store";
import { readTeamworkConfig } from "@/lib/server/config/root";

export const dynamic = "force-dynamic";

export default function ReviewPage() {
  let tasks: TaskBrief[] = [];
  let updatedAt = "";
  let defaultUser = "";
  try {
    const r = readTasks();
    updatedAt = r.updatedAt;
    tasks = r.tasks.map((t) => ({ id: t.id, title: t.title, module: t.module }));
  } catch {
    // 队列照常展示，只是没有标题
  }
  try {
    defaultUser = readTeamworkConfig().username;
  } catch {
    // 保持空
  }

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader updatedAt={updatedAt} defaultUser={defaultUser} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <ReviewQueue tasks={tasks} />
      </main>
    </div>
  );
}
