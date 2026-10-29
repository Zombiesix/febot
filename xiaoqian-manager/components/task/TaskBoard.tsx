"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Inbox, WifiOff } from "lucide-react";
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
import type { PipelineRun } from "@/lib/domain/run";
import {
  ATTENTION_WEIGHT,
  NO_RUN_WEIGHT,
  requestNotificationPermission,
  useRuns,
} from "@/components/pipeline/useRuns";
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

  const { online, runs, byTask, refresh } = useRuns();

  // 注意力排序：needs_input > failed > running > 其他有 run > 无 run
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const weightOf = (t: Task): number => {
      const run = byTask[t.id];
      return run ? ATTENTION_WEIGHT[run.status] : NO_RUN_WEIGHT;
    };
    return initialTasks
      .filter((t) => {
        if (moduleFilter !== "all" && t.module !== moduleFilter) return false;
        if (q && !`${t.title} ${t.id} ${t.module}`.toLowerCase().includes(q))
          return false;
        return true;
      })
      .sort((a, b) => weightOf(a) - weightOf(b));
  }, [initialTasks, query, moduleFilter, byTask]);

  const hasLiveRun = runs.some(
    (r) => r.status === "starting" || r.status === "running" || r.status === "needs_input" || r.status === "settling"
  );
  const pendingReview = runs.filter((r) => r.status === "needs_input").length;

  // 弹框始终取当前任务列表里的最新快照，避免 router.refresh() 后表单还是旧值
  const sheetTask = sheet
    ? (initialTasks.find((t) => t.id === sheet.taskId) ?? null)
    : null;

  // run 收口时由 runner 回调服务端写任务轨迹；这里轮询让页面看到结果
  useEffect(() => {
    if (!hasLiveRun) return;
    const timer = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(timer);
  }, [hasLiveRun, router]);

  const startPipeline = async (taskId: string) => {
    // 通知权限需要用户手势；启动按钮正好是手势上下文
    requestNotificationPermission();
    try {
      const res = await fetch(`/api/tasks/${taskId}/pipeline`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        details?: string;
        run?: PipelineRun;
      };
      if (!res.ok) {
        toast.error(json.error || "启动流水线失败", {
          description: json.details,
        });
        return;
      }
      const runId = json.run?.id;
      toast.success("流水线已启动");
      refresh();
      if (runId) router.push(`/runs/${encodeURIComponent(runId)}`);
      else router.refresh();
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
        {pendingReview > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-600/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
            {pendingReview} 个会话待你处理
          </span>
        )}
        <span className="ml-auto text-sm text-muted-foreground">
          共 {filtered.length} 个任务
        </span>
      </div>

      {!online && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-600/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
          <WifiOff className="h-3.5 w-3.5" />
          runner 未启动，流水线功能不可用。请在项目目录执行 <code className="font-mono">yarn runner</code>。
        </div>
      )}

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
              run={byTask[t.id]}
              onOpenStage={(stage) => setSheet({ taskId: t.id, stage })}
              onStartPipeline={startPipeline}
              onOpenRun={(runId) => router.push(`/runs/${encodeURIComponent(runId)}`)}
            />
          ))}
        </Accordion>
      )}

      <StageSheet
        key={sheet ? `${sheet.taskId}:${sheet.stage.key}` : "closed"}
        sheet={sheet}
        task={sheetTask}
        gitOptions={gitOptions}
        onClose={() => setSheet(null)}
        onSaved={() => router.refresh()}
      />
    </div>
  );
}
