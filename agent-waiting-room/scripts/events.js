'use strict';
// 「等一下」本机事件流水与统计：events/YYYY-MM-DD.jsonl，一行一个事件，只存本机，保留 30 天。
// 只记事件类型、时间、会话 ID 和少量数字，不记提示词和回复。

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const KEEP_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;
const ENGAGE_TYPES = ['hub_open', 'hub_visible', 'game_start', 'relax_start'];
const GAMES = ['fly', 'lamp', 'pair'];
const RELAX_KINDS = ['breath', 'eyes', 'stretch'];
const MAX_MS = 24 * 3600 * 1000;

// 网页可以通过 POST /api/event 上报的事件，以及每种事件 d 里允许的字段
const HUB_EVENT_SCHEMAS = {
  hub_open: { source: ['auto', 'manual', 'link'] },
  hub_visible: {},
  game_start: { game: GAMES },
  game_end: { game: GAMES, ms: 'ms', score: 'num' },
  relax_start: { kind: RELAX_KINDS },
  relax_end: { kind: RELAX_KINDS, ms: 'ms' },
  banner_shown: { kind: ['done', 'needs_input', 'failed'] },
  back_click: {}
};

// ---------- 本地日期 ----------
function pad2(n) { return String(n).padStart(2, '0'); }
function dateKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function startOfDay(ms) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function addDays(ms, n) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); }
function keyToMs(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
function eventFile(key) { return path.join(L.eventsDir(), key + '.jsonl'); }

// ---------- 写 ----------
// opts: { cfg, t }。metrics=false 时不写，返回 false
function appendEvent(type, sid, d, opts) {
  try {
    const o = opts || {};
    const cfg = o.cfg || L.loadConfig();
    if (!cfg.metrics) return false;
    const t = Number.isFinite(o.t) ? o.t : Date.now();
    fs.mkdirSync(L.eventsDir(), { recursive: true });
    const line = JSON.stringify({ t, type: String(type), sid: sid ? L.safeId(sid) : null, d: d || {} });
    fs.appendFileSync(eventFile(dateKey(t)), line + '\n');
    return true;
  } catch (e) {
    L.log('写事件失败: ' + e.message);
    return false;
  }
}

// ---------- 读 ----------
function parseLines(text, filter) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || (filter && !filter(line))) continue;
    try {
      const e = JSON.parse(line);
      if (e && Number.isFinite(e.t) && typeof e.type === 'string') out.push(e);
    } catch (_) { /* 坏行跳过 */ }
  }
  return out;
}
function readFileEvents(key, filter) {
  try { return parseLines(fs.readFileSync(eventFile(key), 'utf8'), filter); } catch (_) { return []; }
}
function listEventKeys() {
  try {
    return fs.readdirSync(L.eventsDir()).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 10)).sort();
  } catch (_) { return []; }
}
function readAllEvents() {
  let out = [];
  for (const key of listEventKeys()) out = out.concat(readFileEvents(key));
  return out.sort((a, b) => a.t - b.t);
}
function readEventsBetween(fromMs, toMs, filter) {
  let out = [];
  for (let day = startOfDay(fromMs); day <= toMs; day = addDays(day, 1)) {
    out = out.concat(readFileEvents(dateKey(day), filter));
    if (out.length > 200000) break;
  }
  return out.filter((e) => e.t >= fromMs && e.t <= toMs);
}

// 回合结束时判断：这个回合里用户有没有打开或看过等候室
function computeEngaged(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return false;
  const quick = (line) => ENGAGE_TYPES.some((t) => line.includes('"' + t + '"'));
  return readEventsBetween(fromMs, toMs, quick).some((e) => ENGAGE_TYPES.includes(e.type));
}

// 只保留最近 30 天（含今天）的文件，服务启动时调用
function pruneEvents(now, keepDays) {
  const cutoff = dateKey(addDays(now || Date.now(), -((keepDays || KEEP_DAYS) - 1)));
  let removed = 0;
  for (const key of listEventKeys()) {
    if (key >= cutoff) continue;
    try { fs.unlinkSync(eventFile(key)); removed++; } catch (_) {}
  }
  return removed;
}

