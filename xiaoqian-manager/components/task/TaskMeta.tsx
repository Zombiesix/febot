import type { Task } from "@/lib/domain/schema";
import { fmtDateTime } from "@/lib/ui/format";

export default function TaskMeta({ task }: { task: Task }) {
  const items: [string, string][] = [
    ["任务ID", task.id],
    ["需求ID", task.demandId],
    ["产品/模块", task.module],
    ["客户", task.customerName],
    ["执行人", task.assignee],
    ["任务类型", task.taskType],
    ["研发阶段", task.leval],
    ["难度", task.demandLevel],
    ["最大工时", task.maxHour != null ? `${task.maxHour} h` : ""],
    ["已报工时", task.developmentHour != null ? `${task.developmentHour} h` : ""],
    ["版本", task.version],
    [
      "计划时间",
      task.planStart || task.planEnd
        ? `${fmtDateTime(task.planStart)} ~ ${fmtDateTime(task.planEnd)}`
        : "",
    ],
    ["实际开始", fmtDateTime(task.factStart)],
    ["实际完成", fmtDateTime(task.factFinish)],
    ["创建", `${task.createdName} ${fmtDateTime(task.createdTime)}`],
  ].filter(([, v]) => v) as [string, string][];

  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 rounded-lg border bg-muted/20 px-4 py-3 sm:grid-cols-3 lg:grid-cols-4">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="truncate text-sm" title={v}>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}
