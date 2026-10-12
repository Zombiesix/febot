#!/usr/bin/env python
"""hindsight-memo.py - AgentTeam 侧 Hindsight 记忆 CLI（软降级）。

用法：
  hindsight-memo.py recall  --bank X [--query Q] [--budget N] [--out FILE]
  hindsight-memo.py retain  --bank X --content C [--context CTX] [--out FILE]
  hindsight-memo.py reflect --bank X [--query Q] [--out FILE]

设计约束（贴合 febot "只传路径、只收摘要"）：
  - 输出 JSON 到 stdout；--out FILE 时同时落盘供 subagent 用路径读。
  - **软降级**：Hindsight 未起 / 无网络 / 接口异常 → 打印空结果、exit 0，
    绝不抛异常阻塞流水线。调用方据此"没命中就不写、禁止编造"。
  - 用 stdlib urllib，不依赖 hindsight_client 包（无需额外 pip install）。
  - 若要换成官方 hindsight_client，仅需改下方 _call() 一个函数。
"""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

# ===== 已验证（2026-10-08 对照 OpenAPI 实测）=====
BASE_URL = "http://localhost:8888"
API_PREFIX = "/v1/default/banks"
ENDPOINTS = {
    "recall": API_PREFIX + "/{bank}/memories/recall",
    "retain": API_PREFIX + "/{bank}/memories",
    "reflect": API_PREFIX + "/{bank}/reflect",
}
TIMEOUT_S = 30


def _build_payload(op: str, args: argparse.Namespace) -> dict:
    if op == "retain":
        item: dict = {"content": args.content}
        if args.context:
            item["context"] = args.context
        return {"items": [item]}
    # recall / reflect 同构：query 必填；budget 是枚举 low/mid/high（实测 422 确认）
    payload: dict = {"query": args.query}
    if args.budget:
        payload["budget"] = args.budget
    return payload


def _call(op: str, bank: str, payload: dict) -> object:
    url = BASE_URL + ENDPOINTS[op].format(bank=urllib.parse.quote(bank))
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw.strip() else None


def main() -> int:
    p = argparse.ArgumentParser(description="Hindsight 记忆 CLI（软降级）")
    p.add_argument("op", choices=["recall", "retain", "reflect"])
    p.add_argument("--bank", required=True, help="bank_id")
    p.add_argument("--query", default="")
    p.add_argument("--content", default="")
    p.add_argument("--context", default="")
    p.add_argument("--budget", choices=["low", "mid", "high"], default="low",
                   help="recall/reflect 的预算档位（服务端枚举，默认 low 最精简）")
    p.add_argument("--out", default="")
    a = p.parse_args()

    # 无参告警：防止剧本忘传关键参数生成空记忆
    if a.op in ("recall", "reflect") and not a.query:
        print("[]")
        return 0
    if a.op == "retain" and not a.content:
        print("{}")
        return 0

    payload = _build_payload(a.op, a)
    try:
        result = _call(a.op, a.bank, payload)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        # Hindsight 不可用 → 空结果，软降级
        result = [] if a.op == "recall" else {"ok": False, "error": "hindsight unreachable"}

    out = json.dumps(result, ensure_ascii=False, indent=2)
    print(out[:3000])  # stdout 截断摘要
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())