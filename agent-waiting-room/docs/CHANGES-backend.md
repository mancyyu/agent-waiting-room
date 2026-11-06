STATUS: DONE

# 后端 v0.2 变更记录

这份文件记录后端（`scripts/`、`hooks/`、`skills/`、`bin/`、两个 manifest）相对 `docs/SPEC.md` 的偏离和补充，后面附上给前端的接口提示和 README 需要的事实。SPEC.md 本身没有改动。

验证结果（2026-11-05）：

- `node tests/run-tests.js`：`SUMMARY: 64 passed, 0 failed, 0 skipped`，连跑两次都通过，每次约 32 秒。
- `claude plugin validate <插件目录>`：通过，有 1 条不影响结果的提示 `ICON_MISSING`（v0.1 就没有图标）。
- `claude plugin validate <prototype 目录>`：通过。

## 一、规格补充（来自协调人，2026-11-05）

桌面 App 的会话有时几分钟收不到 Stop 事件。v0.1 里就出现过两个会话分别显示「工作中」395 秒和 489 秒，所以加了两条规则：

1. `/api/state` 的每个会话多一个 `stale: true/false`。规则：`status` 为 `working` 或 `needs_input`，并且 `updatedAt` 距今超过 10 分钟。`waiting-room status` 命令也会在这类会话后面注明「可能已经停了」。
2. 服务启动时清理一次、之后每小时清理一次 `updatedAt` 距今超过 2 小时的会话文件，任何状态都清。
3. 测试里有对应用例：stale 判定、2 小时清理、启动时清理、`/api/state` 返回的 stale 值。

## 二、偏离或补充 SPEC 的地方

**钩子和会话**

1. **`StopFailure` 已接上。** 官方文档（code.claude.com/docs/en/hooks）确认有这个事件：回合因 API 错误结束时代替 Stop 触发，输入里有 `error`、`error_details`、`last_assistant_message`，不能阻止任何操作。我们只读 `error`，错误文字不存。
2. **`failed` 会话的 `reason` 记错误类型。** SPEC 只规定了 `needs_input` 的 reason。出错时我们写入 `rate_limit`、`overloaded` 这类官方枚举值，不认识的记为 `unknown`。Cursor 的 `stop`（`status: "error"`）也记为 `unknown`。
3. **出错也发系统通知，`notify` 事件的 `kind` 多了一个 `"failed"`。** 通知文字是「Claude 出错停下了，回去看看 · 项目名」。
4. **`needs_input` 的原因对应关系**：
   - `permission_prompt` → `permission`；`elicitation_dialog`、`elicitation_url_dialog`、`agent_needs_input` → `question`。
   - `idle_prompt` 只在会话还显示「工作中」时才记为 `idle`。这种情况说明漏掉了 Stop；会话已经干完时，`idle_prompt` 不改状态。
   - Notification 没有类型字段（老版本）时，reason 为 `null`。
   - Codex 的 `PermissionRequest`（新事件 `permission`）→ `permission`。
5. **回合要有开始时间才计数。** 没收到 `prompt` 就收到 Stop 时（比如插件是会话中途装上的），会话照样记为干完了并发通知，但 `turns` 不加一，也不写 `turn_end`。重复的 Stop 同样不再计数。
6. **会话文件多了 `seenAt` 字段。** SPEC 第 6 节提到它，第 4 节的示例里没有。会话状态一变（新回合开始、干完、出错、等你确认），`seenAt` 就清空为 `null`。
7. **v0.1 留下的会话文件在读取时补齐新字段**：`agent` 补成 `claude-code`，`turns` 补成 0，旧的 reason 值 `permission_prompt` 转换成 `permission`。
8. **`agent` 只认四个值。** 别的值记为 `other`；`claude` 自动转成 `claude-code`。

**钩子命令新增的用法**（主要给 Codex / Cursor 适配用）

