'use strict';
// 「等一下」本地服务的安全检查和页面外壳：Host 检查、局域网令牌、写接口的 CSRF 防护、请求体上限。
// 都是不依赖服务状态的小函数，方便单独测试。

const os = require('os');
const crypto = require('crypto');

const BODY_LIMIT = 4 * 1024;
const SHELL_HEAD = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>';
const SHELL_TAIL = '</body></html>';

// hub.html 是片段，发送时包一层 doctype/head/body。已经是完整文档的（旧版文件）原样发送。
function wrapHub(fragment) {
  const s = String(fragment);
  if (/^\s*(<!doctype|<html)/i.test(s)) return s;
  return SHELL_HEAD + s + SHELL_TAIL;
}

// 127.0.0.0/8、::1，以及 IPv4 映射写法 ::ffff:127.x.x.x
function isLoopback(addr) {
  let a = String(addr || '');
  if (a.startsWith('::ffff:')) a = a.slice(7);
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

// 本机的局域网 IPv4 地址（去掉回环和 169.254 自分配地址）
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (v4 && !a.internal && !/^169\.254\./.test(a.address) && !out.includes(a.address)) out.push(a.address);
    }
  }
  return out;
}

function allowedHosts(port, cfg) {
  const hosts = new Set(['127.0.0.1:' + port, 'localhost:' + port]);
  if (cfg && cfg.lan) for (const ip of lanAddresses()) hosts.add(ip + ':' + port);
  return hosts;
}
function allowedOrigins(port, cfg) {
  return new Set(Array.from(allowedHosts(port, cfg), (h) => 'http://' + h));
}

function lanUrls(port, cfg) {
  if (!cfg || !cfg.lan || !cfg.lanToken) return [];
  return lanAddresses().map((ip) => 'http://' + ip + ':' + port + '/?t=' + encodeURIComponent(cfg.lanToken));
}

// 常量时间比较，避免按字符猜令牌
function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected.length < 24) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 所有请求的入口检查。req 只用到 headers 和 socket.remoteAddress。返回 null 表示放行，否则 { status, error }
function checkAccess(req, url, port, cfg) {
  const host = String((req.headers && req.headers.host) || '').toLowerCase();
  if (!allowedHosts(port, cfg).has(host)) return { status: 403, error: 'forbidden' };
  const remote = req.socket && req.socket.remoteAddress;
  if (isLoopback(remote)) return null;
  if (!cfg || !cfg.lan) return { status: 403, error: 'forbidden' };
  const given = (url && url.searchParams.get('t')) || (req.headers && req.headers['x-wr-token']);
  if (!tokenMatches(given, cfg.lanToken)) return { status: 401, error: 'token required' };
  return null;
}

// 写接口：Content-Type 必须是 JSON，Origin 必须是本服务自己的来源
function checkPost(req, port, cfg) {
  const type = String((req.headers && req.headers['content-type']) || '').trim().toLowerCase();
  if (!type.startsWith('application/json')) return { status: 403, error: 'content-type must be application/json' };
  const origin = String((req.headers && req.headers.origin) || '').toLowerCase();
  if (!origin || !allowedOrigins(port, cfg).has(origin)) return { status: 403, error: 'bad origin' };
  return null;
}

// 读请求体，超过上限回调 'too-large'
function readBody(req, limit, cb) {
  const max = limit || BODY_LIMIT;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) { req.resume(); return cb('too-large'); }
  const chunks = [];
  let size = 0;
  let done = false;
  req.on('data', (c) => {
    if (done) return;
    size += c.length;
    if (size > max) { done = true; req.resume(); return cb('too-large'); }
    chunks.push(c);
  });
  req.on('end', () => { if (!done) { done = true; cb(null, Buffer.concat(chunks).toString('utf8')); } });
  req.on('error', () => { if (!done) { done = true; cb('error'); } });
}

module.exports = {
  BODY_LIMIT, SHELL_HEAD, SHELL_TAIL, wrapHub,
  isLoopback, lanAddresses, allowedHosts, allowedOrigins, lanUrls, tokenMatches,
  checkAccess, checkPost, readBody
};
