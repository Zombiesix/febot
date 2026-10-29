"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { html as diffHtml } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import { FileCode2, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DiffFile, DiffSummary, FilePatch } from "@/lib/domain/run";
import { cn } from "@/lib/utils";

// 右侧 diff 窄栏：默认只显示文件列表，点选后懒加载单个文件的 patch。
// 展示的是工作区相对 baseSha 的全部改动，不区分改动来源。

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "?",
};

const STATUS_CLASS: Record<DiffFile["status"], string> = {
  added: "text-emerald-600 border-emerald-600/40",
  modified: "text-amber-600 border-amber-600/40",
  deleted: "text-destructive border-destructive/40",
  renamed: "text-blue-600 border-blue-600/40",
  untracked: "text-muted-foreground border-border",
};

export default function DiffPanel({
  runId,
  refreshToken,
  selected,
  onSelectedChange,
  className,
  extraActions,
}: {
  runId: string;
  refreshToken: number;
  selected: string[];
  onSelectedChange: (paths: string[]) => void;
  className?: string;
  extraActions?: React.ReactNode;
}) {
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [patch, setPatch] = useState<FilePatch | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  useEffect(() => {
    let stopped = false;
    fetch(`/api/runs/${encodeURIComponent(runId)}/diff`, { cache: "no-store" })
      .then(async (res) => {
        const json = (await res.json()) as DiffSummary & { error?: string };
        if (stopped) return;
        if (!res.ok) {
          setError(json.error ?? "读取 diff 失败");
          return;
        }
        setError("");
        setSummary(json);
        setActivePath((prev) => {
          if (prev && json.files.some((f) => f.path === prev)) return prev;
          return json.files[0]?.path ?? null;
        });
      })
      .catch((e: unknown) => {
        if (!stopped) setError(e instanceof Error ? e.message : "读取 diff 失败");
      })
      .finally(() => {
        if (!stopped) setLoadingList(false);
      });
    return () => {
      stopped = true;
    };
  }, [runId, refreshToken, tick]);

  useEffect(() => {
    if (!activePath) return;
    let stopped = false;
    fetch(
      `/api/runs/${encodeURIComponent(runId)}/diff?path=${encodeURIComponent(activePath)}`,
      { cache: "no-store" }
    )
      .then(async (res) => {
        const json = (await res.json()) as FilePatch & { error?: string };
        if (stopped) return;
        if (!res.ok) {
          setPatch({ path: activePath, patch: "", binary: false, tooLarge: false, note: json.error });
          return;
        }
        setPatch(json);
      })
      .catch((e: unknown) => {
        if (!stopped) {
          setPatch({
            path: activePath,
            patch: "",
            binary: false,
            tooLarge: false,
            note: e instanceof Error ? e.message : "读取文件 diff 失败",
          });
        }
      });
    return () => {
      stopped = true;
    };
  }, [runId, activePath, refreshToken]);

  const toggle = useCallback(
    (path: string) => {
      const next = new Set(selectedSet);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      onSelectedChange([...next]);
    },
    [onSelectedChange, selectedSet]
  );

  const files = useMemo(() => summary?.files ?? [], [summary]);
  const totals = useMemo(
    () =>
      files.reduce(
        (acc, f) => ({
          additions: acc.additions + f.additions,
          deletions: acc.deletions + f.deletions,
        }),
        { additions: 0, deletions: 0 }
      ),
    [files]
  );

  // 切换文件时旧 patch 还没被新请求覆盖，按 path 匹配后再渲染，避免串味；
  // 有选中文件但 patch 尚未落位，就是加载中
  const activePatch = patch && patch.path === activePath ? patch : null;
  const loadingPatch = Boolean(activePath) && activePatch === null;

  const patchHtml = useMemo(() => {
    if (!activePatch?.patch) return "";
    try {
      return diffHtml(activePatch.patch, {
        drawFileList: false,
        matching: "lines",
        outputFormat: "side-by-side",
      });
    } catch {
      return "";
    }
  }, [activePatch]);

  return (
    <div className={cn("flex min-h-0 flex-col rounded-lg border bg-card", className)}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <FileCode2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">改动</span>
        <span className="text-xs text-muted-foreground">
          {files.length} 个文件
          {files.length > 0 && (
            <>
              {" · "}
              <span className="text-emerald-600">+{totals.additions}</span>{" "}
              <span className="text-destructive">-{totals.deletions}</span>
            </>
          )}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          title="刷新"
          onClick={() => {
            setLoadingList(true);
            setTick((n) => n + 1);
          }}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loadingList && "animate-spin")} />
        </Button>
        {extraActions}
      </div>

      {error && (
        <div className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="w-[220px] shrink-0 overflow-y-auto border-r">
          {files.length === 0 && !loadingList && (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              工作区没有改动
            </p>
          )}
          {files.map((f) => (
            <div
              key={f.path}
              className={cn(
                "flex cursor-pointer items-center gap-2 border-b px-2 py-1.5 text-xs hover:bg-muted/50",
                activePath === f.path && "bg-muted/70"
              )}
              onClick={() => setActivePath(f.path)}
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 shrink-0 accent-primary"
                checked={selectedSet.has(f.path)}
                onChange={() => toggle(f.path)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`选择 ${f.path}`}
              />
              <Badge
                variant="outline"
                className={cn("h-4 shrink-0 px-1 font-mono text-[10px]", STATUS_CLASS[f.status])}
              >
                {STATUS_LABEL[f.status]}
              </Badge>
              <span className="min-w-0 flex-1 truncate" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                {f.path}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                <span className="text-emerald-600">+{f.additions}</span>
                <span className="text-destructive">-{f.deletions}</span>
              </span>
            </div>
          ))}
        </div>

        <div className="min-w-0 flex-1 overflow-auto p-2">
          {loadingPatch && (
            <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中…
            </div>
          )}
          {!loadingPatch && activePatch?.tooLarge && (
            <p className="p-4 text-xs text-muted-foreground">
              文件超过 2MB，请在本地查看。
            </p>
          )}
          {!loadingPatch && activePatch?.binary && (
            <p className="p-4 text-xs text-muted-foreground">二进制文件，不渲染内容。</p>
          )}
          {!loadingPatch && !activePatch?.binary && !activePatch?.tooLarge && activePatch?.note && !activePatch?.patch && (
            <p className="p-4 text-xs text-muted-foreground">{activePatch.note}</p>
          )}
          {!loadingPatch && patchHtml && (
            <div
              className="diff2html-wrapper text-xs"
              // diff2html 输出的是转义后的 diff HTML
              dangerouslySetInnerHTML={{ __html: patchHtml }}
            />
          )}
          {!loadingPatch && !patchHtml && !activePatch?.binary && !activePatch?.tooLarge && !activePatch?.note && (
            <p className="p-4 text-xs text-muted-foreground">
              {files.length === 0 ? "暂无改动" : "选择左侧文件查看 patch"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
