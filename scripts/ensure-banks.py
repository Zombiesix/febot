#!/usr/bin/env python
"""ensure-banks.py - 幂等创建 Hindsight bank + 预填充 febot-project 静态规矩。

用法：
  python scripts/ensure-banks.py [--product <你的产品线名>] [--reseed] [--skip-seed]

行为：
  - 建/clip 3 个 bank：li-expertise / febot-project / <产品线>(默认 product-line)。
  - 往 febot-project 预填充流水线静态规矩：**按 marker 去重**（已存在则不重复写）。
  - `--reseed`：先把**已过时的规矩**（正文含 retire 关键词，如写死的旧分支名/旧措辞）
    PATCH 成 `state=invalidated`（软退休，不物理删除、可查证），再补写当前规矩。
    流程改动后跑一次这个，避免 planner/orchestrator recall 到旧约定。
  - **软降级**：Hindsight 不可用 → 打印不可达提示、exit 0，不抛异常。
  - bank 创建 REST 地址见 ASSUMPTION 块，部署后与真实 schema 不符只改这里。
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
TIMEOUT_S = 30

DEFAULT_PRODUCT = "product-line"

# febot-project 静态规矩（写入 = 规则被应用的实例，供 planner/orchestrator recall）
mv = "febot-project"

# 静态规矩：(正文, 去重 marker)。marker = 正文里一个能扛住抽取 LLM 改写的特征短语，
# 库里已有含该 marker 的条目就不再重复写（Hindsight 的抽取会改写正文，故不能用全文比对）。
STATIC_RULES = [
    ("禁用更改 node / npm / yarn 版本：不执行 nvm use、全局切换或 engines/.nvmrc/package.json 版本改动，版本锁定为现状。",
     "禁用更改 node / npm / yarn 版本"),
    ("涉及 node_modules 数据修改前必须先明确提示「因为 <原因> 需要进行 node_modules 修改」并征得同意，不得静默 install/改依赖/动 link。",
     "需要进行 node_modules 修改"),
    ("commit message 单行规范：feat(R-<别名>): <标题>，只含标题一行、不加正文。标题含中文时用 -F 写消息文件，勿经 bash 中文参数。",
     "commit message 单行规范"),
    ("基准分支由配置决定：从 febot.config.json 的 branches.default 读取（默认 dev，非 master），候选分支见 branches.candidates；主仓 checkout 常驻该分支。",
     "基准分支由配置决定"),
    ("AgentTeam 直接在主仓基准分支工作区改代码（不建 worktree、不切分支），改动以未提交形式留在工作区，绝不 add/commit/push 远程；远程提交合并是 xiaoqian deploy 阶段由人完成。",
     "直接在主仓基准分支工作区改代码"),
    ("开工门禁：需求开工前主仓工作区必须干净（当前分支 == febot.config.json 的 branches.default，且 git status --porcelain 为空），不干净就停下来等人工在 ⑤ 步提交；因共用同一工作区，同一仓库同一时间只能跑一个需求。",
     "开工门禁"),
]

# --reseed 时软退休：正文含这些词的老条目视为过时（2026-10-12 起分支改由配置驱动）。
# 注意别把 "worktree" 放进来：现行「直接在主仓基准分支工作区改代码」这条正文里就有
# 「不建 worktree」，按关键词退休会把当前规矩自己退休掉。这里只放写死分支名/旧措辞。
RETIRE_KEYWORDS = ["dev-zjb", "固定分支"]
SEED_TAG = "seed:febot-project"


def _post(path: str, payload: dict) -> object:
    url = BASE_URL + path
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw.strip() else None


def _put(path: str, payload: dict) -> object:
    url = BASE_URL + path
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw.strip() else None


def _list_rows(bank: str) -> list:
    """列出 bank 里的记忆。失败返回 []（软降级，不阻塞 seed）。"""
    url = f"{BASE_URL}{API_PREFIX}/{urllib.parse.quote(bank)}/memories/list?limit=200"
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_S) as resp:
            raw = resp.read().decode("utf-8")
        data = json.loads(raw) if raw.strip() else {}
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError):
        return []
    if isinstance(data, list):
        return data
    for k in ("items", "results", "memories"):
        if isinstance(data.get(k), list):
            return data[k]
    return []


def _patch_memory(bank: str, mem_id: str, payload: dict) -> None:
    url = f"{BASE_URL}{API_PREFIX}/{urllib.parse.quote(bank)}/memories/{urllib.parse.quote(mem_id)}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="PATCH",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        resp.read()


def _retire_outdated(bank: str, rows: list) -> int:
    """软退休（PATCH state=invalidated，可逆）正文含 RETIRE_KEYWORDS 的条目。

    只处理 `world` 行：派生 observation **不允许 PATCH**（实测 400），
    但父行 invalidated 后派生条也随之退出 recall/list（实测确认），不必单独处理。
    """
    n = 0
    for r in rows:
        mid = r.get("id")
        text = str(r.get("text") or "")
        if not mid or r.get("fact_type") == "observation":
            continue
        if not any(k in text for k in RETIRE_KEYWORDS):
            continue
        try:
            _patch_memory(
                bank,
                mid,
                {"state": "invalidated", "reason": "ensure-banks --reseed: 约定已过时（弃用 worktree）"},
            )
            n += 1
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            print(f"[retire:{bank}] {mid} 失败：{e}")
    return n


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--product", default=DEFAULT_PRODUCT)
    p.add_argument("--skip-seed", action="store_true", help="只建库，不预填充静态规矩")
    p.add_argument("--reseed", action="store_true",
                   help="先软退休已过时的规矩（正文含旧分支名等旧约定），再补齐当前规矩")
    a = p.parse_args()

    banks = ["li-expertise", "febot-project", a.product]
    try:
        src_banks = [b for b in banks if b]
        created = 0
        for b in src_banks:
            try:
                _put(f"{API_PREFIX}/{urllib.parse.quote(b)}", {})
                created += 1
            except urllib.error.HTTPError as e:
                # 409 已存在可视为幂等成功
                if e.code == 409:
                    created += 1
                else:
                    print(f"[bank:{b}] HTTP {e.code}")
        print(f"banks ensured: {created}/{len(src_banks)}")

        if not a.skip_seed:
            rows = _list_rows(mv)
            if a.reseed:
                retired = _retire_outdated(mv, rows)
                print(f"retired {retired} outdated rule(s) from {mv}")
                rows = _list_rows(mv)  # 退休后重取，去重才准
            existing = [str(r.get("text") or "") for r in rows]

            seeded = skipped = 0
            for text, marker in STATIC_RULES:
                if any(marker in t for t in existing):
                    skipped += 1
                    continue
                try:
                    _post(
                        f"{API_PREFIX}/{urllib.parse.quote(mv)}/memories",
                        {"items": [{"content": text, "context": "ensure-banks 静态规矩",
                                    "tags": [SEED_TAG]}]},
                    )
                    seeded += 1
                except (urllib.error.URLError, urllib.error.HTTPError) as e:
                    print(f"[seed:{mv}] 失败：{e}")
            print(f"seeded {seeded}/{len(STATIC_RULES)} static rules into {mv}（已存在跳过 {skipped}）")
    except (urllib.error.URLError, TimeoutError, OSError):
        print("hindsight unreachable — banks not ensured (fail-soft)")
    return 0


if __name__ == "__main__":
    sys.exit(main())