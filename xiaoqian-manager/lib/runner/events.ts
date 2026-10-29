import fs from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { TimelineEvent } from "../domain/run";

// 结构化事件流的读取端。
//
// 写入方只有 advance.mjs（经 XQ_EVENTS_FILE 注入的绝对路径），runner 只读不写。
// 按字节偏移增量解析，避免每次变更整文件重读；坏行跳过并计数，不阻塞后续事件。

export function parseEventLine(line: string): TimelineEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const type = String(obj.type ?? "");
  if (!type) return null;
  return {
    // 未知 type / 未知字段一律放行：runner 只负责转发，UI 侧做「尽力渲染」
    v: typeof obj.v === "number" ? obj.v : 0,
    ts: typeof obj.ts === "string" ? obj.ts : new Date().toISOString(),
    type: type as TimelineEvent["type"],
    stage: typeof obj.stage === "string" ? obj.stage : undefined,
    name: typeof obj.name === "string" ? obj.name : undefined,
    status: typeof obj.status === "string" ? (obj.status as TimelineEvent["status"]) : undefined,
    path: typeof obj.path === "string" ? obj.path : undefined,
    action: typeof obj.action === "string" ? (obj.action as TimelineEvent["action"]) : undefined,
    by: typeof obj.by === "string" ? obj.by : undefined,
    message: typeof obj.message === "string" ? obj.message : undefined,
  };
}

export class EventsTailer {
  private offset = 0;
  private pending = "";
  private watcher: FSWatcher | null = null;
  private stopped = false;
  /** 解析失败的行数（排查用，不中断） */
  badLines = 0;

  constructor(
    private readonly file: string,
    private readonly onEvent: (event: TimelineEvent) => void
  ) {}

  start(): void {
    if (this.stopped || this.watcher) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    } catch {
      // 目录创建失败时 watcher 会启动不了；调用方仍可走 GET /events 全量读取
    }
    this.read();
    this.watcher = watch(this.file, { ignoreInitial: true, persistent: true });
    this.watcher.on("add", () => this.read());
    this.watcher.on("change", () => this.read());
  }

  private read = (): void => {
    if (this.stopped) return;
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return; // 文件还没建出来
    }
    if (size < this.offset) {
      // 文件被截断/重建：从头再读
      this.offset = 0;
      this.pending = "";
    }
    if (size === this.offset) return;

    const length = size - this.offset;
    const buf = Buffer.alloc(length);
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.file, "r");
      fs.readSync(fd, buf, 0, length, this.offset);
      this.offset = size;
    } catch {
      return;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }

    this.pending += buf.toString("utf8");
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = parseEventLine(line);
      if (!event) {
        this.badLines += 1;
        continue;
      }
      try {
        this.onEvent(event);
      } catch (e) {
        console.error("[events] 事件回调失败", e);
      }
    }
  };

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}

/** 首屏加载 / 历史回看：整文件按行解析。 */
export function readAllEvents(file: string): TimelineEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: TimelineEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = parseEventLine(line);
    if (event) out.push(event);
  }
  return out;
}
