import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { clearScanCache, getScan } from "./src/cache";
import {
  projectOverview,
  traceFlow,
  traceEvent,
  traceState,
  channelsSummary,
  moduleGraphView,
  listWarnings,
  searchIndex,
} from "./src/query";

/**
 * stdio MCP server。目标仓路径由 CLI 参数固定（v1 单 server 单仓），
 * 进程内扫描缓存带 TTL，rescan 工具可强制重扫。
 */

export function serve(repoPath: string): void {
  const server = new McpServer({ name: "code-indexer", version: "0.1.0" });

  server.registerTool(
    "get_project_map",
    {
      description:
        "Project overview of the indexed Vue3 repo: routes (with Chinese business labels), business modules, API domains, static-analysis warnings. Call this before explaining any module.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: projectOverview(getScan(repoPath)) }] }),
  );

  server.registerTool(
    "trace_flow",
    {
      description:
        "Trace one business flow by route path (e.g. /bed-overview) or module name: route -> page component -> component tree -> API domains -> concrete backend endpoints (method + URL + source location).",
      inputSchema: { target: z.string().describe("route path or module name") },
    },
    async args => ({ content: [{ type: "text", text: traceFlow(getScan(repoPath), args.target) }] }),
  );

  server.registerTool(
    "trace_event",
    {
      description:
        "Trace one component event: who emits it (declaration style + emit call sites), who listens (@event handler on the parent), and what the handler does (API calls / store actions / route changes). Use when explaining an interaction flow — the render tree only covers parent->child, this covers child->parent.",
      inputSchema: {
        component: z.string().describe("component name or path fragment, e.g. BasicDrawer"),
        event: z.string().describe("event name, kebab-case or camelCase"),
      },
    },
    async args => ({
      content: [{ type: "text", text: traceEvent(getScan(repoPath), args.component, args.event) }],
    }),
  );

  server.registerTool(
    "trace_state",
    {
      description:
        "Trace a Pinia store field: who reads it and who writes it (file:line + enclosing function). Answers 'who changes this state'. Pass 'storeId' or 'storeId.field'.",
      inputSchema: {
        target: z.string().describe("store id, optionally with a field: 'user' or 'user.authorization'"),
      },
    },
    async args => ({ content: [{ type: "text", text: traceState(getScan(repoPath), args.target) }] }),
  );

  server.registerTool(
    "list_channels",
    {
      description:
        "State & event channels of the repo: stores, component events (child->parent), permission codes, router guards, storage keys, websockets. Pass kind to narrow down.",
      inputSchema: {
        kind: z
          .string()
          .optional()
          .describe("store | event | permission | guard | storage | ws"),
      },
    },
    async args => ({ content: [{ type: "text", text: channelsSummary(getScan(repoPath), args.kind) }] }),
  );

  server.registerTool(
    "list_module_graph",
    {
      description:
        "Cross-module relations: which module references which (component usage), which modules depend on shared component dirs, which stores are shared across modules, shared API domains, cross-module events. Pass a module name to see only its dependencies.",
      inputSchema: {
        module: z.string().optional().describe("module name; omit for the whole graph"),
      },
    },
    async args => ({ content: [{ type: "text", text: moduleGraphView(getScan(repoPath), args.module) }] }),
  );

  server.registerTool(
    "list_warnings",
    {
      description: "List static-analysis warnings of the indexed repo, optionally filtered by kind.",
      inputSchema: {
        kind: z.string().optional().describe("filter by warning kind"),
        limit: z.number().optional().describe("max items returned (default 20)"),
      },
    },
    async args => ({
      content: [{ type: "text", text: listWarnings(getScan(repoPath), args) }],
    }),
  );

  server.registerTool(
    "search_index",
    {
      description: "Keyword search across routes, modules and API endpoints of the indexed repo.",
      inputSchema: { keyword: z.string().describe("case-insensitive keyword") },
    },
    async args => ({ content: [{ type: "text", text: searchIndex(getScan(repoPath), args.keyword) }] }),
  );

  server.registerTool(
    "rescan",
    {
      description: "Drop the scan cache and rescan the repo. Use after the target repo changed on disk.",
      inputSchema: {},
    },
    async () => {
      clearScanCache();
      const map = getScan(repoPath);
      return { content: [{ type: "text", text: JSON.stringify({ rescanned: true, stats: map.stats }, null, 1) }] };
    },
  );

  async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  void main();
}