9. 新事件：`fail`（StopFailure）、`permission`（等你批准）、`interrupt`（用户自己打断：记为干完了，不发通知）。
10. 也接受各家的原生事件名，例如 `UserPromptSubmit`、`StopFailure`、`PermissionRequest`、`beforeSubmitPrompt`、`sessionEnd`。不写事件名时读 stdin 里的 `hook_event_name`。
11. `--json` 参数：往 stdout 打印放行用的 JSON（`prompt` 打印 `{"continue":true}`，其他打印 `{}`）。只给 Codex / Cursor 用；Claude Code 的钩子仍然什么都不输出。
12. stdin 字段兼容：会话 ID 依次找 `session_id`、`sessionId`、`conversation_id`、`conversationId`、`thread_id`；项目目录依次找 `cwd`、`workspace_roots[0]`。Cursor 的 `stop` 会读 `status`：`error` 记为出错了，`aborted` 记为干完了且不发通知。

**统计（GET /api/stats）的口径**

13. `totals` 和 `days` 只算最近 `days` 天，含今天，按本地时区分天。`days` 默认 14，取值范围 1–30，非法值按 14 算。`firstSeen`、`activeDays`、`retention`、`modeHistory` 用全部保存的事件计算，最多 30 天。
14. `activeDays` 是出现过任何事件的本地日期个数。
15. `turnsOver30s` 按 `ms >= 30000` 计，正好等于回合总数减去 `lt30s` 那一档。
16. 分档边界：`lt30s` 是 30 秒以下；`s30to5m` 是 30 秒到 5 分钟，含 5 分钟；`m5to45` 是 5 分钟以上到 45 分钟，含 45 分钟；`gt45m` 是 45 分钟以上。
17. 中位数：个数为偶数时取中间两个的平均，再取整。p90 用最近秩法，排序后取第 ceil(0.9 × n) 个。`openRate` 保留 3 位小数，分母为 0 时为 `null`。
18. `gamesPlayed` 数的是 `game_start`，`relaxCount` 数的是 `relax_start`，`playMs` 是所有 `game_end.ms` 之和。
19. 没有合法 `ms` 的 `turn_end` 整条不计，所以各档加起来总是等于 `turns`。
20. `retention.day7` 看的是首次使用日期加 7 天那一天。
21. 已知局限：事件文件只留 30 天，30 天以后 `firstSeen` 会跟着往后挪，留存数字也会跟着变。4 周内的验证不受影响。

**HTTP 接口**

22. `GET /`：`hub.html` 如果已经以 `<!doctype` 或 `<html` 开头，就原样发送，方便前端改造期间过渡；否则按 SPEC 包外壳。文件按修改时间缓存，前端改了文件不用重启服务。沿用 v0.1 的 CSP 响应头。
23. `GET /api/export`：默认导出全部保存的 30 天，也接受 `?days=`。`exportedAt` 是 ISO 8601 字符串。导出内容用白名单重新组装一遍，确保带不出别的字段。
24. `POST /api/config`：
    - 只接受 JSON 原生类型，比如 `delaySeconds: "20"` 会返回 400。
    - `port`、`lanToken` 和其他未知键返回 400。
    - 从局域网改 `lan` 返回 **403**（SPEC 没写状态码），理由是这属于权限问题，不是格式错误。
    - 空对象 `{}` 返回 200，什么都不改。
    - 成功时返回的 config 带 `port`，不带 `lanToken`。
    - `quietHours` 接受 `null`、`"23:00-08:00"` 或 `{ "start": "23:00", "end": "08:00" }`，返回时统一成对象。开始和结束相同算非法。
