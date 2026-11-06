#!/usr/bin/env node
'use strict';
// 「等一下」命令行入口。
//   hook <事件> [--agent claude-code|codex|cursor|other] [--json]
//        事件：prompt | stop | fail | notification | ask | permission | tool | interrupt | end
//        也接受原生事件名（UserPromptSubmit、Stop、StopFailure、beforeSubmitPrompt、sessionEnd 等）
//        由 agent 的钩子调用（stdin 是 JSON）。--json 时向 stdout 输出一个放行用的 JSON，给要求 JSON 输出的 agent 用
//   open                                          打开等候室网页
//   config [key=value ...]                        查看 / 修改设置
//   status                                        查看服务和会话状态
//   stop                                          停止本地服务
//   bg-open <sessionId> <turnStartedAt>           内部用：后台延迟打开

const path = require('path');
const { spawn } = require('child_process');
const L = require('./lib');
const E = require('./events');
const S = require('./strings');

const AUTO_OPEN_COOLDOWN_MS = 5 * 60 * 1000; // 5 分钟内自动打开过，就不再自动打开
const HUB_SEEN_WINDOW_MS = 2 * 60 * 1000;    // 2 分钟内网页还在轮询，说明标签页开着

// Claude Code Notification 的类型 → 等你确认的原因
const NOTIFICATION_REASONS = {
  permission_prompt: 'permission',
  elicitation_dialog: 'question',
  elicitation_url_dialog: 'question',
  agent_needs_input: 'question'
};
// StopFailure 的错误类型（官方文档列出的枚举），其余记为 unknown
const ERROR_TYPES = ['rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold',
  'billing_error', 'invalid_request', 'model_not_found', 'server_error', 'max_output_tokens', 'cloud_credential_error', 'unknown'];
// 各家 agent 的原生事件名 → 本插件的事件
const EVENT_ALIASES = {
  prompt: 'prompt', userpromptsubmit: 'prompt', beforesubmitprompt: 'prompt',
  stop: 'stop',
  fail: 'fail', failed: 'fail', stopfailure: 'fail',
  notification: 'notification',
  ask: 'ask',
  permission: 'permission', permissionrequest: 'permission',
  tool: 'tool', posttooluse: 'tool', posttoolusefailure: 'tool', aftershellexecution: 'tool', aftermcpexecution: 'tool', afterfileedit: 'tool',
  interrupt: 'interrupt',
  end: 'end', sessionend: 'end'
};
const AGENT_LABEL = { 'claude-code': 'Claude', codex: 'Codex', cursor: 'Cursor', other: 'Agent' };

// ---------- 钩子 ----------
function readStdin(timeoutMs) {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(data); } };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; if (data.length > 5e6) finish(); });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, timeoutMs).unref();
  });
}

function spawnSelfDetached(args) {
  try {
    const child = spawn(process.execPath, [__filename].concat(args), {
      detached: true, stdio: 'ignore', cwd: L.homeDir(), env: process.env
    });
    child.on('error', () => {});
    child.unref();
  } catch (e) { L.log('后台进程启动失败: ' + e.message); }
}

// 解析 `hook <事件> --agent codex --json`，参数顺序不限
function parseHookArgs(args) {
  const out = { event: null, agent: null, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--json') out.json = true;
    else if (a === '--agent') out.agent = args[++i] || null;
    else if (a.startsWith('--agent=')) out.agent = a.slice(8);
    else if (!out.event && !a.startsWith('--')) out.event = a;
  }
  return out;
}
function canonicalEvent(name) { return EVENT_ALIASES[String(name || '').trim().toLowerCase()] || null; }

