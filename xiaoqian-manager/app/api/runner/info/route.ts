import { NextResponse } from "next/server";
import { isRunnerOnline, readRunnerInfo } from "@/lib/server/runner-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 浏览器直连 runner 的 WS 地址与 token（只在本机监听 127.0.0.1）
export async function GET() {
  const info = readRunnerInfo();
  if (!info) {
    return NextResponse.json({ online: false, wsUrl: null, token: null });
  }
  const online = await isRunnerOnline();
  return NextResponse.json({
    online,
    wsUrl: info.wsUrl,
    httpUrl: info.httpUrl,
    token: info.token,
  });
}