25. 请求体超过 4 KB 返回 **413**（SPEC 没写状态码）。CSRF 检查先于路由，所以没通过检查的 POST 一律 403；通过检查但路径不存在的返回 404。对只接受 POST 的路径发 GET，返回 405。
26. `POST /api/event`：先校验再看 `metrics`，所以非法事件在 `metrics=false` 时也返回 400。`d` 按类型校验：枚举值必须在 SPEC 列出的范围内，`ms` 要在 0–86400000 之间，`score` 要是数字；`d` 里的其他字段直接丢掉。
27. `POST /api/seen`：sid 不合法返回 400，会话不存在返回 404。成功返回 `{ ok, sid, status, seenAt }`。
28. 局域网：`lanUrls` 列出本机所有非回环的 IPv4 地址（VPN 地址也算），去掉 169.254 开头的自分配地址。局域网访问只支持 IPv4，不接受 `主机名.local` 这样的 Host。
29. 重新监听：`POST /api/config` 改了 `lan` 时，服务发完响应立刻重新监听。命令行 `waiting-room config lan=...` 改的是文件，服务每 2 秒检查一次配置，所以最多 2 秒后生效。

**命令行**

30. `lanToken` 只接受 `lanToken=reset`（重新随机生成），不接受手写的令牌，这样令牌始终来自 `crypto.randomBytes`（24 字节，32 个字符）。
31. `waiting-room config` 的输出不显示令牌，只显示「已生成」。原因是这段输出会进入 Claude 的对话记录。手机网址（带令牌）只在本机打开等候室时，由 `/api/state` 的 `lanUrls` 给出。
32. 修了 v0.1 的一个 bug：设置了 `WAITING_ROOM_PORT` 环境变量时，运行任何 `config` 修改都会把正在跑的服务停掉，原因是旧代码拿环境变量端口和文件端口做比较。

## 三、给前端的接口提示

- **手机上的令牌**：从手机打开的网址形如 `http://192.168.x.x:47823/?t=令牌`。页面里的每个请求都要带上令牌，包括 `/api/state`、`/api/stats`、各个 POST，以及「导出匿名汇总」的链接。可以读 `location.search` 里的 `t`，给 fetch 加请求头 `X-WR-Token`，或者在网址后面加 `?t=`。不带令牌的局域网请求一律 401。
- **POST 的写法**：`fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(...) })`。浏览器会自动带上 Origin；不写 Content-Type 会被 403。
- `/api/state` 的每个会话都有 `agent`、`turns`、`lastTurnMs`、`totalWorkMs`、`seenAt`、`stale`。判断要不要弹横幅时，可以比较 `seenAt` 和 `statusChangedAt`：前者更晚，说明用户已经看过。
- `failed` 会话的 `reason` 是错误类型字符串，例如 `rate_limit`，可以直接显示，也可以忽略。
- `/api/state` 返回的会话已经排好序：等你确认 > 工作中 > 干完了和出错了，同一档里按状态变化时间从新到旧。

## 四、README 需要的事实（交给协调人）

**版本**：0.2.0（`plugin.json`、`marketplace.json`、`/api/state`、`/api/health` 都已同步）。

**新增设置项**（`~/.claude/waiting-room/config.json`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `both` | `both` = 提醒 + 小游戏；`remind` = 只要提醒（不自动打开网页，只发通知） |
| `quietHours` | `null` | 勿扰时段，如 `23:00-08:00`，可以跨午夜；期间不自动打开、不发通知 |
| `metrics` | `true` | 是否在本机记录事件流水（`events/`），关掉后「我的数据」显示已关闭 |
| `lan` | `false` | 手机访问；开启后服务监听 0.0.0.0，局域网请求必须带令牌 |
| `lanToken` | 首次开启 `lan` 时生成 | 只存本机；用 `lanToken=reset` 换新 |

原有的 `autoOpen`、`delaySeconds`、`notify`、`port` 不变。

**命令示例**：

