'use strict';
// 「等一下」后端文案表：系统通知、命令行输出、设置校验和接口报错的中英两套文字。
// 用法：t(lang, key, vars)。lang 为 'zh' 或 'en'；vars 里的 {name} 会替换进文案。
// 这个文件不依赖 lib.js，避免循环引用。网页的文案在 public/hub.html 里自己维护。

const LANGS = ['zh', 'en'];               // 解析后的语言
const LANG_VALUES = ['auto', 'zh', 'en']; // 配置项 lang 的合法取值

const STR = {
  zh: {
    // ---- 系统通知 ----
    'notify.done.title': '干完了 · {project}',
    'notify.done.body': '{who} 这一回合用了 {duration}，回去看看',
    'notify.done.bodyNoTime': '{who} 干完了，回去看看',
    'notify.needs_input.title': '等你确认 · {project}',
    'notify.needs_input.permission': '{who} 在等你批准一个操作',
    'notify.needs_input.question': '{who} 有问题要问你',
    'notify.needs_input.idle': '{who} 停下来等你了',
    'notify.needs_input.other': '{who} 在等你',
    'notify.failed.title': '出错了 · {project}',
    'notify.failed.body': '{who} 出错停下了（{error}），回去看看',
    'notify.failed.bodyUnknown': '{who} 出错停下了，回去看看',
    // StopFailure 的错误类型 → 用户能看懂的短语；表里没有的直接显示原始代码
    'error.rate_limit': '触发了速率限制',
    'error.overloaded': '服务繁忙',
    'error.authentication_failed': '登录失效',
    'error.billing_error': '账单问题',
    'error.server_error': '服务端错误',
    'error.max_output_tokens': '输出超长',
    'error.invalid_request': '请求无效',
    'error.model_not_found': '找不到模型',

    // ---- 命令行：open ----
    'cli.open.portInUse': '打不开：端口 {port} 被别的程序占用了。可以运行 /agent-waiting-room:config port=47824 把端口改成别的数字。',
    'cli.open.serverFailed': '本地服务没能启动，详情见日志：{log}',
    'cli.open.opened': '等候室已在浏览器打开：{url}',

    // ---- 命令行：config ----
    'cli.config.title': '「等一下」当前设置（文件：{file}）',
    'cli.config.mode': 'both = 提醒 + 小游戏；remind = 只要提醒（不自动打开网页，只发通知）',
    'cli.config.autoOpen': 'agent 干活超过 delaySeconds 秒后，自动在浏览器打开等候室（mode=remind 时不生效）',
    'cli.config.delaySeconds': '自动打开前等多少秒（0–3600）',
    'cli.config.notify': '干完 / 等你确认 / 出错时弹系统通知',
    'cli.config.quietHours': '勿扰时段，例如 23:00-08:00；这段时间不自动打开网页，也不弹通知',
    'cli.config.quietNow': '（现在正处于勿扰时段）',
    'cli.config.metrics': '在这台电脑上记录使用统计（不上传），等候室「我的数据」页会用到',
    'cli.config.lan': '手机访问：开启后同一局域网的手机凭令牌访问等候室',
    'cli.config.lanToken': '手机访问令牌；写 lanToken=reset 重新生成，旧链接随即失效',
    'cli.config.tokenSet': '已生成（只存在这台电脑上）',
    'cli.config.tokenUnset': '未生成',
    'cli.config.lang': '通知和命令输出的语言：auto / zh / en（auto = 跟网页一致，没有网页时看系统语言；当前解析为 {resolved}）',
    'cli.config.port': '本地网页端口（1024–65535），网址 {url}',
    'cli.config.examples': '修改示例：waiting-room config mode=remind quietHours=23:00-08:00 lang=en',
    'cli.config.badArg': '看不懂「{arg}」，格式应为 键=值',
    'cli.config.notSaved': '没有保存：',
    'cli.config.saved': '已保存。',
    'cli.config.portStopped': '已停止旧端口 {port} 上的服务，下次使用时会在新端口启动。',
    'cli.config.lanOn': '手机访问已开启：本地服务会在几秒内改为对局域网开放。手机网址（含令牌）在这台电脑上打开等候室后，在「设置」页里查看。只在可信的家庭或公司网络里开启。',
    'cli.config.lanOff': '手机访问已关闭：本地服务会在几秒内改回只对这台电脑开放。',

    // ---- 设置校验（命令行和网页接口共用）----
    'cfg.mode': 'mode 只能是 both（提醒 + 小游戏）或 remind（只要提醒）',
    'cfg.bool': '{key} 只能是 true 或 false',
    'cfg.delaySeconds': 'delaySeconds 要在 0 到 3600 之间',
    'cfg.quietHours': 'quietHours 要写成 23:00-08:00 这样的格式，或 off 关闭；开始和结束不能相同',
    'cfg.port': 'port 要是 1024 到 65535 之间的整数',
    'cfg.lanToken': 'lanToken 只能写 lanToken=reset，重新随机生成',
    'cfg.lang': 'lang 只能是 auto（自动）、zh（中文）或 en（English）',
    'cfg.unknownKey': '没有「{key}」这个设置项',

    // ---- 命令行：status / stop / 用法 ----
    'cli.status.running': '运行中（pid {pid}）',
    'cli.status.foreign': '端口被别的程序占用',
    'cli.status.notRunning': '未运行（下次 agent 干活时会自动启动）',
    'cli.status.server': '本地服务：{server} · {url}',
    'cli.status.summary': '模式：{mode} · 勿扰时段：{quiet} · 手机访问：{lan} · 语言：{lang}',
    'cli.status.modeBoth': '提醒 + 小游戏',
    'cli.status.modeRemind': '只要提醒',
    'cli.status.unset': '未设置',
    'cli.status.on': '开启',
    'cli.status.off': '关闭',
    'cli.status.dataDir': '数据目录：{dir}',
    'cli.status.noSessions': '会话：暂无',
    'cli.status.stale': '（超过 10 分钟没动静，可能已经停了）',
    'status.working': '工作中',
    'status.needs_input': '等你确认',
    'status.done': '干完了',
    'status.failed': '出错了',
    'cli.stop.stopped': '本地服务已停止。',
    'cli.stop.notRunning': '本地服务没有在运行。',
    'cli.usage': '用法：waiting-room <open|config|status|stop>',
    'cli.error': '出错了：{message}',

    // ---- 本地服务的接口报错 ----
    'api.bodyObject': '请求体要是 JSON 对象',
    'api.keyNotEditable': '网页上不能修改「{key}」',
    'api.lanLocalOnly': '手机访问只能在这台电脑上开关',
    'api.tooLarge': '请求体超过 4 KB',
    'api.readFailed': '请求体读取失败',
    'api.badJSON': '请求体不是合法 JSON',
    'api.internal': '服务内部错误',
    'api.badSid': 'sid 不合法',
    'api.noSession': '没有这个会话',
    'api.badLangHint': 'lang 只能是 zh 或 en'
  },

  en: {
    // ---- System notifications ----
    'notify.done.title': 'Done · {project}',
    'notify.done.body': '{who} worked for {duration}. Back to the terminal.',
    'notify.done.bodyNoTime': '{who} has finished. Back to the terminal.',
    'notify.needs_input.title': 'Needs your input · {project}',
    'notify.needs_input.permission': '{who} is asking for your permission to continue.',
    'notify.needs_input.question': '{who} has a question for you.',
    'notify.needs_input.idle': '{who} has paused and is waiting for you.',
    'notify.needs_input.other': '{who} is waiting for you.',
    'notify.failed.title': 'Failed · {project}',
    'notify.failed.body': '{who} stopped with an error ({error}). Back to the terminal.',
    'notify.failed.bodyUnknown': '{who} stopped with an error. Back to the terminal.',
    'error.rate_limit': 'rate limit',
    'error.overloaded': 'server overloaded',
    'error.authentication_failed': 'authentication failed',
    'error.billing_error': 'billing problem',
    'error.server_error': 'server error',
    'error.max_output_tokens': 'output too long',
    'error.invalid_request': 'invalid request',
    'error.model_not_found': 'model not found',

    // ---- CLI: open ----
    'cli.open.portInUse': 'Cannot open: port {port} is in use by another program. Run /agent-waiting-room:config port=47824 to switch to a different port.',
    'cli.open.serverFailed': 'The local server did not start. See the log: {log}',
    'cli.open.opened': 'Waiting Room opened in your browser: {url}',

    // ---- CLI: config ----
    'cli.config.title': 'Waiting Room settings (file: {file})',
    'cli.config.mode': 'both = remind + games; remind = remind only (never auto-opens the page, notifications only)',
    'cli.config.autoOpen': 'open the waiting room in your browser once an agent has worked longer than delaySeconds (ignored when mode=remind)',
    'cli.config.delaySeconds': 'seconds to wait before auto-opening (0–3600)',
    'cli.config.notify': 'system notification when an agent finishes, needs your input, or fails',
    'cli.config.quietHours': 'quiet hours, e.g. 23:00-08:00: no auto-open and no notifications in that window',
    'cli.config.quietNow': ' (quiet hours are active right now)',
    'cli.config.metrics': 'keep usage stats on this computer only (never uploaded); the "My Data" page reads them',
    'cli.config.lan': 'phone access: phones on the same Wi-Fi can open the waiting room with a token',
    'cli.config.lanToken': 'phone-access token; lanToken=reset generates a new one and old links stop working',
    'cli.config.tokenSet': 'generated (stored on this computer only)',
    'cli.config.tokenUnset': 'not generated',
    'cli.config.lang': 'language for notifications and command output: auto / zh / en (auto = follow the web page, else the system locale; currently resolves to {resolved})',
    'cli.config.port': 'local web port (1024–65535), URL {url}',
    'cli.config.examples': 'Examples: waiting-room config mode=remind quietHours=23:00-08:00 lang=en',
    'cli.config.badArg': 'Cannot read "{arg}"; expected key=value',
    'cli.config.notSaved': 'Not saved:',
    'cli.config.saved': 'Saved.',
    'cli.config.portStopped': 'Stopped the server on the old port {port}; it will start on the new port next time.',
    'cli.config.lanOn': 'Phone access is on: within a few seconds the local server opens to your LAN. Open the waiting room on this computer and find the phone URL (with its token) on the Settings page. Only turn this on in a trusted home or office network.',
    'cli.config.lanOff': 'Phone access is off: within a few seconds the local server goes back to this computer only.',

    // ---- Config validation (shared by CLI and web API) ----
    'cfg.mode': 'mode must be both (remind + games) or remind (remind only)',
    'cfg.bool': '{key} must be true or false',
    'cfg.delaySeconds': 'delaySeconds must be between 0 and 3600',
    'cfg.quietHours': 'quietHours must look like 23:00-08:00, or off to disable; start and end cannot be the same',
    'cfg.port': 'port must be an integer between 1024 and 65535',
    'cfg.lanToken': 'lanToken only accepts lanToken=reset, which generates a new random token',
    'cfg.lang': 'lang must be auto, zh (中文) or en (English)',
    'cfg.unknownKey': 'There is no setting called "{key}"',

    // ---- CLI: status / stop / usage ----
    'cli.status.running': 'running (pid {pid})',
    'cli.status.foreign': 'port in use by another program',
    'cli.status.notRunning': 'not running (starts automatically the next time an agent works)',
    'cli.status.server': 'Local server: {server} · {url}',
    'cli.status.summary': 'Mode: {mode} · Quiet hours: {quiet} · Phone access: {lan} · Language: {lang}',
    'cli.status.modeBoth': 'Remind + games',
    'cli.status.modeRemind': 'Remind only',
    'cli.status.unset': 'not set',
    'cli.status.on': 'on',
    'cli.status.off': 'off',
    'cli.status.dataDir': 'Data folder: {dir}',
    'cli.status.noSessions': 'Sessions: none',
    'cli.status.stale': ' (no activity for 10+ minutes, probably ended)',
    'status.working': 'Working',
    'status.needs_input': 'Needs you',
    'status.done': 'Done',
    'status.failed': 'Failed',
    'cli.stop.stopped': 'Local server stopped.',
    'cli.stop.notRunning': 'The local server is not running.',
    'cli.usage': 'Usage: waiting-room <open|config|status|stop>',
    'cli.error': 'Error: {message}',

    // ---- Local server API errors ----
    'api.bodyObject': 'Request body must be a JSON object',
    'api.keyNotEditable': '"{key}" cannot be changed from the web page',
    'api.lanLocalOnly': 'Phone access can only be switched from this computer',
    'api.tooLarge': 'Request body exceeds 4 KB',
    'api.readFailed': 'Could not read the request body',
    'api.badJSON': 'Request body is not valid JSON',
    'api.internal': 'Internal server error',
    'api.badSid': 'Invalid sid',
    'api.noSession': 'No such session',
    'api.badLangHint': 'lang must be zh or en'
  }
};

// 取文案。找不到 key 时退回英文表，再找不到就原样返回 key（不抛错，通知和命令行都不能因为缺文案挂掉）
function t(lang, key, vars) {
  const table = STR[lang] || STR.en;
  let s = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : STR.en[key];
  if (typeof s !== 'string') return key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

// 回合用时：zh「1 分 12 秒」「1 小时 3 分」；en「1m 12s」「1h 3m」
function formatDuration(lang, ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (lang === 'zh') {
    if (h) return h + ' 小时 ' + m + ' 分';
    if (m) return m + ' 分 ' + s + ' 秒';
    return s + ' 秒';
  }
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + s + 's';
  return s + 's';
}

// StopFailure 的错误类型 → 短语；表里没有的返回原始代码；unknown 返回 null（正文不提原因）
function errorLabel(lang, code) {
  const c = String(code || '');
  if (!c || c === 'unknown') return null;
  const key = 'error.' + c;
  const table = STR[lang] || STR.en;
  return table[key] || STR.en[key] || c;
}

module.exports = { LANGS, LANG_VALUES, STR, t, formatDuration, errorLabel };