// 兼容各家的字段名：Claude Code / Codex 用 session_id，Cursor 用 conversation_id
function pickString(input, keys) {
  for (const k of keys) {
    const v = input[k];
    if ((typeof v === 'string' && v) || (typeof v === 'number' && Number.isFinite(v))) return String(v);
  }
  return null;
}
function sessionIdOf(input) {
  return pickString(input, ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId', 'thread-id']);
}
function cwdOf(input) {
  const direct = pickString(input, ['cwd', 'workspace_root', 'workspaceRoot', 'project_dir']);
  if (direct) return direct;
  const roots = input.workspace_roots || input.workspaceRoots;
  return Array.isArray(roots) && typeof roots[0] === 'string' && roots[0] ? roots[0] : null;
}
function projectName(cwd) { return path.basename(cwd.replace(/[\\/]+$/, '')) || cwd; }

function errorTypeOf(input) {
  const e = typeof input.error === 'string' ? input.error : (typeof input.error_type === 'string' ? input.error_type : '');
  return ERROR_TYPES.includes(e) ? e : 'unknown';
}

// 发通知要过三关：非交互运行不发、notify=false 不发、勿扰时段不发
function maybeNotify(ctx, kind, title, body) {
  if (L.isHeadlessRun() || !ctx.cfg.notify || L.inQuietHours(ctx.cfg)) return;
  L.notify(title, body);
  E.appendEvent('notify', ctx.sid, { kind }, { cfg: ctx.cfg });
}

// 通知文字：标题带项目名，正文按语言生成（SPEC-v0.3 第 4 节）
//   done：正文带本回合用时；needs_input：正文说明是权限还是提问；failed：正文带错误类型
function notifyText(ctx, kind, extra) {
  const lang = L.resolveLang(ctx.cfg);
  const who = AGENT_LABEL[ctx.agent] || AGENT_LABEL.other;
  const title = S.t(lang, 'notify.' + kind + '.title', { project: ctx.project });
  let body;
  if (kind === 'done') {
    body = extra && Number.isFinite(extra.ms)
      ? S.t(lang, 'notify.done.body', { who, duration: S.formatDuration(lang, extra.ms) })
      : S.t(lang, 'notify.done.bodyNoTime', { who });
  } else if (kind === 'needs_input') {
    const r = extra && extra.reason;
    const key = r === 'permission' || r === 'question' || r === 'idle' ? r : 'other';
    body = S.t(lang, 'notify.needs_input.' + key, { who });
  } else {
    const label = S.errorLabel(lang, extra && extra.reason);
    body = label ? S.t(lang, 'notify.failed.body', { who, error: label }) : S.t(lang, 'notify.failed.bodyUnknown', { who });
  }
  return { title, body };
}

function startTurn(ctx, input) {
  // 本插件自己的斜杠命令不算“干活”
  if (typeof input.prompt === 'string' && /^\s*\/agent-waiting-room:/.test(input.prompt)) return;
  const { sid, base, now } = ctx;
  L.writeSession(Object.assign({}, base, {
    agent: ctx.agent, project: ctx.project, status: 'working', reason: null,
    turnStartedAt: now, statusChangedAt: now, finishedAt: null, seenAt: null
  }));
  E.appendEvent('turn_start', sid, { agent: ctx.agent }, { cfg: ctx.cfg, t: now });
  // 后台：确保本地服务在跑，并在 N 秒后视情况自动打开等候室
  spawnSelfDetached(['bg-open', String(sid), String(now)]);
}

// 回合结束：outcome 为 done 或 failed。silent=true 时不发通知（用户自己打断的）
function finishTurn(ctx, outcome, reason, silent) {
  const { sid, prev, base, now } = ctx;
  const active = !prev || prev.status === 'working' || prev.status === 'needs_input';
  if (!active) return; // 重复的 Stop：不再计一个回合
  const started = prev && prev.turnStartedAt;
  const ms = started ? Math.max(0, now - started) : null;
  const next = Object.assign({}, base, {
    agent: ctx.agent, project: ctx.project, status: outcome, reason: outcome === 'failed' ? reason : null,
    statusChangedAt: now, finishedAt: now, seenAt: null
  });
  if (ms !== null) {
    next.turns = (base.turns || 0) + 1;
    next.lastTurnMs = ms;
    next.totalWorkMs = (base.totalWorkMs || 0) + ms;
  }
  L.writeSession(next);
  if (ms !== null && ctx.cfg.metrics) {
    const engaged = E.computeEngaged(started, now);
    E.appendEvent('turn_end', sid, { agent: ctx.agent, ms, outcome, engaged }, { cfg: ctx.cfg, t: now });
  }
  if (silent) return;
  const kind = outcome === 'failed' ? 'failed' : 'done';
  // 几秒就回完的回合，用户多半还盯着终端：不足 notifyMinSeconds 秒的「干完了」不通知。出错和等你确认不受这个限制
  if (kind === 'done' && ms !== null && ms < ctx.cfg.notifyMinSeconds * 1000) return;
  const text = notifyText(ctx, kind, kind === 'failed' ? { reason } : { ms });
  maybeNotify(ctx, kind, text.title, text.body);
}

function needsInput(ctx, reason) {
  const { sid, prev, base, now } = ctx;
  const changed = !prev || prev.status !== 'needs_input';
  L.writeSession(Object.assign({}, base, {
    agent: ctx.agent, project: ctx.project, status: 'needs_input', reason,
    turnStartedAt: base.turnStartedAt || now,
    statusChangedAt: changed ? now : prev.statusChangedAt,
    seenAt: changed ? null : base.seenAt
  }));
  if (!changed) return;
  E.appendEvent('needs_input', sid, { reason }, { cfg: ctx.cfg, t: now });
  const text = notifyText(ctx, 'needs_input', { reason });
  maybeNotify(ctx, 'needs_input', text.title, text.body);
}

function notificationReason(input, prev) {
  const t = input.notification_type;
  if (!t) return prev && (prev.status === 'done' || prev.status === 'failed') ? undefined : null; // 老版本没有类型字段
  if (NOTIFICATION_REASONS[t]) return NOTIFICATION_REASONS[t];
  // idle_prompt：只在漏掉了 Stop、会话还显示“工作中”时才算等你输入；已干完的会话不改
  if (t === 'idle_prompt' && prev && prev.status === 'working') return 'idle';
  return undefined; // 比如 auth_success：不改状态
}

function handleHook(event, input, agentFlag) {
  const sid = sessionIdOf(input);
  if (!L.safeId(sid)) return;
  const now = Date.now();
  const prev = L.readSession(sid);
  const cwd = cwdOf(input);
  const ctx = {
    sid, prev, now,
    base: prev || { sessionId: L.safeId(sid), createdAt: now },
    agent: L.normalizeAgent(agentFlag || (prev && prev.agent) || 'claude-code'),
    project: cwd ? projectName(cwd) : (prev ? prev.project : '未知项目'),
    cfg: L.loadConfig()
  };
  ctx.base.sessionId = L.safeId(sid);

  switch (event) {
    case 'prompt': return startTurn(ctx, input);
    case 'stop': {
      // Cursor 的 stop 带 status：error = 出错，aborted = 用户打断
      if (input.status === 'error') return finishTurn(ctx, 'failed', 'unknown', false);
      if (input.status === 'aborted') return finishTurn(ctx, 'done', null, true);
      return finishTurn(ctx, 'done', null, false);
    }
    case 'fail': return finishTurn(ctx, 'failed', errorTypeOf(input), false);
    case 'interrupt': return finishTurn(ctx, 'done', null, true);
    case 'ask': return needsInput(ctx, 'question');
    case 'permission': return needsInput(ctx, 'permission');
    case 'notification': {
      const reason = notificationReason(input, prev);
      if (reason === undefined) return;
      return needsInput(ctx, reason);
    }
    case 'tool': {
      // 用户批准权限 / 回答问题后，工具跑完 → 回到“工作中”
      if (!prev) return;
      if (prev.status === 'needs_input') {
        L.writeSession(Object.assign({}, prev, { status: 'working', reason: null, statusChangedAt: now, seenAt: null }));
      } else if (prev.status === 'working' && now - (prev.updatedAt || 0) > 60 * 1000) {
        L.writeSession(prev); // 刷新 updatedAt，表示会话还活着
      }
      return;
    }
    case 'end': return L.removeSession(sid);
    default: return;
  }
}

async function runHook(args) {
  // 无论如何 2.5 秒内退出；正常情况下几十毫秒就结束。默认不往 stdout 写任何东西。
  setTimeout(() => process.exit(0), 2500).unref();
  const opts = parseHookArgs(args);
  let input = {};
  try {
    const raw = await readStdin(800);
    input = raw ? JSON.parse(raw) : {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  } catch (_) { input = {}; }
  const event = canonicalEvent(opts.event) || canonicalEvent(input.hook_event_name);
  try { if (event) handleHook(event, input, opts.agent); } catch (e) { L.log('hook ' + opts.event + ' 出错: ' + (e && e.stack || e)); }
  if (opts.json) {
    // 给 Codex / Cursor：明确放行，不阻止任何操作
    try { process.stdout.write(event === 'prompt' ? '{"continue":true}\n' : '{}\n'); } catch (_) {}
  }
  process.exitCode = 0;
  if (process.stdout.writableLength) process.stdout.once('drain', () => process.exit(0));
  else process.exit(0);
}

// ---------- 后台：确保服务 + 延迟自动打开 ----------
// 不自动打开的情况：autoOpen=false、mode=remind、勿扰时段、非交互运行
function autoOpenAllowed(cfg) { return L.shouldAutoOpen(cfg) && !L.inQuietHours(cfg) && !L.isHeadlessRun(); }

async function bgOpen(sid, turnStartedAt) {
  const cfg = L.loadConfig();
  const r = await L.ensureServer(cfg);
  if (!r.ok) { L.log('本地服务未就绪: ' + r.reason + '（端口 ' + cfg.port + '）'); return; }
  if (!autoOpenAllowed(cfg)) return;

  await L.sleep(cfg.delaySeconds * 1000);

  const cfg2 = L.loadConfig();
  if (!autoOpenAllowed(cfg2)) return;
  const s = L.readSession(sid);
  if (!s || s.status !== 'working' || String(s.turnStartedAt) !== String(turnStartedAt)) return;

  const now = Date.now();
  const hub = await L.getJSON(cfg2.port, '/api/hub', 800);
  if (hub && hub.json && now - (hub.json.lastHubSeenAt || 0) < HUB_SEEN_WINDOW_MS) return; // 页面已经开着
  const marker = L.readHubMarker();
  if (now - (marker.lastAutoOpenAt || 0) < AUTO_OPEN_COOLDOWN_MS) return;               // 刚自动开过

  L.updateHubMarker({ lastAutoOpenAt: now }); // 合并写入，保留网页上报的 langHint
  L.openBrowser(L.hubUrl(cfg2) + '?src=auto');
  E.appendEvent('auto_open', sid, {}, { cfg: cfg2 });
  L.log('已自动打开等候室');
}

// ---------- 用户命令 ----------
// 命令输出的语言：跟通知一样由 resolveLang 决定
async function cmdOpen() {
  const cfg = L.loadConfig();
  const lang = L.resolveLang(cfg);
  const r = await L.ensureServer(cfg);
  if (!r.ok) {
    if (r.reason === 'port-in-use') console.log(S.t(lang, 'cli.open.portInUse', { port: cfg.port }));
    else console.log(S.t(lang, 'cli.open.serverFailed', { log: L.logPath() }));
    return;
  }
  L.openBrowser(L.hubUrl(cfg));
  console.log(S.t(lang, 'cli.open.opened', { url: L.hubUrl(cfg) }));
}

const KEY_ALIASES = {
  mode: 'mode', '模式': 'mode',
  lang: 'lang', language: 'lang', '语言': 'lang',
  autoopen: 'autoOpen', 'auto-open': 'autoOpen', auto_open: 'autoOpen', auto: 'autoOpen',
  delayseconds: 'delaySeconds', delay: 'delaySeconds', 'delay-seconds': 'delaySeconds',
  notify: 'notify', notification: 'notify', notifications: 'notify',
  notifyminseconds: 'notifyMinSeconds', 'notify-min-seconds': 'notifyMinSeconds', notify_min_seconds: 'notifyMinSeconds',
  notifymin: 'notifyMinSeconds', 'notify-min': 'notifyMinSeconds', minseconds: 'notifyMinSeconds', '最短通知秒数': 'notifyMinSeconds',
  quiethours: 'quietHours', quiet: 'quietHours', 'quiet-hours': 'quietHours', quiet_hours: 'quietHours', dnd: 'quietHours', '勿扰': 'quietHours',
  metrics: 'metrics', stats: 'metrics', '统计': 'metrics',
  lan: 'lan', phone: 'lan', mobile: 'lan', '手机访问': 'lan',
  lantoken: 'lanToken', 'lan-token': 'lanToken', token: 'lanToken',
  port: 'port'
};

// 列出当前设置。键名保持英文（命令行要照着写），说明文字按 lang 输出
function describeConfig(cfg, lang) {
  const lg = lang || L.resolveLang(cfg);
  const d = (key, vars) => S.t(lg, 'cli.config.' + key, vars);
  const quietNow = L.inQuietHours(cfg) ? d('quietNow') : '';
  return [
    d('title', { file: L.configPath() }),
    '  mode         = ' + cfg.mode + '   ' + d('mode'),
    '  autoOpen     = ' + cfg.autoOpen + '   ' + d('autoOpen'),
    '  delaySeconds = ' + cfg.delaySeconds + '   ' + d('delaySeconds'),
    '  notify       = ' + cfg.notify + '   ' + d('notify'),
    '  notifyMinSeconds = ' + cfg.notifyMinSeconds + '   ' + d('notifyMinSeconds'),
    '  quietHours   = ' + L.formatQuietHours(cfg.quietHours) + '   ' + d('quietHours') + quietNow,
    '  metrics      = ' + cfg.metrics + '   ' + d('metrics'),
    '  lan          = ' + cfg.lan + '   ' + d('lan'),
    '  lanToken     = ' + (cfg.lanToken ? d('tokenSet') : d('tokenUnset')) + '   ' + d('lanToken'),
    '  lang         = ' + cfg.lang + '   ' + d('lang', { resolved: lg }),
    '  port         = ' + cfg.port + '   ' + d('port', { url: L.hubUrl(cfg) }),
    d('examples')
  ].join('\n');
}

async function cmdConfig(args) {
  const before = L.loadConfig();
  const lang = L.resolveLang(before);
  if (!args.length) { console.log(describeConfig(before, lang)); return; }
  const next = L.loadFileConfig();
  const errors = [];
  for (const a of args) {
    const m = /^([^=]+)=(.*)$/.exec(a);
    if (!m) { errors.push(S.t(lang, 'cli.config.badArg', { arg: a })); continue; }
    const key = KEY_ALIASES[m[1].trim().toLowerCase()];
    if (!key) { errors.push(S.t(lang, 'cfg.unknownKey', { key: m[1] })); continue; }
    const r = L.validateConfigValue(key, m[2].trim(), false, lang);
    if (!r.ok) errors.push(r.error); else next[key] = r.value;
  }
  if (errors.length) { console.log(S.t(lang, 'cli.config.notSaved') + '\n  ' + errors.join('\n  ')); return; }
  const saved = L.saveConfig(next);
  const after = L.loadConfig();
  const lang2 = L.resolveLang(after); // 刚改了 lang 的话，确认信息就用新语言
  if (saved.mode !== before.mode) E.appendEvent('mode_change', null, { from: before.mode, to: saved.mode }, { cfg: saved });
  // 比较的是实际生效的端口（WAITING_ROOM_PORT 环境变量优先），没变就不停服务
  if (after.port !== before.port) {
    const stopped = await stopServer(before.port);
    if (stopped) console.log(S.t(lang2, 'cli.config.portStopped', { port: before.port }));
  }
  if (saved.lan !== before.lan) console.log(S.t(lang2, saved.lan ? 'cli.config.lanOn' : 'cli.config.lanOff'));
  console.log(S.t(lang2, 'cli.config.saved') + '\n' + describeConfig(after, lang2));
}

async function stopServer(port) {
  const p = await L.probeServer(port);
  if (p.kind !== 'ours' || !p.info || !p.info.pid) return false;
  try { process.kill(p.info.pid, 'SIGTERM'); return true; } catch (_) { return false; }
}

async function cmdStatus() {
  const cfg = L.loadConfig();
  const lang = L.resolveLang(cfg);
  const t = (key, vars) => S.t(lang, key, vars);
  const p = await L.probeServer(cfg.port);
  const server = p.kind === 'ours' ? t('cli.status.running', { pid: p.info.pid }) : p.kind === 'foreign' ? t('cli.status.foreign') : t('cli.status.notRunning');
  const lines = [
    t('cli.status.server', { server, url: L.hubUrl(cfg) }),
    t('cli.status.summary', {
      mode: t(cfg.mode === 'remind' ? 'cli.status.modeRemind' : 'cli.status.modeBoth'),
      quiet: cfg.quietHours ? L.formatQuietHours(cfg.quietHours) : t('cli.status.unset'),
      lan: t(cfg.lan ? 'cli.status.on' : 'cli.status.off'),
      lang: cfg.lang === 'auto' ? 'auto (' + lang + ')' : cfg.lang
    }),
    t('cli.status.dataDir', { dir: L.homeDir() })
  ];
  const sessions = L.listSessions();
  if (!sessions.length) lines.push(t('cli.status.noSessions'));
  for (const s of sessions) {
    const stale = L.isStale(s) ? t('cli.status.stale') : '';
    const label = S.STR.en['status.' + s.status] ? t('status.' + s.status) : s.status;
    lines.push('  · ' + AGENT_LABEL[s.agent] + ' · ' + s.project + ' — ' + label + stale);
  }
  console.log(lines.join('\n'));
}

// 出错或打印用法时也要选语言；这里连读配置都可能失败，所以兜底到 en
function safeLang() {
  try { return L.resolveLang(L.loadConfig()); } catch (_) { try { return L.resolveLang(null); } catch (__) { return 'en'; } }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'hook': return runHook(rest);
    case 'bg-open': return bgOpen(rest[0], rest[1]);
    case 'open': return cmdOpen();
    case 'config': return cmdConfig(rest);
    case 'status': return cmdStatus();
    case 'stop': {
      const cfg = L.loadConfig();
      const ok = await stopServer(cfg.port);
      console.log(S.t(L.resolveLang(cfg), ok ? 'cli.stop.stopped' : 'cli.stop.notRunning'));
      return;
    }
    default:
      console.log(S.t(safeLang(), 'cli.usage'));
  }
}

main().catch((e) => {
  L.log('cli 出错: ' + (e && e.stack || e));
  if (process.argv[2] === 'hook') process.exit(0);
  console.error(S.t(safeLang(), 'cli.error', { message: (e && e.message) || e }));
  process.exit(1);
});
