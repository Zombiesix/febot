"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Inbox } from "lucide-react";
import { toast } from "sonner";
import { Accordion } from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Stage, Task } from "@/lib/domain/schema";
import type { GitOptions } from "@/lib/domain/git";
import TaskRow from "./TaskRow";
import StageSheet from "./StageSheet";

export default function TaskBoard({
  initialTasks,
  error,
  gitOptions,
}: {
  initialTasks: Task[];
  error?: string;
  gitOptions: GitOptions;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [moduleFilter, setModuleFilter] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ taskId: string; stage: Stage } | null>(
    null
  );

  const modules = useMemo(
    () =>
      [...new Set(initialTasks.map((t) => t.module).filter(Boolean))].sort(),
    [initialTasks]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return initialTasks.filter((t) => {
      if (moduleFilter !== "all" && t.module !== moduleFilter) return false;
      if (q && !`${t.title} ${t.id} ${t.module}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [initialTasks, query, moduleFilter]);

  const hasActivePipeline = initialTasks.some((t) =>
    t.stages.some(
      (s) =>
        (s.key === "planer" || s.key === "coder") && s.status === "active"
    )
  );

  // 流水线在独立终端窗口里跑，结束后由服务端自动置 done —— 轮询刷新让页面看到结果
  useEffect(() => {
    if (!hasActivePipeline) return;
    const timer = setInterval(() => router.refresh(), 15000);
    return () => clearInterval(timer);
  }, [hasActivePipeline, router]);

  const startPipeline = async (taskId: string) => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/pipeline`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        toast.error(json.error || "启动流水线失败");
        return;
      }
      toast.success("流水线已启动，请在弹出的终端窗口里回车开始");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "启动流水线失败");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题 / 任务ID / 模块"
            className="pl-9"
          />
        </div>
        <Select value={moduleFilter} onValueChange={setModuleFilter}>
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue placeholder="全部模块" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部模块</SelectItem>
            {modules.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">
          共 {filtered.length} 个任务
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {initialTasks.length === 0 && !error ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-center">
          <Inbox className="h-10 w-10 text-muted-foreground/50" />
          <div>
            <p className="font-medium">还没有任务</p>
            <p className="mt-1 text-sm text-muted-foreground">
              点击右上角「同步」从协作平台拉取任务列表。
            </p>
          </div>
        </div>
      ) : (
        <Accordion
          type="single"
          collapsible
          value={openId ?? undefined}
          onValueChange={(v) => setOpenId(v || null)}
          className="space-y-3"
        >
          {filtered.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              onOpenStage={(stage) => setSheet({ taskId: t.id, stage })}
              onStartPipeline={startPipeline}
            />
          ))}
        </Accordion>
      )}

      <StageSheet
        key={sheet ? `${sheet.taskId}:${sheet.stage.key}` : "closed"}
        sheet={sheet}
        gitOptions={gitOptions}
        onClose={() => setSheet(null)}
        onSaved={() => router.refresh()}
      />
    </div>
  );
}
