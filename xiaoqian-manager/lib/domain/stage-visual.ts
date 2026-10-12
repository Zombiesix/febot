import type { StageKey, StageStatus } from "./schema";

// 状态 -> 视觉映射，纯函数、无 Node 依赖，浏览器端可安全 import。

export interface StageVisual {
  /** 节点卡片边框类名 */
  card: string;
  /** 图标徽章类名 */
  icon: string;
  /** 顶部状态条渐变类名 */
  bar: string;
  /** Badge 变体 */
  badge: "outline" | "default" | "secondary";
  badgeLabel: string;
  text: string;
}

const VISUALS: Record<StageStatus, StageVisual> = {
  pending: {
    card: "border-dashed border-muted-foreground/30",
    icon: "bg-muted text-muted-foreground",
    bar: "from-transparent to-transparent",
    badge: "outline",
    badgeLabel: "未开始",
    text: "text-muted-foreground",
  },
  active: {
    card: "border-primary/60 ring-2 ring-primary/40",
    icon: "bg-primary/10 text-primary",
    bar: "from-primary/70 to-primary/30",
    badge: "default",
    badgeLabel: "进行中",
    text: "text-foreground",
  },
  done: {
    card: "border-primary/30 bg-primary/[0.04]",
    icon: "bg-primary/10 text-primary",
    bar: "from-primary to-primary/60",
    badge: "secondary",
    badgeLabel: "已完成",
    text: "text-foreground",
  },
};

export function stageVisual(status: StageStatus): StageVisual {
  return VISUALS[status];
}

export const STAGE_ICONS: Record<StageKey, string> = {
  planer: "ClipboardList",
  coder: "Code2",
  test: "FlaskConical",
  deploy: "Rocket",
};

export interface StageFlowEdge {
  id: string;
  source: StageKey;
  target: StageKey;
}

export const STAGE_EDGES: StageFlowEdge[] = [
  { id: "planer->coder", source: "planer", target: "coder" },
  { id: "coder->test", source: "coder", target: "test" },
  { id: "test->deploy", source: "test", target: "deploy" },
];
