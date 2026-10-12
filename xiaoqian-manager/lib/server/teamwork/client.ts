import fs from "node:fs";
import path from "node:path";
import { readTeamworkConfig, type TeamworkConfig } from "@/lib/server/config/root";
import { readCredentials } from "./credentials";

// 协作平台取数客户端（零依赖纯 fetch），保持原有接口行为与坑位注释，不要凭猜测改动。
// 平台地址、表格 id、autograph、user-tag 全部来自 febot.config.json 的 teamwork 段。

const TW_LOGIN_PATH = "/teamworkapi/user/login";
const TW_LIST = "/teamworkapi/tableReader/getTableData";
const TW_DETAIL = "/teamworkapi/api/query/task/getById";
const TW_RECORD = "/teamworkapi/api/query/question/getRecord";
const TW_OPERATION = "/process/developmentPerson/operation";
const TW_SAVE_WORKHOURS = "/process/workHours/saveBatch";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const FIELD_KEYS = [
  "title", "demand_level", "status", "username", "created_time", "fact_finish_time", "demand_id",
  "fact_start_time", "userid", "audit_state", "innovate_sign", "development_hour", "end_time", "fraction",
  "description", "schedule", "schedule_desc", "created_name", "start_time", "module", "assign_description",
  "assessor_id", "version", "created_by", "updated_by", "id", "updated_name", "updated_time", "assessor",
  "auditingdate", "module_id", "customer_id", "customer_name", "task_level", "max_hour", "leval",
  "task_type", "ai_sign",
];
const MAX_PAGES = 50;
const COOKIE_TTL_MS = 30 * 60 * 1000;

const COOKIE_FILE = path.join(process.cwd(), "data", ".tw-cookie.json");

// 配置惰性解析：import 期不读盘，缺配置时只在真正发请求时报错。
function cfg(): TeamworkConfig {
  return readTeamworkConfig();
}

/** 平台地址：teamwork.base → auth.txt 的 host → 报错。绝不兜底到任何内置地址。 */
function baseUrl(): string {
  const c = cfg();
  if (c.base) return c.base;
  try {
    const host = readCredentials().host.trim();
    if (host) return host.replace(/\/+$/, "");
  } catch {
    // auth.txt 也没有，落到下面统一报错
  }
  throw new TwLoginError("未配置协作平台地址：请在 febot.config.json 的 teamwork.base 填写");
}

function tableId(): string {
  const v = cfg().tableId;
  if (!v) throw new Error("未配置 teamwork.tableId：请在 febot.config.json 填写");
  return v;
}

function autograph(): string {
  const v = cfg().autograph;
  if (!v) throw new Error("未配置 teamwork.autograph：请在 febot.config.json 填写");
  return v;
}

let memoryCookie: { cookie: string; savedAt: number } | null = null;

function loadCookie(): string | null {
  if (memoryCookie && Date.now() - memoryCookie.savedAt < COOKIE_TTL_MS) {
    return memoryCookie.cookie;
  }
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8")) as {
        cookie?: string;
        savedAt?: number;
      };
      if (raw.cookie && raw.savedAt && Date.now() - raw.savedAt < COOKIE_TTL_MS) {
        memoryCookie = { cookie: raw.cookie, savedAt: raw.savedAt };
        return raw.cookie;
      }
    }
  } catch {
    // 缓存损坏就当没有
  }
  return null;
}

function saveCookie(cookie: string): void {
  memoryCookie = { cookie, savedAt: Date.now() };
  try {
    fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
    fs.writeFileSync(
      COOKIE_FILE,
      JSON.stringify({ cookie, savedAt: Date.now() }),
      "utf8"
    );
  } catch {
    // 缓存写失败不影响主流程
  }
}

function clearCookie(): void {
  memoryCookie = null;
  try {
    if (fs.existsSync(COOKIE_FILE)) fs.rmSync(COOKIE_FILE);
  } catch {
    // ignore
  }
}

function reqHeaders(cookie: string) {
  const base = baseUrl();
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/x-www-form-urlencoded",
    cookie,
    origin: base,
    referer: `${base}/`,
    "user-agent": UA,
  };
  const tag = cfg().userTag;
  if (tag) headers["user-tag"] = tag;
  return headers;
}

export class TwLoginError extends Error {}

