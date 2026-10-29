#!/usr/bin/env node
/**
 * runner - 拥有 PTY、仓库状态注册表、git 操作的常驻进程
 *
 * 独立启动（`yarn runner`），**不与 `yarn dev` 绑定**：Next 的 HMR/重启不会杀会话。
 * 只监听 127.0.0.1，浏览器通过 ws://127.0.0.1:3011/ws 直连。
 *
 * 环境变量：
 *   XQ_RUNNER_PORT      端口，默认 3011
 *   XQ_RUNNER_TOKEN     WS token，缺省随机生成并写入 data/runner.json
 *   XQ_APP_URL          Next 地址，默认 http://127.0.0.1:3010
 *   XQ_RUN_TIMEOUT_MS   单次会话兜底超时，默认 6h
 */
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { RunManager, RepoBusyError, RunNotFoundError, ensureDataDirs } from "../lib/runner/pty";
import { repoStatus } from "../lib/runner/repos";
import { RUNNER_INFO_FILE } from "../lib/runner/paths";
import type { ClientMessage, RunnerInfo, ServerMessage } from "../lib/runner/protocol";

const PORT = Number(process.env.XQ_RUNNER_PORT) || 3011;
const TOKEN = process.env.XQ_RUNNER_TOKEN?.trim() || RunManager.newToken();
const APP_URL = process.env.XQ_APP_URL?.trim() || "http://127.0.0.1:3010";

interface Client {
  ws: WebSocket;
  attached: Set<string>;
  alive: boolean;
}

const clients = new Set<Client>();

function broadcast(runId: string, message: ServerMessage): void {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (!client.attached.has(runId)) continue;
    try {
      client.ws.send(payload);
    } catch {
      clients.delete(client);
    }
  }
}

const manager = new RunManager(broadcast, TOKEN);

// ---------- HTTP ----------

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw.trim()) throw new Error("请求体为空");
  return JSON.parse(raw) as T;
}

