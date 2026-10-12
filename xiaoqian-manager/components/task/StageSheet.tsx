"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Stage, StageStatus } from "@/lib/domain/schema";
import type { GitOptions } from "@/lib/domain/git";
import { stageVisual } from "@/lib/domain/stage-visual";
import { fmtDateTime } from "@/lib/ui/format";

const STATUS_OPTIONS: { value: StageStatus; label: string }[] = [
  { value: "pending", label: "未开始" },
  { value: "active", label: "进行中" },
  { value: "done", label: "已完成" },
];

export default function StageSheet({
  sheet,
  gitOptions,
  onClose,
  onSaved,
}: {
  sheet: { taskId: string; stage: Stage } | null;
  gitOptions: GitOptions;
  onClose: () => void;
  onSaved: () => void;
}) {
  // 部署节点只有「已完成」一种终态：默认即为 done，且不允许改。
  const isDeploy = sheet?.stage.key === "deploy";
  // 表单初始值来自挂载时的 props；父组件用 key={taskId:stageKey} 触发重挂载来重置。
  const [status, setStatus] = useState<StageStatus>(
    isDeploy ? "done" : (sheet?.stage.status ?? "pending"),
  );
  const [owner, setOwner] = useState(sheet?.stage.owner ?? "");
  const [note, setNote] = useState(sheet?.stage.note ?? "");
  const [repo, setRepo] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [saving, setSaving] = useState(false);

  if (!sheet) return null;
  const { stage, taskId } = sheet;
  const gitIncomplete = isDeploy && (!repo || !targetBranch);

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        stageKey: stage.key,
        status,
        owner,
        note,
      };
      if (isDeploy) {
        body.repo = repo;
        body.targetBranch = targetBranch;
      }
      const res = await fetch(`/api/tasks/${taskId}/stage`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "保存失败");
      toast.success("阶段状态已更新");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const v = stageVisual(status);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{stage.name}</SheetTitle>
          <SheetDescription>
            任务 {taskId} · 更新该阶段的状态与信息
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <div className="space-y-2">
            <Label>状态</Label>
            <Select
              value={status}
              onValueChange={(val) => setStatus(val as StageStatus)}
              disabled={isDeploy}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isDeploy && (
              <p className="text-xs text-muted-foreground">
                部署节点固定为「已完成」，不可修改。
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="stage-owner">负责人</Label>
            <Input
              id="stage-owner"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="如：你的协作平台用户名"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="stage-note">备注</Label>
            <textarea
              id="stage-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              placeholder="（可选）"
            />
          </div>
          {isDeploy && (
            <>
              <div className="space-y-2">
                <Label>代码仓库</Label>
                <Select value={repo} onValueChange={setRepo}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择仓库" />
                  </SelectTrigger>
                  <SelectContent>
                    {gitOptions.repos.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>目标分支</Label>
                <Select value={targetBranch} onValueChange={setTargetBranch}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择目标分支" />
                  </SelectTrigger>
                  <SelectContent>
                    {gitOptions.branches.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                标记为「已完成」时会把该仓的改动提交并推送，再把这一次提交
                cherry-pick 到目标分支。失败则不写平台、不落库。
              </p>
              {repo && gitOptions.jenkins[repo] && (
                <p className="text-sm">
                  Jenkins：
                  <a
                    href={gitOptions.jenkins[repo]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-primary underline underline-offset-4"
                  >
                    {gitOptions.jenkins[repo]}
                  </a>
                </p>
              )}
            </>
          )}
          <dl className="space-y-1.5 rounded-lg border bg-muted/20 px-4 py-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">当前标记</dt>
              <dd>{v.badgeLabel}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">开始时间</dt>
              <dd className="tabular-nums">
                {fmtDateTime(stage.startedAt) || "-"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">完成时间</dt>
              <dd className="tabular-nums">
                {fmtDateTime(stage.finishedAt) || "-"}
              </dd>
            </div>
          </dl>
          {gitIncomplete && (
            <p className="text-sm text-destructive">
              标记为「已完成」前请先选择代码仓库与目标分支。
            </p>
          )}
        </div>
        <SheetFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save} disabled={saving || gitIncomplete}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