async function reLogin(): Promise<string> {
  const cred = readCredentials();
  const base = baseUrl();
  const resp = await fetch(base + TW_LOGIN_PATH, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/x-www-form-urlencoded",
      origin: base,
      referer: `${base}/`,
      "user-agent": UA,
    },
    body: new URLSearchParams({
      loginName: cred.loginName,
      password: cred.password,
      host: cred.host,
    }).toString(),
  });
  const text = await resp.text();
  let json: { result?: string; resultMsg?: string } | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new TwLoginError(`登录返回异常，HTTP ${resp.status}`);
  }
  if (!json || json.result !== "SUCCESS") {
    throw new TwLoginError(`登录协作平台失败：${(json && json.resultMsg) || "未知原因"}`);
  }
  const sc =
    typeof resp.headers.getSetCookie === "function"
      ? resp.headers.getSetCookie().join("; ")
      : resp.headers.get("set-cookie") || "";
  const pick = (n: string) => {
    const m = sc.match(new RegExp(`${n}=([^;]+)`));
    return m ? m[1] : "";
  };
  const zb = pick("zb_sid");
  const ses = pick("SESSION");
  if (!zb || !ses) throw new TwLoginError("登录成功但未取到新 cookie");
  const cookie = `zb_sid=${zb}; SESSION=${ses}`;
  saveCookie(cookie);
  return cookie;
}

