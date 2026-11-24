#!/usr/bin/env node
/* ==========================================================================
 * 城市地铁线网开通纪事 · 本地服务端（零依赖）
 * --------------------------------------------------------------------------
 * 只使用 Node 内置模块：node:http / node:fs / node:path / node:url。
 * 职责：
 *   1. 托管前端单文件（工作区根目录的「地铁线网开通纪事.html」优先）；
 *   2. 提供方案（plan）/ 自定义城市（cities）的 JSON API；
 *   3. 数据落盘到 server/data/store.json，采用「临时文件 + rename」原子写。
 *
 * 启动：node metro-chronicle/server/server.mjs
 * 默认：http://127.0.0.1:8787   （PORT / HOST 可用环境变量覆盖）
 * ========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* -------------------------------------------------------------------------
 * 常量
 * ---------------------------------------------------------------------- */

const VERSION = '1.0.0';
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const ROOT_INDEX_NAME = '地铁线网开通纪事.html';
const MAX_BODY_BYTES = 512 * 1024;
const MAX_CITIES = 200;
const COORD_EPSILON = 1e-9;
const STORE_VERSION = 1;

const LABEL_SIDES = new Set(['top', 'bottom', 'left', 'right']);
const LINE_TYPES = new Set(['metro', 'intercity']);
const COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;
const RESERVED_CITY_IDS = new Set(['__proto__', 'constructor', 'prototype']);

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(SERVER_DIR);        // metro-chronicle/
const WORKSPACE_ROOT = path.dirname(PROJECT_DIR);    // default-workspace/
const DIST_DIR = path.join(PROJECT_DIR, 'dist');
const DATA_DIR = path.join(SERVER_DIR, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const STORE_TMP = STORE_FILE + '.tmp';

/** 静态根：按顺序尝试（工作区根目录优先） */
const STATIC_ROOTS = [WORKSPACE_ROOT, DIST_DIR];
/** 首页候选：工作区根目录的成品单文件优先，其次 dist 产物 */
const INDEX_CANDIDATES = [path.join(WORKSPACE_ROOT, ROOT_INDEX_NAME), path.join(DIST_DIR, 'metro-chronicle.html')];

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.png', 'image/png']
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600'
};

/* -------------------------------------------------------------------------
 * 通用小工具
 * ---------------------------------------------------------------------- */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 按「字符」计长度（避免中文/emoji 被 UTF-16 长度误判） */
function charLength(value) {
  return Array.from(String(value)).length;
}

function describeValue(value) {
  if (typeof value === 'string') {
    const text = value.length > 24 ? value.slice(0, 24) + '…' : value;
    return JSON.stringify(text);
  }
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return Array.isArray(value) ? 'array' : typeof value;
}

function invalid(reason) {
  return { ok: false, reason };
}

/** 带状态码与固定 JSON 载荷的请求级错误 */
class HttpError extends Error {
  constructor(status, payload, headers) {
    super((payload && (payload.reason || payload.error)) || `HTTP ${status}`);
    this.status = status;
    this.payload = payload;
    this.headers = headers || undefined;
  }
}

function httpError(status, payload, headers) {
  return new HttpError(status, payload, headers);
}

/* -------------------------------------------------------------------------
 * 数据层：内存缓存 + 原子落盘
 * ---------------------------------------------------------------------- */

let store = emptyStore();

function emptyStore() {
  return { version: STORE_VERSION, plans: {}, cities: [], updatedAt: null };
}

function brokenStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 读到损坏数据时先备份，绝不静默丢数据 */
function backupBrokenStore(rawText, reason) {
  const backupFile = `${STORE_FILE}.broken-${brokenStamp()}`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(backupFile, rawText == null ? '' : rawText, 'utf8');
    console.error(`[metro] store.json 损坏（${reason}），已备份为 ${backupFile}`);
  } catch (err) {
    console.error(`[metro] store.json 损坏（${reason}），备份失败：${err && err.message}`);
  }
}

