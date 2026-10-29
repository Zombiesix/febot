"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Workflow } from "lucide-react";
import { fmtDateTime } from "@/lib/ui/format";
import { cn } from "@/lib/utils";
import SyncButton from "@/components/sync/SyncButton";
import TimesheetEntry from "@/components/timesheet/TimesheetEntry";
import { ThemeToggle } from "./ThemeToggle";

export default function AppHeader({
  updatedAt,
  defaultUser = "",
}: {
  updatedAt: string;
  defaultUser?: string;
}) {
  const pathname = usePathname();
  const onReview = pathname?.startsWith("/review");
  return (
    <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4">
        <div className="flex items-center gap-2">
          <Workflow className="h-5 w-5 text-primary" />
          <span className="font-semibold tracking-tight">
            小前 · 前端工作流
          </span>
        </div>
        <nav className="ml-2 hidden items-center gap-1 sm:flex">
          <Link
            href="/"
            className={cn(
              "rounded-md px-2 py-1 text-sm hover:bg-muted",
              !onReview && "text-foreground",
              onReview && "text-muted-foreground"
            )}
          >
            任务
          </Link>
          <Link
            href="/review"
            className={cn(
              "rounded-md px-2 py-1 text-sm hover:bg-muted",
              onReview && "text-foreground",
              !onReview && "text-muted-foreground"
            )}
          >
            待审
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {updatedAt && (
            <span className="hidden text-xs text-muted-foreground sm:block">
              更新于 {fmtDateTime(updatedAt)}
            </span>
          )}
          <TimesheetEntry />
          <SyncButton defaultUser={defaultUser} />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
