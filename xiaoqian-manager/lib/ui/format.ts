import { format, parseISO } from "date-fns";

// 展示用时间格式化，浏览器安全（无 Node 依赖）。

export function toDate(s?: string | null): Date | null {
  if (!s) return null;
  const d = s.includes("T") ? parseISO(s) : parseISO(s.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

export function fmtDateTime(s?: string | null): string {
  if (!s) return "";
  const d = toDate(s);
  return d ? format(d, "MM-dd HH:mm") : s;
}

export function fmtDate(s?: string | null): string {
  if (!s) return "";
  const d = toDate(s);
  return d ? format(d, "yyyy-MM-dd") : s;
}