/** 启动时加载；文件缺失/JSON 损坏/结构非法都回退到空结构 */
function loadStore() {
  let rawText;
  try {
    rawText = fs.readFileSync(STORE_FILE, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error(`[metro] 读取 store.json 失败（${err.code || err.message}），使用空结构`);
    }
    return emptyStore();
  }

  try {
    if (rawText.charCodeAt(0) === 0xfeff) rawText = rawText.slice(1);
    const parsed = JSON.parse(rawText);
    if (!isPlainObject(parsed)) throw new Error('根节点不是对象');
    const plans = parsed.plans;
    if (plans !== undefined && !isPlainObject(plans)) throw new Error('plans 字段不是对象');
    const cities = parsed.cities;
    if (cities !== undefined && !Array.isArray(cities)) throw new Error('cities 字段不是数组');
    return {
      version: STORE_VERSION,
      plans: plans ? { ...plans } : {},
      cities: Array.isArray(cities) ? cities : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
    };
  } catch (err) {
    backupBrokenStore(rawText, err && err.message ? err.message : String(err));
    return emptyStore();
  }
}

/** 原子写：先写 store.json.tmp，再 rename 覆盖；完成后内存缓存即为最新 */
function persistStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const previousUpdatedAt = store.updatedAt;
  store.updatedAt = new Date().toISOString();
  const text = JSON.stringify(store, null, 2) + '\n';
  try {
    fs.writeFileSync(STORE_TMP, text, 'utf8');
    fs.renameSync(STORE_TMP, STORE_FILE);
  } catch (err) {
    store.updatedAt = previousUpdatedAt;
    console.error(`[metro] 写入 store.json 失败：${err && err.message}`);
    throw httpError(500, { ok: false, error: 'storage_error', reason: '数据写入失败，请检查 server/data 目录权限' });
  }
}

/* -------------------------------------------------------------------------
 * 校验层
 * ---------------------------------------------------------------------- */

function validateView(view, label) {
  if (!isPlainObject(view)) return invalid(`${label} 必须是对象`);
  const center = view.center;
  if (!Array.isArray(center) || center.length !== 2) return invalid(`${label}.center 必须是 [lat, lng] 形式的两元素数组`);
  const lat = center[0];
  const lng = center[1];
  if (!isFiniteNumber(lat)) return invalid(`${label}.center[0]（纬度）必须是数字，当前为 ${describeValue(lat)}`);
  if (!isFiniteNumber(lng)) return invalid(`${label}.center[1]（经度）必须是数字，当前为 ${describeValue(lng)}`);
  if (lat < -85 || lat > 85) return invalid(`${label}.center 纬度 ${lat} 超出 -85..85`);
  if (lng < -180 || lng > 180) return invalid(`${label}.center 经度 ${lng} 超出 -180..180`);
  if (!isFiniteNumber(view.zoom)) return invalid(`${label}.zoom 必须是数字，当前为 ${describeValue(view.zoom)}`);
  if (view.zoom < 3 || view.zoom > 18) return invalid(`${label}.zoom ${view.zoom} 超出 3..18`);
  return { ok: true };
}

/**
 * 校验 plan（不修改入参，保证 PUT 写入的内容与 GET 返回完全一致）。
 * 返回 { ok:true } 或 { ok:false, reason }
 */