async function post(
  pathname: string,
  body: string,
  cookie: string,
  retry = true
): Promise<{ result?: string; resultMsg?: string; map?: Record<string, unknown> }> {
  const resp = await fetch(baseUrl() + pathname, {
    method: "POST",
    headers: reqHeaders(cookie),
    body,
  });
  const text = await resp.text();
  let json: { result?: string; resultMsg?: string; map?: Record<string, unknown> };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${pathname} 返回非 JSON，HTTP ${resp.status}`);
  }
  if (retry && json && json.result === "NO_LOGIN") {
    clearCookie();
    const fresh = await reLogin();
    return post(pathname, body, fresh, false);
  }
  return json;
}

async function ensureCookie(): Promise<string> {
  const cached = loadCookie();
  if (cached) return cached;
  return reLogin();
}

// ---------- 取数 ----------

export interface FetchListOptions {
  statuses: string[];
  user: string;
  module: string;
  pageSize: number;
}

function buildListBody(opts: FetchListOptions & { page: number }): string {
  const qq: Record<string, unknown>[] = [];
  if (opts.statuses.length) {
    qq.push({
      field_key: "status",
      con: "CONVERT",
      value: opts.statuses.map((v) => [{ con: "EQ", field_key: "status", value: v }]),
      limit_date: "",
      start_val: "",
      end_val: "",
      unit: "",
      id: "1082880266130690055",
    });
  }
  if (opts.user) {
    qq.push({
      field_key: "username",
      con: "CL",
      value: opts.user,
      limit_date: "",
      start_val: "",
      end_val: "",
      unit: "",
      id: "1082880266130690051",
    });
  }
  if (opts.module) {
    qq.push({
      field_key: "module",
      con: "EQ",
      value: opts.module,
      limit_date: "",
      start_val: "",
      end_val: "",
      unit: "",
      id: "",
    });
  }
  const enc = encodeURIComponent;
  return [
    `pageSize=${opts.pageSize}`,
    `page=${opts.page}`,
    `tableId=${tableId()}`,
    `autograph=${autograph()}`,
    "conObj=",
    "sqlExpression=",
    `qqConObj=${enc(JSON.stringify(qq))}`,
    `preConObj=${enc("[]")}`,
    "preSqlExpression=",
    "keyword=",
    `fieldKeys=${enc(JSON.stringify(FIELD_KEYS))}`,
    "conditions=",
    "mark=2",
    "open_window_width=800",
    "isDefault=-1",
    `order_field_setting=${enc("[]")}`,
    "asyncCount=0",
    "source=quickSearch",
  ].join("&");
}

export interface TwRow {
  id?: string | number;
  demand_id?: string | number;
  [key: string]: unknown;
}

// 口径坑（实测，勿改）：map.records = 总条数，map.total = 总页数。
export async function fetchList(opts: FetchListOptions): Promise<TwRow[]> {
  const cookie = await ensureCookie();
  const rows: TwRow[] = [];
  let page = 1;
  let totalPages = 1;
  for (;;) {
    const json = await post(TW_LIST, buildListBody({ ...opts, page }), cookie);
    if (!json || json.result !== "SUCCESS") {
      throw new Error("拉取列表失败：" + ((json && json.resultMsg) || "未知原因"));
    }
    const m = (json.map || {}) as { rows?: TwRow[]; total?: number | string; records?: number | string };
    const got = Array.isArray(m.rows) ? m.rows : [];
    rows.push(...got);
    totalPages = Number(m.total) || 1;
    const want = Number(m.records) || rows.length;
    if (!got.length || page >= totalPages || rows.length >= want || page >= MAX_PAGES) break;
    page++;
  }
  return rows;
}

export async function fetchDetail(taskId: string): Promise<TwRow | null> {
  const cookie = await ensureCookie();
  const json = await post(TW_DETAIL, "pid=" + encodeURIComponent(taskId), cookie);
  if (!json || json.result !== "SUCCESS") return null;
  const rows = ((json.map as { rows?: TwRow[] }) || {}).rows || [];
  return rows[0] || null;
}

export async function fetchRecord(demandId: string): Promise<TwRow[]> {
  if (!demandId) return [];
  const cookie = await ensureCookie();
  const json = await post(TW_RECORD, `id=${encodeURIComponent(demandId)}&pageSize=100`, cookie);
  if (!json || json.result !== "SUCCESS") return [];
  return ((json.map as { rows?: TwRow[] }) || {}).rows || [];
}

// ---------- 开发人员操作（写平台） ----------

// 更新阶段状态前，先调这个接口把操作写到协作平台，成功后才允许落本地 tasks.json。
// 入参除 id（任务ID）外均为固定值，与浏览器实测请求一致：
//   POST /process/developmentPerson/operation
//   {"id":"...","description":"<p>1</p>","operationAction":"js","taskFj":"[]"}
// 注意原始请求里 description 出现两次（"" 与 "<p>1</p>"），JSON 解析取后者。
export async function pushDevOperation(taskId: string): Promise<void> {
  const cookie = await ensureCookie();
  return postOperation(taskId, cookie, true);
}

async function postOperation(
  taskId: string,
  cookie: string,
  retry: boolean
): Promise<void> {
  const body = JSON.stringify({
    id: taskId,
    description: "<p>1</p>",
    operationAction: "js",
    taskFj: "[]",
  });
  const resp = await fetch(baseUrl() + TW_OPERATION, {
    method: "POST",
    headers: {
      ...reqHeaders(cookie),
      "content-type": "application/json;charset=UTF-8",
    },
    body,
  });
  const text = await resp.text();
  let json: { success?: boolean; code?: string; msg?: string; result?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`operation 返回非 JSON，HTTP ${resp.status}`);
  }
  // 登录失效时重登一次再试（该接口与 teamworkapi 不同，用 msg 兜_login 判断）
  const loginExpired =
    json.result === "NO_LOGIN" ||
    (json.success === false && /登录|login/i.test(json.msg || ""));
  if (retry && loginExpired) {
    clearCookie();
    const fresh = await reLogin();
    return postOperation(taskId, fresh, false);
  }
  if (json.success !== true) {
    throw new Error(`协作平台 operation 失败：${json.msg || "未知原因"}`);
  }
}

// ---------- 工时写入（写平台） ----------

// 今日工时批量写入：POST /process/workHours/saveBatch。
// 字段语义（与浏览器实测请求一致）：id = 工时单ID（新填时不确定，留空由平台生成）、
// businessDate = 业务日期、workHoursList = 单条工时、jsonField = 单程附加配置。
// 认证仍走 cookie（zb_sid + SESSION），登录失效时与 operation 一样重登一次再试。
export interface WorkHourRow {
  id: string;
  title: string;
  curSchedule: number;
  duration: number;
  planDuration: number;
  relationId: string;
  relationName: string;
  relationType: string;
  surplusSchedule: number;
  productId: string;
  productName: string;
  productTeamId: string;
  jsonField?: string;
}

export interface SaveWorkHoursPayload {
  id: string;
  businessDate: string;
  workHoursList: WorkHourRow[];
  jsonField?: string;
}

export async function saveWorkHours(payload: SaveWorkHoursPayload): Promise<void> {
  const cookie = await ensureCookie();
  return postSaveWorkHours(payload, cookie, true);
}

async function postSaveWorkHours(
  payload: SaveWorkHoursPayload,
  cookie: string,
  retry: boolean
): Promise<void> {
  const body = JSON.stringify({
    ...payload,
    jsonField: payload.jsonField ?? '{"aiTag":1}',
  });
  const resp = await fetch(baseUrl() + TW_SAVE_WORKHOURS, {
    method: "POST",
    headers: {
      ...reqHeaders(cookie),
      "content-type": "application/json;charset=UTF-8",
    },
    body,
  });
  const text = await resp.text();
  let json: { success?: boolean; code?: string; msg?: string; result?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`workHours/saveBatch 返回非 JSON，HTTP ${resp.status}`);
  }
  const loginExpired =
    json.result === "NO_LOGIN" ||
    (json.success === false && /登录|login/i.test(json.msg || ""));
  if (retry && loginExpired) {
    clearCookie();
    const fresh = await reLogin();
    return postSaveWorkHours(payload, fresh, false);
  }
  if (json.success !== true) {
    throw new Error(`协作平台保存工时失败：${json.msg || "未知原因"}`);
  }
}
