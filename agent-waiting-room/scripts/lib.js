'use strict';
// 「等一下」共享工具：路径、配置、会话状态、本地 HTTP、通知、打开浏览器。
// 只用 Node.js 内置模块。

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const S = require('./strings');

const APP = 'agent-waiting-room';
const VERSION = '0.3.1';
const DEFAULTS = Object.freeze({
  mode: 'both', autoOpen: true, delaySeconds: 20, notify: true,
  quietHours: null, metrics: true, lan: false, port: 47823, lang: 'auto'
});
const MODES = ['both', 'remind'];
const LANGS = S.LANGS;             // 解析结果：zh / en
const LANG_VALUES = S.LANG_VALUES; // 配置值：auto / zh / en
const STATUSES = ['working', 'needs_input', 'done', 'failed'];
const AGENTS = ['claude-code', 'codex', 'cursor', 'other'];
const REASONS = ['permission', 'question', 'idle'];

// ---------- 路径 ----------
function homeDir() {
  return process.env.WAITING_ROOM_HOME || path.join(os.homedir(), '.claude', 'waiting-room');
}
function sessionsDir() { return path.join(homeDir(), 'sessions'); }
function eventsDir() { return path.join(homeDir(), 'events'); }
function configPath() { return path.join(homeDir(), 'config.json'); }
function hubMarkerPath() { return path.join(homeDir(), 'hub.json'); }
function serverInfoPath() { return path.join(homeDir(), 'server.json'); }
function logPath() { return path.join(homeDir(), 'waiting-room.log'); }
function dryRunLogPath() { return path.join(homeDir(), 'dry-run.log'); }

function ensureDirs() {
  fs.mkdirSync(sessionsDir(), { recursive: true });
}

// ---------- JSON 文件 ----------
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJSON(file, obj) {
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function log(msg) {
  try {
    ensureDirs();
    const file = logPath();
    try { if (fs.statSync(file).size > 512 * 1024) fs.writeFileSync(file, ''); } catch (_) {}
    fs.appendFileSync(file, new Date().toISOString() + ' [' + process.pid + '] ' + msg + '\n');
  } catch (_) { /* 日志失败不影响任何功能 */ }
}

// ---------- 勿扰时段 ----------
// 接受 null / "off" / "23:00-08:00" / { start, end }。返回 { ok, value }，value 为 null 或 { start, end }
const OFF_WORDS = ['', 'off', 'none', 'null', 'false', 'no', '0', '关', '关闭', '不要'];
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return String(h).padStart(2, '0') + ':' + m[2];
}
function parseQuietHours(v) {
  if (v === null || v === undefined || v === false) return { ok: true, value: null };
  let start;
  let end;
  if (typeof v === 'string') {
    if (OFF_WORDS.includes(v.trim().toLowerCase())) return { ok: true, value: null };
    const m = /^\s*(\d{1,2}:\d{2})\s*(?:-|–|—|~|～|到|至|to)\s*(\d{1,2}:\d{2})\s*$/i.exec(v);
    if (!m) return { ok: false };
    start = parseHHMM(m[1]);
    end = parseHHMM(m[2]);
  } else if (typeof v === 'object' && !Array.isArray(v)) {
    start = parseHHMM(v.start);
    end = parseHHMM(v.end);
  } else {
    return { ok: false };
  }
  if (!start || !end || start === end) return { ok: false };
  return { ok: true, value: { start, end } };
}
function minutesOf(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }

// 现在是否在勿扰时段内（本地时间）。可跨午夜：23:00–08:00 表示晚上 11 点到第二天早上 8 点
function inQuietHours(cfg, date) {
  const q = cfg && cfg.quietHours;
  if (!q || !q.start || !q.end) return false;
  const d = date || new Date();
  const now = d.getHours() * 60 + d.getMinutes();
  const s = minutesOf(q.start);
  const e = minutesOf(q.end);
  return s < e ? (now >= s && now < e) : (now >= s || now < e);
}
function formatQuietHours(q) { return q ? q.start + '-' + q.end : 'off'; }

// ---------- 配置 ----------
function newLanToken() { return crypto.randomBytes(24).toString('base64url'); } // 32 位
function validToken(t) { return typeof t === 'string' && /^[A-Za-z0-9_-]{24,128}$/.test(t); }

