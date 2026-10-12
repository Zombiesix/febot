const { tsImport } = await import("tsx/esm/api");
await tsImport("../cli.ts", import.meta.url);