function validatePlan(plan, queryCityId) {
  if (!isPlainObject(plan)) return invalid('请求体必须是 JSON 对象（plan）');

  if (typeof plan.cityId !== 'string' || plan.cityId.trim() === '') return invalid('cityId 必须是非空字符串');
  if (plan.cityId !== queryCityId) {
    return invalid(`cityId（${plan.cityId}）必须与查询参数 city（${queryCityId}）一致`);
  }

  if (typeof plan.cityName !== 'string') return invalid('cityName 必须是字符串');
  const cityNameLength = charLength(plan.cityName.trim());
  if (cityNameLength < 1 || cityNameLength > 24) return invalid(`cityName 长度必须为 1..24 个字符，当前为 ${cityNameLength}`);

  const viewChecked = validateView(plan.view, 'view');
  if (!viewChecked.ok) return viewChecked;

  if (!Array.isArray(plan.lines)) return invalid('lines 必须是数组');
  if (plan.lines.length < 1 || plan.lines.length > 8) {
    return invalid(`lines 数量必须为 1..8，当前为 ${plan.lines.length} 条`);
  }

  const lineKeys = new Set();
  /** 跨线路同 key 的坐标基准：key -> { lat, lng, lineKey } */
  const stationCoords = new Map();

  for (let lineIndex = 0; lineIndex < plan.lines.length; lineIndex += 1) {
    const line = plan.lines[lineIndex];
    const lineLabel = `lines[${lineIndex}]`;
    if (!isPlainObject(line)) return invalid(`${lineLabel} 必须是对象`);

    if (typeof line.key !== 'string' || line.key.trim() === '') return invalid(`${lineLabel}.key 必须是非空字符串`);
    if (lineKeys.has(line.key)) return invalid(`线路 key 重复：${line.key}`);
    lineKeys.add(line.key);

    if (typeof line.badge !== 'string') return invalid(`线路 ${line.key} 的 badge 必须是字符串，当前为 ${describeValue(line.badge)}`);
    const badgeLength = charLength(line.badge.trim());
    if (badgeLength < 1 || badgeLength > 4) return invalid(`线路 ${line.key} 的 badge 长度必须为 1..4 个字符，当前为 ${badgeLength}`);

    if (typeof line.name !== 'string') return invalid(`线路 ${line.key} 的 name 必须是字符串，当前为 ${describeValue(line.name)}`);
    const lineNameLength = charLength(line.name.trim());
    if (lineNameLength < 1 || lineNameLength > 24) return invalid(`线路 ${line.key} 的 name 长度必须为 1..24 个字符，当前为 ${lineNameLength}`);

    if (typeof line.color !== 'string' || !COLOR_PATTERN.test(line.color)) {
      return invalid(`线路 ${line.key} 的 color 必须匹配 ^#[0-9a-fA-F]{3,8}$，当前为 ${describeValue(line.color)}`);
    }

    if (line.type !== undefined && !(typeof line.type === 'string' && LINE_TYPES.has(line.type))) {
      return invalid(`线路 ${line.key} 的 type 只允许 "metro" 或 "intercity"，当前为 ${describeValue(line.type)}`);
    }

    if (typeof line.dateText !== 'string') return invalid(`线路 ${line.key} 的 dateText 必须是字符串，当前为 ${describeValue(line.dateText)}`);
    const dateTextLength = charLength(line.dateText.trim());
    if (dateTextLength < 1 || dateTextLength > 16) return invalid(`线路 ${line.key} 的 dateText 长度必须为 1..16 个字符，当前为 ${dateTextLength}`);

    if (typeof line.status !== 'string') return invalid(`线路 ${line.key} 的 status 必须是字符串，当前为 ${describeValue(line.status)}`);
    const statusLength = charLength(line.status.trim());
    if (statusLength < 1 || statusLength > 8) return invalid(`线路 ${line.key} 的 status 长度必须为 1..8 个字符，当前为 ${statusLength}`);

    if (!Array.isArray(line.stations)) return invalid(`线路 ${line.key} 的 stations 必须是数组`);
    if (line.stations.length > 40) return invalid(`线路 ${line.key} 的 stations 数量不能超过 40，当前为 ${line.stations.length}`);

    const stationKeys = new Set();
    for (let stationIndex = 0; stationIndex < line.stations.length; stationIndex += 1) {
      const station = line.stations[stationIndex];
      const stationLabel = `${lineLabel}.stations[${stationIndex}]`;
      if (!isPlainObject(station)) return invalid(`线路 ${line.key} 的 ${stationLabel} 必须是对象`);

      if (typeof station.key !== 'string' || station.key.trim() === '') {
        return invalid(`线路 ${line.key} 的 ${stationLabel}.key 必须是非空字符串`);
      }
      if (stationKeys.has(station.key)) return invalid(`线路 ${line.key} 内站点 key 重复：${station.key}`);
      stationKeys.add(station.key);

      if (typeof station.name !== 'string') return invalid(`站点 ${station.key} 的 name 必须是字符串，当前为 ${describeValue(station.name)}`);
      const stationNameLength = charLength(station.name.trim());
      if (stationNameLength < 1 || stationNameLength > 24) {
        return invalid(`站点 ${station.key} 的 name 长度必须为 1..24 个字符，当前为 ${stationNameLength}`);
      }

      if (!isFiniteNumber(station.lat)) return invalid(`站点 ${station.key} 的 lat 必须是数字，当前为 ${describeValue(station.lat)}`);
      if (!isFiniteNumber(station.lng)) return invalid(`站点 ${station.key} 的 lng 必须是数字，当前为 ${describeValue(station.lng)}`);
      if (station.lat < -85 || station.lat > 85) return invalid(`站点 ${station.key} 的 lat ${station.lat} 超出 -85..85`);
      if (station.lng < -180 || station.lng > 180) return invalid(`站点 ${station.key} 的 lng ${station.lng} 超出 -180..180`);

      if (typeof station.side !== 'string' || !LABEL_SIDES.has(station.side)) {
        return invalid(`站点 ${station.key} 的 side 只允许 top/bottom/left/right，当前为 ${describeValue(station.side)}`);
      }

      for (const flag of ['ghost', 'shared', 'terminal']) {
        if (station[flag] !== undefined && typeof station[flag] !== 'boolean') {
          return invalid(`站点 ${station.key} 的 ${flag} 必须是布尔值，当前为 ${describeValue(station[flag])}`);
        }
      }

      const seen = stationCoords.get(station.key);
      if (!seen) {
        stationCoords.set(station.key, { lat: station.lat, lng: station.lng, lineKey: line.key });
      } else if (Math.abs(seen.lat - station.lat) > COORD_EPSILON || Math.abs(seen.lng - station.lng) > COORD_EPSILON) {
        return invalid(
          `换乘站 ${station.key} 的坐标不一致：${seen.lineKey}（${seen.lat}, ${seen.lng}）与 ${line.key}（${station.lat}, ${station.lng}），跨线路同 key 坐标误差需 ≤ 1e-9`
        );
      }
    }
  }

  return { ok: true };
}

