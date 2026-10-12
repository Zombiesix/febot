"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Task } from "@/lib/domain/schema";

export default function TaskTabs({ task }: { task: Task }) {
  const desc = [task.description, task.assignDescription]
    .filter(Boolean)
    .join("\n\n———— 分配任务说明 ————\n\n");

  return (
    <Tabs defaultValue="desc">
      <TabsList>
        <TabsTrigger value="desc">描述</TabsTrigger>
        <TabsTrigger value="traj">
          轨迹{task.trajectory.length ? `（${task.trajectory.length}）` : ""}
        </TabsTrigger>
        <TabsTrigger value="att">
          附件{task.attachments.length ? `（${task.attachments.length}）` : ""}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="desc">
        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/20 px-4 py-3 text-sm leading-relaxed">
          {desc || "（无）"}
        </pre>
      </TabsContent>
      <TabsContent value="traj">
        {task.trajectory.length ? (
          <div className="max-h-72 overflow-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">时间</th>
                  <th className="px-3 py-2 font-medium">操作人</th>
                  <th className="px-3 py-2 font-medium">动作</th>
                  <th className="px-3 py-2 font-medium">内容</th>
                </tr>
              </thead>
              <tbody>
                {task.trajectory.map((t, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                      {t.time}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{t.operator}</td>
                    <td className="whitespace-nowrap px-3 py-2">{t.action}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {t.content || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-lg border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            （无轨迹）
          </p>
        )}
      </TabsContent>
      <TabsContent value="att">
        {task.attachments.length ? (
          <ul className="space-y-2 rounded-lg border bg-muted/20 px-4 py-3">
            {task.attachments.map((url, i) => (
              <li key={i} className="min-w-0">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-sm text-primary underline-offset-2 hover:underline"
                >
                  {url}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            （无附件）
          </p>
        )}
      </TabsContent>
    </Tabs>
  );
}
