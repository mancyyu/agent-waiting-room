#!/usr/bin/env node
'use strict';
// 「等一下」本地服务：默认只监听 127.0.0.1，提供等候室网页和 /api/*。
// 开启手机访问（lan=true）时改为监听 0.0.0.0，局域网请求必须带令牌。
// 没有会话在干活、且 30 分钟没有任何请求时自动退出。

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const L = require('./lib');
const E = require('./events');
const W = require('./web');
const S = require('./strings');

const PORT = L.loadConfig().port;
const IDLE_MS = (Number(process.env.WAITING_ROOM_IDLE_MINUTES) || 30) * 60 * 1000;
const CHECK_MS = Math.min(60 * 1000, Math.max(1000, Math.floor(IDLE_MS / 4)));
const CONFIG_POLL_MS = 2000;               // 命令行改了 lan 时，最多 2 秒后重新监听
const STALE_ACTIVE_MS = 6 * 3600 * 1000;   // “工作中”超过 6 小时没动静，视为已失联，不再阻止自动退出
const HUB_FILE = path.join(__dirname, '..', 'public', 'hub.html');
const CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CONFIG_KEYS_FROM_WEB = ['mode', 'autoOpen', 'delaySeconds', 'notify', 'notifyMinSeconds', 'quietHours', 'metrics', 'lan', 'lang'];

// 接口报错的语言：按当前解析结果（config.lang → WAITING_ROOM_LANG → 网页上报的 langHint → 系统语言）
function apiText(cfg, key, vars) { return S.t(L.resolveLang(cfg), key, vars); }

// ---------- 网页文件：按修改时间缓存，前端改了文件不用重启服务 ----------
let hubCache = { mtimeMs: -1, html: null };
function hubPage() {
  try {
    const st = fs.statSync(HUB_FILE);
    if (st.mtimeMs !== hubCache.mtimeMs) hubCache = { mtimeMs: st.mtimeMs, html: W.wrapHub(fs.readFileSync(HUB_FILE, 'utf8')) };
  } catch (e) {
    if (!hubCache.html) throw e;
  }
  return hubCache.html;
}
try { hubPage(); } catch (e) {
  L.log('读不到 hub.html: ' + e.message);
  process.exit(1);
}

const startedAt = Date.now();
let lastRequestAt = Date.now();
let lastHubSeenAt = 0;

function send(res, status, type, body, extra) {
  res.writeHead(status, Object.assign({
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  }, extra || {}));
  res.end(body);
}
function sendText(res, status, text, extra) { send(res, status, 'text/plain; charset=utf-8', text, extra); }
function sendJSON(res, status, obj, extra) { send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), extra); }

// ---------- GET ----------
function stateBody(req, cfg) {
  const now = Date.now();
  return {
    app: L.APP,
    version: L.VERSION,
    now,
    platform: process.platform,
    demo: false,
    config: L.publicConfig(cfg),
    resolvedLang: L.resolveLang(cfg), // 后端当前用的语言（zh / en），网页在 lang=auto 时可以对照
    lanUrls: W.isLoopback(req.socket.remoteAddress) ? W.lanUrls(PORT, cfg) : [],
    sessions: L.listSessions().map((s) => Object.assign(s, { stale: L.isStale(s, now) }))
  };
}

function statsBody(cfg, daysParam, fallbackDays) {
  return E.computeStats(E.readAllEvents(), { now: Date.now(), days: E.clampDays(daysParam, fallbackDays), cfg });
}

function handleGet(req, res, url, cfg) {
  switch (url.pathname) {
    case '/':
    case '/index.html':
      return send(res, 200, 'text/html; charset=utf-8', hubPage(), { 'Content-Security-Policy': CSP });
    case '/api/state':
      if (url.searchParams.get('hub') === '1') lastHubSeenAt = Date.now();
      return sendJSON(res, 200, stateBody(req, cfg));
    case '/api/stats':
      return sendJSON(res, 200, statsBody(cfg, url.searchParams.get('days'), 14));
    case '/api/export': {
      const stats = statsBody(cfg, url.searchParams.get('days'), E.KEEP_DAYS);
      return sendJSON(res, 200, E.exportStats(stats, cfg), { 'Content-Disposition': 'attachment; filename="waiting-room-stats.json"' });
    }
    case '/api/health':
      return sendJSON(res, 200, { app: L.APP, version: L.VERSION, pid: process.pid, port: PORT, startedAt });
    case '/api/hub':
      return sendJSON(res, 200, { lastHubSeenAt, now: Date.now() });
    case '/favicon.ico':
      res.writeHead(204); return res.end();
    case '/api/event':
    case '/api/config':
    case '/api/seen':
    case '/api/lang-hint':
      return sendText(res, 405, 'method not allowed');
    default:
      return sendText(res, 404, 'not found');
  }
}