/** PUT /api/cities 的请求体：城市对象数组 */
function validateCities(list) {
  if (!Array.isArray(list)) return invalid('请求体必须是城市对象数组');
  if (list.length > MAX_CITIES) return invalid(`城市数量不能超过 ${MAX_CITIES}，当前为 ${list.length}`);

  const seenIds = new Set();
  for (let index = 0; index < list.length; index += 1) {
    const city = list[index];
    const label = `cities[${index}]`;
    if (!isPlainObject(city)) return invalid(`${label} 必须是对象`);
    if (typeof city.id !== 'string' || city.id.trim() === '') return invalid(`${label}.id 必须是非空字符串`);
    if (charLength(city.id) > 64) return invalid(`${label}.id 长度不能超过 64 个字符`);
    if (RESERVED_CITY_IDS.has(city.id)) return invalid(`${label}.id 不能使用保留字 ${city.id}`);
    if (seenIds.has(city.id)) return invalid(`城市 id 重复：${city.id}`);
    seenIds.add(city.id);
    if (typeof city.name !== 'string') return invalid(`${label}.name 必须是字符串`);
    const nameLength = charLength(city.name.trim());
    if (nameLength < 1 || nameLength > 24) return invalid(`${label}.name 长度必须为 1..24 个字符，当前为 ${nameLength}`);
    const viewChecked = validateView(city.view, `${label}.view`);
    if (!viewChecked.ok) return viewChecked;
  }

  return { ok: true };
}