// ---------- 网页事件校验 ----------
function validateHubEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: '请求体要是 JSON 对象' };
  const schema = HUB_EVENT_SCHEMAS[body.type];
  if (!schema) return { ok: false, error: '不接受这种事件类型' };
  const src = body.d === undefined || body.d === null ? {} : body.d;
  if (typeof src !== 'object' || Array.isArray(src)) return { ok: false, error: 'd 要是对象' };
  const d = {};
  for (const [k, rule] of Object.entries(schema)) {
    if (src[k] === undefined) continue;
    const v = src[k];
    if (Array.isArray(rule)) {
      if (!rule.includes(v)) return { ok: false, error: k + ' 的值不在允许范围内' };
      d[k] = v;
    } else if (rule === 'ms') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_MS) return { ok: false, error: k + ' 要是 0 到 86400000 之间的毫秒数' };
      d[k] = Math.round(v);
    } else if (rule === 'num') {
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e9) return { ok: false, error: k + ' 要是数字' };
      d[k] = v;
    }
  }
  const sid = typeof body.sid === 'string' && L.safeId(body.sid) ? L.safeId(body.sid) : null;
  return { ok: true, event: { type: body.type, sid, d } };
}

// ---------- 统计 ----------
const OVER_30S = 30 * 1000;
const FIVE_MIN = 5 * 60 * 1000;
const FORTY_FIVE_MIN = 45 * 60 * 1000;

function turnMs(e) { const ms = e.d && e.d.ms; return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : null; }
function ratio(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 1000 : null; }

// 分档：<30 秒、30 秒–5 分钟（含 5 分钟）、5–45 分钟（含 45 分钟）、>45 分钟
function bucketOf(ms) {
  if (ms < OVER_30S) return 'lt30s';
  if (ms <= FIVE_MIN) return 's30to5m';
  if (ms <= FORTY_FIVE_MIN) return 'm5to45';
  return 'gt45m';
}
// 中位数：偶数个时取中间两个的平均（取整）；p90：最近秩法，排序后第 ceil(0.9n) 个
function median(sorted) {
  const n = sorted.length;
  if (!n) return null;
  return n % 2 ? sorted[(n - 1) / 2] : Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2);
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1];
}

function blankRow() {
  return {
    turns: 0, turnsOver30s: 0, engagedOver30s: 0, needsInput: 0, autoOpens: 0, notifies: 0,
    gamesPlayed: 0, playMs: 0, relaxCount: 0, backClicks: 0,
    buckets: { lt30s: 0, s30to5m: 0, m5to45: 0, gt45m: 0 }, byAgent: {}, msList: []
  };
}
function addToRow(row, e) {
  const d = e.d || {};
  switch (e.type) {
    case 'turn_end': {
      const ms = turnMs(e);
      if (ms === null) return; // 没有时长的回合不计
      row.turns++;
      row.msList.push(ms);
      row.buckets[bucketOf(ms)]++;
      const agent = L.normalizeAgent(d.agent);
      row.byAgent[agent] = (row.byAgent[agent] || 0) + 1;
      if (ms >= OVER_30S) { row.turnsOver30s++; if (d.engaged === true) row.engagedOver30s++; }
      return;
    }
    case 'needs_input': row.needsInput++; return;
    case 'auto_open': row.autoOpens++; return;
    case 'notify': row.notifies++; return;
    case 'game_start': row.gamesPlayed++; return;
    case 'game_end': { const ms = turnMs(e); if (ms !== null) row.playMs += Math.min(ms, MAX_MS); return; }
    case 'relax_start': row.relaxCount++; return;
    case 'back_click': row.backClicks++; return;
    default: return;
  }
}

function clampDays(v, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return fallback || 14;
  return Math.min(KEEP_DAYS, n);
}

