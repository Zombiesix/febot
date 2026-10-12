import { createStages, type Task, type TrajectoryItem } from "@/lib/domain/schema";
import type { TwRow } from "./client";

// teamwork 行数据 -> 本项目 Task。白名单挑字段，从源头杜绝凭证泄漏。

const STATUS_TEXT: Record<string, string> = { "1": "待处理", "2": "处理中" };

const OP_TEXT: Record<string, string> = {
  create: "新建需求",
  demand_allot: "需求分配",
  start_task: "开始研发",
  end_task: "结束研发",
  progress: "进度描述",
};

// 多值字段是 "###<json>"，也可能是裸值（详情里 status 就是裸数字）
function decodeField(v: unknown): { value: string; text: string } {
  if (v === null || v === undefined || v === "") return { value: "", text: "" };
  if (typeof v === "object") {
    const o = v as { value?: unknown; change_text?: unknown };
    return { value: String(o.value ?? ""), text: String(o.change_text ?? "") };
  }
  const s = String(v);
  const i = s.indexOf("###");
  if (i !== -1) {
    try {
      const o = JSON.parse(s.slice(i + 3)) as { value?: unknown; change_text?: unknown };
      return { value: String(o.value ?? ""), text: String(o.change_text ?? "") };
    } catch {
      /* 落回裸值 */
    }
  }
  return { value: s, text: s };
}

function statusLabel(row: TwRow, detail: TwRow | null): string {
  const a = decodeField(row.status);
  if (a.text && !/^\d+$/.test(a.text)) return a.text;
  const b = decodeField(detail && detail.status);
  if (b.text && !/^\d+$/.test(b.text)) return b.text;
  const v = a.value || b.value;
  return STATUS_TEXT[v] || v;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractImgs(html: string): string[] {
  const out: string[] = [];
  const re = /<img[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function htmlToText(html: unknown): string {
  if (!html) return "";
  let s = String(html);
  s = s.replace(
    /<img[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
    (_: string, src: string) => `\n\n![](${src})\n\n`
  );
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "- ");
  s = s.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// fj 是轨迹附件的 JSON 数组（可能是字符串）
function fjUrls(fj: unknown): string[] {
  if (!fj) return [];
  let arr: unknown = fj;
  if (typeof fj === "string") {
    try {
      arr = JSON.parse(fj);
    } catch {
      return extractImgs(fj);
    }
  }
  if (!Array.isArray(arr)) arr = [arr];
  return (arr as Array<string | Record<string, unknown>>)
    .map((x) => {
      if (typeof x === "string") return x;
      const o = x ?? {};
      return String(o.url ?? o.src ?? o.path ?? "");
    })
    .filter((u) => /^https?:\/\//i.test(u));
}

// 轨迹单元格：图片只留 [图片 xN] 占位（URL 已在「附件」里列全）
function trajText(html: unknown): string {
  if (!html) return "";
  const n = extractImgs(String(html)).length;
  const t = htmlToText(String(html).replace(/<img[^>]*>/gi, "")).trim();
  return [t, n ? `[图片 x${n}]` : ""].filter(Boolean).join(" ");
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapTrajectory(traj: TwRow[]): TrajectoryItem[] {
  return [...traj]
    .sort((a, b) => str(a.created_time).localeCompare(str(b.created_time)))
    .map((t) => {
      const action =
        OP_TEXT[str(t.operation_action)] || str(t.title) || str(t.operation_action);
      const att = fjUrls(t.fj);
      const content = [trajText(t.description), att.length ? `[附件 x${att.length}]` : ""]
        .filter(Boolean)
        .join(" ");
      return {
        time: str(t.created_time),
        operator: str(t.follow_pname),
        action,
        content,
      };
    });
}

export function rowToTask(row: TwRow, detail: TwRow | null, traj: TwRow[]): Task {
  const d = detail || {};
  const pick = (k: string): unknown =>
    row[k] !== undefined && row[k] !== null && row[k] !== "" ? row[k] : d[k];

  const imgs: string[] = [];
  const collect = (html: unknown) => {
    if (html) extractImgs(String(html)).forEach((u) => imgs.push(u));
  };
  collect(d.demand_text);
  collect(d.assign_description);
  collect(d.attachment);
  traj.forEach((t) => {
    collect(t.description);
    fjUrls(t.fj).forEach((u) => imgs.push(u));
  });

  return {
    id: str(pick("id")),
    demandId: str(pick("demand_id")),
    title: str(pick("title")),
    module: str(pick("module")),
    customerName: str(pick("customer_name")),
    assignee: str(pick("username")),
    twStatus: statusLabel(row, detail),
    leval: decodeField(pick("leval")).text,
    taskType: decodeField(pick("task_type")).text,
    demandLevel: decodeField(pick("demand_level")).text,
    maxHour: toNum(pick("max_hour")),
    developmentHour: toNum(pick("development_hour")),
    planStart: str(pick("start_time")) || null,
    planEnd: str(pick("end_time")) || null,
    factStart: str(pick("fact_start_time")) || null,
    factFinish: str(pick("fact_finish_time")) || null,
    createdName: str(pick("created_name")),
    createdTime: str(pick("created_time")),
    version: str(pick("version")),
    stages: createStages(),
    trajectory: mapTrajectory(traj),
    description: htmlToText(d.demand_text || row.description),
    assignDescription: htmlToText(d.assign_description || row.assign_description),
    attachments: [...new Set(imgs)],
    syncedAt: new Date().toISOString(),
  };
}
