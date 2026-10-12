#!/usr/bin/env node
/**
 * assistant-map.mjs — 事实层 P1：跑索引器 map，渲染成中文项目地图
 *
 * 用法：
 *   node scripts/assistant-map.mjs <仓路径> [--out FILE] [--warnings] [--stdout]
 *
 * 产物：docs/assistant/<repo>/map.md（默认）
 *
 * 设计约束（贴计划）：
 *   · **渲染工作，不是抽取工作**：中文业务名索引器已抽好（routes[].label / modules[].label），
 *     本脚本只排版；label 为 null 的如实标「待补」，不脑补。
 *   · 产物**可能过期**：是 init 时点的快照，权威以现算为准。文件头已写明。
 *   · 告警（warnings）默认只出现一行计数；加 --warnings 才展开明细（P1-4）。
 *
 * ⚠️ Git Bash 下若传 `/xxx` 形式的路径，MSYS 会把它转成 Windows 路径；
 *    传绝对路径（D:/…）或用 `MSYS_NO_PATHCONV=1` 前缀。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../code-indexer/bin/cli.mjs');

class Fail extends Error {}
const fail = (m) => { throw new Fail(m); };

/* ── 中日韩全角按 2 格算，表格才对得齐 ── */
const width = (s) => [...String(s)].reduce((n, c) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(c) ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));
const table = (headers, rows) => {
  const all = [headers, ...rows];
  const w = headers.map((_, i) => Math.max(...all.map((r) => width(r[i] ?? ''))));
  return [
    '| ' + headers.map((h, i) => pad(h, w[i])).join(' | ') + ' |',
    '| ' + w.map((x) => '-'.repeat(x)).join(' | ') + ' |',
    ...rows.map((r) => '| ' + headers.map((_, i) => pad(r[i] ?? '', w[i])).join(' | ') + ' |'),
  ].join('\n');
};
const dash = (v) => (v === null || v === undefined || v === '' ? '待补' : String(v));
/** 索引器有的字段给数组、有的直接给计数（如 events.edges 是数字）—— 都接住 */
const cnt = (v) => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : v && typeof v === 'object' ? Object.keys(v).length : 0);

function parseArgs(argv) {
  const f = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) f[a.slice(2)] = true;
      else { f[a.slice(2)] = next; i++; }
    } else pos.push(a);
  }
  return { pos, f };
}

