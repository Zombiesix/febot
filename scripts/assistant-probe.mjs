#!/usr/bin/env node
/**
 * assistant-probe.mjs — 助手层 Hindsight 探针（P0-2）
 *
 * 目的：一次跑完助手层记忆所需的全部接口，**打印真实结果**，不软降级。
 * 与 scripts/hindsight-memo.py 相反：任何一步失败 → stderr 报错 + 非 0 退出，
 * 防止「以为在存其实没存」。
 *
 * 跑法：yarn assistant:probe   （或 node scripts/assistant-probe.mjs [--bank B] [--reset]）
 *
 * 本探针已实测坐实的事实（2026-10-10，对照 /openapi.json + 真跑）：
 *   · retain 一条 item → 落成 2 个 memory unit：fact_type=world + 派生 observation。
 *   · `metadata`（string map）在 world 上**逐字存活**；派生 observation 上**是空的**——
 *     溯源信息必须存 metadata，且只信 world 行。
 *   · `context` 不稳定：world 上时有时无，observation 上必为空 → **不可作为存储通道**，
 *     只当「抽取提示词」用。
 *   · `tags`（item 级）在 world 和 observation 上**都在**，且服务端可过滤 → 唯一可靠的分类通道。
 *   · list/recall 的 tags_match 默认 'any' **会把无标签条目一起捞出来**；
 *     要「只要该 tag」必须显式传 'all_strict' 或 'any_strict'。
 *   · 删单条 = PATCH {"state":"invalidated"}（可逆，list/recall 均排除）；
 *     ⚠️ DELETE {bank}/memories 是**清空整个 bank**，不是删单条。
 *   · `timestamp` 参数落到原生 date 字段，可配合 list 的 time_field/start_date 用。
 */

const BASE = process.env.HINDSIGHT_BASE || 'http://localhost:8888';
const API = '/v1/default/banks';

const STAMP = Date.now().toString(36);
const TAG_A = `probe-a-${STAMP}`;
const TAG_B = `probe-b-${STAMP}`;
const PATCHED_TEXT = `导管管理模块的支付流程改由 icis-pay-v2 组件负责（探针修订 ${STAMP}）`;
const QUERY = '导管管理模块的支付流程';

class Bail extends Error {}
function bail(msg) { throw new Bail(msg); }

let step = 0;
const say = (m) => console.log(m);
const head = (m) => console.log(`\n── ${++step}. ${m}`);

async function req(method, path, body) {
  const opts = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  let resp;
  try {
    resp = await fetch(BASE + path, opts);
  } catch (e) {
    bail(`Hindsight 不可达：${BASE}（${e.message}）\n  请先启动 Hindsight 再重跑。`);
  }
  const raw = await resp.text();
  let json = null;
  try { json = raw.trim() ? JSON.parse(raw) : null; } catch { /* 保留 raw 供报错 */ }
  if (!resp.ok) bail(`${method} ${path} → HTTP ${resp.status}\n  ${raw.slice(0, 400)}`);
  return json;
}

const q = (s) => encodeURIComponent(s);
const brief = (s, n = 72) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
const rowsOf = (r) => r?.items || r?.results || r?.memories || r?.data || (Array.isArray(r) ? r : []);

async function listRows(bank, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else qs.set(k, String(v));
  }
  const s = qs.toString();
  return rowsOf(await req('GET', `${API}/${q(bank)}/memories/list${s ? `?${s}` : ''}`));
}