function normalizeConfig(raw) {
  const cfg = Object.assign({}, DEFAULTS);
  if (raw && typeof raw === 'object') {
    if (MODES.includes(raw.mode)) cfg.mode = raw.mode;
    for (const k of ['autoOpen', 'notify', 'metrics', 'lan']) if (typeof raw[k] === 'boolean') cfg[k] = raw[k];
    const d = Number(raw.delaySeconds);
    if (raw.delaySeconds !== undefined && Number.isFinite(d)) cfg.delaySeconds = Math.min(3600, Math.max(0, Math.round(d)));
    const q = parseQuietHours(raw.quietHours);
    if (q.ok) cfg.quietHours = q.value;
    const p = Number(raw.port);
    if (raw.port !== undefined && Number.isInteger(p) && p >= 1024 && p <= 65535) cfg.port = p;
    if (validToken(raw.lanToken)) cfg.lanToken = raw.lanToken;
    // v0.2 的 config.json 没有 lang：按 auto 处理，不报错
    if (LANG_VALUES.includes(raw.lang)) cfg.lang = raw.lang;
  }
  return cfg;
}

// ---------- 语言 ----------
// hub.json 除了 lastAutoOpenAt，还存网页上报的 langHint。两边都用这个函数改，避免互相覆盖
function readHubMarker() {
  const m = readJSON(hubMarkerPath(), null);
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}
function updateHubMarker(patch) {
  ensureDirs();
  const next = Object.assign({}, readHubMarker(), patch || {});
  writeJSON(hubMarkerPath(), next);
  return next;
}

// 系统语言：LC_ALL > LC_MESSAGES > LANG，取第一个非空的；以 zh 开头算中文
function localeLang() {
  for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const v = String(process.env[k] || '').trim();
    if (!v) continue;
    return /^zh/i.test(v) ? 'zh' : 'en';
  }
  return 'en';
}

// 后端用哪种语言（通知、命令行输出）。优先级：
//   config.lang 明确指定 → 环境变量 WAITING_ROOM_LANG → 网页上报的 langHint（hub.json）→ 系统语言以 zh 开头 → en
// cfg 可以不传（只看后面几级）。永远返回 'zh' 或 'en'
function resolveLang(cfg) {
  if (cfg && LANGS.includes(cfg.lang)) return cfg.lang;
  const env = String(process.env.WAITING_ROOM_LANG || '').trim().toLowerCase();
  if (LANGS.includes(env)) return env;
  const hint = readHubMarker().langHint;
  if (LANGS.includes(hint)) return hint;
  return localeLang();
}

// 开启手机访问时，如果还没有令牌就生成一个（只存本机）
function ensureLanToken(cfg) {
  if (cfg.lan && !validToken(cfg.lanToken)) cfg.lanToken = newLanToken();
  return cfg;
}

// 读取配置；文件不存在时用默认值创建。文件存在但写坏了，就用默认值，不覆盖用户的文件。
function loadConfig() {
  ensureDirs();
  const file = configPath();
  let raw = null;
  if (fs.existsSync(file)) {
    raw = readJSON(file, null);
    if (raw === null) log('config.json 不是合法 JSON，暂时使用默认设置');
  } else {
    try { writeJSON(file, DEFAULTS); } catch (e) { log('写入默认配置失败: ' + e.message); }
  }
  const cfg = normalizeConfig(raw);
  if (raw && cfg.lan && !cfg.lanToken) {
    // 用户手动把 lan 改成 true 但没有令牌：补一个并写回
    try { cfg.lanToken = saveConfig(normalizeConfig(raw)).lanToken; } catch (e) { log('生成令牌失败: ' + e.message); cfg.lan = false; }
  }
  const envPort = Number(process.env.WAITING_ROOM_PORT);
  if (Number.isInteger(envPort) && envPort >= 1024 && envPort <= 65535) cfg.port = envPort;
  return cfg;
}

// 只读文件里的设置（不叠加 WAITING_ROOM_PORT 环境变量），用于修改后回写
function loadFileConfig() {
  loadConfig();
  return normalizeConfig(readJSON(configPath(), null));
}

function saveConfig(cfg) {
  ensureDirs();
  const clean = ensureLanToken(normalizeConfig(cfg));
  writeJSON(configPath(), clean);
  return clean;
}

// 网页能看到的设置子集（不含令牌和端口）
function publicConfig(cfg) {
  return {
    mode: cfg.mode, autoOpen: cfg.autoOpen, delaySeconds: cfg.delaySeconds, notify: cfg.notify,
    quietHours: cfg.quietHours, metrics: cfg.metrics, lan: cfg.lan, lang: cfg.lang || 'auto'
  };
}
function configWithoutToken(cfg) { return Object.assign(publicConfig(cfg), { port: cfg.port }); }

