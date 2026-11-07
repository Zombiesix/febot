import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// febot.mjs derives paths at import time. createFixture() must run before any
// script module is imported so a developer's real configuration and tasks stay
// untouched.
export function createFixture(prefix = "febot-requirement-") {
  const tempParent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempParent, prefix));
  const configPath = path.join(root, "febot.config.json");
  const originalEnv = {
    FEBOT_ROOT: process.env.FEBOT_ROOT,
    FEBOT_CONFIG: process.env.FEBOT_CONFIG,
  };

  process.env.FEBOT_ROOT = root;
  process.env.FEBOT_CONFIG = configPath;
  fs.writeFileSync(configPath, JSON.stringify({ repositories: [] }), "utf8");

  return {
    root,
    tempParent,
    configPath,
    makeCfg(raw = {}, dir = root) {
      return { path: path.join(dir, "febot.config.json"), dir, raw };
    },
    writeTasks(content) {
      const tasksPath = path.join(root, "tasks.md");
      fs.writeFileSync(tasksPath, content, "utf8");
      return tasksPath;
    },
    cleanup() {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const resolved = fs.realpathSync(root);
      assert.equal(path.dirname(resolved), tempParent);
      assert(path.basename(resolved).startsWith(prefix));
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}