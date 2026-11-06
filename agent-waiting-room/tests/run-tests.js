#!/usr/bin/env node
'use strict';
// 「等一下」后端自动化测试。只用 Node.js 内置模块：
//   node tests/run-tests.js
// 所有数据写在临时目录（WR_TEST_TMP 指定的目录，默认系统临时目录）里，端口用 47901–47908，
// 不碰 ~/.claude/waiting-room，不绑 47823；WAITING_ROOM_DRY_RUN=1，不会真开浏览器、真弹通知。
// 子进程默认 WAITING_ROOM_LANG=zh，让输出和断言不受这台电脑系统语言的影响；要测英文的用例自己传 env。
// 结束时停掉所有自己启动的服务进程。WR_TEST_KEEP=1 时保留临时目录方便排查。

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'cli.js');
const SERVER = path.join(ROOT, 'scripts', 'server.js');
const BIN = path.join(ROOT, 'bin', 'waiting-room');
const HUB_FILE = path.join(ROOT, 'public', 'hub.html');
const PORTS = { main: 47901, lan: 47902, foreign: 47903, idle: 47904, flow: 47905, auto: 47906, cli: 47907, unit: 47908, stale: 47909 };
const REAL_PORT = 47823;
if (Object.values(PORTS).includes(REAL_PORT)) throw new Error('测试端口不能用 47823');

const RUN_DIR = fs.mkdtempSync(path.join(process.env.WR_TEST_TMP || os.tmpdir(), 'wr-test-'));
const HOMES = {};
for (const k of ['unit', 'main', 'lan', 'foreign', 'idle', 'flow', 'auto', 'cli', 'prune', 'stale']) {
  HOMES[k] = path.join(RUN_DIR, k);
  fs.mkdirSync(HOMES[k], { recursive: true });
}

// 本进程里直接加载模块做单元测试，先把数据目录指到临时目录
process.env.WAITING_ROOM_HOME = HOMES.unit;
process.env.WAITING_ROOM_DRY_RUN = '1';
process.env.WAITING_ROOM_PORT = String(PORTS.unit); // 本进程万一用到端口，也只会是测试端口
process.env.WAITING_ROOM_LANG = 'zh';               // 默认中文；resolveLang 的用例会临时改掉再恢复
delete process.env.CLAUDE_CODE_ENTRYPOINT;
const L = require(path.join(ROOT, 'scripts', 'lib'));
const E = require(path.join(ROOT, 'scripts', 'events'));
const W = require(path.join(ROOT, 'scripts', 'web'));
const S = require(path.join(ROOT, 'scripts', 'strings'));
const HAS_CJK = /[一-鿿]/;

// ---------- 小测试框架 ----------
const tests = [];
const results = { pass: 0, fail: 0, skip: 0, failures: [] };
function test(name, fn) { tests.push({ name, fn }); }
class Skip extends Error {}
function skip(why) { throw new Skip(why); }

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
function quietAroundNow() { const n = Date.now(); return hhmm(n - 3600e3) + '-' + hhmm(n + 3600e3); }

// extra 里值为 null 的键会从环境里删掉（比如要测“没有 WAITING_ROOM_LANG”的情况）
function envFor(home, port, extra) {
  const env = Object.assign({}, process.env, {
    WAITING_ROOM_HOME: home, WAITING_ROOM_PORT: String(port), WAITING_ROOM_DRY_RUN: '1', WAITING_ROOM_IDLE_MINUTES: '3'
  }, extra || {});
  for (const k of Object.keys(env)) if (env[k] === null) delete env[k];
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

function writeConfig(home, cfg) { fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2)); }
function readConfigFile(home) { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); }
function readSessionFile(home, sid) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'sessions', sid + '.json'), 'utf8')); } catch (_) { return null; }
}
function writeSessionFile(home, s) {
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', s.sessionId + '.json'), JSON.stringify(s));
}
function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; }
}
function readEvents(home) {
  const dir = path.join(home, 'events');
  let out = [];
  try { for (const f of fs.readdirSync(dir).sort()) out = out.concat(readLines(path.join(dir, f))); } catch (_) {}
  return out;
}
function readDry(home) { return readLines(path.join(home, 'dry-run.log')); }
function rm(file) { try { fs.unlinkSync(file); } catch (_) {} }

async function waitFor(fn, timeoutMs, stepMs) {
  const end = Date.now() + (timeoutMs || 3000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(stepMs || 100);
  }
}

// 运行一个子进程（命令行或钩子），返回退出码、输出和耗时
function run(args, o) {
  const opts = o || {};
  return new Promise((resolve) => {
    const started = Date.now();
    const cmd = opts.sh ? 'sh' : process.execPath;
    const argv = opts.sh ? [BIN].concat(args) : [CLI].concat(args);
    const child = spawn(cmd, argv, { env: envFor(opts.home, opts.port, opts.env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr, ms: Date.now() - started }); });
    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.end(typeof opts.input === 'string' ? opts.input : JSON.stringify(opts.input));
    else child.stdin.end();
  });
}

const hookTimes = [];
async function hook(home, port, args, input, env) {
  const r = await run(['hook'].concat(args), { home, port, input, env });
  hookTimes.push({ args: args.join(' '), ms: r.ms });
  assert.strictEqual(r.code, 0, 'hook 退出码应为 0：' + args.join(' '));
  return r;
}
async function hookQuiet(home, port, args, input, env) {
  const r = await hook(home, port, args, input, env);
  assert.strictEqual(r.stdout, '', 'hook 标准输出应为空：' + args.join(' '));
  return r;
}
function cli(home, port, args, env) { return run(args, { home, port, env }); }
const EN = { WAITING_ROOM_LANG: 'en' };
function readMarker(home) { return JSON.parse(fs.readFileSync(path.join(home, 'hub.json'), 'utf8')); }