function runIndexer(repoPath) {
  const r = spawnSync('node', [CLI, 'map', repoPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail(`跑不通索引器：${r.error.message}`);
  if (r.status !== 0) fail(`索引器 map 失败（exit ${r.status}）：\n${(r.stderr || '').slice(0, 500)}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    fail(`索引器 map 输出不是 JSON：\n${r.stdout.slice(0, 300)}`);
  }
}

function render(m, { withWarnings }) {
  const endpoints = (m.apiDomains || []).reduce((s, d) => s + (d.endpoints || 0), 0);
  const owners = new Map();               // 模块 → 用到的 API 域
  for (const d of m.apiDomains || []) {
    for (const u of d.usedBy || []) {
      if (!owners.has(u)) owners.set(u, []);
      owners.get(u).push(d.name);
    }
  }
  const permNote = m.permissions?.definedInRepo === false
    ? '**权限判定不在本仓**（`definedInRepo=false`）——判定在 qiankun 宿主仓，本仓只引 `usePermission()`。查「为什么拦不住」要去宿主仓看。'
    : '权限判定在本仓。';

  const L = [];
  L.push(`# ${m.repo} — 项目地图`, '');
  L.push(`> 由 \`init\`（\`yarn assistant:map ${'<仓路径>'}\`）生成，**是时点快照、可能过期**；权威结论以现算为准。`);
  L.push(`> 生成时间 ${new Date().toISOString()} ｜ 栈 ${m.stack?.kind ?? '?'} / ${m.stack?.builder ?? '?'}${m.stack?.qiankunChild ? ' / qiankun 子应用' : ''}`, '');

  L.push('## 规模', '');
  L.push(table(['项', '数'], [
    ['路由', m.routes?.length ?? 0],
    ['API 端点', endpoints],
    ['模块', m.modules?.length ?? 0],
    ['API 域', m.apiDomains?.length ?? 0],
    ['store', m.stores?.length ?? 0],
    ['权限码', m.permissions?.codes ?? 0],
    ['事件边', cnt(m.events?.edges)],
    ['存储 key', m.storageKeys?.length ?? 0],
    ['告警', m.warningTotal ?? cnt(m.warnings)],
  ]), '');

  L.push('## 路由 → 中文业务名', '');
  L.push(table(['路径', '中文业务名', '模块'],
    (m.routes || []).map((r) => [`\`${r.path}\``, dash(r.label), dash(r.module)])), '');

  L.push('## 模块', '');
  L.push('> `待补`= 索引器未抽到中文业务名，需人工确认；`*`= 无独立路由（布局/抽屉/内容页等）。', '');
  L.push(table(['模块', '中文业务名', '独立路由', '用到的 API 域'],
    (m.modules || []).map((x) => [
      x.name + (x.hasRoute ? '' : ' *'),
      dash(x.label),
      x.hasRoute ? '有' : '无',
      (owners.get(x.name) || []).join('、') || '—',
    ])), '');

  L.push('## API 域', '');
  L.push(table(['域', '端点数', '被哪些模块用'],
    (m.apiDomains || []).map((d) => [d.name, d.endpoints ?? 0, (d.usedBy || []).join('、') || '—'])), '');

  L.push('## store', '');
  L.push(table(['store', '绑定名', '归属模块', 'state', 'actions', '持久化 key'],
    (m.stores || []).map((s) => [
      `\`${s.id}\``, s.binding ?? '—', s.owner ?? '—',
      s.state ?? 0, s.actions ?? 0, s.persist ?? '—',
    ])), '');

  L.push('## 权限', '');
  L.push(`- 权限码 ${m.permissions?.codes ?? 0} 个；按判定方式：${JSON.stringify(m.permissions?.byKind ?? {})}`);
  L.push(`- ${permNote}`);
  L.push(`- helper：${(m.permissions?.helpers || []).join('、') || '—'}`);
  L.push(`- 示例码：${(m.permissions?.sample || []).slice(0, 6).map((c) => `\`${c}\``).join('、') || '—'}`, '');

  L.push('## 事件', '');
  const e = m.events || {};
  L.push(`- 组件 ${cnt(e.components)} 个，事件边 ${cnt(e.edges)} 条，v-model 边 ${cnt(e.vModelEdges)} 条，透传 ${cnt(e.passthrough)} 条`);
  L.push(`- 对不上绑定的 ${cnt(e.mismatched)} 条（说不清的照实转述，不脑补）`, '');

  L.push('## 存储', '');
  L.push(table(['key', 'storage', '读', '写', '经手包装器'],
    (m.storageKeys || []).map((k) => [
      `\`${k.key}\``, k.storage ?? '—', k.reads ?? 0, k.writes ?? 0, k.viaWrapper ?? '—',
    ])), '');

  L.push('## 告警', '');
  const wl = m.warnings || [];
  L.push(`共 ${m.warningTotal ?? wl.length} 条。${withWarnings ? '' : '（默认不展开；需要明细加 `--warnings`）'}`);
  if (withWarnings && wl.length) {
    L.push('');
    for (const w of wl) L.push(`- ${w}`);
  }
  L.push('');
  return L.join('\n');
}

function main() {
  const { pos, f } = parseArgs(process.argv.slice(2));
  if (!pos[0]) fail('用法：assistant-map.mjs <仓路径> [--out FILE] [--warnings] [--stdout]');
  const repoPath = pos[0];

  const m = runIndexer(repoPath);
  if (!m.routes?.length) {
    fail(`索引器对 ${repoPath} 解析出 0 条路由——先跑 \`stats\`/\`map\` 核对索引器，别把空地图当结论。`);
  }
  const md = render(m, { withWarnings: f.warnings === true });

  if (f.stdout === true) { console.log(md); return; }
  const out = resolve(process.cwd(), f.out || `docs/assistant/${m.repo}/map.md`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md, 'utf8');
  console.log(`✓ ${m.repo}：路由 ${m.routes.length} / 模块 ${m.modules?.length ?? 0} / 端点 ${(m.apiDomains || []).reduce((s, d) => s + (d.endpoints || 0), 0)} → ${out}`);
}

try { main(); } catch (e) {
  console.error(`✗ ${e instanceof Fail ? e.message : e.stack || e.message}`);
  process.exitCode = 1;
}