- `waiting-room config mode=remind`（也接受 `mode=只要提醒`）、`mode=both`
- `waiting-room config quietHours=23:00-08:00`、`quietHours=off`
- `waiting-room config metrics=off`
- `waiting-room config lan=on`、`lan=off`、`lanToken=reset`
- `waiting-room status`：多显示模式、勿扰时段、手机访问开关、每个会话的 agent 名，以及「可能已经停了」的提示
- 斜杠命令照旧：`/agent-waiting-room:config 只要提醒`、`/agent-waiting-room:config 勿扰 23:00-08:00`、`/agent-waiting-room:config 打开手机访问`

**怎么开启手机访问**：

1. 在 Claude Code 里输入 `/agent-waiting-room:config 打开手机访问`，或者在终端运行 `waiting-room config lan=on`。
2. 本地服务最多 2 秒后改为对局域网开放。服务没在跑也没关系，下次启动时直接按局域网模式启动。
3. 在这台电脑上打开等候室，到「设置」页找到手机网址，网址里带着令牌。
4. 手机连同一个 Wi-Fi，打开这个网址。
5. 只在可信的家庭或公司网络里开启。担心链接外泄时运行 `lanToken=reset`，旧链接马上失效。用完后用 `lan=off` 关掉。
6. 如果 macOS 防火墙是开着的，第一次开启时系统可能会问「是否允许 node 接受传入连接」，要选允许，手机才能连上。本次测试所在的电脑防火墙是关着的，这一步没有实际验证。

**数据和隐私**：

- 新增 `events/YYYY-MM-DD.jsonl`：一行一个事件，只有类型、时间、会话 ID 和少量数字（用时、得分、模式），不存提示词、回复、命令内容和错误文字。只保留最近 30 天，服务启动时清理更早的文件。
- 会话文件在 2 小时没动静后由服务清理。
- 「导出匿名汇总」（`/api/export`）不含项目名和会话 ID。

**钩子**：

- 新接上 Claude Code 的 `StopFailure`，会话会显示「出错了」。
- Codex CLI 和 Cursor 的接法写在 `docs/adapters.md`，**未实测**。Cursor 没有「等你批准」类事件，所以不会显示「等你确认」。
- 测试里钩子跑了 58 次，最慢一次 219 毫秒。

**怎么跑测试**：

```bash
node tests/run-tests.js
```

- 只用 Node 内置模块，不需要 `npm install`，大约 30 多秒跑完。
- 数据写在临时目录里，可以用 `WR_TEST_TMP=某个目录` 指定位置，加 `WR_TEST_KEEP=1` 保留临时目录方便排查。
- 用端口 47901–47908，不碰 47823 和 `~/.claude/waiting-room`。
- 设置了 `WAITING_ROOM_DRY_RUN=1`，不会真开浏览器、真弹通知。
- 结束时会停掉自己启动的所有服务，并检查这些端口上没有残留。
- 局域网那几项会真的从本机局域网 IP 发请求；电脑没有局域网地址时，这几项显示 SKIP。

**校验命令**：`claude plugin validate ./agent-waiting-room` 和 `claude plugin validate .`（在 prototype 目录下运行）。

**新文件**：`scripts/events.js`（事件流水和统计）、`scripts/web.js`（Host / 令牌 / CSRF 检查和页面外壳）、`tests/run-tests.js`、`docs/adapters.md`、`docs/CHANGES-backend.md`。

---

# 后端 v0.3 变更记录

这一节记录后端为 v0.3（`docs/SPEC-v0.3.md`）做的改动：中英双语、`lang` 设置、一个新接口、manifest 改名。钩子事件、会话状态机、事件统计口径、手机访问和 CSRF 规则都没有动。

## 一、新增文件

- `scripts/strings.js`：中英两套文案，`t(lang, key, vars)` 取字；另有 `formatDuration(lang, ms)`（回合用时）和 `errorLabel(lang, code)`（StopFailure 错误类型 → 短语）。它不依赖 `lib.js`。中英两张表的 key 和占位变量必须一致，测试会检查。

## 二、设置项 `lang`