// mode=remind 时视为不自动打开
function shouldAutoOpen(cfg) { return !!cfg.autoOpen && cfg.mode !== 'remind'; }

// 校验单个设置值。strict=true（网页接口）时布尔和数字必须是 JSON 原生类型；false（命令行）时接受中文和字符串。
// lang 决定报错文字的语言（'zh' / 'en'）；不传时按 resolveLang() 解析。
const MODE_WORDS = {
  both: 'both', '提醒+小游戏': 'both', '提醒加小游戏': 'both', '全部': 'both', all: 'both', games: 'both',
  remind: 'remind', '只要提醒': 'remind', '只提醒': 'remind', '提醒': 'remind', reminder: 'remind'
};
// 命令行里 lang 的别名：中文 → zh、English / 英文 → en、自动 → auto
const LANG_WORDS = {
  auto: 'auto', '自动': 'auto', default: 'auto', system: 'auto', '跟随系统': 'auto',
  zh: 'zh', 'zh-cn': 'zh', zh_cn: 'zh', 'zh-hans': 'zh', 'zh-tw': 'zh', chinese: 'zh', '中文': 'zh', '汉语': 'zh', '简体中文': 'zh',
  en: 'en', 'en-us': 'en', en_us: 'en', 'en-gb': 'en', english: 'en', '英文': 'en', '英语': 'en'
};
function parseBool(v) {
  const s = String(v).trim().toLowerCase();
  if (['true', 'on', 'yes', '1', '开', '开启', '打开'].includes(s)) return true;
  if (['false', 'off', 'no', '0', '关', '关闭'].includes(s)) return false;
  return null;
}
function validateConfigValue(key, value, strict, lang) {
  const fail = (k, vars) => ({ ok: false, error: S.t(lang || resolveLang(null), k, vars) });
  switch (key) {
    case 'mode': {
      const m = strict ? (MODES.includes(value) ? value : null) : MODE_WORDS[String(value).trim().toLowerCase()];
      return m ? { ok: true, value: m } : fail('cfg.mode');
    }
    case 'autoOpen': case 'notify': case 'metrics': case 'lan': {
      const b = typeof value === 'boolean' ? value : (strict ? null : parseBool(value));
      return b === null ? fail('cfg.bool', { key }) : { ok: true, value: b };
    }
    case 'delaySeconds': {
      const n = strict ? (typeof value === 'number' ? value : NaN) : Number(String(value).trim() || NaN);
      return Number.isFinite(n) && n >= 0 && n <= 3600 ? { ok: true, value: Math.round(n) } : fail('cfg.delaySeconds');
    }
    case 'quietHours': {
      const q = parseQuietHours(value);
      return q.ok ? { ok: true, value: q.value } : fail('cfg.quietHours');
    }
    case 'port': {
      const n = strict ? value : Number(String(value).trim() || NaN);
      return Number.isInteger(n) && n >= 1024 && n <= 65535 ? { ok: true, value: n } : fail('cfg.port');
    }
    case 'lanToken': {
      // 令牌只能重新随机生成，不接受手写的值
      const s = String(value).trim().toLowerCase();
      return ['reset', 'new', '重置', '重新生成'].includes(s) ? { ok: true, value: newLanToken() } : fail('cfg.lanToken');
    }
    case 'lang': {
      const v = strict ? (LANG_VALUES.includes(value) ? value : null) : LANG_WORDS[String(value).trim().toLowerCase()];
      return v ? { ok: true, value: v } : fail('cfg.lang');
    }
    default:
      return fail('cfg.unknownKey', { key });
  }
}

function hubUrl(cfg) { return 'http://127.0.0.1:' + cfg.port + '/'; }

// ---------- 会话状态 ----------
// 每个会话一个 JSON 文件。只存：会话 ID、agent 类型、项目文件夹名、状态、原因类别、时间戳和回合计数。不存提示词内容。
function safeId(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  return s || null;
}
function sessionFile(id) { return path.join(sessionsDir(), safeId(id) + '.json'); }

const AGENT_ALIASES = { claude: 'claude-code', claudecode: 'claude-code', 'claude_code': 'claude-code', 'codex-cli': 'codex' };
function normalizeAgent(a) {
  if (a === undefined || a === null || a === '') return 'claude-code';
  const s = String(a).trim().toLowerCase();
  const v = AGENT_ALIASES[s] || s;
  return AGENTS.includes(v) ? v : 'other';
}

