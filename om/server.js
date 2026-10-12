'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
// data.json 不入库（example/om-data.json 是模板），缺失时的空看板骨架
const EMPTY_DATA = { updatedAt: null, projects: [], currentWeekByUser: {}, currentWeekFinished: [], weekRange: null };
const DOCS_DIR = path.join(ROOT, 'docs');

// ---- 配置：读仓库根的 febot.config.json（不入库，由 yarn setup 生成）----
// 查找顺序：FEBOT_CONFIG → <om 上一级>/febot.config.json → <om>/febot.config.json → cwd/febot.config.json
function loadConfig() {
  const candidates = [
    process.env.FEBOT_CONFIG ? path.resolve(process.env.FEBOT_CONFIG) : '',
    path.join(ROOT, '..', 'febot.config.json'),
    path.join(ROOT, 'febot.config.json'),
    path.join(process.cwd(), 'febot.config.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      console.warn(`[config] ${p} 读取失败，跳过：${e.message}`);
      continue;
    }
    try {
      const json = JSON.parse(raw);
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        console.log(`[config] 已加载 ${p}`);
        return json;
      }
      console.warn(`[config] ${p} 顶层不是对象，跳过`);
    } catch (e) {
      console.warn(`[config] ${p} 不是合法 JSON，跳过：${e.message}`);
    }
  }
  console.warn('[config] 未找到 febot.config.json —— 请先跑 yarn setup 并填写 teamwork 段，否则「一键更新」不可用');
  return {};
}
const CONFIG = loadConfig();
const TW = (CONFIG.teamwork && typeof CONFIG.teamwork === 'object') ? CONFIG.teamwork : {};
const str = v => (typeof v === 'string' ? v.trim() : '');

// ---- teamwork 取数（cookie 过期时用 .teamwork/auth.txt 自动重新登录刷新）----
const BASE = str(TW.base);
const TW_API_PATH = '/teamworkapi/tableReader/getTableData';
const TW_LOGIN_PATH = '/teamworkapi/user/login';
const TW_USERNAME = str(TW.username);
const AUTH_FILE = path.join(ROOT, '..', '.teamwork', 'auth.txt');
let TW_COOKIE = str(TW.cookie);

function baseUrl() {
  if (!BASE) throw new Error('未配置协作平台地址：请在 febot.config.json 的 teamwork.base 填写');
  return BASE;
}

const pad2 = n => String(n).padStart(2, '0');
function fmt(dt) {
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
}
// 最近一次周五 00:00（getDay(): Sun=0 ... Thu=4）
function lastThursday() {
  const now = new Date();
  const daysSinceThu = (now.getDay() - 5 + 7) % 7;
  const d = new Date(now);
  d.setDate(now.getDate() - daysSinceThu);
  d.setHours(0, 0, 0, 0);
  return d;
}

function buildBody(startVal, endVal, username) {
  const enc = encodeURIComponent;
  const qqConObj = enc(JSON.stringify([
    { field_key: 'username', con: 'CL', value: username || TW_USERNAME, limit_date: '', start_val: '', end_val: '', unit: '', id: '1082880266130690051' },
    { field_key: 'fact_finish_time', con: 'IN', value: '', limit_date: '', start_val: startVal, end_val: endVal, unit: '', id: '1082880266130690052' }
  ]));
  const fieldKeys = enc(JSON.stringify([
    'title', 'demand_level', 'status', 'username', 'created_time', 'fact_finish_time', 'demand_id',
    'fact_start_time', 'userid', 'audit_state', 'innovate_sign', 'development_hour', 'end_time', 'fraction',
    'description', 'schedule', 'schedule_desc', 'created_name', 'start_time', 'module', 'assign_description',
    'assessor_id', 'version', 'created_by', 'updated_by', 'id', 'updated_name', 'updated_time', 'assessor',
    'auditingdate', 'module_id'
  ]));
  const autograph = str(TW.autograph);
  return [
    'pageSize=50', 'page=1', `tableId=${str(TW.tableId)}`, `autograph=${autograph}`,
    'conObj=', 'sqlExpression=', `qqConObj=${qqConObj}`, 'preConObj=%5B%5D', 'preSqlExpression=', 'keyword=',
    `fieldKeys=${fieldKeys}`, 'conditions=', 'mark=2', 'open_window_width=800', 'isDefault=-1',
    'order_field_setting=%5B%5D', 'asyncCount=0', 'source=quickSearch'
  ].join('&');
}