1. `DEFAULTS` 加 `lang: 'auto'`，取值 `auto` / `zh` / `en`。v0.2 的 `config.json` 没有这个键时按 `auto` 处理，读取时不改文件，下次保存时补上。
2. `resolveLang(cfg)` 的优先级：`config.lang` 明确指定 → 环境变量 `WAITING_ROOM_LANG`（写 `auto` 等于没写）→ 网页上报的 `langHint`（存在 `hub.json`）→ 系统语言 → `en`。系统语言按 POSIX 的习惯取 `LC_ALL`、`LC_MESSAGES`、`LANG` 里第一个非空的值，以 `zh` 开头算中文；所以 `LC_ALL=C` 加 `LANG=zh_CN.UTF-8` 会解析成英文，和其他命令行工具一致。
3. 命令行：`waiting-room config lang=en`；键的别名 `language`、`语言`；值的别名 `中文` → `zh`，`English` / `英文` → `en`，`自动` → `auto`。网页接口（`POST /api/config`）只收 `auto` / `zh` / `en` 三个原值。
4. `publicConfig` 多返回 `lang`，所以 `/api/state` 的 `config` 里有它。

## 三、通知和命令行输出

5. 系统通知改为「标题 + 正文」。`L.notify(title, body)`，macOS 的标题不再固定是「等一下」，而是：
   - 干完：`干完了 · 项目名` / `Done · project`，正文带本回合用时（「Claude 这一回合用了 1 分 12 秒，回去看看」/「Claude worked for 1m 12s. Back to the terminal.」）。没有回合开始时间（插件中途装上）时正文不带用时。
   - 等你确认：`等你确认 · 项目名` / `Needs your input · project`，正文按原因分三种：权限（「在等你批准一个操作」/「is asking for your permission」）、提问（「有问题要问你」/「has a question for you」）、idle（「停下来等你了」/「has paused and is waiting for you」）。
   - 出错：`出错了 · 项目名` / `Failed · project`，正文带错误类型的短语（如「触发了速率限制」/「rate limit」）；类型是 `unknown` 时不提原因。错误原文仍然不记录。
   - 给测试用的 dry-run 记录（`dry-run.log`）里，`notify` 的 `detail` 从字符串改成 `{ title, body }`。
6. 命令行的所有输出走文案表：`describeConfig`（多一行 `lang`，并注明当前解析结果）、保存确认、「没有保存」/ "Not saved:" 的报错、`open`、`status`、`stop`、用法、手机访问开关的提示。设置键名保持英文不翻译。改了 `lang` 之后，确认信息用改完后的语言输出。
7. `validateConfigValue(key, value, strict, lang)` 多了第 4 个参数，报错文字按它输出；不传时按 `resolveLang()` 解析。
8. `bg-open` 写 `hub.json` 时改为合并写入（`updateHubMarker`），不再覆盖网页上报的 `langHint`。

## 四、HTTP 接口

9. `GET /api/state` 多一个顶层字段 `resolvedLang`（`zh` 或 `en`），是后端当前的解析结果。
10. **新增 `POST /api/lang-hint`**：请求体 `{ "lang": "zh" | "en" }`。过和其他 POST 一样的检查（Content-Type 为 JSON、Origin 同源、局域网要令牌），否则 403。合法时把 `langHint` 和 `langHintAt` 写进 `hub.json`（不写 `config.json`），返回 `{ ok: true, langHint, resolvedLang }`；其他值（包括 `auto`、大写、非字符串、空对象）返回 400 `{ error }`。对它发 GET 返回 405。网页只在 `lang=auto` 时上报。
11. `POST /api/config` 接受 `lang`，校验同第 3 条。
12. 接口报错的文字（请求体不合法、键不能改、手机访问只能在本机开关、sid 不合法等）也按解析语言输出。

## 五、Skills 和 manifest