// 兼容 v0.1 的原因值（permission_prompt 等）
function normalizeReason(status, reason) {
  if (!reason) return null;
  const r = String(reason);
  if (status === 'failed') return r.replace(/[^a-z_]/g, '').slice(0, 40) || null;
  if (REASONS.includes(r)) return r;
  if (r === 'permission_prompt') return 'permission';
  if (/^elicitation|agent_needs_input/.test(r)) return 'question';
  if (r === 'idle_prompt') return 'idle';
  return null;
}

function nonNegInt(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; }

function cleanSession(s, updatedAt) {
  const status = STATUSES.includes(s.status) ? s.status : 'working';
  return {
    sessionId: String(s.sessionId),
    agent: normalizeAgent(s.agent),
    project: String(s.project || '未知项目').slice(0, 120),
    status,
    reason: normalizeReason(status, s.reason),
    createdAt: s.createdAt || updatedAt,
    turnStartedAt: s.turnStartedAt || null,
    statusChangedAt: s.statusChangedAt || updatedAt,
    finishedAt: s.finishedAt || null,
    updatedAt,
    turns: nonNegInt(s.turns),
    lastTurnMs: s.lastTurnMs === null || s.lastTurnMs === undefined ? null : nonNegInt(s.lastTurnMs),
    totalWorkMs: nonNegInt(s.totalWorkMs),
    seenAt: s.seenAt || null
  };
}

function readSession(id) {
  if (!safeId(id)) return null;
  return readJSON(sessionFile(id), null);
}

function writeSession(s) {
  ensureDirs();
  const clean = cleanSession(s, Date.now());
  writeJSON(sessionFile(clean.sessionId), clean);
  return clean;
}

function removeSession(id) {
  if (!safeId(id)) return;
  try { fs.unlinkSync(sessionFile(id)); } catch (_) {}
}

const HIDE_AFTER_MS = 12 * 3600 * 1000;      // 12 小时没动静的会话不再显示
const DELETE_AFTER_MS = 7 * 24 * 3600 * 1000; // 7 天没动静的会话文件直接删除
const STALE_MS = 10 * 60 * 1000;              // 工作中 / 等你确认超过 10 分钟没动静，标记为可能失联
const PRUNE_AFTER_MS = 2 * 3600 * 1000;       // 服务启动时和每小时：删掉 2 小时没动静的会话文件

// 桌面 App 有时漏掉 Stop 事件，会话会一直显示“工作中”。网页据 stale 提示“可能已经停了”
function isStale(s, now) {
  return (s.status === 'working' || s.status === 'needs_input') && (now || Date.now()) - (s.updatedAt || 0) > STALE_MS;
}

function pruneSessions(maxAgeMs, now) {
  let names = [];
  try { names = fs.readdirSync(sessionsDir()); } catch (_) { return 0; }
  const limit = (now || Date.now()) - (maxAgeMs || PRUNE_AFTER_MS);
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(sessionsDir(), name);
    const s = readJSON(file, null);
    if (s && (s.updatedAt || 0) >= limit) continue;
    try { fs.unlinkSync(file); removed++; } catch (_) {}
  }
  return removed;
}

function listSessions() {
  let names = [];
  try { names = fs.readdirSync(sessionsDir()); } catch (_) { return []; }
  const now = Date.now();
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(sessionsDir(), name);
    const s = readJSON(file, null);
    if (!s || !s.sessionId) continue;
    const age = now - (s.updatedAt || 0);
    if (age > DELETE_AFTER_MS) { try { fs.unlinkSync(file); } catch (_) {} continue; }
    if (age > HIDE_AFTER_MS) continue;
    out.push(cleanSession(s, s.updatedAt || 0)); // 读取时补齐 v0.1 文件缺的字段
  }
  const rank = { needs_input: 0, working: 1, done: 2, failed: 2 };
  out.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.statusChangedAt - a.statusChangedAt));
  return out;
}