async function main() {
  const argv = process.argv.slice(2);
  const bi = argv.indexOf('--bank');
  const BANK = bi >= 0 ? argv[bi + 1] : 'assistant-probe';

  say(`探针 bank=${BANK}  base=${BASE}  stamp=${STAMP}`);

  // ── 0. bank 就绪
  head('建/验 bank（PUT，幂等）');
  await req('PUT', `${API}/${q(BANK)}`, {});
  say(`✓ ${BANK} 就绪`);

  // ── 0b. 可选：清空探针库（只对 assistant-probe 生效，防误清真实库）
  if (argv.includes('--reset')) {
    if (BANK !== 'assistant-probe' && !argv.includes('--force')) {
      bail(`--reset 只允许清 assistant-probe；要清 ${BANK} 需显式加 --force`);
    }
    const del = await req('DELETE', `${API}/${q(BANK)}/memories`);
    say(`✓ 已清空 ${BANK}：${brief(JSON.stringify(del), 120)}`);
  }

  // ── 1. retain：tags 是分类通道，metadata 是溯源通道
  head('retain：3 条（A 带 tagA+metadata / B 带 tagB / C 无 tag）');
  const retain = await req('POST', `${API}/${q(BANK)}/memories`, {
    items: [
      {
        content: `导管管理模块的支付流程由 icis-pay 组件负责（探针样本 A ${STAMP}）`,
        metadata: { repo: 'probe', module: 'pay', evidence: 'src/pay/index.ts:42', source: 'probe', date: '2026-10-10' },
        tags: [TAG_A],
      },
      {
        content: `护士排班模块的班次数据来自 nurse-schedule 接口（探针样本 B ${STAMP}）`,
        metadata: { repo: 'probe', module: 'schedule', evidence: 'src/schedule/api.ts:11', source: 'probe', date: '2026-10-10' },
        tags: [TAG_B],
      },
      { content: `这条没有 tag，用于验证 tags_match=any 会不会把无标签条目一起捞出来（探针样本 C ${STAMP}）` },
    ],
  });
  say(`✓ items_count=${retain.items_count}  usage=${retain.usage?.total_tokens} tokens`);

  // ── 2. recall 必须命中（用 tags 判据，不用正文——正文会被抽取 LLM 改写）
  head('recall：同词召回，必须命中 A');
  const recall = await req('POST', `${API}/${q(BANK)}/memories/recall`, { query: QUERY, budget: 'low' });
  const rRows = rowsOf(recall);
  const hitA = rRows.some((r) => (r.tags || []).includes(TAG_A));
  say(`命中 ${rRows.length} 条；含 tagA：${hitA ? '是' : '否'}`);
  rRows.slice(0, 3).forEach((r) => say(`  · [${r.fact_type}] ${brief(r.text)}`));
  if (!hitA) bail('recall 未命中刚 retain 的 A —— 记忆链路不通。');
  say('✓ recall 往返命中');

  // ── 3. list 拿 id（认 world 行：只有它带 metadata）
  head('list：列条目并拿 id');
  const rows = await listRows(BANK, { tags: [TAG_A], tags_match: 'all_strict', limit: 50 });
  const kinds = [...new Set(rows.map((r) => r.fact_type))].join(',');
  say(`tagA 下 ${rows.length} 行，fact_type=[${kinds}]`);
  const worldA = rows.find((r) => r.fact_type === 'world');
  const obsA = rows.find((r) => r.fact_type === 'observation');
  if (!worldA) bail('拿不到 A 的 world 行（无 id，patch/delete 无从谈起）。');
  say(`✓ world id=${worldA.id.slice(0, 8)}…  metadata=${JSON.stringify(worldA.metadata)}`);
  say(`  observation id=${obsA ? obsA.id.slice(0, 8) + '…' : '(未生成)'}  metadata=${JSON.stringify(obsA?.metadata ?? null)}`);

  // ── 4. patch：改 text
  head('patch：改 A 的 text，再读回确认');
  await req('PATCH', `${API}/${q(BANK)}/memories/${q(worldA.id)}`, { text: PATCHED_TEXT });
  const back = await req('GET', `${API}/${q(BANK)}/memories/${q(worldA.id)}`);
  const okPatch = String(back.text || '').includes('icis-pay-v2');
  say(`读回：${brief(back.text)}`);
  if (!okPatch) bail('patch 未生效。');
  say('✓ patch 生效（注意：PATCH 字段名是 text，不是 content）');

  // ── 5. tags 服务端过滤能力 → 定论
  head('tags 过滤：服务端能力矩阵');
  const base0 = await listRows(BANK, { limit: 100 });
  const mode = {};
  for (const m of ['any', 'all', 'all_strict', 'any_strict']) {
    mode[m] = (await listRows(BANK, { tags: [TAG_A], tags_match: m, limit: 100 })).length;
  }
  const untaggedVisible = (await listRows(BANK, { tags: [TAG_A], tags_match: 'any', limit: 100 }))
    .some((r) => (r.tags || []).length === 0);
  say(`无过滤=${base0.length}  any=${mode.any}  all=${mode.all}  all_strict=${mode.all_strict}  any_strict=${mode.any_strict}`);
  say(`  any 模式里混入无标签条目：${untaggedVisible ? '是' : '否'}`);
  const serverSide = mode.all_strict > 0 && mode.all_strict < base0.length && !untaggedVisible === false;
  const okStrict = mode.all_strict > 0 && mode.all_strict < mode.any;
  if (!okStrict) bail(`tags 过滤没起到收窄作用（all_strict=${mode.all_strict} vs any=${mode.any}）——list --repo 需改客户端筛。`);
  say(`✓ 定论：服务端可过滤。**必须用 all_strict/any_strict**，默认 'any' 会把无标签条目一起捞出来。`);
  const recallScoped = rowsOf(await req('POST', `${API}/${q(BANK)}/memories/recall`, {
    query: QUERY, budget: 'low', tags: [TAG_A], tags_match: 'all_strict',
  }));
  say(`  recall 带 tags 收窄：${rRows.length} → ${recallScoped.length}（可用）`);

  // ── 6. 删单条 = invalidated（可逆）
  head('删单条：PATCH state=invalidated（不调 DELETE —— 那是清空整库）');
  await req('PATCH', `${API}/${q(BANK)}/memories/${q(worldA.id)}`, { state: 'invalidated', reason: 'assistant-probe cleanup' });
  const stillListed = (await listRows(BANK, { limit: 100 })).some((r) => r.id === worldA.id);
  const archived = (await listRows(BANK, { limit: 100, state: 'invalidated' })).some((r) => r.id === worldA.id);
  const stillRecalled = rowsOf(await req('POST', `${API}/${q(BANK)}/memories/recall`, { query: QUERY, budget: 'low' }))
    .some((r) => r.id === worldA.id);
  say(`list 默认仍列出：${stillListed}（期望 false）`);
  say(`list state=invalidated 可查到：${archived}（期望 true）`);
  say(`recall 仍召回：${stillRecalled}（期望 false）`);
  if (stillListed || !archived || stillRecalled) bail('invalidated 行为与预期不符。');
  say('✓ 单条删除（软退休）验证通过，且可逆（PATCH state=valid 可恢复）');

  // ── 7. 收尾
  head('清理：退休本次探针的其余条目');
  let retired = 0;
  for (const r of await listRows(BANK, { limit: 100 })) {
    const t = r.tags || [];
    if (!t.includes(TAG_A) && !t.includes(TAG_B) && t.length > 0) continue;
    if (r.id === worldA.id) continue;
    await req('PATCH', `${API}/${q(BANK)}/memories/${q(r.id)}`, { state: 'invalidated', reason: 'assistant-probe cleanup' });
    retired++;
  }
  say(`✓ 退休 ${retired} 条（归档不删，可查证；加 --reset 可整库清空）`);

  say(`\n✅ 探针全部通过 —— bank=${BANK}`);
  say('   契约要点：retain 落 2 行(world+observation) / metadata 只在 world / tags 唯一可靠分类 / ');
  say('             tags_match 必须 all_strict / PATCH 字段是 text / 删单条走 invalidated');
}

main().catch((e) => {
  if (e instanceof Bail) { console.error(`\n✗ 失败：${e.message}`); }
  else { console.error(`\n✗ 未预期错误：\n${e.stack || e.message}`); }
  process.exitCode = 1;
});