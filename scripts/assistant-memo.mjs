#!/usr/bin/env node
/**
 * assistant-memo.mjs — 助手层 Hindsight 记忆 CLI（P0-3）
 *
 * 形状抄 scripts/hindsight-memo.py（同一套 REST），但两处**故意不同**：
 *   · 失败行为：**硬报错**（stderr「Hindsight 不可达」+ 非 0 退出），不像流水线侧静默软降级。
 *     理由：助手层最怕「以为在存其实没存」。
 *   · 存储通道：溯源信息进 `metadata`（不是 context），分类信息进 `tags`。
 *
 * 用法：
 *   assistant-memo.mjs recall  --bank B --query Q [--budget low|mid|high] [--repo R] [--module M] [--limit N] [--no-prefer-observations] [--json]
 *   assistant-memo.mjs retain  --bank B --content C [--repo R] [--module M] [--evidence F:L] [--source S] [--date D] [--tags a,b] [--context C]
 *   assistant-memo.mjs list    --bank B [--repo R] [--module M] [--days N] [--state valid|invalidated] [--limit N] [--json]
 *   assistant-memo.mjs patch   --bank B --id ID [--text T] [--state valid|invalidated] [--reason R]
 *   assistant-memo.mjs delete  --bank B --id ID [--reason R]      # 软退休（可逆），非物理删除
 *   assistant-memo.mjs restore --bank B --id ID                   # = patch --state valid
 *   assistant-memo.mjs clear   --bank B --yes                     # ⚠️ 清空整个 bank
 *   assistant-memo.mjs stats   --bank B [--json]
 *   assistant-memo.mjs status  [--bank B | --all]                 # P0-5：一眼看出「到底存没存进去」
 *   assistant-memo.mjs health                                     # 服务探活
 *
 * 实测契约要点（2026-10-10，详见 scripts/assistant-probe.mjs 头注释）：
 *   · 一条 retain → 落 2 个 unit：world + 派生 observation；
 *     `metadata` 只在 world 上、派生 observation 上为空；`tags` 两者都在。
 *     故 evidence 同时写进 tags（`ev:<文件:行>`），保证派生条也能带上出处。
 *   · list/recall 的 tags_match 默认 'any' 会**连带捞出无标签条目**；
 *     本 CLI 一律显式传 'all_strict'。
 *   · PATCH 的字段名是 `text`，不是 `content`。
 *   · DELETE {bank}/memories = **清空整个 bank**，故 `delete` 子命令走 invalidated。
 */

const BASE = process.env.HINDSIGHT_BASE || 'http://localhost:8888';
const API = '/v1/default/banks';

class Fail extends Error {}

function fail(msg) { throw new Fail(msg); }

async function req(method, path, body) {
  const opts = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  let resp;
  try {
    resp = await fetch(BASE + path, opts);
  } catch (e) {
    fail(`Hindsight 不可达：${BASE}（${e.message}）\n  记忆不可用。请先启动 Hindsight（见 docs/hindsight-接入方案.md）。`);
  }
  const raw = await resp.text();
  let json = null;
  try { json = raw.trim() ? JSON.parse(raw) : null; } catch { /* 保留 raw */ }
  if (!resp.ok) {
    const detail = json?.detail ? JSON.stringify(json.detail).slice(0, 300) : raw.slice(0, 300);
    fail(`${method} ${path} → HTTP ${resp.status}\n  ${detail}`);
  }
  return json;
}

const q = (s) => encodeURIComponent(s);
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const rowsOf = (r) => r?.items || r?.results || r?.memories || r?.data || (Array.isArray(r) ? r : []);

function parseArgs(argv) {
  const cmd = argv[0];
  const f = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) f[a.slice(2)] = true;
    else { f[a.slice(2)] = next; i++; }
  }
  return { cmd, f };
}

function need(f, ...keys) {
  for (const k of keys) if (f[k] === undefined || f[k] === true) fail(`缺少参数 --${k}`);
}

const fromTag = (tags, prefix) => {
  const t = tags.find((x) => x.startsWith(prefix));
  return t ? t.slice(prefix.length) : null;
};

/** recall 行用 `type`，list 行用 `fact_type` —— 统一；出处优先取 metadata，取不到回落到 tag */
function norm(r) {
  const md = r.metadata || {};
  const tags = r.tags || [];
  return {
    id: r.id,
    type: r.type ?? r.fact_type ?? null,
    text: r.text ?? r.content ?? '',
    date: r.date ?? r.mentioned_at ?? null,
    tags,
    repo: md.repo ?? fromTag(tags, 'repo:'),
    module: md.module ?? fromTag(tags, 'module:'),
    evidence: md.evidence ?? fromTag(tags, 'ev:'),
    source: md.source ?? null,
    state: r.state ?? null,
    scores: r.scores ?? null,
  };
}

