import { z } from "zod";

// 固定四节点：planner 计划 -> coder 写代码 -> 人工测试 -> 上传部署
// key 保留用户原文 "planer"
export const STAGE_KEYS = ["planer", "coder", "test", "deploy"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export const StageStatus = z.enum(["pending", "active", "done"]);
export type StageStatus = z.infer<typeof StageStatus>;

export const STAGE_DEFS: { key: StageKey; name: string }[] = [
  { key: "planer", name: "计划" },
  { key: "coder", name: "写代码" },
  { key: "test", name: "人工测试" },
  { key: "deploy", name: "上传部署" },
];

export const Stage = z.object({
  key: z.enum(STAGE_KEYS),
  name: z.string(),
  owner: z.string().default(""),
  status: StageStatus.default("pending"),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  note: z.string().default(""),
});
export type Stage = z.infer<typeof Stage>;

export function createStages(): Stage[] {
  return STAGE_DEFS.map((d) => Stage.parse({ key: d.key, name: d.name }));
}

export const TrajectoryItem = z.object({
  time: z.string(),
  operator: z.string().default(""),
  action: z.string().default(""),
  content: z.string().default(""),
});
export type TrajectoryItem = z.infer<typeof TrajectoryItem>;

export const Task = z.object({
  id: z.string(),
  demandId: z.string().default(""),
  title: z.string(),
  module: z.string().default(""),
  customerName: z.string().default(""),
  assignee: z.string().default(""),
  twStatus: z.string().default(""),
  leval: z.string().default(""),
  taskType: z.string().default(""),
  demandLevel: z.string().default(""),
  maxHour: z.number().nullable().default(null),
  developmentHour: z.number().nullable().default(null),
  planStart: z.string().nullable().default(null),
  planEnd: z.string().nullable().default(null),
  factStart: z.string().nullable().default(null),
  factFinish: z.string().nullable().default(null),
  createdName: z.string().default(""),
  createdTime: z.string().default(""),
  version: z.string().default(""),
  stages: z.array(Stage).length(4),
  trajectory: z.array(TrajectoryItem).default([]),
  description: z.string().default(""),
  assignDescription: z.string().default(""),
  attachments: z.array(z.string()).default([]),
  syncedAt: z.string(),
});
export type Task = z.infer<typeof Task>;

export const TasksFile = z.object({
  version: z.number(),
  updatedAt: z.string(),
  tasks: z.array(Task),
});
export type TasksFile = z.infer<typeof TasksFile>;

// 工时接口契约（本期只预留，不实现存储）
export const TimeEntry = z.object({
  id: z.string(),
  taskId: z.string().nullable().default(null),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hours: z.number().positive().max(24),
  description: z.string().default(""),
  createdAt: z.string(),
});
export type TimeEntry = z.infer<typeof TimeEntry>;