function mapError(res: ServerResponse, e: unknown): void {
  if (e instanceof RepoBusyError) {
    json(res, 409, { error: e.message, occupant: e.occupant });
    return;
  }
  if (e instanceof RunNotFoundError) {
    json(res, 404, { error: e.message });
    return;
  }
  json(res, 500, { error: e instanceof Error ? e.message : String(e) });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const segments = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  if (url.pathname === "/healthz") {
    json(res, 200, { ok: true, pid: process.pid, startedAt: STARTED_AT, appUrl: APP_URL });
    return;
  }

  // GET /repos?key=... 或 GET /repos/<urlencoded repoKey>
  if (segments[0] === "repos" && method === "GET") {
    const key = segments[1] ? decodeURIComponent(segments.slice(1).join("/")) : url.searchParams.get("key");
    if (!key) {
      json(res, 400, { error: "缺少 repoKey" });
      return;
    }
    json(res, 200, { repoKey: key, ...repoStatus(key) });
    return;
  }

  if (segments[0] === "runs") {
    const id = segments[1] ? decodeURIComponent(segments[1]) : null;
    const sub = segments[2] ?? null;

    if (!id) {
      if (method === "GET") {
        const status = url.searchParams.get("status");
        let runs = manager.list();
        if (status === "review") {
          runs = runs.filter(
            (r) =>
              (r.status === "done" || r.status === "failed" || r.status === "cancelled") &&
              r.changedFiles > 0 &&
              !r.acceptedAt
          );
        }
        json(res, 200, { runs });
        return;
      }
      if (method === "POST") {
        const body = await readJson<{
          taskId: string;
          repoRoot: string;
          repoKey: string;
          cols: number;
          rows: number;
          planContent: string;
        }>(req);
        const run = manager.start({
          taskId: body.taskId,
          repoRoot: body.repoRoot,
          repoKey: body.repoKey,
          cols: body.cols,
          rows: body.rows,
          planContent: body.planContent,
        });
        json(res, 201, { run });
        return;
      }
      json(res, 405, { error: "method not allowed" });
      return;
    }

    if (!sub) {
      if (method === "GET") {
        const run = manager.get(id);
        if (!run) {
          json(res, 404, { error: `run 不存在：${id}` });
          return;
        }
        json(res, 200, { run });
        return;
      }
      if (method === "DELETE") {
        json(res, 200, { run: manager.cancel(id) });
        return;
      }
      json(res, 405, { error: "method not allowed" });
      return;
    }

    if (sub === "events" && method === "GET") {
      json(res, 200, { events: manager.events(id) });
      return;
    }

    if (sub === "diff" && method === "GET") {
      const p = url.searchParams.get("path");
      if (p) {
        json(res, 200, manager.patch(id, p));
        return;
      }
      json(res, 200, manager.diff(id));
      return;
    }

    if (sub === "reject" && method === "POST") {
      const body = await readJson<{ paths?: string[] }>(req);
      if (!Array.isArray(body.paths) || body.paths.length === 0) {
        json(res, 400, { error: "paths 必须是非空数组" });
        return;
      }
      json(res, 200, { results: manager.reject(id, body.paths) });
      return;
    }

    if (sub === "accept" && method === "POST") {
      json(res, 200, { run: manager.accept(id) });
      return;
    }

    if (sub === "input" && method === "POST") {
      const body = await readJson<{ data?: string; submit?: boolean }>(req);
      const data = typeof body.data === "string" ? body.data : "";
      manager.input(id, body.submit === false ? data : `${data}\r`);
      json(res, 200, { ok: true });
      return;
    }

    if (sub === "resize" && method === "POST") {
      const body = await readJson<{ cols: number; rows: number }>(req);
      manager.resize(id, body.cols, body.rows);
      json(res, 200, { ok: true });
      return;
    }
  }

  json(res, 404, { error: `not found: ${url.pathname}` });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => mapError(res, e));
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  if (url.searchParams.get("token") !== TOKEN) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws: WebSocket) => {
  const client: Client = { ws, attached: new Set(), alive: true };
  clients.add(client);

  ws.on("pong", () => {
    client.alive = true;
  });
  ws.on("close", () => clients.delete(client));
  ws.on("error", () => clients.delete(client));

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case "attach": {
          if (!msg.runId) return;
          client.attached.add(msg.runId);
          const { messages } = manager.replay(msg.runId, msg.lastSeq);
          for (const m of messages) ws.send(JSON.stringify(m));
          return;
        }
        case "detach":
          client.attached.delete(msg.runId);
          return;
        case "input":
          manager.input(msg.runId, msg.data);
          return;
        case "resize":
          manager.resize(msg.runId, msg.cols, msg.rows);
          return;
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        default:
          return;
      }
    } catch (e) {
      ws.send(
        JSON.stringify({
          type: "error",
          runId: (msg as { runId?: string }).runId ?? "",
          seq: 0,
          message: e instanceof Error ? e.message : String(e),
        })
      );
    }
  });
});

const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      client.ws.terminate();
      clients.delete(client);
      continue;
    }
    client.alive = false;
    try {
      client.ws.ping();
    } catch {
      clients.delete(client);
    }
  }
}, 30_000);

// ---------- 启动 ----------

const STARTED_AT = new Date().toISOString();

function writeInfoFile(): void {
  const info: RunnerInfo = {
    pid: process.pid,
    port: PORT,
    httpUrl: `http://127.0.0.1:${PORT}`,
    wsUrl: `ws://127.0.0.1:${PORT}/ws`,
    token: TOKEN,
    startedAt: STARTED_AT,
  };
  fs.mkdirSync(path.dirname(RUNNER_INFO_FILE), { recursive: true });
  fs.writeFileSync(RUNNER_INFO_FILE, JSON.stringify(info, null, 2), "utf8");
}

ensureDataDirs();
const staleRuns = manager.cleanupStale();
writeInfoFile();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[runner] listening on http://127.0.0.1:${PORT}`);
  console.log(`[runner] ws: ws://127.0.0.1:${PORT}/ws?token=<runner.json>`);
  console.log(`[runner] app: ${APP_URL} · stale runs failed: ${staleRuns}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[runner] ${signal}，收尾中…`);
  clearInterval(heartbeat);
  try {
    await manager.shutdown();
  } catch (e) {
    console.error("[runner] shutdown 失败", e);
  }
  wss.close();
  server.close(() => process.exit(0));
  // 兜底：3s 内没退出就强杀
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