// ---------- 本地 HTTP ----------
function getJSON(port, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs || 500, headers: { Host: '127.0.0.1:' + port } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (_) { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// 返回 'ours'（我们的服务在跑）/ 'foreign'（端口被别的程序占了）/ 'none'（没有服务）
async function probeServer(port) {
  const r = await getJSON(port, '/api/health', 500);
  if (!r) return { kind: 'none' };
  if (r.json && r.json.app === APP) return { kind: 'ours', info: r.json };
  return { kind: 'foreign' };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function startServerDetached() {
  ensureDirs();
  const serverJs = path.join(__dirname, 'server.js');
  let fd = 'ignore';
  try { fd = fs.openSync(logPath(), 'a'); } catch (_) {}
  const child = spawn(process.execPath, [serverJs], {
    detached: true,
    stdio: ['ignore', fd, fd],
    cwd: homeDir(),
    env: process.env
  });
  child.on('error', (e) => log('启动服务失败: ' + e.message));
  child.unref();
  if (typeof fd === 'number') { try { fs.closeSync(fd); } catch (_) {} }
}

// 确保本地服务在跑。返回 { ok: true } 或 { ok: false, reason }
async function ensureServer(cfg) {
  const first = await probeServer(cfg.port);
  if (first.kind === 'foreign') return { ok: false, reason: 'port-in-use' };
  if (first.kind === 'ours') {
    const info = first.info || {};
    if (info.version === VERSION) return { ok: true };
    // 插件升级后，旧版本的服务往往还在跑（网页开着就不会空闲退出）：先停掉它，再起新版本
    try { if (info.pid) process.kill(info.pid, 'SIGTERM'); } catch (_) {}
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      if ((await probeServer(cfg.port)).kind === 'none') break;
    }
    log('发现旧版本服务 ' + (info.version || '?') + '，重启为 ' + VERSION);
  }
  startServerDetached();
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    const p = await probeServer(cfg.port);
    if (p.kind === 'ours') return { ok: true };
    if (p.kind === 'foreign') return { ok: false, reason: 'port-in-use' };
  }
  return { ok: false, reason: 'timeout' };
}

// ---------- 副作用：通知、打开浏览器 ----------
function isDryRun() { return process.env.WAITING_ROOM_DRY_RUN === '1'; }
function dryRunRecord(kind, detail) {
  try { ensureDirs(); fs.appendFileSync(dryRunLogPath(), JSON.stringify({ t: Date.now(), kind, detail }) + '\n'); } catch (_) {}
}

// 非交互的 `claude -p` / SDK 运行不弹通知、不开浏览器（启发式判断，变量由 Claude Code 进程设置）
function isHeadlessRun() {
  const ep = String(process.env.CLAUDE_CODE_ENTRYPOINT || '');
  return ep.startsWith('sdk');
}

function detachedRun(cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch (_) {}
}

// 系统通知：title 是标题（如「干完了 · picpick-ios」），body 是正文。文字由调用方按语言生成
function notify(title, body) {
  const t = String(title || 'Waiting Room');
  const b = String(body || '');
  if (isDryRun()) { dryRunRecord('notify', { title: t, body: b }); return; }
  if (process.platform === 'darwin') {
    // 文本通过 argv 传入，避免引号转义问题
    detachedRun('osascript', [
      '-e', 'on run argv',
      '-e', 'display notification (item 1 of argv) with title (item 2 of argv) sound name "Glass"',
      '-e', 'end run',
      b, t
    ]);
  } else if (process.platform === 'linux') {
    detachedRun('notify-send', [t, b]);
  }
  // Windows：暂不支持系统通知，网页里的横幅照常工作
}

function openBrowser(url) {
  if (isDryRun()) { dryRunRecord('open', url); return; }
  if (process.platform === 'darwin') detachedRun('open', [url]);
  else if (process.platform === 'win32') detachedRun('cmd', ['/c', 'start', '', url]);
  else detachedRun('xdg-open', [url]);
}

module.exports = {
  APP, VERSION, DEFAULTS, MODES, STATUSES, AGENTS, LANGS, LANG_VALUES,
  homeDir, sessionsDir, eventsDir, configPath, hubMarkerPath, serverInfoPath, logPath, dryRunLogPath,
  ensureDirs, readJSON, writeJSON, log,
  parseQuietHours, inQuietHours, formatQuietHours,
  newLanToken, validToken, normalizeConfig, loadConfig, loadFileConfig, saveConfig,
  readHubMarker, updateHubMarker, resolveLang,
  publicConfig, configWithoutToken, shouldAutoOpen, parseBool, validateConfigValue, hubUrl,
  safeId, normalizeAgent, readSession, writeSession, removeSession, listSessions,
  STALE_MS, PRUNE_AFTER_MS, isStale, pruneSessions,
  getJSON, probeServer, ensureServer, sleep,
  notify, openBrowser, isHeadlessRun, isDryRun
};