/* -------------------------------------------------------------------------
 * HTTP 基础设施
 * ---------------------------------------------------------------------- */

function sendJson(res, status, payload, extraHeaders) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(extraHeaders || {})
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

/** 读取请求体；超过 512KB 直接 413（不缓存、不解析） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      req.resume();
      reject(httpError(413, { ok: false, error: 'payload_too_large', reason: '请求体超过 512KB 上限' }));
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        req.resume();
        reject(httpError(413, { ok: false, error: 'payload_too_large', reason: '请求体超过 512KB 上限' }));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function parseJsonBody(buffer, label) {
  if (!buffer || buffer.length === 0) {
    throw httpError(400, { ok: false, error: 'invalid_json', reason: `${label || '请求体'}为空，需要合法的 JSON` });
  }
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 容忍客户端带 BOM
  try {
    return JSON.parse(text);
  } catch (err) {
    throw httpError(400, { ok: false, error: 'invalid_json', reason: `JSON 解析失败：${err && err.message}` });
  }
}

function normalizeCityId(rawValue) {
  const value = String(rawValue == null ? '' : rawValue).trim();
  if (!value) return invalid('city 参数不能为空');
  if (charLength(value) > 64) return invalid('city 参数长度不能超过 64 个字符');
  if (/[\u0000-\u001f\u007f]/.test(value)) return invalid('city 参数包含控制字符');
  if (RESERVED_CITY_IDS.has(value)) return invalid(`city 参数不能使用保留字 ${value}`);
  return { ok: true, id: value };
}

function hasPlan(cityId) {
  return Object.prototype.hasOwnProperty.call(store.plans, cityId);
}

/* -------------------------------------------------------------------------
 * API
 * ---------------------------------------------------------------------- */

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (pathname === '/api/health') {
    if (method !== 'GET') throw httpError(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET' });
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      time: new Date().toISOString(),
      plans: Object.keys(store.plans).length
    });
    return;
  }

  if (pathname === '/api/plans') {
    await handlePlans(req, res, url, method);
    return;
  }

  if (pathname === '/api/cities') {
    await handleCities(req, res, method);
    return;
  }

  throw httpError(404, { error: 'unknown_endpoint' });
}