function retentionOf(firstSeen, activeSet, todayKey) {
  if (!firstSeen) return { day1: null, day7: null };
  const base = keyToMs(firstSeen);
  const check = (n) => { const k = dateKey(addDays(base, n)); return todayKey < k ? null : activeSet.has(k); };
  return { day1: check(1), day7: check(7) };
}

// 第 7 节的统计。events 为全部事件；totals 和 days 只算最近 days 天（含今天，按本地时区分天），
// firstSeen / activeDays / retention / modeHistory 用全部保存的事件（最多 30 天）
function computeStats(events, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const days = clampDays(o.days, 14);
  const cfg = o.cfg || L.DEFAULTS;
  const all = (events || []).filter((e) => e && Number.isFinite(e.t) && typeof e.type === 'string').sort((a, b) => a.t - b.t);

  const activeSet = new Set(all.map((e) => dateKey(e.t)));
  const firstSeen = all.length ? dateKey(all[0].t) : null;
  const todayKey = dateKey(now);
  const modeHistory = all.filter((e) => e.type === 'mode_change')
    .map((e) => ({ t: e.t, from: (e.d && e.d.from) || null, to: (e.d && e.d.to) || null }));

  const windowStart = addDays(startOfDay(now), -(days - 1));
  const totals = blankRow();
  const rows = new Map();
  for (let i = 0; i < days; i++) rows.set(dateKey(addDays(windowStart, i)), blankRow());
  for (const e of all) {
    if (e.t < windowStart) continue;
    addToRow(totals, e);
    const row = rows.get(dateKey(e.t));
    if (row) addToRow(row, e);
  }

  const sorted = totals.msList.slice().sort((a, b) => a - b);
  return {
    metricsEnabled: cfg.metrics !== false,
    firstSeen,
    activeDays: activeSet.size,
    retention: retentionOf(firstSeen, activeSet, todayKey),
    mode: cfg.mode || 'both',
    modeHistory,
    totals: {
      turns: totals.turns, turnsOver30s: totals.turnsOver30s, engagedOver30s: totals.engagedOver30s,
      openRate: ratio(totals.engagedOver30s, totals.turnsOver30s),
      needsInput: totals.needsInput, autoOpens: totals.autoOpens, notifies: totals.notifies,
      gamesPlayed: totals.gamesPlayed, playMs: totals.playMs, relaxCount: totals.relaxCount, backClicks: totals.backClicks,
      medianTurnMs: median(sorted), p90TurnMs: percentile(sorted, 0.9),
      buckets: totals.buckets,
      byAgent: totals.byAgent
    },
    days: Array.from(rows.entries()).map(([date, r]) => ({
      date, turns: r.turns, turnsOver30s: r.turnsOver30s, engagedOver30s: r.engagedOver30s,
      openRate: ratio(r.engagedOver30s, r.turnsOver30s), gamesPlayed: r.gamesPlayed, playMs: r.playMs, needsInput: r.needsInput
    }))
  };
}

// 匿名汇总：统计本身不含项目名和会话 ID；这里再用白名单重建一遍，确保不会带出别的字段
function exportStats(stats, cfg, now) {
  return {
    exportedAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
    version: L.VERSION,
    mode: (cfg && cfg.mode) || stats.mode,
    metricsEnabled: stats.metricsEnabled,
    firstSeen: stats.firstSeen,
    activeDays: stats.activeDays,
    retention: { day1: stats.retention.day1, day7: stats.retention.day7 },
    modeHistory: stats.modeHistory.map((m) => ({ t: m.t, from: m.from, to: m.to })),
    totals: JSON.parse(JSON.stringify(stats.totals)),
    days: stats.days.map((d) => Object.assign({}, d))
  };
}

module.exports = {
  KEEP_DAYS, DAY_MS, ENGAGE_TYPES, HUB_EVENT_SCHEMAS,
  dateKey, startOfDay, addDays, eventFile,
  appendEvent, readAllEvents, readEventsBetween, computeEngaged, pruneEvents,
  validateHubEvent, bucketOf, median, percentile, clampDays, computeStats, exportStats
};