// 用 .teamwork/auth.txt 重新登录，刷新 TW_COOKIE（登录接口需前端加密密文，见协作平台接口流程 §0/§8）
async function reLogin() {
  const raw = fs.readFileSync(AUTH_FILE, 'utf8');
  const cred = Object.fromEntries(raw.trim().split('\n').map(l => {
    const i = l.indexOf('=');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
  if (!cred.loginName || !cred.password || !cred.host) throw new Error('auth.txt 缺 loginName / password / host');
  const resp = await fetch(baseUrl() + TW_LOGIN_PATH, {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/plain, */*',
      'content-type': 'application/x-www-form-urlencoded',
      'origin': baseUrl(),
      'referer': `${baseUrl()}/`,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    },
    body: new URLSearchParams(cred).toString()
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`重新登录返回异常，HTTP ${resp.status}: ${text.slice(0, 120)}`); }
  if (!json || json.result !== 'SUCCESS') throw new Error('重新登录失败：' + (json && json.resultMsg || text.slice(0, 120)));
  const sc = resp.headers.get('set-cookie') || '';
  const pick = name => { const m = sc.match(new RegExp(`${name}=([^;]+)`)); return m ? m[1] : ''; };
  const zb = pick('zb_sid'), ses = pick('SESSION');
  if (!zb || !ses) throw new Error('重新登录成功但未取到新 cookie');
  TW_COOKIE = `zb_sid=${zb}; SESSION=${ses}`;
  console.log('[reLogin] cookie 已刷新');
}

function reqHeaders() {
  const h = {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/x-www-form-urlencoded',
    'cookie': TW_COOKIE,
    'origin': baseUrl(),
    'referer': `${baseUrl()}/`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
  };
  const tag = str(TW.userTag);
  if (tag) h['user-tag'] = tag;
  return h;
}

async function tableRequest(startVal, endVal, username) {
  const resp = await fetch(baseUrl() + TW_API_PATH, { method: 'POST', headers: reqHeaders(), body: buildBody(startVal, endVal, username) });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`teamwork 返回非 JSON，HTTP ${resp.status}: ${text.slice(0, 200)}`); }
  return json;
}

// om/docs 下最晚日报日期的当天最后一秒（如 2026-10-09 23:59:59）；无日报时回退到最近一次周五 00:00
function latestDocStart() {
  const docsDir = path.join(__dirname, 'docs');
  let dates = [];
  try {
    dates = fs.readdirSync(docsDir)
      .map(f => (f.match(/^(\d{4}-\d{2}-\d{2})\.md$/) || [])[1])
      .filter(Boolean);
  } catch { /* 目录不存在则走回退 */ }
  if (!dates.length) return lastThursday();
  dates.sort();
  const [y, m, d] = dates[dates.length - 1].split('-').map(Number);
  const dt = new Date(y, m - 1, d, 23, 59, 59);
  return dt;
}

async function fetchCurrentWeek(username) {
  // 配置里没塞 cookie 就先登录一次，避免拿空 cookie 去撞平台拿回一个含糊的失败
  if (!TW_COOKIE) await reLogin();
  const startVal = fmt(latestDocStart());
  const endVal = fmt(new Date());
  let json = await tableRequest(startVal, endVal, username);
  if (json && json.result === 'NO_LOGIN') {
    await reLogin();
    json = await tableRequest(startVal, endVal, username);
  }
  const rows = (json && json.map && Array.isArray(json.map.rows)) ? json.map.rows
    : (Array.isArray(json && json.rows) ? json.rows : []);
  const total = rows.length;
  const byModule = {};
  rows.forEach(r => {
    const m = (r.module || '').trim() || '未分类';
    (byModule[m] = byModule[m] || []).push(r);
  });
  const modules = Object.keys(byModule)
    .sort((a, b) => byModule[b].length - byModule[a].length)
    .map(m => ({ module: m, count: byModule[m].length, items: byModule[m] }));
  return { ok: true, startVal, endVal, total, modules };
}

function splitList(s) {
  if (!s) return [];
  return String(s).split(/[\n,，、]/).map(x => x.trim()).filter(Boolean);
}

// 汇总每个负责人已抓取的「本周已完成」，任务名通过项目名关联 module
function weekModulesByKey(data) {
  const byModule = {};
  if (data.currentWeekByUser && typeof data.currentWeekByUser === 'object') {
    Object.keys(data.currentWeekByUser).forEach(u => {
      (data.currentWeekByUser[u] || []).forEach(m => {
        const arr = (byModule[m.module] = byModule[m.module] || []);
        (m.items || []).forEach(r => {
          const t = r.title; if (t && !arr.includes(t)) arr.push(t);
        });
      });
    });
    return byModule;
  }
  (data.currentWeekFinished || []).forEach(m => {
    byModule[m.module] = (m.items || []).map(r => r.title);
  });
  return byModule;
}

// 汇总某项目的所有负责人手动「新功能/修复」，兼容旧共享字段
function projectFx(p) {
  const feats = [], fixs = [];
  const pushOne = (list, t) => { if (t && !list.includes(t)) list.push(t); };
  if (p.fxByUser && typeof p.fxByUser === 'object') {
    Object.keys(p.fxByUser).forEach(u => {
      const b = p.fxByUser[u] || {};
      splitList(b.features).forEach(t => pushOne(feats, t));
      splitList(b.fixes).forEach(t => pushOne(fixs, t));
    });
  } else {
    splitList(p.features).forEach(t => pushOne(feats, t));
    splitList(p.fixes).forEach(t => pushOne(fixs, t));
  }
  return { feats, fixs };
}

// 按 trim 后内容去重，保留首次出现顺序；忽略首尾/连续空格差异，避免同任务在抓取与手填间重复
function uniqItems(list) {
  const seen = new Set();
  return (list || []).filter(x => {
    const key = String(x).trim().replace(/\s+/g, ' ');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 按 groups 项目组织，任务名通过项目名关联 currentWeekFinished 的 module
function buildMarkdown(data) {
  const byModule = weekModulesByKey(data);
  const known = new Set();
  (data.projects || []).forEach(p => known.add(p.name));
  // 全文级去重：前后端协同任务可能同时挂在多人名下，整个文档只保留首次出现
  const seen = new Set();
  const takeGlobal = list => (list || []).filter(t => {
    const key = String(t).trim().replace(/\s+/g, ' ');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const blocks = [];
  (data.projects || []).forEach(p => {
    const pf = projectFx(p);
    const feats = takeGlobal(uniqItems((byModule[p.name] || []).concat(pf.feats)));
    const fixs = takeGlobal(uniqItems(pf.fixs));
    const lines = [
      `# ${p.name}`,
      '',
      `# ${p.version || ''}`,
      '',
      '#### ✨Feats',
      ''
    ];
    feats.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
    if (fixs.length) {
      lines.push('');
      lines.push('#### 🐛Fixs', '');
      fixs.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
    }
    blocks.push(lines.join('\n'));
  });
  // 本周已完成里、看板没有对应项目的孤儿 module，独立导出
  Object.keys(byModule).filter(m => !known.has(m)).forEach(m => {
    const feats = takeGlobal(byModule[m] || []);
    const lines = [`# ${m}`, '', '#### ✨Feats', ''];
    feats.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
    blocks.push(lines.join('\n'));
  });
  return blocks.join('\n\n') + '\n';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ---- data API ----
  if (pathname === '/api/data') {
    if (req.method === 'GET') {
      try {
        send(res, 200, fs.readFileSync(DATA_FILE, 'utf8'));
      } catch (e) {
        // data.json 不入库，新克隆的仓库里没有它 —— 返回空看板骨架而不是 500，
        // 让前端能正常渲染空态、直接开始录入。
        if (e && e.code === 'ENOENT') {
          send(res, 200, JSON.stringify(EMPTY_DATA));
        } else {
          send(res, 500, JSON.stringify({ error: '读取 data.json 失败: ' + e.message }));
        }
      }
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          data.updatedAt = new Date().toISOString();
          const tmp = DATA_FILE + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
          fs.renameSync(tmp, DATA_FILE);
          send(res, 200, JSON.stringify({ ok: true, updatedAt: data.updatedAt }));
        } catch (e) {
          send(res, 400, JSON.stringify({ error: '数据写入失败: ' + e.message }));
        }
      });
      return;
    }
    send(res, 405, JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  // ---- 前端配置：负责人列表 + 默认负责人（来自 febot.config.json 的 teamwork 段）----
  if (pathname === '/api/config' && req.method === 'GET') {
    const users = Array.isArray(TW.users) ? TW.users.map(str).filter(Boolean) : [];
    send(res, 200, JSON.stringify({ users, defaultUser: TW_USERNAME, hasBase: !!BASE }));
    return;
  }

  // ---- 一键更新：上周五至今的实际完成任务，按 module 分类 ----
  if (pathname === '/api/current-week' && req.method === 'GET') {
    if (!TW_COOKIE && !fs.existsSync(AUTH_FILE)) {
      send(res, 502, JSON.stringify({
        error: '未配置协作平台凭据：请在 febot.config.json 的 teamwork 段填 base / cookie，或跑 yarn setup 生成 .teamwork/auth.txt（loginName / password / host）'
      }));
      return;
    }
    const username = (url.searchParams.get('user') || '').trim() || TW_USERNAME;
    fetchCurrentWeek(username)
      .then(result => send(res, 200, JSON.stringify(result)))
      .catch(e => send(res, 502, JSON.stringify({ error: e.message })));
    return;
  }

  // ---- 导出 Markdown 到 docs/ ----
  if (pathname === '/api/export' && req.method === 'POST') {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      const md = buildMarkdown(data);
      fs.mkdirSync(DOCS_DIR, { recursive: true });
      const d = new Date();
      const fname = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.md`;
      const filePath = path.join(DOCS_DIR, fname);
      fs.writeFileSync(filePath, md, 'utf8');
      send(res, 200, JSON.stringify({ ok: true, file: fname, path: `om/docs/${fname}` }));
    } catch (e) {
      send(res, 500, JSON.stringify({ error: '导出失败: ' + e.message }));
    }
    return;
  }

  // ---- static ----
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(ROOT, safePath));
  if (!filePath.startsWith(ROOT)) {
    send(res, 403, 'forbidden');
    return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, content, MIME[ext] || 'application/octet-stream');
  });
});

server.listen(PORT, () => {
  console.log(`发版看板已启动: http://localhost:${PORT}`);
});