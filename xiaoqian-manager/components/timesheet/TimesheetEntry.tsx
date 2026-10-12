"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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

function todayKey() {
  return "xq.timesheet." + new Date().toISOString().slice(0, 10);
}

export default function TimesheetEntry() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mounted 守卫：水合后才有 localStorage
    setDone(localStorage.getItem(todayKey()) === "1");
  }, []);

  const finish = async () => {
    try {
      const date = new Date().toISOString().slice(0, 10);
      // workHoursList：本期无任务数据源（输入框均占位），不确定的字段先空着，
      // 仅 date 落地到 /api/time-entries，由服务端透传给协作平台 saveBatch。
      const res = await fetch("/api/time-entries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date, workHours: [] }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(json?.error || `提交失败（HTTP ${res.status}）`);
      localStorage.setItem(todayKey(), "1");
      setDone(true);
      setOpen(false);
      toast.success("今日工时已提交至协作平台");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "提交工时失败");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Clock className="h-4 w-4" />
          今日工时
          <Badge variant={done ? "secondary" : "outline"} className="ml-1">
            {done ? "已填写" : "未填写"}
          </Badge>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>填写今日工时</DialogTitle>
          <DialogDescription>
            具体填写后续由脚本接入 /api/time-entries 实现，当前为占位入口。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ts-task">任务</Label>
            <Input id="ts-task" disabled placeholder="（脚本接入后选择任务）" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ts-date">日期</Label>
              <Input
                id="ts-date"
                disabled
                value={new Date().toISOString().slice(0, 10)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ts-hours">工时（小时）</Label>
              <Input id="ts-hours" disabled placeholder="-" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button onClick={finish}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
