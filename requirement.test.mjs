import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { cleanupTempRoot, makeCfg, tempRoot, writeTempTasks } from "./helpers.mjs";
import { ScriptError, TASKS_PATH } from "../scripts/lib/febot.mjs";
import {
  deriveProjectMap,
  parseTasksRow,
  resolveBranch,
  resolveRepo,
} from "../scripts/lib/requirement.mjs";

describe("scripts/lib/requirement.mjs", () => {
  after(() => {
    cleanupTempRoot();
  });

  beforeEach(() => {
    if (fs.existsSync(TASKS_PATH)) {
      fs.rmSync(TASKS_PATH, { force: true });
    }
  });

  describe("deriveProjectMap", () => {
    it("filters out projects missing name and treats non-array keywords as empty array", () => {
      const cfg = makeCfg({
        repositories: [
          {
            name: "repo-alpha",
            projects: [
              { name: "订单中心", keywords: ["退款", "售后"] },
              { name: "   ", keywords: ["无效"] },
              { keywords: ["无名项目"] },
              null,
              { name: "商品中心", keywords: "not-an-array" },
            ],
          },
          {
            name: "  repo-beta  ",
            projects: [{ name: "  用户中心  " }],
          },
        ],
      });

      const map = deriveProjectMap(cfg);
      assert.deepEqual(map, [
        { product: "订单中心", keywords: ["退款", "售后"], repo: "repo-alpha" },
        { product: "商品中心", keywords: [], repo: "repo-alpha" },
        { product: "用户中心", keywords: [], repo: "repo-beta" },
      ]);
    });
  });

  describe("resolveBranch", () => {
    it("prefers repository-level devBranch over defaults.devBranch", () => {
      const cfg = makeCfg({
        defaults: { devBranch: "dev" },
        repositories: [
          { name: "repo-custom", devBranch: "feature/main-dev" },
          { name: "repo-default" },
        ],
      });

      assert.deepEqual(resolveBranch(cfg, null, "repo-custom"), {
        branch: "feature/main-dev",
        source: "repositories.devBranch",
      });
    });

    it("falls back to defaults.devBranch when repository devBranch is unset", () => {
      const cfg = makeCfg({
        defaults: { devBranch: "develop" },
        repositories: [{ name: "repo-default" }],
      });

      assert.deepEqual(resolveBranch(cfg, null, "repo-default"), {
        branch: "develop",
        source: "defaults.devBranch",
      });
    });

    it("throws ScriptError with code 6 when neither repository nor defaults specify devBranch", () => {
      const cfg = makeCfg({
        defaults: {},
        repositories: [{ name: "repo-none" }],
      });

      assert.throws(
        () => resolveBranch(cfg, null, "repo-none"),
        (err) => {
          assert.ok(err instanceof ScriptError);
          assert.equal(err.code, 6);
          assert.equal(err.details?.repo, "repo-none");
          return true;
        },
      );
    });
  });

  describe("resolveRepo", () => {
    it("resolves exact project name match with single entry", () => {
      const cfg = makeCfg({
        repoRoot: "repos",
        defaults: { devBranch: "dev" },
        repositories: [
          {
            name: "mall-web",
            projects: [{ name: "商城前台" }],
          },
        ],
      });

      const res = resolveRepo(cfg, "商城前台", "首页轮播图优化");
      assert.deepEqual(res, {
        repo: "mall-web",
        repoDir: path.join(tempRoot, "repos", "mall-web"),
        branch: "dev",
        branchSource: "defaults.devBranch",
      });
    });

    it("matches title keywords and picks the first matching entry in array order", () => {
      const cfg = makeCfg({
        repoRoot: "repos",
        defaults: { devBranch: "dev" },
        repositories: [
          {
            name: "order-h5",
            devBranch: "dev-h5",
            projects: [{ name: "订单系统", keywords: ["移动端", "H5"] }],
          },
          {
            name: "order-admin",
            devBranch: "dev-admin",
            projects: [{ name: "订单系统", keywords: ["后台", "H5"] }],
          },
          {
            name: "order-common",
            projects: [{ name: "订单系统" }],
          },
        ],
      });

      const res = resolveRepo(cfg, "订单系统", "修复 H5 后台订单列表展示");
      assert.equal(res.repo, "order-h5");
      assert.equal(res.branch, "dev-h5");
      assert.equal(res.branchSource, "repositories.devBranch");
      assert.equal(res.repoDir, path.join(tempRoot, "repos", "order-h5"));
    });

    it("falls back to the unique keyword-less entry when no keywords match the title", () => {
      const cfg = makeCfg({
        repoRoot: "repos",
        defaults: { devBranch: "main" },
        repositories: [
          {
            name: "order-h5",
            projects: [{ name: "订单系统", keywords: ["移动端", "小程序"] }],
          },
          {
            name: "order-core",
            projects: [{ name: "订单系统", keywords: [] }],
          },
        ],
      });

      const res = resolveRepo(cfg, "订单系统", "导出报表字段调整");
      assert.equal(res.repo, "order-core");
      assert.equal(res.branch, "main");
      assert.equal(res.repoDir, path.join(tempRoot, "repos", "order-core"));
    });

    it("throws ScriptError (code === 6) when there are 2 fallback entries without keywords", () => {
      const cfg = makeCfg({
        defaults: { devBranch: "dev" },
        repositories: [
          {
            name: "order-a",
            projects: [{ name: "订单系统" }],
          },
          {
            name: "order-b",
            projects: [{ name: "订单系统", keywords: [] }],
          },
        ],
      });

      assert.throws(
        () => resolveRepo(cfg, "订单系统", "普通需求标题"),
        (err) => {
          assert.ok(err instanceof ScriptError);
          assert.equal(err.code, 6);
          assert.deepEqual(err.details?.repos, ["order-a", "order-b"]);
          return true;
        },
      );
    });

    it("throws ScriptError (code === 2) with details.knownProducts containing all products when project name misses", () => {
      const cfg = makeCfg({
        defaults: { devBranch: "dev" },
        repositories: [
          {
            name: "repo-1",
            projects: [{ name: "商品中心" }, { name: "结算中心" }],
          },
          {
            name: "repo-2",
            projects: [{ name: "会员中心" }, { name: "商品中心" }],
          },
        ],
      });

      assert.throws(
        () => resolveRepo(cfg, "不存在的模块", "任意标题"),
        (err) => {
          assert.ok(err instanceof ScriptError);
          assert.equal(err.code, 2);
          assert.equal(err.details?.module, "不存在的模块");
          assert.deepEqual(err.details?.knownProducts, ["商品中心", "结算中心", "会员中心"]);
          return true;
        },
      );
    });

    it("throws ScriptError (code === 2) when candidates have keywords, title misses, and no fallback exists", () => {
      const cfg = makeCfg({
        defaults: { devBranch: "dev" },
        repositories: [
          {
            name: "pay-wechat",
            projects: [{ name: "支付模块", keywords: ["微信"] }],
          },
          {
            name: "pay-alipay",
            projects: [{ name: "支付模块", keywords: ["支付宝"] }],
          },
        ],
      });

      assert.throws(
        () => resolveRepo(cfg, "支付模块", "银联云闪付接入"),
        (err) => {
          assert.ok(err instanceof ScriptError);
          assert.equal(err.code, 2);
          assert.equal(err.details?.module, "支付模块");
          return true;
        },
      );
    });
  });

  describe("parseTasksRow", () => {
    it("throws ScriptError (code === 6) when alias is not found in tasks.md", () => {
      writeTempTasks(
        [
          "| 需求ID | 项目 | 优先级 | tier | 仓库 | 状态 | 入口 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| R-2026-001 | 商城前台 | P1 | full | mall-web | init | docs/requirements/R-2026-001/context.md |",
        ].join("\n"),
      );

      assert.throws(
        () => parseTasksRow("R-2026-999"),
        (err) => {
          assert.ok(err instanceof ScriptError);
          assert.equal(err.code, 6);
          return true;
        },
      );
    });

    it("parses a matching alias row from temporary tasks.md under FEBOT_ROOT", () => {
      assert.equal(TASKS_PATH, path.join(tempRoot, "tasks.md"));
      writeTempTasks(
        [
          "| 需求ID | 项目 | 优先级 | tier | 仓库 | 状态 | 入口 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| R-2026-001 | 商城前台 | P1 | express | mall-web | locating | docs/requirements/R-2026-001/context.md |",
        ].join("\n"),
      );

      const row = parseTasksRow("R-2026-001");
      assert.equal(row.project, "商城前台");
      assert.equal(row.priority, "P1");
      assert.equal(row.tier, "express");
      assert.equal(row.repo, "mall-web");
      assert.equal(row.status, "locating");
    });
  });
});