13. `skills/open/SKILL.md`、`skills/config/SKILL.md` 正文改成英文，`description` 和 `argument-hint` 英文在前、中文在后，frontmatter 的键和 `allowed-tools` 没变。config 的技能里保留中文说法到键值的对照，并加了英文说法（"remind only" → `mode=remind`，"quiet hours 11pm to 8am" → `quietHours=23:00-08:00`，"switch to English" → `lang=en` 等）。最后一句都是「用用户提问的语言回复」。
14. `plugin.json` 和 `../.claude-plugin/marketplace.json`：版本 `0.3.0`，`displayName` 为 `Waiting Room (等一下)`，描述按 SPEC 第 1 节的双语句子；市场名改为 `waiting-room`（原 `waiting-room-local` 作废），加 `owner.url`、`metadata.homepage`，插件条目加 `license`、`homepage` 和关键词 `claude-code`、`waiting-room`、`notifications`。插件 id `agent-waiting-room` 不变。

## 六、测试

15. 子进程默认 `WAITING_ROOM_LANG=zh`，让断言不受这台电脑系统语言的影响；要测英文的用例自己传 `env`。`envFor` 里值为 `null` 的键会从环境里删掉。
16. 新增用例：`lang` 的解析和别名；旧 `config.json` 没有 `lang` 时按 `auto`；`resolveLang` 的每一级优先级（在本进程里改环境变量再恢复）；文案表的中英一致性、用时格式、错误类型短语；中英两种语言的通知文案（dry-run）；`config.lang` 和环境变量的优先关系；`/api/lang-hint` 正常、非法值、缺 Origin、GET；`/api/config` 的 `lang` 校验和它对 `resolvedLang` 的影响；命令行 `lang` 的键值别名、双语输出和「没有保存」；`status` / `stop` / 用法 / `open` 的英文输出；`bg-open` 不覆盖 `langHint`。
17. 原有用例里和版本号、通知文字有关的断言同步改成 `0.3.0` 和新的 `{ title, body }` 格式。

## 后端 v0.4 变更记录（2026-11-06）

1. 新设置 `notifyMinSeconds`（0–3600，默认 10）：`finishTurn` 里 outcome 为 done 且回合用时不足这个秒数时不发通知，回合和事件照记；failed 和 needs_input 不受影响。`normalizeConfig`、`validateConfigValue`（和 `delaySeconds` 同一分支，报错 key `cfg.notifyMinSeconds`）、`publicConfig`、`/api/config` 白名单、命令行别名（`notifymin`、`notify-min-seconds`、`最短通知秒数` 等）和 `config` 的列表输出都加了它。v0.3 的 config.json 没有这个键时按 10 处理。
2. `notify()` 拆成 `notifyCommand(title, body, platform, release)`（纯函数，可测）加 `detachedRun`。macOS 仍是 osascript；Linux `notify-send -a 'Waiting Room' -u normal`；Windows（`win32`）和 WSL（`linux` 且 `os.release()` 含 microsoft）用 `powershell.exe -EncodedCommand`，脚本调 WinRT 的 `ToastNotificationManager`，AppId 借用系统 PowerShell 的 AUMID；标题正文写成单引号字符串（`'` 写两个）再 `SecurityElement.Escape`。spawn 加 `windowsHide: true`。其他平台返回 null，不发。Windows / Linux 只过了单元测试，没有真机。
3. 测试 80 项：新增 `notifyMinSeconds` 的校验和默认值、通知命令按平台、流程用例（不足 10 秒不通知 / 等你确认和出错照常 / 改回 0 又通知）、命令行别名。flow 和 auto 两个测试目录的配置写了 `notifyMinSeconds: 0`，原有的毫秒级回合用例才能继续收到通知。
4. 版本 `0.4.0`；图标 `.claude-plugin/icon.png`（1024×1024，源文件在仓库 `docs/images/icon.svg`），`claude plugin validate` 不再提示 ICON_MISSING。