// ---------- POST ----------
function postEvent(req, res, body, cfg) {
  const v = E.validateHubEvent(body);
  if (!v.ok) return sendJSON(res, 400, { error: v.error });
  if (!cfg.metrics) return sendJSON(res, 200, { ok: true, skipped: true });
  E.appendEvent(v.event.type, v.event.sid, v.event.d, { cfg });
  return sendJSON(res, 200, { ok: true });
}

function postConfig(req, res, body, cfg) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJSON(res, 400, { error: apiText(cfg, 'api.bodyObject') });
  const lang = L.resolveLang(cfg);
  const before = L.loadFileConfig();
  const next = Object.assign({}, before);
  for (const key of Object.keys(body)) {
    if (!CONFIG_KEYS_FROM_WEB.includes(key)) return sendJSON(res, 400, { error: S.t(lang, 'api.keyNotEditable', { key }) });
    if (key === 'lan' && !W.isLoopback(req.socket.remoteAddress)) return sendJSON(res, 403, { error: S.t(lang, 'api.lanLocalOnly') });
    const r = L.validateConfigValue(key, body[key], true, lang);
    if (!r.ok) return sendJSON(res, 400, { error: r.error });
    next[key] = r.value;
  }
  const saved = L.saveConfig(next);
  if (saved.mode !== before.mode) E.appendEvent('mode_change', null, { from: before.mode, to: saved.mode }, { cfg: saved });
  const out = L.configWithoutToken(Object.assign({}, saved, { port: cfg.port }));
  res.on('finish', () => setTimeout(syncListen, 50)); // lan 变了就重新监听（先把响应发完）
  return sendJSON(res, 200, out);
}

// 网页在 lang=auto 时上报自己解析出的语言。只写 hub.json 的 langHint，不动 config.json
function postLangHint(req, res, body, cfg) {
  const lang = body && typeof body === 'object' && !Array.isArray(body) ? body.lang : null;
  if (!L.LANGS.includes(lang)) return sendJSON(res, 400, { error: apiText(cfg, 'api.badLangHint') });
  L.updateHubMarker({ langHint: lang, langHintAt: Date.now() });
  return sendJSON(res, 200, { ok: true, langHint: lang, resolvedLang: L.resolveLang(cfg) });
}

function postSeen(req, res, body, cfg) {
  const sid = body && typeof body.sid === 'string' ? body.sid : '';
  if (!sid || !L.safeId(sid) || L.safeId(sid) !== sid) return sendJSON(res, 400, { error: apiText(cfg, 'api.badSid') });
  const s = L.readSession(sid);
  if (!s) return sendJSON(res, 404, { error: apiText(cfg, 'api.noSession') });
  const saved = L.writeSession(Object.assign({}, s, { seenAt: Date.now() }));
  return sendJSON(res, 200, { ok: true, sid, status: saved.status, seenAt: saved.seenAt });
}

const POST_ROUTES = { '/api/event': postEvent, '/api/config': postConfig, '/api/seen': postSeen, '/api/lang-hint': postLangHint };

function handlePost(req, res, url, cfg) {
  const bad = W.checkPost(req, PORT, cfg);
  if (bad) { req.resume(); return sendText(res, bad.status, bad.error); }
  const route = POST_ROUTES[url.pathname];
  if (!route) { req.resume(); return sendText(res, 404, 'not found'); }
  W.readBody(req, W.BODY_LIMIT, (err, text) => {
    if (err === 'too-large') return sendJSON(res, 413, { error: apiText(cfg, 'api.tooLarge') }, { Connection: 'close' });
    if (err) return sendJSON(res, 400, { error: apiText(cfg, 'api.readFailed') });
    let body;
    try { body = JSON.parse(text); } catch (_) { return sendJSON(res, 400, { error: apiText(cfg, 'api.badJSON') }); }
    try { route(req, res, body, cfg); } catch (e) {
      L.log('处理 ' + url.pathname + ' 出错: ' + (e && e.stack || e));
      if (!res.headersSent) sendJSON(res, 500, { error: apiText(cfg, 'api.internal') });
    }
  });
}