function request(port, o) {
  const opts = o || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ Host: opts.host || ('127.0.0.1:' + port) }, opts.headers || {});
    let body = opts.body;
    if (body !== undefined && typeof body !== 'string') body = JSON.stringify(body);
    if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request({
      host: opts.addr || '127.0.0.1', port, method: opts.method || 'GET', path: opts.path || '/', headers, timeout: 3000, agent: false
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
function post(port, urlPath, body, extra) {
  const o = extra || {};
  const headers = Object.assign({ 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:' + port }, o.headers || {});
  for (const k of Object.keys(headers)) if (headers[k] === null) delete headers[k];
  return request(port, { method: 'POST', path: urlPath, body, headers, addr: o.addr, host: o.host });
}
async function health(port, addr) {
  try { return (await request(port, { path: '/api/health', addr })).json; } catch (_) { return null; }
}

// ---------- 服务进程管理 ----------
const children = [];
function spawnServer(home, port, extraEnv) {
  const child = spawn(process.execPath, [SERVER], { env: envFor(home, port, extraEnv), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  child.exited = new Promise((r) => child.on('exit', (code, sig) => { child.done = true; r({ code, sig }); }));
  children.push(child);
  return child;
}
async function startServer(home, port, extraEnv) {
  const child = spawnServer(home, port, extraEnv);
  const ok = await waitFor(async () => { const h = await health(port); return h && h.pid === child.pid; }, 5000);
  if (!ok) throw new Error('服务没能在端口 ' + port + ' 启动');
  return child;
}
async function stopChild(child) {
  if (child.done) return;
  child.kill('SIGTERM');
  const r = await Promise.race([child.exited, sleep(2000).then(() => null)]);
  if (!r) { child.kill('SIGKILL'); await child.exited; }
}

// 收尾：停掉自己启动的服务，再按各测试目录的 server.json 扫一遍（钩子在后台可能拉起过服务）
async function cleanup() {
  await sleep(1500); // 等后台 bg-open 进程走完
  for (const c of children) await stopChild(c);
  for (let round = 0; round < 2; round++) {
    for (const home of Object.values(HOMES)) {
      const info = L.readJSON(path.join(home, 'server.json'), null);
      if (!info || !info.pid || !Object.values(PORTS).includes(info.port)) continue;
      const h = await health(info.port);
      if (h && h.app === 'agent-waiting-room' && h.pid === info.pid) { try { process.kill(info.pid, 'SIGTERM'); } catch (_) {} }
    }
    await sleep(800);
  }
  const stray = [];
  for (const port of Object.values(PORTS)) { const h = await health(port); if (h && h.app === 'agent-waiting-room') stray.push(port + '(pid ' + h.pid + ')'); }
  return stray;
}

// =====================================================================
// 单元测试：配置、勿扰时段、统计、校验、安全检查
// =====================================================================

test('勿扰时段：解析各种写法', () => {
  assert.deepStrictEqual(L.parseQuietHours('23:00-08:00'), { ok: true, value: { start: '23:00', end: '08:00' } });
  assert.deepStrictEqual(L.parseQuietHours('7:30 - 9:00').value, { start: '07:30', end: '09:00' });
  assert.deepStrictEqual(L.parseQuietHours('22:00到06:30').value, { start: '22:00', end: '06:30' });
  assert.deepStrictEqual(L.parseQuietHours({ start: '1:05', end: '02:00' }).value, { start: '01:05', end: '02:00' });
  assert.deepStrictEqual(L.parseQuietHours('off'), { ok: true, value: null });
  assert.deepStrictEqual(L.parseQuietHours(null), { ok: true, value: null });
  for (const bad of ['25:00-08:00', '23:00-23:00', '23:60-01:00', 'abc', 123, [], { start: '23:00' }]) {
    assert.strictEqual(L.parseQuietHours(bad).ok, false, '应拒绝 ' + JSON.stringify(bad));
  }
});

test('勿扰时段：跨午夜和同一天的判定', () => {
  const at = (h, m) => new Date(2026, 10, 5, h, m, 0);
  const night = { quietHours: { start: '23:00', end: '08:00' } };
  assert.strictEqual(L.inQuietHours(night, at(23, 0)), true);
  assert.strictEqual(L.inQuietHours(night, at(23, 30)), true);
  assert.strictEqual(L.inQuietHours(night, at(3, 0)), true);
  assert.strictEqual(L.inQuietHours(night, at(7, 59)), true);
  assert.strictEqual(L.inQuietHours(night, at(8, 0)), false);
  assert.strictEqual(L.inQuietHours(night, at(12, 0)), false);
  assert.strictEqual(L.inQuietHours(night, at(22, 59)), false);
  const day = { quietHours: { start: '09:00', end: '17:00' } };
  assert.strictEqual(L.inQuietHours(day, at(9, 0)), true);
  assert.strictEqual(L.inQuietHours(day, at(16, 59)), true);
  assert.strictEqual(L.inQuietHours(day, at(17, 0)), false);
  assert.strictEqual(L.inQuietHours(day, at(8, 59)), false);
  assert.strictEqual(L.inQuietHours({ quietHours: null }, at(3, 0)), false);
});

test('配置：默认值、令牌生成、公开子集', () => {
  const d = L.normalizeConfig({});
  assert.deepStrictEqual(d, { mode: 'both', autoOpen: true, delaySeconds: 20, notify: true, quietHours: null, metrics: true, lan: false, port: 47823, lang: 'auto' });
  const saved = L.saveConfig({ lan: true });
  assert.ok(L.validToken(saved.lanToken) && saved.lanToken.length >= 24, '开启 lan 时应生成 24 位以上令牌');
  const again = L.saveConfig(Object.assign({}, saved, { notify: false }));
  assert.strictEqual(again.lanToken, saved.lanToken, '再次保存不应换令牌');
  const off = L.saveConfig(Object.assign({}, again, { lan: false }));
  assert.strictEqual(off.lanToken, saved.lanToken, '关闭 lan 时保留令牌');
  assert.deepStrictEqual(Object.keys(L.publicConfig(off)).sort(), ['autoOpen', 'delaySeconds', 'lan', 'lang', 'metrics', 'mode', 'notify', 'quietHours']);
  assert.ok(!('lanToken' in L.configWithoutToken(off)));
  assert.strictEqual(L.shouldAutoOpen({ autoOpen: true, mode: 'remind' }), false);
  assert.strictEqual(L.shouldAutoOpen({ autoOpen: true, mode: 'both' }), true);
  // 手动把 lan 改成 true、没有令牌：读取时补上
  writeConfig(HOMES.unit, { lan: true });
  const loaded = L.loadConfig();
  assert.ok(L.validToken(loaded.lanToken));
  assert.strictEqual(readConfigFile(HOMES.unit).lanToken, loaded.lanToken);
  writeConfig(HOMES.unit, {});
});

test('配置：单项校验（网页严格 / 命令行宽松）', () => {
  const v = L.validateConfigValue;
  assert.deepStrictEqual(v('mode', 'remind', true), { ok: true, value: 'remind' });
  assert.strictEqual(v('mode', '只要提醒', true).ok, false);
  assert.deepStrictEqual(v('mode', '只要提醒', false), { ok: true, value: 'remind' });
  assert.strictEqual(v('autoOpen', 'true', true).ok, false);
  assert.deepStrictEqual(v('autoOpen', '关', false), { ok: true, value: false });
  assert.strictEqual(v('delaySeconds', 3601, true).ok, false);
  assert.strictEqual(v('delaySeconds', '20', true).ok, false);
  assert.deepStrictEqual(v('delaySeconds', '40', false), { ok: true, value: 40 });
  assert.deepStrictEqual(v('quietHours', '23:00-08:00', true).value, { start: '23:00', end: '08:00' });
  assert.strictEqual(v('quietHours', '23:00', true).ok, false);
  assert.strictEqual(v('lanToken', 'my-own-token-aaaaaaaaaaaaaaaaaaaaa', false).ok, false);
  assert.ok(L.validToken(v('lanToken', 'reset', false).value));
  assert.strictEqual(v('port', 80, true).ok, false);
  assert.strictEqual(v('nope', 1, true).ok, false);
});

// =====================================================================
// v0.3：语言设置 lang、resolveLang、文案表
// =====================================================================

test('lang：配置值解析——网页严格、命令行收别名、默认 auto、报错双语', () => {
  const v = L.validateConfigValue;
  assert.deepStrictEqual(v('lang', 'en', true), { ok: true, value: 'en' });
  assert.deepStrictEqual(v('lang', 'zh', true), { ok: true, value: 'zh' });
  assert.deepStrictEqual(v('lang', 'auto', true), { ok: true, value: 'auto' });
  assert.strictEqual(v('lang', '中文', true).ok, false, '网页接口不收别名');
  for (const bad of ['fr', 'EN', '', 1, null, true, {}]) assert.strictEqual(v('lang', bad, true).ok, false, '应拒绝 ' + JSON.stringify(bad));
  for (const [w, want] of [['中文', 'zh'], ['English', 'en'], ['英文', 'en'], ['自动', 'auto'], ['ZH', 'zh'], [' en ', 'en'], ['zh-CN', 'zh'], ['chinese', 'zh'], ['auto', 'auto']]) {
    assert.deepStrictEqual(v('lang', w, false), { ok: true, value: want }, w);
  }
  assert.strictEqual(v('lang', 'fr', false).ok, false);
  assert.strictEqual(v('lang', 'fr', false, 'zh').error, 'lang 只能是 auto（自动）、zh（中文）或 en（English）');
  assert.strictEqual(v('lang', 'fr', false, 'en').error, 'lang must be auto, zh (中文) or en (English)');
  assert.strictEqual(v('mode', 'x', true, 'en').error, 'mode must be both (remind + games) or remind (remind only)');
  assert.strictEqual(v('mode', 'x', true, 'zh').error, 'mode 只能是 both（提醒 + 小游戏）或 remind（只要提醒）');
  assert.strictEqual(v('notify', 'x', true, 'en').error, 'notify must be true or false');
  assert.strictEqual(v('nope', 1, true, 'en').error, 'There is no setting called "nope"');
  assert.strictEqual(L.normalizeConfig({}).lang, 'auto');
  assert.strictEqual(L.normalizeConfig({ lang: 'zh' }).lang, 'zh');
  assert.strictEqual(L.normalizeConfig({ lang: 'fr' }).lang, 'auto', '非法值按 auto');
  assert.strictEqual(L.publicConfig(L.normalizeConfig({ lang: 'en' })).lang, 'en');
  assert.deepStrictEqual(L.LANG_VALUES, ['auto', 'zh', 'en']);
});

test('lang：v0.2 的 config.json 没有 lang，读取时按 auto，其他设置不变', () => {
  writeConfig(HOMES.unit, { mode: 'remind', autoOpen: false, delaySeconds: 33, notify: true, quietHours: { start: '23:00', end: '08:00' }, metrics: false, lan: false, port: 47823 });
  const cfg = L.loadConfig();
  assert.strictEqual(cfg.lang, 'auto');
  assert.strictEqual(cfg.mode, 'remind');
  assert.strictEqual(cfg.delaySeconds, 33);
  assert.strictEqual(cfg.metrics, false);
  assert.deepStrictEqual(cfg.quietHours, { start: '23:00', end: '08:00' });
  assert.ok(!('lang' in readConfigFile(HOMES.unit)), '只读不写，旧文件保持原样');
  const saved = L.saveConfig(Object.assign({}, L.loadFileConfig(), { notify: false }));
  assert.strictEqual(saved.lang, 'auto');
  assert.strictEqual(readConfigFile(HOMES.unit).lang, 'auto', '下次保存时补上 lang');
  assert.strictEqual(readConfigFile(HOMES.unit).mode, 'remind');
  writeConfig(HOMES.unit, {});
});

test('lang：resolveLang 的优先级（config.lang → WAITING_ROOM_LANG → langHint → LC_ALL/LC_MESSAGES/LANG → en）', () => {
  const keys = ['WAITING_ROOM_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG'];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  const marker = path.join(HOMES.unit, 'hub.json');
  rm(marker);
  try {
    assert.strictEqual(L.resolveLang({ lang: 'auto' }), 'en', '什么都没有 → en');
    assert.strictEqual(L.resolveLang(null), 'en');
    process.env.LANG = 'zh_CN.UTF-8';
    assert.strictEqual(L.resolveLang({ lang: 'auto' }), 'zh', 'LANG 以 zh 开头');
    process.env.LC_MESSAGES = 'en_US.UTF-8';
    assert.strictEqual(L.resolveLang(null), 'en', 'LC_MESSAGES 优先于 LANG');
    process.env.LC_ALL = 'zh_TW.UTF-8';
    assert.strictEqual(L.resolveLang(null), 'zh', 'LC_ALL 优先于 LC_MESSAGES');
    process.env.LC_ALL = 'C';
    assert.strictEqual(L.resolveLang(null), 'en', 'LC_ALL=C 不算中文');
    L.updateHubMarker({ langHint: 'zh' });
    assert.strictEqual(L.resolveLang({ lang: 'auto' }), 'zh', '网页上报的 langHint 优先于系统语言');
    process.env.WAITING_ROOM_LANG = 'en';
    assert.strictEqual(L.resolveLang({ lang: 'auto' }), 'en', '环境变量优先于 langHint');
    process.env.WAITING_ROOM_LANG = 'auto';
    assert.strictEqual(L.resolveLang({ lang: 'auto' }), 'zh', '环境变量写 auto 等于没写');
    process.env.WAITING_ROOM_LANG = 'EN';
    assert.strictEqual(L.resolveLang(undefined), 'en', '环境变量不分大小写');
    assert.strictEqual(L.resolveLang({ lang: 'zh' }), 'zh', 'config.lang 最优先');
    assert.strictEqual(L.resolveLang({ lang: 'en' }), 'en');
    delete process.env.WAITING_ROOM_LANG;
    L.updateHubMarker({ langHint: 'nope', lastAutoOpenAt: 5 });
    assert.strictEqual(L.resolveLang(null), 'en', '非法 hint 忽略，回到系统语言');
    assert.strictEqual(L.readHubMarker().lastAutoOpenAt, 5, 'updateHubMarker 是合并写入');
    fs.writeFileSync(marker, 'not json');
    assert.deepStrictEqual(L.readHubMarker(), {}, '坏文件当空对象');
    assert.strictEqual(L.resolveLang(null), 'en');
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rm(marker);
  }
  assert.strictEqual(process.env.WAITING_ROOM_LANG, 'zh', '环境已恢复');
});

test('文案表：t() 两种语言、变量替换、缺 key 回退；中英 key 和变量一致；用时和错误类型', () => {
  assert.strictEqual(S.t('zh', 'notify.done.title', { project: 'p' }), '干完了 · p');
  assert.strictEqual(S.t('en', 'notify.done.title', { project: 'p' }), 'Done · p');
  assert.strictEqual(S.t('zh', 'notify.needs_input.title', { project: 'p' }), '等你确认 · p');
  assert.strictEqual(S.t('en', 'notify.needs_input.title', { project: 'p' }), 'Needs your input · p');
  assert.strictEqual(S.t('zh', 'notify.failed.title', { project: 'p' }), '出错了 · p');
  assert.strictEqual(S.t('en', 'notify.failed.title', { project: 'p' }), 'Failed · p');
  assert.strictEqual(S.t('fr', 'cli.config.saved'), 'Saved.', '未知语言退回英文');
  assert.strictEqual(S.t('zh', 'no.such.key'), 'no.such.key', '缺 key 原样返回，不抛错');
  assert.strictEqual(S.t('zh', 'cfg.bool', { key: 'notify' }), 'notify 只能是 true 或 false');
  assert.strictEqual(S.t('en', 'cfg.bool'), '{key} must be true or false', '没给变量时保留占位符');
  assert.deepStrictEqual(Object.keys(S.STR.zh).sort(), Object.keys(S.STR.en).sort(), '中英两张表的 key 要一样');
  for (const k of Object.keys(S.STR.en)) {
    const vars = (s) => (s.match(/\{\w+\}/g) || []).sort();
    assert.deepStrictEqual(vars(S.STR.zh[k]), vars(S.STR.en[k]), k + ' 两种语言的变量要一致');
    assert.ok(!HAS_CJK.test(S.STR.en[k].replace(/\(中文\)/, '')), k + ' 的英文文案不应含中文');
  }
  assert.strictEqual(S.formatDuration('zh', 45000), '45 秒');
  assert.strictEqual(S.formatDuration('zh', 72000), '1 分 12 秒');
  assert.strictEqual(S.formatDuration('zh', 3780000), '1 小时 3 分');
  assert.strictEqual(S.formatDuration('en', 45000), '45s');
  assert.strictEqual(S.formatDuration('en', 72000), '1m 12s');
  assert.strictEqual(S.formatDuration('en', 3780000), '1h 3m');
  assert.strictEqual(S.formatDuration('en', -5), '0s');
  assert.strictEqual(S.errorLabel('zh', 'rate_limit'), '触发了速率限制');
  assert.strictEqual(S.errorLabel('en', 'rate_limit'), 'rate limit');
  assert.strictEqual(S.errorLabel('en', 'unknown'), null);
  assert.strictEqual(S.errorLabel('en', null), null);
  assert.strictEqual(S.errorLabel('en', 'some_new_code'), 'some_new_code', '表里没有的显示原始代码');
});

test('会话：stale 判定（工作中 / 等你确认超过 10 分钟）', () => {
  const now = Date.now();
  const min = 60 * 1000;
  assert.strictEqual(L.isStale({ status: 'working', updatedAt: now - 11 * min }, now), true);
  assert.strictEqual(L.isStale({ status: 'needs_input', updatedAt: now - 11 * min }, now), true);
  assert.strictEqual(L.isStale({ status: 'working', updatedAt: now - 9 * min }, now), false);
  assert.strictEqual(L.isStale({ status: 'done', updatedAt: now - 60 * min }, now), false);
  assert.strictEqual(L.isStale({ status: 'failed', updatedAt: now - 60 * min }, now), false);
});

test('会话：清理 2 小时没动静的会话文件', () => {
  const now = Date.now();
  writeSessionFile(HOMES.unit, { sessionId: 'old-done', status: 'done', updatedAt: now - 3 * 3600e3 });
  writeSessionFile(HOMES.unit, { sessionId: 'old-working', status: 'working', updatedAt: now - 2 * 3600e3 - 1000 });
  writeSessionFile(HOMES.unit, { sessionId: 'recent', status: 'working', updatedAt: now - 3600e3 });
  assert.strictEqual(L.pruneSessions(L.PRUNE_AFTER_MS, now), 2);
  assert.strictEqual(readSessionFile(HOMES.unit, 'old-done'), null);
  assert.strictEqual(readSessionFile(HOMES.unit, 'old-working'), null);
  assert.ok(readSessionFile(HOMES.unit, 'recent'));
  rm(path.join(HOMES.unit, 'sessions', 'recent.json'));
});

test('会话：读取 v0.1 文件时补齐新字段', () => {
  writeSessionFile(HOMES.unit, { sessionId: 'v01', project: 'p', status: 'needs_input', reason: 'permission_prompt', updatedAt: Date.now() });
  const s = L.listSessions().find((x) => x.sessionId === 'v01');
  assert.strictEqual(s.agent, 'claude-code');
  assert.strictEqual(s.reason, 'permission');
  assert.strictEqual(s.turns, 0);
  assert.strictEqual(s.lastTurnMs, null);
  rm(path.join(HOMES.unit, 'sessions', 'v01.json'));
});

test('事件：engaged 只看回合时间窗内的打开 / 可见 / 游戏 / 放松', () => {
  const t0 = Date.now() - 60000;
  const cfg = { metrics: true };
  E.appendEvent('banner_shown', null, { kind: 'done' }, { cfg, t: t0 + 1000 });
  assert.strictEqual(E.computeEngaged(t0, t0 + 10000), false, 'banner_shown 不算');
  E.appendEvent('hub_visible', null, {}, { cfg, t: t0 + 5000 });
  assert.strictEqual(E.computeEngaged(t0, t0 + 10000), true);
  assert.strictEqual(E.computeEngaged(t0 + 6000, t0 + 10000), false);
  E.appendEvent('relax_start', null, { kind: 'eyes' }, { cfg, t: t0 + 20000 });
  assert.strictEqual(E.computeEngaged(t0 + 15000, t0 + 25000), true);
  assert.strictEqual(E.appendEvent('hub_open', null, {}, { cfg: { metrics: false } }), false, 'metrics=false 不写');
});

test('事件：只保留最近 30 天', () => {
  process.env.WAITING_ROOM_HOME = HOMES.prune;
  try {
    const now = Date.now();
    const keys = [40, 30, 29, 1, 0].map((n) => E.dateKey(E.addDays(now, -n)));
    fs.mkdirSync(path.join(HOMES.prune, 'events'), { recursive: true });
    for (const k of keys) fs.writeFileSync(path.join(HOMES.prune, 'events', k + '.jsonl'), '{"t":1,"type":"x","sid":null,"d":{}}\n');
    assert.strictEqual(E.pruneEvents(now, 30), 2);
    const left = fs.readdirSync(path.join(HOMES.prune, 'events')).map((f) => f.slice(0, 10)).sort();
    assert.deepStrictEqual(left, keys.slice(2).sort());
  } finally { process.env.WAITING_ROOM_HOME = HOMES.unit; }
});

// 合成事件：今天是 2026-11-20 中午（本地时区）
function syntheticEvents() {
  const day = (n, h) => new Date(2026, 10, n, h || 10, 0, 0).getTime();
  const ev = [];
  let k = 0;
  const add = (t, type, d, sid) => ev.push({ t: t + (k++), type, sid: sid || null, d: d || {} });
  add(day(10), 'turn_start', { agent: 'claude-code' }, 'sid-secret-1');
  add(day(10), 'turn_end', { agent: 'claude-code', ms: 20000, outcome: 'done', engaged: false }, 'sid-secret-1');
  add(day(11), 'turn_end', { agent: 'claude-code', ms: 40000, outcome: 'done', engaged: true }, 'sid-secret-1');
  add(day(17), 'hub_visible', {});
  add(day(17), 'mode_change', { from: 'both', to: 'remind' });
  const today = [
    [5000, true, 'claude-code'], [10000, false, 'claude-code'], [29999, false, 'codex'], [30000, true, 'codex'],
    [45000, false, 'cursor'], [300000, true, 'claude-code'], [300001, false, 'claude-code'], [2700000, false, 'something'],
    [2700001, false, 'claude-code'], [100000, false, 'claude-code']
  ];
  for (const [ms, engaged, agent] of today) add(day(20, 9), 'turn_end', { agent, ms, outcome: 'done', engaged }, 'sid-secret-2');
  add(day(20, 9), 'turn_end', { agent: 'claude-code', ms: 'abc', outcome: 'done', engaged: true });
  for (let i = 0; i < 2; i++) add(day(20, 9), 'needs_input', { reason: 'permission' });
  add(day(20, 9), 'auto_open', {});
  for (let i = 0; i < 3; i++) add(day(20, 9), 'notify', { kind: 'done' });
  add(day(20, 9), 'game_start', { game: 'fly' });
  add(day(20, 9), 'game_end', { game: 'fly', ms: 60000, score: 12 });
  add(day(20, 9), 'game_start', { game: 'pair' });
  add(day(20, 9), 'game_end', { game: 'pair', ms: 30000, score: 3 });
  add(day(20, 9), 'relax_start', { kind: 'breath' });
  add(day(20, 9), 'relax_end', { kind: 'breath', ms: 64000 });
  add(day(20, 9), 'back_click', {});
  add(day(20, 9), 'back_click', {});
  add(day(20, 9), 'hub_open', { source: 'auto' });
  return { ev, now: day(20, 12) };
}

test('统计：14 天窗口的计数、分档、中位数、p90、byAgent、留存', () => {
  const { ev, now } = syntheticEvents();
  const s = E.computeStats(ev, { now, days: 14, cfg: { metrics: true, mode: 'remind' } });
  assert.strictEqual(s.metricsEnabled, true);
  assert.strictEqual(s.firstSeen, '2026-11-10');
  assert.strictEqual(s.activeDays, 4);
  assert.deepStrictEqual(s.retention, { day1: true, day7: true });
  assert.strictEqual(s.mode, 'remind');
  assert.strictEqual(s.modeHistory.length, 1);
  assert.deepStrictEqual({ from: s.modeHistory[0].from, to: s.modeHistory[0].to }, { from: 'both', to: 'remind' });
  const t = s.totals;
  assert.strictEqual(t.turns, 12);
  assert.strictEqual(t.turnsOver30s, 8);
  assert.strictEqual(t.engagedOver30s, 3);
  assert.strictEqual(t.openRate, 0.375);
  assert.deepStrictEqual(t.buckets, { lt30s: 4, s30to5m: 5, m5to45: 2, gt45m: 1 });
  assert.strictEqual(t.medianTurnMs, 42500);
  assert.strictEqual(t.p90TurnMs, 2700000);
  assert.deepStrictEqual(t.byAgent, { 'claude-code': 8, codex: 2, cursor: 1, other: 1 });
  assert.strictEqual(t.needsInput, 2);
  assert.strictEqual(t.autoOpens, 1);
  assert.strictEqual(t.notifies, 3);
  assert.strictEqual(t.gamesPlayed, 2);
  assert.strictEqual(t.playMs, 90000);
  assert.strictEqual(t.relaxCount, 1);
  assert.strictEqual(t.backClicks, 2);
  assert.strictEqual(s.days.length, 14);
  assert.strictEqual(s.days[0].date, '2026-11-07');
  assert.strictEqual(s.days[13].date, '2026-11-20');
  assert.deepStrictEqual(s.days[13], { date: '2026-11-20', turns: 10, turnsOver30s: 7, engagedOver30s: 2, openRate: 0.286, gamesPlayed: 2, playMs: 90000, needsInput: 2 });
  assert.deepStrictEqual(s.days.find((d) => d.date === '2026-11-11'), { date: '2026-11-11', turns: 1, turnsOver30s: 1, engagedOver30s: 1, openRate: 1, gamesPlayed: 0, playMs: 0, needsInput: 0 });
  assert.strictEqual(s.days.find((d) => d.date === '2026-11-12').openRate, null);
});

test('统计：7 天窗口只算最近 7 天', () => {
  const { ev, now } = syntheticEvents();
  const s = E.computeStats(ev, { now, days: 7, cfg: { metrics: true } });
  assert.strictEqual(s.days.length, 7);
  assert.strictEqual(s.days[0].date, '2026-11-14');
  assert.strictEqual(s.totals.turns, 10);
  assert.strictEqual(s.totals.turnsOver30s, 7);
  assert.strictEqual(s.totals.engagedOver30s, 2);
  assert.strictEqual(s.totals.openRate, 0.286);
  assert.strictEqual(s.totals.medianTurnMs, 72500);
  assert.strictEqual(s.totals.p90TurnMs, 2700000);
  assert.deepStrictEqual(s.totals.buckets, { lt30s: 3, s30to5m: 4, m5to45: 2, gt45m: 1 });
  assert.strictEqual(s.activeDays, 4, 'activeDays 用全部保存的事件');
});

test('统计：留存的 null / false 情况，空数据', () => {
  const day = (n) => new Date(2026, 10, n, 10).getTime();
  const only = (days) => days.map((n) => ({ t: day(n), type: 'hub_open', d: {} }));
  assert.deepStrictEqual(E.computeStats(only([20]), { now: day(20) }).retention, { day1: null, day7: null });
  assert.deepStrictEqual(E.computeStats(only([17, 18]), { now: day(20) }).retention, { day1: true, day7: null });
  assert.deepStrictEqual(E.computeStats(only([10]), { now: day(20) }).retention, { day1: false, day7: false });
  assert.deepStrictEqual(E.computeStats(only([10, 17]), { now: day(17) }).retention, { day1: false, day7: true });
  const empty = E.computeStats([], { now: day(20) });
  assert.strictEqual(empty.firstSeen, null);
  assert.strictEqual(empty.activeDays, 0);
  assert.strictEqual(empty.totals.openRate, null);
  assert.strictEqual(empty.totals.medianTurnMs, null);
  assert.strictEqual(empty.totals.p90TurnMs, null);
  assert.strictEqual(E.computeStats([], { now: day(20), cfg: { metrics: false } }).metricsEnabled, false);
  assert.strictEqual(E.median([1, 2, 3]), 2);
  assert.strictEqual(E.median([1, 2]), 2); // (1+2)/2 = 1.5 取整为 2
  assert.strictEqual(E.percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9), 90);
  assert.strictEqual(E.percentile([5], 0.9), 5);
  assert.strictEqual(E.bucketOf(29999), 'lt30s');
  assert.strictEqual(E.bucketOf(30000), 's30to5m');
  assert.strictEqual(E.bucketOf(300000), 's30to5m');
  assert.strictEqual(E.bucketOf(300001), 'm5to45');
  assert.strictEqual(E.bucketOf(2700000), 'm5to45');
  assert.strictEqual(E.bucketOf(2700001), 'gt45m');
  assert.strictEqual(E.clampDays('abc', 14), 14);
  assert.strictEqual(E.clampDays(999, 14), 30);
  assert.strictEqual(E.clampDays(0, 14), 14);
});

test('导出：不含会话 ID 和项目名，带 exportedAt / version / mode', () => {
  const { ev, now } = syntheticEvents();
  const s = E.computeStats(ev, { now, days: 30, cfg: { metrics: true, mode: 'both' } });
  const out = E.exportStats(s, { mode: 'both' }, now);
  const text = JSON.stringify(out);
  assert.ok(!text.includes('sid-secret'), '导出里不应有会话 ID');
  assert.ok(!/"sid"|"sessionId"|"project"/.test(text));
  assert.strictEqual(out.version, L.VERSION);
  assert.strictEqual(out.mode, 'both');
  assert.ok(!Number.isNaN(Date.parse(out.exportedAt)));
  assert.strictEqual(out.totals.turns, 12);
});

test('网页事件白名单和字段校验', () => {
  const ok = (b) => E.validateHubEvent(b).ok;
  for (const type of Object.keys(E.HUB_EVENT_SCHEMAS)) assert.ok(ok({ type }), type + ' 应被接受');
  for (const type of ['turn_start', 'turn_end', 'needs_input', 'auto_open', 'notify', 'mode_change', 'whatever', '']) {
    assert.ok(!ok({ type }), type + ' 应被拒绝');
  }
  assert.ok(ok({ type: 'hub_open', d: { source: 'auto' } }));
  assert.ok(!ok({ type: 'hub_open', d: { source: 'email' } }));
  assert.ok(!ok({ type: 'game_start', d: { game: 'chess' } }));
  assert.ok(!ok({ type: 'game_end', d: { game: 'fly', ms: -1 } }));
  assert.ok(!ok({ type: 'game_end', d: { game: 'fly', ms: '100' } }));
  assert.ok(!ok({ type: 'banner_shown', d: [] }));
  assert.ok(ok({ type: 'banner_shown', d: { kind: 'failed' } }));
  assert.ok(!ok(null));
  assert.ok(!ok([]));
  const v = E.validateHubEvent({ type: 'game_end', sid: 'abc', d: { game: 'lamp', ms: 1234.4, score: 7, prompt: 'secret' } });
  assert.deepStrictEqual(v.event, { type: 'game_end', sid: 'abc', d: { game: 'lamp', ms: 1234, score: 7 } });
});

test('安全检查：回环地址、令牌比较、Host / 令牌 / CSRF 判定', () => {
  assert.ok(W.isLoopback('127.0.0.1') && W.isLoopback('::1') && W.isLoopback('::ffff:127.0.0.1') && W.isLoopback('127.1.2.3'));
  assert.ok(!W.isLoopback('192.168.1.5') && !W.isLoopback('::ffff:192.168.1.5') && !W.isLoopback('') && !W.isLoopback(undefined));
  const tok = L.newLanToken();
  assert.ok(W.tokenMatches(tok, tok));
  assert.ok(!W.tokenMatches(tok + 'x', tok));
  assert.ok(!W.tokenMatches(undefined, tok));
  assert.ok(!W.tokenMatches('short', 'short'), '短于 24 位的令牌一律不认');
  const P = 47999;
  const fake = (host, remote, headers) => ({ headers: Object.assign({ host }, headers || {}), socket: { remoteAddress: remote } });
  const u = (q) => new URL('/api/state' + (q || ''), 'http://x');
  const lanCfg = { lan: true, lanToken: tok };
  assert.strictEqual(W.checkAccess(fake('127.0.0.1:' + P, '127.0.0.1'), u(), P, { lan: false }), null);
  assert.strictEqual(W.checkAccess(fake('localhost:' + P, '::1'), u(), P, { lan: false }), null);
  assert.strictEqual(W.checkAccess(fake('evil.com:' + P, '127.0.0.1'), u(), P, { lan: false }).status, 403);
  assert.strictEqual(W.checkAccess(fake('127.0.0.1:' + (P + 1), '127.0.0.1'), u(), P, { lan: false }).status, 403);
  assert.strictEqual(W.checkAccess(fake('127.0.0.1:' + P, '192.168.1.9'), u(), P, { lan: false }).status, 403);
  assert.strictEqual(W.checkAccess(fake('127.0.0.1:' + P, '192.168.1.9'), u(), P, lanCfg).status, 401);
  assert.strictEqual(W.checkAccess(fake('127.0.0.1:' + P, '192.168.1.9'), u('?t=nope'), P, lanCfg).status, 401);
  assert.strictEqual(W.checkAccess(fake('127.0.0.1:' + P, '192.168.1.9'), u('?t=' + tok), P, lanCfg), null);
  assert.strictEqual(W.checkAccess(fake('127.0.0.1:' + P, '192.168.1.9', { 'x-wr-token': tok }), u(), P, lanCfg), null);
  const ip = W.lanAddresses()[0];
  if (ip) {
    assert.strictEqual(W.checkAccess(fake(ip + ':' + P, '127.0.0.1'), u(), P, { lan: false }).status, 403, 'lan=false 时不接受局域网 Host');
    assert.strictEqual(W.checkAccess(fake(ip + ':' + P, '127.0.0.1'), u(), P, lanCfg), null);
  }
  const postReq = (type, origin) => ({ headers: { 'content-type': type, origin } });
  assert.strictEqual(W.checkPost(postReq('application/json; charset=utf-8', 'http://localhost:' + P), P, { lan: false }), null);
  assert.strictEqual(W.checkPost(postReq('application/json', undefined), P, { lan: false }).status, 403);
  assert.strictEqual(W.checkPost(postReq('application/json', 'http://evil.com'), P, { lan: false }).status, 403);
  assert.strictEqual(W.checkPost(postReq('text/plain', 'http://127.0.0.1:' + P), P, { lan: false }).status, 403);
  assert.strictEqual(W.checkPost(postReq('application/x-www-form-urlencoded', 'http://127.0.0.1:' + P), P, { lan: false }).status, 403);
});

test('页面外壳：片段包一层 doctype / head / body，完整文档原样', () => {
  const frag = '<title>等一下</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<p>hi</p>';
  const wrapped = W.wrapHub(frag);
  assert.strictEqual(wrapped, '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + frag + '</body></html>');
  const full = '<!DOCTYPE html><html><body>x</body></html>';
  assert.strictEqual(W.wrapHub(full), full);
});

// =====================================================================
// 集成测试：钩子全流程（真实子进程 + 本地服务）
// =====================================================================

const FLOW = () => HOMES.flow;
const FP = PORTS.flow;
const cwdA = '/Users/someone/code/picpick-ios';

let flowChild = null;
test('[准备] 启动 flow 服务', async () => {
  writeConfig(FLOW(), { autoOpen: false, delaySeconds: 1, lanToken: L.newLanToken() });
  flowChild = await startServer(FLOW(), FP);
});

test('钩子 prompt：记为工作中，写 turn_start，stdout 为空', async () => {
  await hookQuiet(FLOW(), FP, ['prompt'], { session_id: 'sess-a', cwd: cwdA, hook_event_name: 'UserPromptSubmit', prompt: '帮我改个 bug' });
  const s = readSessionFile(FLOW(), 'sess-a');
  assert.strictEqual(s.status, 'working');
  assert.strictEqual(s.agent, 'claude-code');
  assert.strictEqual(s.project, 'picpick-ios');
  assert.strictEqual(s.turns, 0);
  assert.ok(s.turnStartedAt > 0);
  assert.ok(!JSON.stringify(s).includes('帮我改个 bug'), '会话文件不能存提示词');
  const ev = readEvents(FLOW()).filter((e) => e.type === 'turn_start' && e.sid === 'sess-a');
  assert.strictEqual(ev.length, 1);
  assert.deepStrictEqual(ev[0].d, { agent: 'claude-code' });
  assert.ok(!JSON.stringify(readEvents(FLOW())).includes('帮我改个 bug'), '事件流水不能存提示词');
});

test('钩子 notification(permission_prompt)：等你确认 + 通知 + 事件', async () => {
  const dryBefore = readDry(FLOW()).length;
  await hookQuiet(FLOW(), FP, ['notification'], { session_id: 'sess-a', cwd: cwdA, notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  const s = readSessionFile(FLOW(), 'sess-a');
  assert.strictEqual(s.status, 'needs_input');
  assert.strictEqual(s.reason, 'permission');
  const ev = readEvents(FLOW());
  assert.deepStrictEqual(ev.filter((e) => e.type === 'needs_input').map((e) => e.d), [{ reason: 'permission' }]);
  assert.deepStrictEqual(ev.filter((e) => e.type === 'notify').map((e) => e.d), [{ kind: 'needs_input' }]);
  const dry = readDry(FLOW()).slice(dryBefore);
  assert.strictEqual(dry.length, 1);
  assert.strictEqual(dry[0].kind, 'notify');
  assert.strictEqual(dry[0].detail.title, '等你确认 · picpick-ios');
  assert.strictEqual(dry[0].detail.body, 'Claude 在等你批准一个操作');
  // 重复的通知不再计数
  await hookQuiet(FLOW(), FP, ['notification'], { session_id: 'sess-a', notification_type: 'permission_prompt' });
  assert.strictEqual(readEvents(FLOW()).filter((e) => e.type === 'needs_input').length, 1);
  assert.strictEqual(readDry(FLOW()).length, dryBefore + 1);
});

test('钩子 tool / ask：批准后回到工作中，提问记为 question', async () => {
  await hookQuiet(FLOW(), FP, ['tool'], { session_id: 'sess-a', tool_name: 'Bash' });
  let s = readSessionFile(FLOW(), 'sess-a');
  assert.strictEqual(s.status, 'working');
  assert.strictEqual(s.reason, null);
  await hookQuiet(FLOW(), FP, ['ask'], { session_id: 'sess-a', tool_name: 'AskUserQuestion' });
  s = readSessionFile(FLOW(), 'sess-a');
  assert.strictEqual(s.status, 'needs_input');
  assert.strictEqual(s.reason, 'question');
  await hookQuiet(FLOW(), FP, ['tool'], { session_id: 'sess-a' });
  assert.strictEqual(readSessionFile(FLOW(), 'sess-a').status, 'working');
});

test('钩子 stop：干完了，回合计数，turn_end 带 engaged=true（期间打开过网页）', async () => {
  const r = await post(FP, '/api/event', { type: 'hub_open', d: { source: 'auto' } });
  assert.strictEqual(r.status, 200);
  await sleep(5);
  const dryBefore = readDry(FLOW()).length;
  await hookQuiet(FLOW(), FP, ['stop'], { session_id: 'sess-a', cwd: cwdA, stop_hook_active: false, last_assistant_message: '改好了' });
  const s = readSessionFile(FLOW(), 'sess-a');
  assert.strictEqual(s.status, 'done');
  assert.strictEqual(s.turns, 1);
  assert.strictEqual(s.lastTurnMs, s.finishedAt - s.turnStartedAt);
  assert.strictEqual(s.totalWorkMs, s.lastTurnMs);
  assert.ok(!JSON.stringify(s).includes('改好了'), '不存回复内容');
  const te = readEvents(FLOW()).filter((e) => e.type === 'turn_end');
  assert.strictEqual(te.length, 1);
  assert.deepStrictEqual(te[0].d, { agent: 'claude-code', ms: s.lastTurnMs, outcome: 'done', engaged: true });
  const dry = readDry(FLOW()).slice(dryBefore);
  assert.strictEqual(dry.length, 1);
  assert.strictEqual(dry[0].detail.title, '干完了 · picpick-ios');
  assert.ok(/^Claude 这一回合用了 \d+ 秒，回去看看$/.test(dry[0].detail.body), dry[0].detail.body);
  assert.strictEqual(readEvents(FLOW()).filter((e) => e.type === 'notify' && e.d.kind === 'done').length, 1);
});

test('钩子 stop：重复的 Stop 不再计回合；idle_prompt 不改已干完的会话', async () => {
  await hookQuiet(FLOW(), FP, ['stop'], { session_id: 'sess-a' });
  await hookQuiet(FLOW(), FP, ['notification'], { session_id: 'sess-a', notification_type: 'idle_prompt' });
  const s = readSessionFile(FLOW(), 'sess-a');
  assert.strictEqual(s.status, 'done');
  assert.strictEqual(s.turns, 1);
  assert.strictEqual(readEvents(FLOW()).filter((e) => e.type === 'turn_end').length, 1);
});

test('第二个回合：没打开网页时 engaged=false，累计用时', async () => {
  const before = readSessionFile(FLOW(), 'sess-a');
  await hookQuiet(FLOW(), FP, ['prompt'], { session_id: 'sess-a', cwd: cwdA, prompt: 'again' });
  await sleep(20);
  await hookQuiet(FLOW(), FP, ['stop'], { session_id: 'sess-a', cwd: cwdA });
  const s = readSessionFile(FLOW(), 'sess-a');
  assert.strictEqual(s.turns, 2);
  assert.strictEqual(s.totalWorkMs, before.totalWorkMs + s.lastTurnMs);
  const te = readEvents(FLOW()).filter((e) => e.type === 'turn_end');
  assert.strictEqual(te[1].d.engaged, false);
});

test('钩子 fail（StopFailure）：出错了，记错误类型，不存错误文字', async () => {
  await hookQuiet(FLOW(), FP, ['prompt'], { session_id: 'sess-f', cwd: '/x/api-gateway', prompt: 'go' });
  const dryBefore = readDry(FLOW()).length;
  await hookQuiet(FLOW(), FP, ['fail'], {
    session_id: 'sess-f', cwd: '/x/api-gateway', hook_event_name: 'StopFailure',
    error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: 'API Error: Rate limit reached'
  });
  const s = readSessionFile(FLOW(), 'sess-f');
  assert.strictEqual(s.status, 'failed');
  assert.strictEqual(s.reason, 'rate_limit');
  assert.strictEqual(s.turns, 1);
  assert.ok(!JSON.stringify(s).includes('API Error') && !JSON.stringify(s).includes('429'));
  const te = readEvents(FLOW()).filter((e) => e.type === 'turn_end' && e.sid === 'sess-f');
  assert.strictEqual(te[0].d.outcome, 'failed');
  assert.ok(readEvents(FLOW()).some((e) => e.type === 'notify' && e.sid === 'sess-f' && e.d.kind === 'failed'));
  const failNote = readDry(FLOW()).slice(dryBefore)[0].detail;
  assert.strictEqual(failNote.title, '出错了 · api-gateway');
  assert.strictEqual(failNote.body, 'Claude 出错停下了（触发了速率限制），回去看看');
  assert.ok(!failNote.body.includes('429'), '通知里不带错误原文');
  // 未知错误类型记为 unknown，通知正文不提原因
  await hookQuiet(FLOW(), FP, ['prompt'], { session_id: 'sess-f', cwd: '/x/api-gateway' });
  const d2 = readDry(FLOW()).length;
  await hookQuiet(FLOW(), FP, ['StopFailure'], { session_id: 'sess-f', error: 'something new' });
  assert.strictEqual(readSessionFile(FLOW(), 'sess-f').reason, 'unknown');
  assert.strictEqual(readDry(FLOW()).slice(d2)[0].detail.body, 'Claude 出错停下了，回去看看');
});

test('通知文案：英文（WAITING_ROOM_LANG=en）——干完带用时、等你确认分权限 / 提问、出错带类型', async () => {
  const proj = '/x/lang-proj';
  const d0 = readDry(FLOW()).length;
  const notes = () => readDry(FLOW()).slice(d0).map((x) => x.detail);
  await hookQuiet(FLOW(), FP, ['prompt'], { session_id: 'sess-en', cwd: proj }, EN);
  await hookQuiet(FLOW(), FP, ['notification'], { session_id: 'sess-en', notification_type: 'permission_prompt' }, EN);
  assert.strictEqual(notes().length, 1);
  assert.strictEqual(notes()[0].title, 'Needs your input · lang-proj');
  assert.strictEqual(notes()[0].body, 'Claude is asking for your permission to continue.');
  await hookQuiet(FLOW(), FP, ['tool'], { session_id: 'sess-en' }, EN);
  await hookQuiet(FLOW(), FP, ['ask'], { session_id: 'sess-en' }, EN);
  assert.strictEqual(notes()[1].title, 'Needs your input · lang-proj');
  assert.strictEqual(notes()[1].body, 'Claude has a question for you.');
  await hookQuiet(FLOW(), FP, ['tool'], { session_id: 'sess-en' }, EN);
  await sleep(1100);
  await hookQuiet(FLOW(), FP, ['stop'], { session_id: 'sess-en' }, EN);
  assert.strictEqual(notes()[2].title, 'Done · lang-proj');
  assert.ok(/^Claude worked for [1-9]\d*s\. Back to the terminal\.$/.test(notes()[2].body), notes()[2].body);
  await hookQuiet(FLOW(), FP, ['prompt'], { session_id: 'sess-en', cwd: proj }, EN);
  await hookQuiet(FLOW(), FP, ['fail'], { session_id: 'sess-en', error: 'rate_limit' }, EN);
  assert.strictEqual(notes()[3].title, 'Failed · lang-proj');
  assert.strictEqual(notes()[3].body, 'Claude stopped with an error (rate limit). Back to the terminal.');
  // 没有回合开始时间的 Stop（插件中途装上）：照样通知，正文不带用时
  await hookQuiet(FLOW(), FP, ['stop', '--agent', 'codex'], { session_id: 'sess-en-2', cwd: proj }, EN);
  assert.strictEqual(notes()[4].title, 'Done · lang-proj');
  assert.strictEqual(notes()[4].body, 'Codex has finished. Back to the terminal.');
  assert.strictEqual(notes().length, 5);
  for (const n of notes()) assert.ok(!HAS_CJK.test(n.title + n.body), '英文通知不应含中文：' + JSON.stringify(n));
  await hookQuiet(FLOW(), FP, ['end'], { session_id: 'sess-en' }, EN);
  await hookQuiet(FLOW(), FP, ['end'], { session_id: 'sess-en-2' }, EN);
});

test('通知文案：中文——提问、idle、服务繁忙', async () => {
  const proj = '/x/lang-zh';
  const d0 = readDry(FLOW()).length;
  await hookQuiet(FLOW(), FP, ['prompt'], { session_id: 'sess-zh', cwd: proj });
  await hookQuiet(FLOW(), FP, ['notification'], { session_id: 'sess-zh', notification_type: 'elicitation_dialog' });
  await hookQuiet(FLOW(), FP, ['tool'], { session_id: 'sess-zh' });
  await hookQuiet(FLOW(), FP, ['notification'], { session_id: 'sess-zh', notification_type: 'idle_prompt' });
  await hookQuiet(FLOW(), FP, ['tool'], { session_id: 'sess-zh' });
  await hookQuiet(FLOW(), FP, ['fail'], { session_id: 'sess-zh', error: 'overloaded' });
  const n = readDry(FLOW()).slice(d0).map((x) => x.detail);
  assert.deepStrictEqual(n.map((x) => x.title), ['等你确认 · lang-zh', '等你确认 · lang-zh', '出错了 · lang-zh']);
  assert.strictEqual(n[0].body, 'Claude 有问题要问你');
  assert.strictEqual(n[1].body, 'Claude 停下来等你了');
  assert.strictEqual(n[2].body, 'Claude 出错停下了（服务繁忙），回去看看');
  await hookQuiet(FLOW(), FP, ['end'], { session_id: 'sess-zh' });
});

test('通知语言：config.lang=zh 时忽略 WAITING_ROOM_LANG=en；改回 auto 后环境变量生效，确认信息用新语言', async () => {
  const c1 = await cli(FLOW(), FP, ['config', 'lang=zh'], EN);
  assert.ok(c1.stdout.startsWith('已保存。'), c1.stdout);
  const d0 = readDry(FLOW()).length;
  await hookQuiet(FLOW(), FP, ['prompt'], { session_id: 'sess-p', cwd: '/x/prio' }, EN);
  await hookQuiet(FLOW(), FP, ['stop'], { session_id: 'sess-p' }, EN);
  assert.strictEqual(readDry(FLOW()).slice(d0)[0].detail.title, '干完了 · prio');
  const c2 = await cli(FLOW(), FP, ['config', 'lang=auto'], EN);
  assert.ok(c2.stdout.startsWith('Saved.'), c2.stdout);
  await hookQuiet(FLOW(), FP, ['prompt'], { session_id: 'sess-p', cwd: '/x/prio' }, EN);
  await hookQuiet(FLOW(), FP, ['stop'], { session_id: 'sess-p' }, EN);
  assert.strictEqual(readDry(FLOW()).slice(d0)[1].detail.title, 'Done · prio');
  assert.strictEqual(readConfigFile(FLOW()).lang, 'auto');
  await hookQuiet(FLOW(), FP, ['end'], { session_id: 'sess-p' });
});

test('Codex：--agent codex、原生事件名、PermissionRequest、--json 输出', async () => {
  const p = await hook(FLOW(), FP, ['UserPromptSubmit', '--agent', 'codex', '--json'], { session_id: 'codex-1', turn_id: 't1', cwd: '/w/api-gateway', hook_event_name: 'UserPromptSubmit', prompt: 'x', model: 'gpt' });
  assert.strictEqual(p.stdout, '{"continue":true}\n');
  let s = readSessionFile(FLOW(), 'codex-1');
  assert.strictEqual(s.agent, 'codex');
  assert.strictEqual(s.project, 'api-gateway');
  await hookQuiet(FLOW(), FP, ['PermissionRequest', '--agent=codex'], { session_id: 'codex-1', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  s = readSessionFile(FLOW(), 'codex-1');
  assert.strictEqual(s.status, 'needs_input');
  assert.strictEqual(s.reason, 'permission');
  assert.ok(!JSON.stringify(s).includes('rm -rf'));
  await hookQuiet(FLOW(), FP, ['PostToolUse', '--agent', 'codex'], { session_id: 'codex-1' });
  assert.strictEqual(readSessionFile(FLOW(), 'codex-1').status, 'working');
  const dryBefore = readDry(FLOW()).length;
  const st = await hook(FLOW(), FP, ['Stop', '--agent', 'codex', '--json'], { session_id: 'codex-1', stop_hook_active: false, last_assistant_message: null });
  assert.strictEqual(st.stdout, '{}\n');
  s = readSessionFile(FLOW(), 'codex-1');
  assert.strictEqual(s.status, 'done');
  const codexNote = readDry(FLOW()).slice(dryBefore)[0].detail;
  assert.strictEqual(codexNote.title, '干完了 · api-gateway');
  assert.ok(codexNote.body.startsWith('Codex 这一回合用了'), codexNote.body);
  const te = readEvents(FLOW()).filter((e) => e.type === 'turn_end' && e.sid === 'codex-1');
  assert.strictEqual(te[0].d.agent, 'codex');
  // Interrupt：用户自己打断，记为干完、不发通知
  await hookQuiet(FLOW(), FP, ['prompt', '--agent', 'codex'], { session_id: 'codex-1', cwd: '/w/api-gateway' });
  const d2 = readDry(FLOW()).length;
  await hookQuiet(FLOW(), FP, ['Interrupt', '--agent', 'codex'], { session_id: 'codex-1', turn_id: 't2' });
  assert.strictEqual(readSessionFile(FLOW(), 'codex-1').status, 'done');
  assert.strictEqual(readDry(FLOW()).length, d2);
  await hookQuiet(FLOW(), FP, ['SessionEnd', '--agent', 'codex'], { session_id: 'codex-1', reason: 'other' });
  assert.strictEqual(readSessionFile(FLOW(), 'codex-1'), null);
});

test('Cursor：conversation_id、workspace_roots、stop 的 status', async () => {
  const base = { conversation_id: 'cur-1', generation_id: 'g', workspace_roots: ['/Users/x/landing-page'], cursor_version: '1.7' };
  const p = await hook(FLOW(), FP, ['beforeSubmitPrompt', '--agent', 'cursor', '--json'], Object.assign({ hook_event_name: 'beforeSubmitPrompt', prompt: 'hi' }, base));
  assert.strictEqual(p.stdout, '{"continue":true}\n');
  let s = readSessionFile(FLOW(), 'cur-1');
  assert.strictEqual(s.agent, 'cursor');
  assert.strictEqual(s.project, 'landing-page');
  await hookQuiet(FLOW(), FP, ['stop', '--agent', 'cursor'], Object.assign({ hook_event_name: 'stop', status: 'error', loop_count: 0 }, base));
  s = readSessionFile(FLOW(), 'cur-1');
  assert.strictEqual(s.status, 'failed');
  assert.strictEqual(s.reason, 'unknown');
  await hookQuiet(FLOW(), FP, ['beforeSubmitPrompt', '--agent', 'cursor'], base);
  const d = readDry(FLOW()).length;
  await hookQuiet(FLOW(), FP, ['stop', '--agent', 'cursor'], Object.assign({ status: 'aborted' }, base));
  assert.strictEqual(readSessionFile(FLOW(), 'cur-1').status, 'done');
  assert.strictEqual(readDry(FLOW()).length, d, '用户打断不发通知');
  await hookQuiet(FLOW(), FP, ['beforeSubmitPrompt', '--agent', 'cursor'], base);
  await hookQuiet(FLOW(), FP, ['stop', '--agent', 'cursor'], Object.assign({ status: 'completed' }, base));
  s = readSessionFile(FLOW(), 'cur-1');
  assert.strictEqual(s.status, 'done');
  assert.strictEqual(s.turns, 3);
  await hookQuiet(FLOW(), FP, ['sessionEnd', '--agent', 'cursor'], Object.assign({ session_id: 'cur-1', reason: 'completed' }, base));
  assert.strictEqual(readSessionFile(FLOW(), 'cur-1'), null);
});

test('钩子：没有事件参数时读 hook_event_name；未知 agent 记为 other', async () => {
  await hookQuiet(FLOW(), FP, [], { session_id: 'sess-n', cwd: '/x/n', hook_event_name: 'UserPromptSubmit' });
  assert.strictEqual(readSessionFile(FLOW(), 'sess-n').status, 'working');
  await hookQuiet(FLOW(), FP, ['--agent', 'aider'], { session_id: 'sess-n', hook_event_name: 'Stop' });
  const s = readSessionFile(FLOW(), 'sess-n');
  assert.strictEqual(s.status, 'done');
  assert.strictEqual(s.agent, 'other');
});

test('钩子 end：删除会话文件；本插件的斜杠命令不算干活', async () => {
  await hookQuiet(FLOW(), FP, ['end'], { session_id: 'sess-n', reason: 'exit' });
  assert.strictEqual(readSessionFile(FLOW(), 'sess-n'), null);
  await hookQuiet(FLOW(), FP, ['prompt'], { session_id: 'sess-slash', cwd: '/x', prompt: '/agent-waiting-room:config 关闭通知' });
  assert.strictEqual(readSessionFile(FLOW(), 'sess-slash'), null);
});

test('钩子：坏输入、空输入、没有会话 ID 都安静退出', async () => {
  await hookQuiet(FLOW(), FP, ['stop'], 'not json at all {');
  await hookQuiet(FLOW(), FP, ['stop'], '');
  await hookQuiet(FLOW(), FP, ['stop'], '[1,2,3]');
  await hookQuiet(FLOW(), FP, ['stop'], { cwd: '/x' });
  await hookQuiet(FLOW(), FP, ['no-such-event'], { session_id: 'zzz' });
  assert.strictEqual(readSessionFile(FLOW(), 'zzz'), null);
});

test('bin/waiting-room 包装脚本：找到 node 后运行，钩子退出码 0、无输出', async () => {
  const r = await run(['hook', 'prompt'], { sh: true, home: FLOW(), port: FP, input: { session_id: 'sess-sh', cwd: '/x/sh-proj' } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(readSessionFile(FLOW(), 'sess-sh').project, 'sh-proj');
  await run(['hook', 'end'], { sh: true, home: FLOW(), port: FP, input: { session_id: 'sess-sh' } });
});

test('勿扰时段：不发通知，但照常记录回合', async () => {
  const c = await cli(FLOW(), FP, ['config', 'quietHours=' + quietAroundNow()]);
  assert.ok(c.stdout.includes('已保存'), c.stdout);
  const dryBefore = readDry(FLOW()).length;
  const notifyBefore = readEvents(FLOW()).filter((e) => e.type === 'notify').length;
  await hookQuiet(FLOW(), FP, ['prompt'], { session_id: 'sess-q', cwd: '/x/q' });
  await hookQuiet(FLOW(), FP, ['notification'], { session_id: 'sess-q', notification_type: 'permission_prompt' });
  await hookQuiet(FLOW(), FP, ['tool'], { session_id: 'sess-q' });
  await hookQuiet(FLOW(), FP, ['stop'], { session_id: 'sess-q' });
  assert.strictEqual(readDry(FLOW()).length, dryBefore, '勿扰时段内不应有通知');
  assert.strictEqual(readEvents(FLOW()).filter((e) => e.type === 'notify').length, notifyBefore);
  assert.ok(readEvents(FLOW()).some((e) => e.type === 'turn_end' && e.sid === 'sess-q'));
  await cli(FLOW(), FP, ['config', 'quietHours=off']);
  assert.strictEqual(readConfigFile(FLOW()).quietHours, null);
});

test('notify=false：不发通知', async () => {
  await cli(FLOW(), FP, ['config', 'notify=off']);
  const dryBefore = readDry(FLOW()).length;
  await hookQuiet(FLOW(), FP, ['prompt'], { session_id: 'sess-q', cwd: '/x/q' });
  await hookQuiet(FLOW(), FP, ['stop'], { session_id: 'sess-q' });
  assert.strictEqual(readDry(FLOW()).length, dryBefore);
  await cli(FLOW(), FP, ['config', 'notify=on']);
});

test('metrics=false：钩子不写事件，POST /api/event 返回 skipped', async () => {
  await cli(FLOW(), FP, ['config', 'metrics=off']);
  const before = readEvents(FLOW()).length;
  await hookQuiet(FLOW(), FP, ['prompt'], { session_id: 'sess-m', cwd: '/x/m' });
  await hookQuiet(FLOW(), FP, ['stop'], { session_id: 'sess-m' });
  const r = await post(FP, '/api/event', { type: 'game_start', d: { game: 'fly' } });
  assert.deepStrictEqual(r.json, { ok: true, skipped: true });
  assert.strictEqual(readEvents(FLOW()).length, before, '关闭统计后不应写入任何事件');
  assert.strictEqual(readSessionFile(FLOW(), 'sess-m').turns, 1, '会话计数照常');
  const st = await request(FP, { path: '/api/stats' });
  assert.strictEqual(st.json.metricsEnabled, false);
  await cli(FLOW(), FP, ['config', 'metrics=on']);
});

test('命令行 config 改别的设置时不会停掉正在跑的服务（WAITING_ROOM_PORT 生效时）', async () => {
  const h = await health(FP);
  assert.ok(h && h.pid === flowChild.pid, '上面几次 config 之后，flow 服务应该还是最初那个进程');
});

test('POST /api/seen：写入 seenAt，状态不变；坏 sid 400，不存在 404', async () => {
  const r = await post(FP, '/api/seen', { sid: 'sess-a' });
  assert.strictEqual(r.status, 200);
  const s = readSessionFile(FLOW(), 'sess-a');
  assert.strictEqual(s.status, 'done');
  assert.ok(s.seenAt > 0 && r.json.seenAt === s.seenAt);
  assert.strictEqual((await post(FP, '/api/seen', { sid: 'nobody' })).status, 404);
  assert.strictEqual((await post(FP, '/api/seen', {})).status, 400);
  assert.strictEqual((await post(FP, '/api/seen', { sid: '../etc/passwd' })).status, 400);
  // 新回合开始后 seenAt 清空
  await hookQuiet(FLOW(), FP, ['prompt'], { session_id: 'sess-a', cwd: cwdA });
  assert.strictEqual(readSessionFile(FLOW(), 'sess-a').seenAt, null);
  await hookQuiet(FLOW(), FP, ['stop'], { session_id: 'sess-a' });
});

test('/api/state：版本、demo、config 子集、不含令牌、stale 标记', async () => {
  const now = Date.now();
  writeSessionFile(FLOW(), { sessionId: 'stale-1', agent: 'claude-code', project: 'p', status: 'working', updatedAt: now - 11 * 60e3, statusChangedAt: now - 20 * 60e3 });
  writeSessionFile(FLOW(), { sessionId: 'fresh-1', agent: 'codex', project: 'p', status: 'working', updatedAt: now - 5 * 60e3, statusChangedAt: now - 5 * 60e3 });
  writeSessionFile(FLOW(), { sessionId: 'olddone-1', agent: 'codex', project: 'p', status: 'done', updatedAt: now - 60 * 60e3, statusChangedAt: now - 60 * 60e3 });
  const r = await request(FP, { path: '/api/state' });
  assert.strictEqual(r.status, 200);
  const j = r.json;
  assert.strictEqual(j.app, 'agent-waiting-room');
  assert.strictEqual(j.version, L.VERSION);
  assert.strictEqual(j.demo, false);
  assert.deepStrictEqual(Object.keys(j.config).sort(), ['autoOpen', 'delaySeconds', 'lan', 'lang', 'metrics', 'mode', 'notify', 'quietHours']);
  assert.strictEqual(j.config.lang, 'auto');
  assert.strictEqual(j.resolvedLang, 'zh', 'flow 服务的环境里 WAITING_ROOM_LANG=zh');
  assert.ok(readConfigFile(FLOW()).lanToken, '这个测试目录的配置里有令牌');
  assert.ok(!r.body.includes(readConfigFile(FLOW()).lanToken) && !r.body.includes('lanToken'), '/api/state 不能带出令牌');
  assert.deepStrictEqual(j.lanUrls, []);
  const byId = Object.fromEntries(j.sessions.map((s) => [s.sessionId, s]));
  assert.strictEqual(byId['stale-1'].stale, true);
  assert.strictEqual(byId['fresh-1'].stale, false);
  assert.strictEqual(byId['olddone-1'].stale, false);
  assert.ok(j.sessions.every((s) => typeof s.stale === 'boolean'));
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  for (const id of ['stale-1', 'fresh-1', 'olddone-1']) rm(path.join(FLOW(), 'sessions', id + '.json'));
});

// =====================================================================
// 自动打开：both 模式打开并带 ?src=auto；remind、autoOpen=false、勿扰时段都不打开
// =====================================================================
const AP = PORTS.auto;
const AH = () => HOMES.auto;
let autoSeq = 0;
async function promptAndWatch(expectOpen) {
  rm(path.join(AH(), 'hub.json')); // 清掉 5 分钟冷却，避免误判
  const before = readDry(AH()).filter((x) => x.kind === 'open').length;
  const sid = 'auto-' + (++autoSeq);
  await hookQuiet(AH(), AP, ['prompt'], { session_id: sid, cwd: '/x/auto' });
  const opened = await waitFor(() => readDry(AH()).filter((x) => x.kind === 'open').length > before, expectOpen ? 5000 : 2500);
  return { sid, opened: !!opened, entries: readDry(AH()).filter((x) => x.kind === 'open').slice(before) };
}

test('[准备] 启动 auto 服务', async () => {
  writeConfig(AH(), { autoOpen: true, delaySeconds: 0, mode: 'both' });
  await startServer(AH(), AP);
});

test('自动打开：both 模式按时打开，网址带 ?src=auto，记 auto_open', async () => {
  const r = await promptAndWatch(true);
  assert.ok(r.opened, '应该自动打开');
  assert.strictEqual(r.entries[0].detail, 'http://127.0.0.1:' + AP + '/?src=auto');
  assert.ok(await waitFor(() => readEvents(AH()).some((e) => e.type === 'auto_open' && e.sid === r.sid), 2000));
  await hookQuiet(AH(), AP, ['stop'], { session_id: r.sid });
});

test('自动打开：mode=remind 不打开，但照常发通知，并记 mode_change', async () => {
  const c = await cli(AH(), AP, ['config', 'mode=remind']);
  assert.ok(c.stdout.includes('已保存'));
  assert.ok(readEvents(AH()).some((e) => e.type === 'mode_change' && e.d.from === 'both' && e.d.to === 'remind'));
  const r = await promptAndWatch(false);
  assert.strictEqual(r.opened, false, 'remind 模式不应自动打开');
  const d = readDry(AH()).length;
  await hookQuiet(AH(), AP, ['stop'], { session_id: r.sid });
  assert.ok(readDry(AH()).slice(d).some((x) => x.kind === 'notify'), 'remind 模式仍然发通知');
  await cli(AH(), AP, ['config', 'mode=both']);
});

test('自动打开：autoOpen=false 不打开', async () => {
  await cli(AH(), AP, ['config', 'autoOpen=false']);
  const r = await promptAndWatch(false);
  assert.strictEqual(r.opened, false);
  await hookQuiet(AH(), AP, ['stop'], { session_id: r.sid });
  await cli(AH(), AP, ['config', 'autoOpen=true']);
});

test('自动打开：勿扰时段不打开', async () => {
  await cli(AH(), AP, ['config', 'quietHours=' + quietAroundNow()]);
  const r = await promptAndWatch(false);
  assert.strictEqual(r.opened, false);
  await hookQuiet(AH(), AP, ['stop'], { session_id: r.sid });
  await cli(AH(), AP, ['config', 'quietHours=off']);
});

test('自动打开：对照组，恢复设置后又能打开（证明上面不是冷却造成的）', async () => {
  const r = await promptAndWatch(true);
  assert.ok(r.opened);
  await hookQuiet(AH(), AP, ['stop'], { session_id: r.sid });
});

test('自动打开：写 hub.json 的 lastAutoOpenAt 时保留网页上报的 langHint', async () => {
  fs.writeFileSync(path.join(AH(), 'hub.json'), JSON.stringify({ langHint: 'en', langHintAt: 1, lastAutoOpenAt: 0 }));
  const before = readDry(AH()).filter((x) => x.kind === 'open').length;
  await hookQuiet(AH(), AP, ['prompt'], { session_id: 'auto-merge', cwd: '/x/auto' });
  assert.ok(await waitFor(() => readDry(AH()).filter((x) => x.kind === 'open').length > before, 5000), '应该自动打开');
  const marker = readMarker(AH());
  assert.strictEqual(marker.langHint, 'en', 'bg-open 不能把 langHint 覆盖掉');
  assert.ok(marker.lastAutoOpenAt > 0);
  await hookQuiet(AH(), AP, ['stop'], { session_id: 'auto-merge' });
});

// =====================================================================
// HTTP 接口
// =====================================================================
const MP = PORTS.main;
const MH = () => HOMES.main;

test('[准备] 启动 main 服务（启动时清理 30 天前的事件和 2 小时前的会话）', async () => {
  writeConfig(MH(), { autoOpen: false, delaySeconds: 1 });
  fs.mkdirSync(path.join(MH(), 'events'), { recursive: true });
  const oldKey = E.dateKey(E.addDays(Date.now(), -45));
  fs.writeFileSync(path.join(MH(), 'events', oldKey + '.jsonl'), '{"t":1,"type":"hub_open","sid":null,"d":{}}\n');
  const now = Date.now();
  writeSessionFile(MH(), { sessionId: 'ancient', project: 'secret-proj-xyz', status: 'working', updatedAt: now - 3 * 3600e3 });
  writeSessionFile(MH(), { sessionId: 'secret-sid-xyz', project: 'secret-proj-xyz', status: 'done', updatedAt: now, statusChangedAt: now });
  fs.appendFileSync(path.join(MH(), 'events', E.dateKey(now) + '.jsonl'),
    JSON.stringify({ t: now - 1000, type: 'turn_end', sid: 'secret-sid-xyz', d: { agent: 'codex', ms: 61000, outcome: 'done', engaged: true } }) + '\n');
  // main 服务不设 WAITING_ROOM_LANG、系统语言为英文，这样 /api/lang-hint 的效果能在 resolvedLang 里看出来
  await startServer(MH(), MP, { WAITING_ROOM_LANG: null, LC_ALL: 'en_US.UTF-8', LC_MESSAGES: null, LANG: null });
  assert.ok(!fs.existsSync(path.join(MH(), 'events', oldKey + '.jsonl')), '45 天前的事件文件应被清理');
  assert.strictEqual(readSessionFile(MH(), 'ancient'), null, '2 小时没动静的会话应被清理');
  assert.ok(readSessionFile(MH(), 'secret-sid-xyz'));
});

test('GET /：返回网页（片段时包外壳），Cache-Control: no-store', async () => {
  const r = await request(MP, { path: '/' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  assert.ok(/^text\/html/.test(r.headers['content-type']));
  assert.ok(r.headers['content-security-policy']);
  const file = fs.readFileSync(HUB_FILE, 'utf8');
  assert.strictEqual(r.body, W.wrapHub(file));
  assert.ok(/^<!doctype html>/i.test(r.body));
  if (!/^\s*<!doctype/i.test(file)) assert.ok(r.body.startsWith(W.SHELL_HEAD) && r.body.endsWith(W.SHELL_TAIL));
  assert.strictEqual((await request(MP, { method: 'HEAD', path: '/' })).status, 200);
});

test('Host 检查、OPTIONS、错误方法、未知路径', async () => {
  assert.strictEqual((await request(MP, { path: '/', host: 'evil.example:' + MP })).status, 403);
  assert.strictEqual((await request(MP, { path: '/api/state', host: 'localhost:' + MP })).status, 200);
  assert.strictEqual((await post(MP, '/api/event', { type: 'hub_visible' }, { host: 'attacker.test' })).status, 403);
  assert.strictEqual((await request(MP, { method: 'OPTIONS', path: '/api/event', headers: { Origin: 'http://evil.com', 'Access-Control-Request-Method': 'POST' } })).status, 405);
  assert.strictEqual((await request(MP, { method: 'PUT', path: '/api/config' })).status, 405);
  assert.strictEqual((await request(MP, { path: '/api/event' })).status, 405);
  assert.strictEqual((await request(MP, { path: '/nope' })).status, 404);
  const h = await health(MP);
  assert.strictEqual(h.version, L.VERSION);
});

test('POST 的 CSRF 防护：缺 Origin、错 Origin、非 JSON、超过 4 KB 都拒绝', async () => {
  const ok = await post(MP, '/api/event', { type: 'hub_visible' });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.json, { ok: true });
  assert.strictEqual((await post(MP, '/api/event', { type: 'hub_visible' }, { headers: { Origin: 'http://localhost:' + MP } })).status, 200);
  assert.strictEqual((await post(MP, '/api/event', { type: 'hub_visible' }, { headers: { Origin: null } })).status, 403);
  assert.strictEqual((await post(MP, '/api/event', { type: 'hub_visible' }, { headers: { Origin: 'http://evil.com' } })).status, 403);
  assert.strictEqual((await post(MP, '/api/event', { type: 'hub_visible' }, { headers: { Origin: 'http://127.0.0.1:' + (MP + 1) } })).status, 403);
  assert.strictEqual((await post(MP, '/api/event', { type: 'hub_visible' }, { headers: { Origin: 'null' } })).status, 403);
  assert.strictEqual((await post(MP, '/api/event', { type: 'hub_visible' }, { headers: { 'Content-Type': 'text/plain' } })).status, 403);
  assert.strictEqual((await post(MP, '/api/event', { type: 'hub_visible' }, { headers: { 'Content-Type': null } })).status, 403);
  assert.strictEqual((await post(MP, '/api/config', { mode: 'remind' }, { headers: { Origin: 'http://evil.com' } })).status, 403);
  const big = JSON.stringify({ type: 'hub_visible', d: {}, pad: 'x'.repeat(5000) });
  assert.strictEqual((await post(MP, '/api/event', big)).status, 413);
  const edge = JSON.stringify({ type: 'hub_visible', pad: 'x'.repeat(4096 - 40) });
  assert.ok(Buffer.byteLength(edge) <= 4096);
  assert.strictEqual((await post(MP, '/api/event', edge)).status, 200, '4 KB 以内可以');
  assert.strictEqual((await post(MP, '/api/event', '{not json')).status, 400);
  assert.strictEqual((await post(MP, '/api/nope', {})).status, 404);
});

test('POST /api/event：白名单和写入', async () => {
  for (const type of ['turn_end', 'turn_start', 'auto_open', 'notify', 'needs_input', 'mode_change', 'xyz']) {
    const r = await post(MP, '/api/event', { type, d: {} });
    assert.strictEqual(r.status, 400, type + ' 应返回 400');
    assert.ok(r.json && r.json.error);
  }
  assert.strictEqual((await post(MP, '/api/event', { type: 'game_start', d: { game: 'chess' } })).status, 400);
  assert.strictEqual((await post(MP, '/api/event', { type: 'game_start', sid: 'secret-sid-xyz', d: { game: 'fly' } })).status, 200);
  assert.strictEqual((await post(MP, '/api/event', { type: 'game_end', d: { game: 'fly', ms: 42000, score: 9 } })).status, 200);
  assert.strictEqual((await post(MP, '/api/event', { type: 'hub_open', d: { source: 'manual' } })).status, 200);
  const ev = readEvents(MH());
  assert.ok(ev.some((e) => e.type === 'game_start' && e.d.game === 'fly' && e.sid === 'secret-sid-xyz'));
  assert.ok(ev.some((e) => e.type === 'game_end' && e.d.ms === 42000 && e.d.score === 9));
  assert.ok(!ev.some((e) => e.type === 'turn_start'), '网页不能写后端事件');
});

test('POST /api/config：校验、不回令牌、记 mode_change', async () => {
  const r = await post(MP, '/api/config', { mode: 'remind', delaySeconds: 40, quietHours: '23:00-08:00' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.mode, 'remind');
  assert.strictEqual(r.json.delaySeconds, 40);
  assert.deepStrictEqual(r.json.quietHours, { start: '23:00', end: '08:00' });
  assert.ok(!('lanToken' in r.json));
  assert.strictEqual(r.json.port, MP);
  assert.strictEqual(readConfigFile(MH()).mode, 'remind');
  assert.ok(readEvents(MH()).some((e) => e.type === 'mode_change' && e.d.to === 'remind'));
  const bad = [
    { mode: 'games' }, { delaySeconds: 5000 }, { delaySeconds: '20' }, { autoOpen: 'yes' }, { notify: 1 },
    { quietHours: '8pm-9pm' }, { quietHours: { start: '10:00', end: '10:00' } }, { port: 50000 }, { lanToken: 'x'.repeat(30) },
    { lan: 'true' }, { other: 1 }
  ];
  for (const b of bad) {
    const x = await post(MP, '/api/config', b);
    assert.strictEqual(x.status, 400, JSON.stringify(b) + ' 应返回 400');
    assert.ok(typeof x.json.error === 'string' && x.json.error.length > 0);
  }
  assert.strictEqual((await post(MP, '/api/config', [])).status, 400);
  assert.strictEqual(readConfigFile(MH()).delaySeconds, 40, '校验失败不改文件');
  const back = await post(MP, '/api/config', { mode: 'both', quietHours: null, metrics: true, notify: true, autoOpen: false });
  assert.strictEqual(back.status, 200);
  assert.strictEqual(back.json.quietHours, null);
  assert.strictEqual((await post(MP, '/api/config', {})).status, 200);
});

test('POST /api/lang-hint：写 hub.json 的 langHint（不碰 config.json），resolvedLang 跟着变；非法值 400、缺 Origin 403、GET 405', async () => {
  const st0 = (await request(MP, { path: '/api/state' })).json;
  assert.strictEqual(st0.config.lang, 'auto');
  assert.strictEqual(st0.resolvedLang, 'en', 'main 服务没有 WAITING_ROOM_LANG，系统语言是 en');
  const r = await post(MP, '/api/lang-hint', { lang: 'zh' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { ok: true, langHint: 'zh', resolvedLang: 'zh' });
  assert.strictEqual(readMarker(MH()).langHint, 'zh');
  const file = readConfigFile(MH());
  assert.ok(!('langHint' in file) && (file.lang === undefined || file.lang === 'auto'), 'hint 不写进 config.json');
  assert.strictEqual((await request(MP, { path: '/api/state' })).json.resolvedLang, 'zh');
  const zhErr = await post(MP, '/api/config', { mode: 'party' });
  assert.ok(zhErr.json.error.includes('只能是'), '接口报错跟着语言走：' + zhErr.json.error);
  for (const b of [{ lang: 'fr' }, { lang: 'auto' }, { lang: 'ZH' }, { lang: 1 }, {}, [], null, 'zh']) {
    const x = await post(MP, '/api/lang-hint', b);
    assert.strictEqual(x.status, 400, JSON.stringify(b) + ' 应返回 400');
    assert.ok(x.json && typeof x.json.error === 'string' && x.json.error.length > 0);
  }
  assert.strictEqual((await post(MP, '/api/lang-hint', { lang: 'en' }, { headers: { Origin: null } })).status, 403, '缺 Origin');
  assert.strictEqual((await post(MP, '/api/lang-hint', { lang: 'en' }, { headers: { Origin: 'http://evil.com' } })).status, 403, '错 Origin');
  assert.strictEqual((await post(MP, '/api/lang-hint', { lang: 'en' }, { headers: { 'Content-Type': 'text/plain' } })).status, 403, '非 JSON');
  assert.strictEqual((await request(MP, { path: '/api/lang-hint' })).status, 405);
  assert.strictEqual(readMarker(MH()).langHint, 'zh', '失败的请求不改 hint');
  const en = await post(MP, '/api/lang-hint', { lang: 'en' });
  assert.deepStrictEqual(en.json, { ok: true, langHint: 'en', resolvedLang: 'en' });
  const enErr = await post(MP, '/api/config', { mode: 'party' });
  assert.ok(enErr.json.error.includes('must be'), enErr.json.error);
});

test('POST /api/config：lang 校验；明确的 lang 优先于 langHint；改回 auto 后按 hint', async () => {
  await post(MP, '/api/lang-hint', { lang: 'zh' });
  const r = await post(MP, '/api/config', { lang: 'en' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.lang, 'en');
  assert.strictEqual(readConfigFile(MH()).lang, 'en');
  const st = (await request(MP, { path: '/api/state' })).json;
  assert.strictEqual(st.config.lang, 'en');
  assert.strictEqual(st.resolvedLang, 'en', 'config.lang=en 优先于 langHint=zh');
  for (const b of [{ lang: 'fr' }, { lang: '中文' }, { lang: 1 }, { lang: null }, { lang: true }, { lang: 'EN' }]) {
    const x = await post(MP, '/api/config', b);
    assert.strictEqual(x.status, 400, JSON.stringify(b) + ' 应返回 400');
    assert.ok(typeof x.json.error === 'string' && x.json.error.includes('lang must be'), x.json.error);
  }
  assert.strictEqual(readConfigFile(MH()).lang, 'en', '校验失败不改文件');
  const back = await post(MP, '/api/config', { lang: 'auto' });
  assert.strictEqual(back.status, 200);
  assert.strictEqual(back.json.lang, 'auto');
  assert.strictEqual((await request(MP, { path: '/api/state' })).json.resolvedLang, 'zh', '回到 auto 后按 langHint');
  assert.strictEqual(readMarker(MH()).langHint, 'zh', '/api/config 不动 hub.json');
  assert.strictEqual((await post(MP, '/api/config', { lang: 'zh', mode: 'both' })).json.lang, 'zh', '和别的键一起改');
  await post(MP, '/api/config', { lang: 'auto' });
});

test('GET /api/stats：结构、days 参数', async () => {
  const r = await request(MP, { path: '/api/stats' });
  assert.strictEqual(r.status, 200);
  const keys = ['activeDays', 'days', 'firstSeen', 'metricsEnabled', 'mode', 'modeHistory', 'retention', 'totals'];
  assert.deepStrictEqual(Object.keys(r.json).sort(), keys);
  assert.deepStrictEqual(Object.keys(r.json.totals).sort(), ['autoOpens', 'backClicks', 'buckets', 'byAgent', 'engagedOver30s', 'gamesPlayed',
    'medianTurnMs', 'needsInput', 'notifies', 'openRate', 'p90TurnMs', 'playMs', 'relaxCount', 'turns', 'turnsOver30s']);
  assert.strictEqual(r.json.days.length, 14);
  assert.strictEqual(r.json.days[13].date, E.dateKey(Date.now()));
  assert.strictEqual(r.json.totals.turns, 1);
  assert.strictEqual(r.json.totals.engagedOver30s, 1);
  assert.strictEqual(r.json.totals.openRate, 1);
  assert.deepStrictEqual(r.json.totals.byAgent, { codex: 1 });
  assert.strictEqual(r.json.modeHistory.length, 2);
  assert.strictEqual((await request(MP, { path: '/api/stats?days=7' })).json.days.length, 7);
  assert.strictEqual((await request(MP, { path: '/api/stats?days=999' })).json.days.length, 30);
  assert.strictEqual((await request(MP, { path: '/api/stats?days=abc' })).json.days.length, 14);
});

test('GET /api/export：附件下载头，匿名（没有项目名和会话 ID）', async () => {
  const r = await request(MP, { path: '/api/export' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-disposition'], 'attachment; filename="waiting-room-stats.json"');
  assert.ok(!r.body.includes('secret-sid-xyz'), '不能有会话 ID');
  assert.ok(!r.body.includes('secret-proj-xyz'), '不能有项目名');
  assert.ok(!/"sid"|"sessionId"|"project"/.test(r.body));
  assert.strictEqual(r.json.version, L.VERSION);
  assert.strictEqual(r.json.mode, 'both');
  assert.ok(!Number.isNaN(Date.parse(r.json.exportedAt)));
  assert.strictEqual(r.json.totals.turns, 1);
  assert.strictEqual(r.json.days.length, 30);
});

test('/api/state?hub=1 刷新网页在线标记（沿用 v0.1）', async () => {
  const before = (await request(MP, { path: '/api/hub' })).json.lastHubSeenAt;
  await request(MP, { path: '/api/state?hub=1' });
  const after = (await request(MP, { path: '/api/hub' })).json.lastHubSeenAt;
  assert.ok(after > before);
});

// =====================================================================
// 手机访问（局域网）：真实地从本机局域网 IP 发请求，远端地址不是回环
// =====================================================================
const LP = PORTS.lan;
const LH = () => HOMES.lan;
const LAN_IP = W.lanAddresses()[0];
let lanToken = null;
const lanReq = (o) => request(LP, Object.assign({ addr: LAN_IP, host: LAN_IP + ':' + LP }, o));
async function lanReachable() { try { await lanReq({ path: '/api/health' }); return true; } catch (_) { return false; } }

test('[准备] lan=true 启动 lan 服务', async () => {
  if (!LAN_IP) skip('这台电脑没有局域网 IPv4 地址');
  writeConfig(LH(), { lan: true, autoOpen: false });
  await startServer(LH(), LP);
  lanToken = readConfigFile(LH()).lanToken;
  assert.ok(L.validToken(lanToken), '开启 lan 时应自动生成令牌');
});

test('局域网：没令牌 401，错令牌 401，?t= 和 X-WR-Token 放行', async () => {
  if (!LAN_IP) skip('没有局域网地址');
  assert.strictEqual((await lanReq({ path: '/api/state' })).status, 401);
  assert.strictEqual((await lanReq({ path: '/' })).status, 401);
  assert.strictEqual((await lanReq({ path: '/api/state?t=wrong-token-wrong-token-wrong' })).status, 401);
  const ok = await lanReq({ path: '/api/state?t=' + encodeURIComponent(lanToken) });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.json.lanUrls, [], '局域网请求不返回 lanUrls');
  assert.strictEqual(ok.json.config.lan, true);
  assert.strictEqual((await lanReq({ path: '/api/stats', headers: { 'X-WR-Token': lanToken } })).status, 200);
  assert.strictEqual((await lanReq({ path: '/?t=' + encodeURIComponent(lanToken) })).status, 200);
  assert.strictEqual((await lanReq({ path: '/api/state?t=' + lanToken, host: 'evil.example:' + LP })).status, 403, 'Host 检查先于令牌');
});

test('局域网：本机请求拿到 lanUrls（含令牌），config 里不含令牌', async () => {
  if (!LAN_IP) skip('没有局域网地址');
  const r = await request(LP, { path: '/api/state' });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.lanUrls.includes('http://' + LAN_IP + ':' + LP + '/?t=' + lanToken));
  assert.ok(!('lanToken' in r.json.config));
});

test('局域网：POST 也要令牌和同源；lan 只能从本机改', async () => {
  if (!LAN_IP) skip('没有局域网地址');
  const origin = 'http://' + LAN_IP + ':' + LP;
  const lanPost = (p, body, headers) => post(LP, p, body, { addr: LAN_IP, host: LAN_IP + ':' + LP, headers: Object.assign({ Origin: origin }, headers || {}) });
  assert.strictEqual((await lanPost('/api/event', { type: 'hub_visible' })).status, 401);
  assert.strictEqual((await lanPost('/api/event', { type: 'hub_visible' }, { 'X-WR-Token': lanToken })).status, 200);
  assert.strictEqual((await lanPost('/api/event', { type: 'hub_visible' }, { 'X-WR-Token': lanToken, Origin: 'http://evil.com' })).status, 403);
  assert.strictEqual((await lanPost('/api/config', { notify: false }, { 'X-WR-Token': lanToken })).status, 200);
  const deny = await lanPost('/api/config', { lan: false }, { 'X-WR-Token': lanToken });
  assert.strictEqual(deny.status, 403);
  assert.strictEqual(readConfigFile(LH()).lan, true);
});

test('局域网：从本机关掉 lan 后改为只听 127.0.0.1，再打开又能访问', async () => {
  if (!LAN_IP) skip('没有局域网地址');
  const off = await post(LP, '/api/config', { lan: false });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.json.lan, false);
  assert.ok(await waitFor(async () => !(await lanReachable()), 3000), '关闭后局域网应连不上');
  const st = await waitFor(async () => { try { const x = await request(LP, { path: '/api/state' }); return x.status === 200 && x.json; } catch (_) { return null; } }, 3000);
  assert.ok(st, '本机仍能访问');
  assert.strictEqual(st.config.lan, false);
  assert.deepStrictEqual(st.lanUrls, []);
  const on = await post(LP, '/api/config', { lan: true });
  assert.strictEqual(on.status, 200);
  assert.ok(await waitFor(lanReachable, 3000), '重新打开后局域网应能连上');
  assert.strictEqual(readConfigFile(LH()).lanToken, lanToken, '令牌不变');
});

test('局域网：命令行改 lan，服务几秒内跟着重新监听', async () => {
  if (!LAN_IP) skip('没有局域网地址');
  const c = await cli(LH(), LP, ['config', 'lan=off']);
  assert.ok(c.stdout.includes('手机访问已关闭'));
  assert.ok(await waitFor(async () => !(await lanReachable()), 5000), '命令行关闭后局域网应连不上');
  const c2 = await cli(LH(), LP, ['config', 'lan=on']);
  assert.ok(c2.stdout.includes('手机访问已开启'));
  assert.ok(!c2.stdout.includes(lanToken), '命令行输出不能显示令牌');
  assert.ok(await waitFor(lanReachable, 5000));
  await cli(LH(), LP, ['config', 'lan=off']);
  assert.ok(await waitFor(async () => !(await lanReachable()), 5000));
});

test('lan=false 的服务连局域网地址连不上（只听 127.0.0.1）', async () => {
  if (!LAN_IP) skip('没有局域网地址');
  let refused = false;
  try { await request(MP, { addr: LAN_IP, host: LAN_IP + ':' + MP, path: '/api/health' }); } catch (_) { refused = true; }
  assert.ok(refused);
});

// =====================================================================
// 命令行 config / status
// =====================================================================
const CH = () => HOMES.cli;
const CP = PORTS.cli;

test('命令行 config：新键的读写', async () => {
  const show = await cli(CH(), CP, ['config']);
  for (const k of ['mode', 'autoOpen', 'delaySeconds', 'notify', 'quietHours', 'metrics', 'lan', 'lanToken', 'lang', 'port']) assert.ok(show.stdout.includes(k), '应列出 ' + k);
  await cli(CH(), CP, ['config', 'quietHours=23:00-08:00']);
  assert.deepStrictEqual(readConfigFile(CH()).quietHours, { start: '23:00', end: '08:00' });
  await cli(CH(), CP, ['config', 'quietHours=off']);
  assert.strictEqual(readConfigFile(CH()).quietHours, null);
  await cli(CH(), CP, ['config', 'mode=remind', 'metrics=off', 'delay=45']);
  let f = readConfigFile(CH());
  assert.strictEqual(f.mode, 'remind');
  assert.strictEqual(f.metrics, false);
  assert.strictEqual(f.delaySeconds, 45);
  assert.ok(!readEvents(CH()).some((e) => e.type === 'mode_change'), 'metrics=off 时 mode_change 也不写');
  await cli(CH(), CP, ['config', 'metrics=on', 'mode=both']);
  assert.ok(readEvents(CH()).some((e) => e.type === 'mode_change' && e.d.from === 'remind' && e.d.to === 'both'));
  const on = await cli(CH(), CP, ['config', 'lan=on']);
  f = readConfigFile(CH());
  assert.strictEqual(f.lan, true);
  assert.ok(L.validToken(f.lanToken));
  assert.ok(!on.stdout.includes(f.lanToken), '不在命令行输出里显示令牌');
  await cli(CH(), CP, ['config', 'lanToken=reset']);
  const f2 = readConfigFile(CH());
  assert.ok(L.validToken(f2.lanToken) && f2.lanToken !== f.lanToken, 'reset 后换新令牌');
  await cli(CH(), CP, ['config', 'lan=off']);
  assert.strictEqual(readConfigFile(CH()).lan, false);
});

test('命令行 config：非法值不保存', async () => {
  const before = fs.readFileSync(path.join(CH(), 'config.json'), 'utf8');
  for (const arg of ['mode=party', 'quietHours=25:00-01:00', 'quietHours=23:00', 'delaySeconds=9999', 'lanToken=abc', 'foo=1', 'metrics=maybe', 'port=80', 'novalue']) {
    const r = await cli(CH(), CP, ['config', arg]);
    assert.ok(r.stdout.includes('没有保存'), arg + ' 应被拒绝：' + r.stdout);
  }
  assert.strictEqual(fs.readFileSync(path.join(CH(), 'config.json'), 'utf8'), before);
});

test('命令行 config：lang 的键别名（language / 语言）和值别名（中文 / English / 英文 / 自动）', async () => {
  const modeChanges = readEvents(CH()).filter((e) => e.type === 'mode_change').length;
  for (const [arg, want] of [['lang=en', 'en'], ['language=中文', 'zh'], ['语言=English', 'en'], ['lang=英文', 'en'], ['lang=自动', 'auto'], ['LANG=ZH', 'zh'], ['lang=auto', 'auto']]) {
    const r = await cli(CH(), CP, ['config', arg]);
    assert.strictEqual(r.code, 0, arg);
    assert.strictEqual(readConfigFile(CH()).lang, want, arg);
  }
  assert.strictEqual(readEvents(CH()).filter((e) => e.type === 'mode_change').length, modeChanges, '改 lang 不产生 mode_change');
});

test('命令行 config：输出语言——描述、保存确认、「没有保存」都双语；确认信息用改完后的语言', async () => {
  const en = await cli(CH(), CP, ['config'], EN);
  assert.ok(en.stdout.startsWith('Waiting Room settings'), en.stdout);
  assert.ok(en.stdout.includes('  lang         = auto'), en.stdout);
  assert.ok(!HAS_CJK.test(en.stdout.replace(/\(file: [^)]*\)/, '').replace(/\(中文\)/, '')), '英文输出不应含中文：\n' + en.stdout);
  const zh = await cli(CH(), CP, ['config']);
  assert.ok(zh.stdout.startsWith('「等一下」当前设置'), zh.stdout);
  const toEn = await cli(CH(), CP, ['config', 'lang=en']);
  assert.ok(toEn.stdout.startsWith('Saved.\nWaiting Room settings'), toEn.stdout);
  assert.ok(toEn.stdout.includes('currently resolves to en'));
  const toZh = await cli(CH(), CP, ['config', 'lang=中文'], EN);
  assert.ok(toZh.stdout.startsWith('已保存。\n「等一下」当前设置'), toZh.stdout);
  const before = fs.readFileSync(path.join(CH(), 'config.json'), 'utf8');
  const badZh = await cli(CH(), CP, ['config', 'lang=fr']);
  assert.ok(badZh.stdout.includes('没有保存') && badZh.stdout.includes('lang 只能是'), badZh.stdout);
  const badEn = await cli(CH(), CP, ['config', 'lang=fr', 'foo=1', 'novalue', 'mode=party'], EN);
  // 文件里 lang=zh 优先于环境变量，所以这条报错是中文；下面把文件改成 auto 再看英文
  assert.ok(badEn.stdout.startsWith('没有保存'), badEn.stdout);
  assert.strictEqual(fs.readFileSync(path.join(CH(), 'config.json'), 'utf8'), before, '非法值不保存');
  await cli(CH(), CP, ['config', 'lang=auto']);
  const badEn2 = await cli(CH(), CP, ['config', 'lang=fr', 'foo=1', 'novalue', 'mode=party'], EN);
  assert.ok(badEn2.stdout.startsWith('Not saved:'), badEn2.stdout);
  for (const s of ['lang must be auto', 'no setting called "foo"', 'expected key=value', 'mode must be both']) assert.ok(badEn2.stdout.includes(s), '应包含 ' + s + '：' + badEn2.stdout);
  assert.strictEqual(readConfigFile(CH()).lang, 'auto');
  const lanOn = await cli(CH(), CP, ['config', 'lan=on'], EN);
  assert.ok(lanOn.stdout.includes('Phone access is on'), lanOn.stdout);
  const lanOff = await cli(CH(), CP, ['config', 'lan=off'], EN);
  assert.ok(lanOff.stdout.includes('Phone access is off'), lanOff.stdout);
});

test('命令行 status：列出模式和会话（中英）', async () => {
  writeSessionFile(CH(), { sessionId: 's1', agent: 'codex', project: 'api-gateway', status: 'failed', updatedAt: Date.now(), statusChangedAt: Date.now() });
  const r = await cli(CH(), CP, ['status']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('Codex · api-gateway — 出错了'), r.stdout);
  assert.ok(r.stdout.includes('模式：') && r.stdout.includes('语言：auto (zh)'), r.stdout);
  const e = await cli(CH(), CP, ['status'], EN);
  assert.ok(e.stdout.includes('Codex · api-gateway — Failed'), e.stdout);
  assert.ok(e.stdout.includes('Mode: Remind + games') && e.stdout.includes('Language: auto (en)'), e.stdout);
  assert.ok(!HAS_CJK.test(e.stdout.replace(/Data folder: .*/, '')), e.stdout);
  const stop = await cli(CH(), CP, ['stop'], EN);
  assert.strictEqual(stop.stdout.trim(), 'The local server is not running.');
  const usage = await cli(CH(), CP, ['nonsense'], EN);
  assert.ok(usage.stdout.startsWith('Usage: waiting-room'), usage.stdout);
});

// =====================================================================
// v0.1 行为：端口被占、空闲退出
// =====================================================================
test('端口被别的程序占用：服务退出码 3，open 命令给出提示', async () => {
  const foreign = http.createServer((req, res) => { res.end('hello'); });
  await new Promise((r) => foreign.listen(PORTS.foreign, '127.0.0.1', r));
  try {
    const child = spawnServer(HOMES.foreign, PORTS.foreign);
    const r = await Promise.race([child.exited, sleep(5000).then(() => null)]);
    assert.ok(r, '服务应自行退出');
    assert.strictEqual(r.code, 3);
    const o = await cli(HOMES.foreign, PORTS.foreign, ['open']);
    assert.ok(o.stdout.includes('被别的程序占用'), o.stdout);
    const oe = await cli(HOMES.foreign, PORTS.foreign, ['open'], EN);
    assert.ok(oe.stdout.includes('port ' + PORTS.foreign + ' is in use by another program'), oe.stdout);
    assert.ok(!readDry(HOMES.foreign).some((x) => x.kind === 'open'), '端口被占时不打开浏览器');
  } finally {
    await new Promise((r) => foreign.close(r));
  }
});

// v0.3.1：插件升级后，旧版本的服务还在端口上（网页开着就不会空闲退出），钩子应把它换成新版本
test('升级后旧版本服务仍在运行：open 会停掉它并启动当前版本', async () => {
  const fakeSrc = "const http=require('http');http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({app:'" + L.APP + "',version:'0.0.1',pid:process.pid,port:" + PORTS.stale + "}))}).listen(" + PORTS.stale + ",'127.0.0.1');setInterval(()=>{},1000)";
  const fake = spawn(process.execPath, ['-e', fakeSrc], { stdio: 'ignore' });
  const fakeExited = new Promise((r) => fake.on('exit', (code, sig) => r({ code, sig })));
  try {
    const up = await waitFor(async () => { const h = await health(PORTS.stale); return h && h.version === '0.0.1'; }, 3000);
    assert.ok(up, '假的旧版本服务应先起来');
    const o = await cli(HOMES.stale, PORTS.stale, ['open']);
    assert.strictEqual(o.code, 0, o.stdout + o.stderr);
    const swapped = await waitFor(async () => { const h = await health(PORTS.stale); return h && h.version === L.VERSION && h.pid !== fake.pid; }, 6000);
    assert.ok(swapped, '端口上应换成当前版本的服务');
    const gone = await Promise.race([fakeExited, sleep(2000).then(() => null)]);
    assert.ok(gone, '旧服务进程应已退出');
    assert.ok(readDry(HOMES.stale).some((x) => x.kind === 'open'), '替换后照常打开网页');
  } finally {
    try { fake.kill('SIGKILL'); } catch (_) {}
    await cli(HOMES.stale, PORTS.stale, ['stop']);
  }
});

test('空闲退出：没有会话、没有请求时自动退出', async () => {
  const child = spawnServer(HOMES.idle, PORTS.idle, { WAITING_ROOM_IDLE_MINUTES: '0.05' });
  assert.ok(await waitFor(async () => !!(await health(PORTS.idle)), 4000), '服务应先启动');
  const r = await Promise.race([child.exited, sleep(12000).then(() => null)]);
  assert.ok(r, '应在空闲约 3 秒后退出');
  assert.strictEqual(r.code, 0);
});

test('所有钩子都在 1 秒内返回', () => {
  assert.ok(hookTimes.length > 30, '应跑过足够多的钩子');
  const slow = hookTimes.filter((h) => h.ms >= 1000);
  assert.deepStrictEqual(slow, [], '慢钩子：' + JSON.stringify(slow));
  const max = Math.max.apply(null, hookTimes.map((h) => h.ms));
  console.log('      （钩子 ' + hookTimes.length + ' 次，最慢 ' + max + ' ms）');
});

// =====================================================================
async function main() {
  console.log('「等一下」后端测试 · 临时目录 ' + RUN_DIR);
  for (const t of tests) {
    try {
      await t.fn();
      results.pass++;
      console.log('  PASS  ' + t.name);
    } catch (e) {
      if (e instanceof Skip) { results.skip++; console.log('  SKIP  ' + t.name + '（' + e.message + '）'); continue; }
      results.fail++;
      results.failures.push(t.name);
      console.log('  FAIL  ' + t.name + '\n        ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n        '));
    }
  }
  const stray = await cleanup();
  if (stray.length) { results.fail++; results.failures.push('收尾：仍有服务在跑 ' + stray.join(', ')); console.log('  FAIL  收尾：仍有服务在跑 ' + stray.join(', ')); }
  else console.log('  PASS  收尾：测试启动的服务都已停止');
  if (process.env.WR_TEST_KEEP !== '1') { try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (_) {} }
  console.log('\nSUMMARY: ' + results.pass + ' passed, ' + results.fail + ' failed, ' + results.skip + ' skipped');
  if (results.failures.length) console.log('失败项：\n  - ' + results.failures.join('\n  - '));
  process.exit(results.fail ? 1 : 0);
}

process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