async function handlePlans(req, res, url, method) {
  const cityParam = url.searchParams.get('city');

  if (method === 'GET') {
    if (cityParam === null || cityParam.trim() === '') {
      const cities = Object.keys(store.plans).sort();
      sendJson(res, 200, { cities, count: cities.length });
      return;
    }
    const city = normalizeCityId(cityParam);
    if (!city.ok) throw httpError(400, { ok: false, error: 'invalid_city', reason: city.reason });
    if (!hasPlan(city.id)) throw httpError(404, { error: 'not_found' });
    sendJson(res, 200, { cityId: city.id, plan: store.plans[city.id] });
    return;
  }

  if (method === 'PUT') {
    if (cityParam === null) throw httpError(400, { ok: false, error: 'missing_city', reason: '缺少 city 查询参数' });
    const city = normalizeCityId(cityParam);
    if (!city.ok) throw httpError(400, { ok: false, error: 'invalid_city', reason: city.reason });

    const plan = parseJsonBody(await readBody(req), 'plan');
    const checked = validatePlan(plan, city.id);
    if (!checked.ok) throw httpError(400, { ok: false, error: 'invalid_plan', reason: checked.reason });

    const existed = hasPlan(city.id);
    const previous = store.plans[city.id];
    store.plans[city.id] = plan;
    try {
      persistStore();
    } catch (err) {
      if (existed) store.plans[city.id] = previous;
      else delete store.plans[city.id];
      throw err;
    }
    console.log(`[metro] PUT /api/plans city=${city.id} lines=${plan.lines.length} → 已保存`);
    sendJson(res, 200, { ok: true, cityId: city.id, savedAt: store.updatedAt });
    return;
  }

  if (method === 'DELETE') {
    if (cityParam === null) throw httpError(400, { ok: false, error: 'missing_city', reason: '缺少 city 查询参数' });
    const city = normalizeCityId(cityParam);
    if (!city.ok) throw httpError(400, { ok: false, error: 'invalid_city', reason: city.reason });

    if (hasPlan(city.id)) {
      const previous = store.plans[city.id];
      delete store.plans[city.id];
      try {
        persistStore();
      } catch (err) {
        store.plans[city.id] = previous;
        throw err;
      }
      console.log(`[metro] DELETE /api/plans city=${city.id} → 已删除`);
    }
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  throw httpError(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, PUT, DELETE' });
}

async function handleCities(req, res, method) {
  if (method === 'GET') {
    sendJson(res, 200, { cities: store.cities });
    return;
  }

  if (method === 'PUT') {
    const list = parseJsonBody(await readBody(req), '城市列表');
    const checked = validateCities(list);
    if (!checked.ok) throw httpError(400, { ok: false, error: 'invalid_cities', reason: checked.reason });

    const previous = store.cities;
    store.cities = list;
    try {
      persistStore();
    } catch (err) {
      store.cities = previous;
      throw err;
    }
    console.log(`[metro] PUT /api/cities count=${list.length} → 已保存`);
    sendJson(res, 200, { ok: true, count: list.length });
    return;
  }

  throw httpError(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, PUT' });
}

/* -------------------------------------------------------------------------
 * 静态文件
 * ---------------------------------------------------------------------- */

function isFile(absPath) {
  try {
    return fs.statSync(absPath).isFile();
  } catch (err) {
    return false;
  }
}

/** 解析后的路径必须落在允许根目录内 */
function isInsideRoot(resolved, root) {
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(rootWithSep) && resolved !== root) return false;
  const rel = path.relative(root, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * URL 路径解码 + 穿越防护。
 * 返回 { ok:true, rel } 或 { ok:false, status, error, reason }
 */
function decodeUrlPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (err) {
    return { ok: false, status: 400, error: 'bad_request', reason: 'URL 编码不合法' };
  }
  if (decoded.includes('\u0000')) {
    return { ok: false, status: 400, error: 'bad_request', reason: '路径包含空字节' };
  }
  const normalized = decoded.replace(/\\/g, '/');
  for (const segment of normalized.split('/')) {
    if (segment === '..') {
      return { ok: false, status: 403, error: 'forbidden', reason: '禁止目录穿越' };
    }
  }
  return { ok: true, rel: normalized.replace(/^\/+/, '') };
}

/** 生成候选相对路径：/dist/x、/metro-chronicle/x、/metro-chronicle/dist/x 都映射到 dist 根 */
function buildStaticVariants(rel) {
  const variants = [];
  const push = (value) => {
    if (value && !variants.includes(value)) variants.push(value);
  };
  push(rel);
  push(rel.replace(/^dist\//, ''));
  push(rel.replace(/^metro-chronicle\/dist\//, ''));
  push(rel.replace(/^metro-chronicle\//, ''));
  return variants;
}

function sendStaticNotFound(res, detail) {
  sendHtml(
    res,
    404,
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>404 Not Found</title>` +
      `<body style="font:15px/1.6 system-ui,sans-serif;padding:32px"><h1>404 Not Found</h1><p>${detail}</p>` +
      `<p>可访问：<a href="/">/</a>（首页）、/dist/metro-chronicle.html、/api/health</p></body></html>`
  );
}

function sendStaticForbidden(res, detail) {
  sendHtml(
    res,
    403,
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>403 Forbidden</title>` +
      `<body style="font:15px/1.6 system-ui,sans-serif;padding:32px"><h1>403 Forbidden</h1><p>${detail}</p></body></html>`
  );
}

function sendFile(req, res, absPath, ext) {
  const body = fs.readFileSync(absPath); // 二进制读，原样写回（不加 BOM）
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES.get(ext) || 'application/octet-stream',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

function sendIndex(req, res) {
  for (const candidate of INDEX_CANDIDATES) {
    if (isFile(candidate)) {
      sendFile(req, res, candidate, '.html');
      return;
    }
  }
  sendStaticNotFound(res, `首页文件不存在（期望 ${INDEX_CANDIDATES.join(' 或 ')}）`);
}

function handleStatic(req, res, url) {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    throw httpError(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
  }

  const decoded = decodeUrlPath(url.pathname);
  if (!decoded.ok) {
    sendStaticForbidden(res, decoded.reason);
    return;
  }

  const { rel } = decoded;
  if (rel === '' || rel === 'index.html') {
    sendIndex(req, res);
    return;
  }

  for (const variant of buildStaticVariants(rel)) {
    for (const root of STATIC_ROOTS) {
      const resolved = path.resolve(root, variant);
      if (!isInsideRoot(resolved, root)) {
        sendStaticForbidden(res, '路径解析后超出允许的根目录');
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      if (!CONTENT_TYPES.has(ext)) continue;
      if (isFile(resolved)) {
        sendFile(req, res, resolved, ext);
        return;
      }
    }
  }

  sendStaticNotFound(res, `未找到静态文件：${rel}（仅支持 .html/.css/.js/.png）`);
}

/* -------------------------------------------------------------------------
 * 请求分发
 * ---------------------------------------------------------------------- */

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1');
  } catch (err) {
    throw httpError(400, { ok: false, error: 'bad_request', reason: '请求 URL 无法解析' });
  }

  const pathname = url.pathname;
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }
  handleStatic(req, res, url);
}

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => handleRequest(req, res))
    .catch((err) => {
      const isHttp = err instanceof HttpError;
      const status = isHttp ? err.status : 500;
      const payload = isHttp
        ? err.payload
        : { ok: false, error: 'internal_error', reason: '服务器内部错误' };
      console.error(`[metro] ${req.method} ${req.url} → ${status}: ${err && err.message ? err.message : String(err)}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      try {
        sendJson(res, status, payload, isHttp ? err.headers : undefined);
      } catch (writeErr) {
        console.error(`[metro] 响应写入失败: ${writeErr && writeErr.message}`);
        res.destroy();
      }
    });
});

/* -------------------------------------------------------------------------
 * 启动 / 退出
 * ---------------------------------------------------------------------- */

function resolvePort(rawValue) {
  const raw = String(rawValue == null ? '' : rawValue).trim();
  if (!raw) return DEFAULT_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.error(`[metro] PORT 无效（${raw}），回退到 ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  return parsed;
}

function shutdown(signal) {
  console.log(`[metro] 收到 ${signal}，正在关闭…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

function bootstrap() {
  store = loadStore();

  const port = resolvePort(process.env.PORT);
  const host = process.env.HOST && process.env.HOST.trim() ? process.env.HOST.trim() : DEFAULT_HOST;

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[metro] 端口 ${port} 已被占用，请用 PORT 环境变量指定其他端口`);
    } else {
      console.error(`[metro] 服务错误: ${err && err.message ? err.message : String(err)}`);
    }
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.log(`[metro] 服务已启动：http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
    console.log(`[metro] 静态根：${STATIC_ROOTS.join(' , ')}`);
    console.log(`[metro] 首页：${INDEX_CANDIDATES[0]}（存在时优先）`);
    console.log(`[metro] 数据文件：${STORE_FILE}（plans=${Object.keys(store.plans).length} cities=${store.cities.length}）`);
    console.log('[metro] 按 Ctrl+C 停止');
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // 兜底：单次请求异常不得让进程退出
  process.on('uncaughtException', (err) => {
    console.error(`[metro] 未捕获异常（进程继续运行）: ${err && err.message ? err.message : String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    const message = reason && reason.message ? reason.message : String(reason);
    console.error(`[metro] 未处理的 Promise 拒绝（进程继续运行）: ${message}`);
  });
}

bootstrap();
