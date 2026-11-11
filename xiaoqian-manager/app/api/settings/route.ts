import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isInitialized,
  patchConfig,
  readSanitizedSettings,
} from "@/lib/server/config/store";
import { guardLocalWrite } from "@/lib/server/config/request-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Project = z.object({
  name: z.string().trim().min(1),
  keywords: z.array(z.string().trim().min(1)).optional(),
});

const SwaggerService = z.object({
  name: z.string().trim().min(1),
  url: z.string().trim().min(1),
});

const Repository = z.object({
  name: z.string().trim().min(1),
  devBranch: z.string().trim().optional(),
  mergeBranch: z.string().trim().optional(),
  jenkinsJob: z.string().trim().optional(),
  swagger: z.array(SwaggerService).optional(),
  projects: z.array(Project).default([]),
});

const Patch = z.object({
  repoRoot: z.string().optional(),
  jenkinsBase: z.string().optional(),
  defaults: z
    .object({
      devBranch: z.string().optional(),
      mergeBranch: z.string().optional(),
    })
    .optional(),
  repositories: z.array(Repository).optional(),
  features: z.object({ hindsight: z.boolean().optional() }).optional(),
  nextDevOrigins: z.array(z.string()).optional(),
});

export async function GET() {
  try {
    return NextResponse.json({
      settings: readSanitizedSettings(),
      initialized: isInitialized(),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown error" },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  const guard = guardLocalWrite(req);
  if (!guard.ok) {
    return NextResponse.json({ error: guard.message }, { status: 403 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  const parsed = Patch.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "请求体校验失败", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const settings = patchConfig(parsed.data);
    return NextResponse.json({ settings: readSanitizedSettings(), saved: settings });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "保存配置失败" },
      { status: 500 },
    );
  }
}