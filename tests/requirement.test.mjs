import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// febot.mjs derives paths at import time. Set both overrides before importing
// either module so a developer's real configuration and tasks stay untouched.
const tempParent = fs.realpathSync(os.tmpdir());
const fixtureRoot = fs.mkdtempSync(path.join(tempParent, "febot-requirement-"));
const configPath = path.join(fixtureRoot, "febot.config.json");
const originalEnv = {
  FEBOT_ROOT: process.env.FEBOT_ROOT,
  FEBOT_CONFIG: process.env.FEBOT_CONFIG,
};
process.env.FEBOT_ROOT = fixtureRoot;
process.env.FEBOT_CONFIG = configPath;
fs.writeFileSync(configPath, JSON.stringify({ repositories: [] }));

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const resolved = fs.realpathSync(fixtureRoot);
  assert.equal(path.dirname(resolved), tempParent);
  assert(path.basename(resolved).startsWith("febot-requirement-"));
  fs.rmSync(resolved, { recursive: true, force: true });
});

const { resolveRepo, resolveBranch, deriveProjectMap, parseTasksRow } =
  await import("../scripts/lib/requirement.mjs");
const { ROOT, TASKS_PATH, ScriptError, readConfig } =
  await import("../scripts/lib/febot.mjs");

function config(repositories, defaults = { devBranch: "develop" }) {
  return {
    dir: fixtureRoot,
    raw: { repoRoot: "repositories", repositories, defaults },
  };
}

function expectScriptError(fn, code, details) {
  assert.throws(fn, (error) => {
    assert(error instanceof ScriptError);
    // ScriptError's existing public property is code (not exitCode).
    assert.equal(error.code, code);
    if (details !== undefined) assert.deepEqual(error.details, details);
    return true;
  });
}

test("configuration and task paths resolve only inside the temporary fixture", () => {
  assert.equal(ROOT, fixtureRoot);
  assert.equal(TASKS_PATH, path.join(fixtureRoot, "tasks.md"));
  assert.equal(readConfig().path, configPath);
  assert.deepEqual(readConfig().raw, { repositories: [] });
});

test("resolveRepo matches the exact project, not a longer project name", () => {
  const cfg = config([
    { name: "extended", projects: [{ name: "Portal Plus" }] },
    { name: "frontend", devBranch: "integration", projects: [{ name: "Portal" }] },
  ]);
  assert.deepEqual(resolveRepo(cfg, "Portal", "Portal Plus maintenance"), {
    repo: "frontend",
    repoDir: path.join(fixtureRoot, "repositories", "frontend"),
    branch: "integration",
    branchSource: "repositories.devBranch",
  });
});

test("resolveRepo keyword matching trims keywords and ignores title case", () => {
  const cfg = config([
    { name: "fallback", projects: [{ name: "Portal" }] },
    { name: "mobile", projects: [{ name: "Portal", keywords: [" Android "] }] },
  ]);
  assert.equal(resolveRepo(cfg, "Portal", "Fix ANDROID layout").repo, "mobile");
});

test("resolveRepo takes the first matching repository in configured order", () => {
  const cfg = config([
    { name: "first", projects: [{ name: "Portal", keywords: ["layout"] }] },
    { name: "second", projects: [{ name: "Portal", keywords: ["mobile"] }] },
  ]);
  assert.equal(resolveRepo(cfg, "Portal", "mobile layout").repo, "first");
});

test("resolveRepo uses the unique fallback when no keyword matches", () => {
  const cfg = config([
    { name: "mobile", projects: [{ name: "Portal", keywords: ["android"] }] },
    { name: "web", projects: [{ name: "Portal", keywords: [] }] },
  ]);
  assert.equal(resolveRepo(cfg, "Portal", "update navigation").repo, "web");
});

test("resolveRepo accepts a missing title when a unique fallback exists", () => {
  const cfg = config([{ name: "web", projects: [{ name: "Portal" }] }]);
  assert.equal(resolveRepo(cfg, "Portal", undefined).repo, "web");
});

test("resolveRepo rejects ambiguous fallbacks with code 6 and repository names", () => {
  const cfg = config([
    { name: "first", projects: [{ name: "Portal" }] },
    { name: "second", projects: [{ name: "Portal", keywords: [] }] },
  ]);
  expectScriptError(() => resolveRepo(cfg, "Portal", "change"), 6, {
    module: "Portal",
    repos: ["first", "second"],
  });
});