// ---------- 入口 ----------
function handle(req, res) {
  lastRequestAt = Date.now();
  const cfg = L.loadConfig();
  cfg.port = PORT;
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return sendText(res, 400, 'bad request'); }
  // 防 DNS rebinding：只接受本机 Host；局域网请求还要带令牌
  const denied = W.checkAccess(req, url, PORT, cfg);
  if (denied) { req.resume(); return sendText(res, denied.status, denied.error); }
  if (req.method === 'POST') return handlePost(req, res, url, cfg);
  if (req.method === 'GET' || req.method === 'HEAD') return handleGet(req, res, url, cfg);
  req.resume();
  return sendText(res, 405, 'method not allowed'); // 包括 OPTIONS：不回应 CORS 预检
}

// ---------- 监听：lan=false 只听 127.0.0.1；lan=true 听 0.0.0.0 ----------
let server = null;
let boundHost = null;
let switching = false;

function desiredHost(cfg) { return cfg.lan ? '0.0.0.0' : '127.0.0.1'; }

function writeServerInfo() {
  try { L.writeJSON(L.serverInfoPath(), { pid: process.pid, port: PORT, version: L.VERSION, startedAt, host: os.hostname(), listen: boundHost }); } catch (_) {}
}

function listen(host, onFail) {
  const s = http.createServer(handle);
  s.once('error', (e) => onFail(e, host));
  s.listen(PORT, host, () => {
    s.removeAllListeners('error');
    s.on('error', (e) => L.log('服务出错: ' + (e && e.stack || e)));
    server = s;
    boundHost = host;
    switching = false;
    writeServerInfo();
    L.log('服务已启动 http://' + host + ':' + PORT + '/ （空闲 ' + Math.round(IDLE_MS / 60000) + ' 分钟后自动退出）');
  });
}

async function onFirstListenError(e) {
  if (e && e.code === 'EADDRINUSE') {
    const p = await L.probeServer(PORT);
    if (p.kind === 'ours') { L.log('端口 ' + PORT + ' 上已有本服务在运行，本进程退出'); process.exit(0); }
    L.log('端口 ' + PORT + ' 被别的程序占用，服务未启动');
    process.exit(3);
  }
  L.log('服务出错: ' + (e && e.stack || e));
  process.exit(1);
}

// 重新监听失败：局域网监听不成就退回只听本机；本机也不成就退出
function onRelistenError(e, host) {
  L.log('重新监听 ' + host + ' 失败: ' + (e && e.message || e));
  if (host !== '127.0.0.1') return listen('127.0.0.1', onRelistenError);
  process.exit(1);
}

function syncListen() {
  if (switching || !server) return;
  const host = desiredHost(L.loadConfig());
  if (host === boundHost) return;
  switching = true;
  const old = server;
  server = null;
  L.log('手机访问设置变了，改为监听 ' + host);
  old.close(() => listen(host, onRelistenError));
  if (old.closeAllConnections) old.closeAllConnections();
}

function pruneOldSessions() {
  const n = L.pruneSessions(L.PRUNE_AFTER_MS, Date.now());
  if (n) L.log('清理了 ' + n + ' 个 2 小时没动静的会话');
}

const removed = E.pruneEvents(Date.now(), E.KEEP_DAYS);
if (removed) L.log('清理了 ' + removed + ' 个 30 天前的事件文件');
pruneOldSessions();
listen(desiredHost(L.loadConfig()), onFirstListenError);

function shutdown(why) {
  L.log('服务退出：' + why);
  try {
    const info = L.readJSON(L.serverInfoPath(), null);
    if (info && info.pid === process.pid) fs.unlinkSync(L.serverInfoPath());
  } catch (_) {}
  if (server) {
    server.close();
    if (server.closeAllConnections) server.closeAllConnections();
  }
  setTimeout(() => process.exit(0), 300).unref();
}

setInterval(() => {
  const now = Date.now();
  const active = L.listSessions().some((s) => (s.status === 'working' || s.status === 'needs_input') && now - (s.updatedAt || 0) < STALE_ACTIVE_MS);
  if (!active && now - lastRequestAt > IDLE_MS) shutdown('空闲超过 ' + Math.round(IDLE_MS / 60000) + ' 分钟');
}, CHECK_MS).unref();

setInterval(syncListen, CONFIG_POLL_MS).unref();
setInterval(pruneOldSessions, 3600 * 1000).unref();

process.on('SIGTERM', () => shutdown('收到 SIGTERM'));
process.on('SIGINT', () => shutdown('收到 SIGINT'));