function printRows(rows, { json } = {}) {
  const n = rows.map(norm);
  if (json) { console.log(JSON.stringify(n, null, 2)); return n; }
  if (!n.length) { console.log('(无条目)'); return n; }
  for (const r of n) {
    const bits = [
      r.id.slice(0, 8),
      (r.date || '').slice(0, 16).replace('T', ' '),
      (r.type || '?').padEnd(11),
      r.repo ? `repo=${r.repo}` : '',
      r.module ? `module=${r.module}` : '',
      r.state && r.state !== 'valid' ? `[${r.state}]` : '',
    ].filter(Boolean).join('  ');
    console.log(`${bits}\n    ${clip(r.text, 220)}${r.evidence ? `\n    出处 ${r.evidence}` : ''}`);
  }
  console.log(`\n共 ${n.length} 条`);
  return n;
}

/** repo/module → tags 过滤（all_strict：只留带全标签的，排除无标签条目） */
function tagFilter(repo, module) {
  const tags = [];
  if (repo) tags.push(`repo:${repo}`);
  if (module) tags.push(`module:${module}`);
  return tags.length ? { tags, tags_match: 'all_strict' } : {};
}

const cmds = {
  async recall(f) {
    need(f, 'bank', 'query');
    const body = {
      query: String(f.query),
      budget: f.budget || 'low',
      ...tagFilter(f.repo, f.module),
    };
    if (f['no-prefer-observations'] !== true) body.prefer_observations = true;
    const res = await req('POST', `${API}/${q(f.bank)}/memories/recall`, body);
    const rows = rowsOf(res).slice(0, Number(f.limit || 20));
    if (!rows.length) {
      console.log('(未命中任何已存结论)');
      if (f.json) console.log('[]');
      return;
    }
    printRows(rows, { json: f.json === true });
  },

  async retain(f) {
    need(f, 'bank', 'content');
    const tags = [];
    if (f.repo) tags.push(`repo:${f.repo}`);
    if (f.module) tags.push(`module:${f.module}`);
    if (f.evidence) tags.push(`ev:${f.evidence}`);   // ← 让派生 observation 也带上出处
    if (f.tags) tags.push(...String(f.tags).split(',').map((s) => s.trim()).filter(Boolean));

    const metadata = {};
    if (f.repo) metadata.repo = String(f.repo);
    if (f.module) metadata.module = String(f.module);
    if (f.evidence) metadata.evidence = String(f.evidence);
    metadata.source = String(f.source || 'chat');
    if (f.date) metadata.date = String(f.date);

    const item = { content: String(f.content), metadata };
    if (tags.length) item.tags = tags;
    if (f.context) item.context = String(f.context);
    if (f.date) item.timestamp = String(f.date);

    const res = await req('POST', `${API}/${q(f.bank)}/memories`, { items: [item] });
    console.log(JSON.stringify({ ok: res?.success !== false, bank: f.bank, items: res?.items_count ?? 1, tags }));
  },

  async list(f) {
    need(f, 'bank');
    const p = new URLSearchParams();
    const tf = tagFilter(f.repo, f.module);
    if (tf.tags) tf.tags.forEach((t) => p.append('tags', t));
    if (tf.tags_match) p.set('tags_match', tf.tags_match);
    if (f.state) p.set('state', String(f.state));
    if (f.days) {
      p.set('time_field', 'created_at');
      p.set('start_date', new Date(Date.now() - Number(f.days) * 864e5).toISOString());
    }
    p.set('limit', String(f.limit || 50));
    const res = await req('GET', `${API}/${q(f.bank)}/memories/list?${p}`);
    printRows(rowsOf(res), { json: f.json === true });
  },

  async patch(f) {
    need(f, 'bank', 'id');
    const body = {};
    if (f.text !== undefined && f.text !== true) body.text = String(f.text);
    else if (f.content !== undefined && f.content !== true) body.text = String(f.content); // 兼容文档里的 --content
    if (f.state) body.state = String(f.state);
    if (f.reason) body.reason = String(f.reason);
    if (!Object.keys(body).length) fail('至少给 --text 或 --state 之一');
    const res = await req('PATCH', `${API}/${q(f.bank)}/memories/${q(f.id)}`, body);
    console.log(JSON.stringify({ ok: true, id: f.id, changed: Object.keys(body), state: res?.state ?? null }));
  },

  async delete(f) {
    need(f, 'bank', 'id');
    await req('PATCH', `${API}/${q(f.bank)}/memories/${q(f.id)}`, {
      state: 'invalidated',
      reason: String(f.reason || 'assistant delete'),
    });
    console.log(JSON.stringify({ ok: true, id: f.id, state: 'invalidated', note: '软退休：不再被召回，可 restore 恢复' }));
  },

  async restore(f) {
    need(f, 'bank', 'id');
    await req('PATCH', `${API}/${q(f.bank)}/memories/${q(f.id)}`, { state: 'valid' });
    console.log(JSON.stringify({ ok: true, id: f.id, state: 'valid' }));
  },

  async clear(f) {
    need(f, 'bank');
    if (f.yes !== true) fail(`clear 会清空整个 bank（不可逆）。确认后加 --yes 再跑。`);
    const res = await req('DELETE', `${API}/${q(f.bank)}/memories`);
    console.log(JSON.stringify({ ok: true, bank: f.bank, ...res }));
  },

  async stats(f) {
    need(f, 'bank');
    const s = await req('GET', `${API}/${q(f.bank)}/stats`);
    if (f.json === true) { console.log(JSON.stringify(s, null, 2)); return; }
    console.log(`bank=${s.bank_id}`);
    console.log(`  条目 unit 数：${s.total_nodes}  ${JSON.stringify(s.nodes_by_fact_type || {})}`);
    console.log(`  已派生 observation：${s.total_observations}`);
    console.log(`  待整理 pending_consolidation：${s.pending_consolidation}  失败：${s.failed_consolidation}`);
    console.log(`  最近写入：${s.last_memory_write_at || '(从未)'}`);
  },

  /** P0-5：「到底存没存进去」一眼可见。服务没起时**显式报警**，不许静默返回 0 条。 */
  async status(f) {
    try {
      await req('GET', '/health');
    } catch {
      fail(`⚠️ Hindsight 不可达，记忆不可用（${BASE}）\n  此时 recall 会「查不到」、retain 会「存不进」——不要当成「本来就没有结论」。`);
    }
    const version = await req('GET', '/version');

    let banks;
    if (f.all === true || (f.bank === undefined)) {
      const list = await req('GET', `${API}`);
      banks = (list?.banks || []).map((b) => b.bank_id).filter((b) => b.startsWith('assistant-'));
    } else {
      banks = [String(f.bank)];
    }
    if (!banks.length) banks = ['assistant-shared'];

    console.log(`✓ Hindsight ${version?.api_version ?? '?'} 在线（${BASE}）`);
    for (const b of banks) {
      try {
        const s = await req('GET', `${API}/${q(b)}/stats`);
        console.log(`  · ${b}：${s.total_nodes} 条（${JSON.stringify(s.nodes_by_fact_type || {})}），` +
          `待整理 ${s.pending_consolidation}，最近写入 ${(s.last_memory_write_at || '从未').slice(0, 16).replace('T', ' ')}`);
      } catch (e) {
        console.log(`  · ${b}：读不到 stats —— ${e.message.split('\n')[0]}`);
      }
    }
    if (version?.features?.bank_llm_health === false) {
      console.log('  注：本实例禁用了 bank 级 LLM 健康检查（features.bank_llm_health=false），故 status 以 /health 为准。');
    }
  },

  async health(f) {
    let live, version;
    try {
      live = await req('GET', '/health');
      version = await req('GET', '/version');
    } catch (e) {
      if (e instanceof Fail) fail(`Hindsight 不可达：${BASE}\n  ${e.message.split('\n').slice(1).join(' ').trim() || '连接失败'}`);
      throw e;
    }
    console.log(`Hindsight ${version?.api_version ?? '?'}  ${live.status}  db=${live.database}  ${BASE}`);
  },
};

async function main() {
  const { cmd, f } = parseArgs(process.argv.slice(2));
  if (!cmd || !cmds[cmd]) {
    fail(`用法：assistant-memo.mjs <${Object.keys(cmds).join('|')}> --bank B […]\n详见文件头注释。`);
  }
  await cmds[cmd](f);
}

main().catch((e) => {
  if (e instanceof Fail) console.error(`✗ ${e.message}`);
  else console.error(`✗ 未预期错误：\n${e.stack || e.message}`);
  process.exitCode = 1;
});