test("resolveRepo rejects unknown projects and lists all distinct known products", () => {
  const cfg = config([
    { name: "first", projects: [{ name: "Portal" }, { name: "Admin" }] },
    { name: "second", projects: [{ name: "Portal" }, { name: "Mobile" }] },
  ]);
  expectScriptError(() => resolveRepo(cfg, "portal", "Portal"), 2, {
    module: "portal",
    knownProducts: ["Portal", "Admin", "Mobile"],
  });
});

test("resolveRepo rejects unmatched keywords without a fallback", () => {
  const cfg = config([
    { name: "web", projects: [{ name: "Portal", keywords: ["browser"] }] },
  ]);
  expectScriptError(() => resolveRepo(cfg, "Portal", "android change"), 2, {
    module: "Portal",
    candidates: [{ keywords: ["browser"], repo: "web" }],
  });
});

test("resolveRepo rejects a configuration with no named projects", () => {
  expectScriptError(() => resolveRepo(config([{ name: "web" }]), "Portal", ""), 6);
});

test("resolveBranch prefers and trims the repository override", () => {
  const cfg = config([{ name: " web ", devBranch: " integration " }]);
  assert.deepEqual(resolveBranch(cfg, null, "web"), {
    branch: "integration",
    source: "repositories.devBranch",
  });
});

test("resolveBranch falls back to the trimmed default for a blank override", () => {
  const cfg = config([{ name: "web", devBranch: " " }], { devBranch: " develop " });
  assert.deepEqual(resolveBranch(cfg, null, "web"), {
    branch: "develop",
    source: "defaults.devBranch",
  });
});

test("resolveBranch falls back when the repository has no override", () => {
  assert.deepEqual(resolveBranch(config([{ name: "web" }]), null, "web"), {
    branch: "develop",
    source: "defaults.devBranch",
  });
});

test("resolveBranch rejects missing repository and default branches", () => {
  expectScriptError(() => resolveBranch(config([{ name: "web" }], {}), null, "web"), 6, {
    repo: "web",
  });
});

test("deriveProjectMap filters unnamed entries and normalizes non-array keywords", () => {
  const cfg = config([
    null,
    { name: " ", projects: [{ name: "Ignored" }] },
    { name: "empty", projects: "not an array" },
    { name: " web ", projects: [
      null, {}, { name: 42 }, { name: " " },
      { name: " Portal ", keywords: "browser" },
      { name: "Admin", keywords: ["settings"] },
    ] },
  ]);
  assert.deepEqual(deriveProjectMap(cfg), [
    { product: "Portal", keywords: [], repo: "web" },
    { product: "Admin", keywords: ["settings"], repo: "web" },
  ]);
});

test("deriveProjectMap handles an absent repository registry", () => {
  assert.deepEqual(deriveProjectMap({ raw: {}, dir: fixtureRoot }), []);
});

test("parseTasksRow reports a missing fixture file with code 6", () => {
  assert.equal(fs.existsSync(TASKS_PATH), false);
  expectScriptError(() => parseTasksRow("R-missing"), 6);
});

test("parseTasksRow requires an exact alias and reports missing aliases", () => {
  fs.writeFileSync(TASKS_PATH, "| R-missing-more | Portal | P1 | full | web | init | link |\n");
  expectScriptError(() => parseTasksRow("R-missing"), 6);
});

test("parseTasksRow reads a CRLF fixture and treats the dash repository as empty", () => {
  const line = "| R-demo | Portal | P1 | full | - | init | docs/requirements/R-demo/context.md |";
  fs.writeFileSync(TASKS_PATH, ["# Tasks", "", line, ""].join("\r\n"));
  assert.deepEqual(parseTasksRow("R-demo"), {
    line: 2,
    cells: ["", "R-demo", "Portal", "P1", "full", "-", "init", "docs/requirements/R-demo/context.md", ""],
    project: "Portal",
    priority: "P1",
    tier: "full",
    repo: null,
    status: "init",
    entry: "docs/requirements/R-demo/context.md",
  });
});
