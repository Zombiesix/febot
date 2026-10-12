"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STATUS_OPTIONS = [
  { label: "待处理 + 处理中", value: "1,2" },
  { label: "仅处理中", value: "2" },
  { label: "仅待处理", value: "1" },
];

interface SyncResult {
  synced: number;
  created: number;
  updated: number;
  removed: number;
  failed: number;
  errors: string[];
}

export default function SyncButton({ defaultUser = "" }: { defaultUser?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState(defaultUser);
  const [statusOpt, setStatusOpt] = useState("1,2");
  const [moduleName, setModuleName] = useState("");
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/tasks/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user,
          statuses: statusOpt.split(","),
          module: moduleName,
        }),
      });
      const json = (await res.json()) as SyncResult & { error?: string };
      if (!res.ok) throw new Error(json.error || "同步失败");
      if (json.failed > 0) {
        toast.warning(
          `同步完成：新增 ${json.created}，更新 ${json.updated}，删除 ${json.removed}，失败 ${json.failed}`,
          { description: json.errors.slice(0, 3).join("\n") }
        );
      } else {
        toast.success(
          `同步完成：新增 ${json.created}，更新 ${json.updated}，删除 ${json.removed}`
        );
      }
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "同步失败");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <RefreshCw className="h-4 w-4" />
          同步
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>从协作平台同步任务</DialogTitle>
          <DialogDescription>
            同步以远程数据为准：范围内远程已不存在的本地任务会被删除，已有任务的阶段进度不会被覆盖。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sync-user">执行人</Label>
            <Input
              id="sync-user"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder={defaultUser || "你的协作平台用户名"}
            />
          </div>
          <div className="space-y-2">
            <Label>状态</Label>
            <Select value={statusOpt} onValueChange={setStatusOpt}>
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
          </div>
          <div className="space-y-2">
            <Label htmlFor="sync-module">模块（可选，精确匹配）</Label>
            <Input
              id="sync-module"
              value={moduleName}
              onChange={(e) => setModuleName(e.target.value)}
              placeholder="如：产品/模块名"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button onClick={run} disabled={running}>
            {running ? "同步中…" : "开始同步"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
