import { getScan, clearScanCache } from "./src/cache";
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
import { serve } from "./mcp";

const USAGE = `code-indexer - Vue3 repo static indexer

Usage:
  xiaoyou-index scan <repo>                    full ProjectMap JSON (large)
  xiaoyou-index map <repo>                     compact project overview
  xiaoyou-index trace <repo> <route|module>    trace one business flow
  xiaoyou-index trace-event <repo> <component> <event>
                                               who emits -> who listens -> what the handler does
  xiaoyou-index trace-state <repo> <store>[.<field>]
                                               who reads / who writes a store field
  xiaoyou-index channels <repo> [--kind K]     state & event channels
                                               K = store|event|permission|guard|storage|ws
  xiaoyou-index modules <repo> [<module>]      cross-module relations
                                               (omit <module> for the whole graph)
  xiaoyou-index warnings <repo> [--kind K] [--limit N]
  xiaoyou-index search <repo> <keyword>
  xiaoyou-index stats <repo>                   scan stats only
  xiaoyou-index rescan <repo>                  drop cache and rescan
  xiaoyou-index serve <repo>                   start stdio MCP server
`;

function args(flags: string[], argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flags) {
    const i = argv.indexOf(f);
    if (i >= 0 && argv[i + 1]) out[f] = argv[i + 1];
  }
  return out;
}

function main(): void {
  const [, , cmd, ...rest] = process.argv;
  const positional = rest.filter(a => !a.startsWith("--"));
  const flags = args(["--kind", "--limit"], rest);
  const repo = positional[0];
  const compact = rest.includes("--compact");

  const print = (text: string) => process.stdout.write(compact ? JSON.stringify(JSON.parse(text)) : text + "\n");
  const map = () => getScan(repo);

  switch (cmd) {
    case "scan": {
      requireRepo(repo);
      print(JSON.stringify(map(), null, 1));
      break;
    }
    case "map": {
      requireRepo(repo);
      print(projectOverview(map()));
      break;
    }
    case "trace": {
      requireRepo(repo);
      const target = positional[1];
      if (!target) fail("trace needs a route path or module name");
      print(traceFlow(map(), target));
      break;
    }
    case "trace-event": {
      requireRepo(repo);
      const component = positional[1];
      const event = positional[2];
      if (!component || !event) fail("trace-event needs a component and an event name");
      print(traceEvent(map(), component, event));
      break;
    }
    case "trace-state": {
      requireRepo(repo);
      const target = positional[1];
      if (!target) fail("trace-state needs a store id (optionally store.field)");
      print(traceState(map(), target));
      break;
    }
    case "channels": {
      requireRepo(repo);
      print(channelsSummary(map(), flags["--kind"]));
      break;
    }
    case "modules": {
      requireRepo(repo);
      print(moduleGraphView(map(), positional[1]));
      break;
    }
    case "warnings": {
      requireRepo(repo);
      const limit = flags["--limit"] ? Number(flags["--limit"]) : undefined;
      print(listWarnings(map(), { kind: flags["--kind"], limit }));
      break;
    }
    case "search": {
      requireRepo(repo);
      const kw = positional[1];
      if (!kw) fail("search needs a keyword");
      print(searchIndex(map(), kw));
      break;
    }
    case "stats": {
      requireRepo(repo);
      const m = map();
      print(JSON.stringify({ repo: m.repo.name, stack: m.stack.kind, stats: m.stats }, null, 1));
      break;
    }
    case "rescan": {
      requireRepo(repo);
      clearScanCache();
      const m = map();
      print(JSON.stringify({ rescanned: true, stats: m.stats }, null, 1));
      break;
    }
    case "serve": {
      requireRepo(repo);
      serve(repo);
      break;
    }
    default:
      process.stderr.write(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

function requireRepo(repo?: string): void {
  if (!repo) fail("missing <repo> path argument");
}

function fail(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

main();
