# 「等一下」v0.2 规格与接口约定

这份文档是 v0.2 的唯一约定。后端（`scripts/`、`hooks/`、`skills/`、`bin/`）和网页（`public/hub.html`）由两个人并行修改，双方都只按这里写的接口对接。实现中如果必须偏离，请在本文末尾的「变更记录」里写清楚改了什么、为什么。

## 1. 产品定位（来自调研结论）

调研发现，用户愿意装的是「帮我盯着 agent」的工具，而不是「陪我玩」的工具：等待小游戏插件的 GitHub star 最高只有 127，帮人盯状态的桌宠 Clawd on Desk 有 6,657 star。所以 v0.2 的优先级是：

1. **状态提醒第一**：多个 agent 会话的状态一眼看清，干完或要你确认时立刻叫你。
2. **填空第二**：30 秒到 5 分钟的等待里，给一局能随时暂停的小游戏，或者一段 30–60 秒的放松。
3. **验证内置**：插件在本机算出验证 MVP 要看的指标（等待期打开率、第 7 天是否还在用、用户选了哪种模式），不上传，用户可以手动导出匿名汇总。

一句话标语：**「Claude 好了叫你，等的时候玩一局」**。

隐私和合规边界（不能破）：

- 不读取、不存储提示词和回复内容。
- 不代理、不转发任何模型请求，不碰用户的登录凭证。
- 不修改 Claude Code 自己的界面元素，插件里不放广告。
- 默认只监听 127.0.0.1；手机访问是可选项，默认关闭，开启后必须带令牌。
- 所有数据只存本机；导出的汇总里不含项目名、会话 ID、时间以外的任何标识。

## 2. 目录与数据文件

数据根目录：`~/.claude/waiting-room/`，可用环境变量 `WAITING_ROOM_HOME` 覆盖（测试必须用它）。

| 文件 | 内容 |
|---|---|
| `config.json` | 设置，见第 3 节 |
| `sessions/<id>.json` | 每个会话一份，见第 4 节 |
| `events/YYYY-MM-DD.jsonl` | 本机事件流水，一行一个 JSON，见第 5 节；只保留最近 30 天，服务启动时清理更早的文件 |
| `server.json`、`hub.json`、`waiting-room.log` | 沿用 v0.1 |

## 3. 设置（config.json）

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `mode` | `"both"` / `"remind"` | `"both"` | `both` = 提醒 + 小游戏；`remind` = 只要提醒（网页隐藏小游戏和放松，且不自动打开网页，只发通知） |
| `autoOpen` | bool | `true` | 回合超过 `delaySeconds` 仍在工作时，自动打开网页（`mode=remind` 时视为 false） |
| `delaySeconds` | 0–3600 | `20` | 自动打开前的等待秒数 |
| `notify` | bool | `true` | 干完 / 要确认时发系统通知 |
| `notifyMinSeconds` | 0–3600 | `10` | （v0.4）回合不足这么多秒不发「干完了」的通知；等你确认和出错不受限制 |
| `quietHours` | `null` 或 `{ "start": "HH:MM", "end": "HH:MM" }` | `null` | 勿扰时段：期间不自动打开网页、不发系统通知；可跨午夜，如 23:00–08:00 |
| `metrics` | bool | `true` | 是否在本机记录事件流水（关闭后第 5 节的事件不再写入，数据面板显示「已关闭」） |
| `lan` | bool | `false` | 手机访问：开启后服务改为监听 0.0.0.0，局域网请求必须带令牌 |
| `lanToken` | string | 首次开启 `lan` 时生成 | 24 位以上随机字符串（`crypto.randomBytes`），只存本机 |
| `port` | 1024–65535 | `47823` | 沿用 v0.1；环境变量 `WAITING_ROOM_PORT` 可覆盖 |

`waiting-room config key=value ...` 命令支持以上所有键；`quietHours=off` 清空，`quietHours=23:00-08:00` 设置。

## 4. 会话（sessions/<id>.json）

```json
{
  "sessionId": "abc",
  "agent": "claude-code",
  "project": "picpick-ios",
  "status": "working",
  "reason": null,
  "createdAt": 0,
  "turnStartedAt": 0,
  "statusChangedAt": 0,
  "finishedAt": null,
  "updatedAt": 0,
  "turns": 3,
  "lastTurnMs": 41000,
  "totalWorkMs": 120000
}
```

- `agent`：`"claude-code"`（默认）、`"codex"`、`"cursor"`、`"other"`。钩子命令可带 `--agent codex` 指定。
- `status`：`working` / `needs_input` / `done` / `failed`。`failed` 来自 Claude Code 的 `StopFailure` 事件（如果钩子支持就接上）。
- `reason`：`needs_input` 时为 `"permission"` / `"question"` / `"idle"` / `null`。
- `turns`、`lastTurnMs`、`totalWorkMs`：每次回合结束（done / failed）时更新；`lastTurnMs = finishedAt - turnStartedAt`。
- `project` 只取 cwd 的最后一级目录名。

## 5. 本机事件（events/YYYY-MM-DD.jsonl）

每行：`{"t": <毫秒时间戳>, "type": "<类型>", "sid": "<会话 id 或 null>", "d": { ... }}`

| type | 谁写 | d 字段 |
|---|---|---|
| `turn_start` | 后端（UserPromptSubmit） | `{ agent }` |
| `turn_end` | 后端（Stop / StopFailure） | `{ agent, ms, outcome: "done"/"failed", engaged: bool }` |
| `needs_input` | 后端 | `{ reason }` |
| `auto_open` | 后端（延迟打开真的打开了网页） | `{}` |
| `notify` | 后端（真的发了通知） | `{ kind: "done"/"needs_input" }` |
| `hub_open` | 网页（POST /api/event） | `{ source: "auto"/"manual"/"link" }`（网址带 `?src=auto` 时为 auto） |
| `hub_visible` | 网页 | `{}`（标签页从隐藏变为可见） |
| `game_start` | 网页 | `{ game: "fly"/"lamp"/"pair" }` |
| `game_end` | 网页 | `{ game, ms, score }` |
| `relax_start` / `relax_end` | 网页 | `{ kind: "breath"/"eyes"/"stretch", ms? }` |
| `banner_shown` | 网页 | `{ kind: "done"/"needs_input"/"failed" }` |
| `back_click` | 网页（横幅上点了「回去看看」） | `{}` |
| `mode_change` | 后端（模式改变时） | `{ from, to }` |

**engaged 的判定**：回合结束时，如果在 `turnStartedAt` 到结束之间出现过任何 `hub_open`、`hub_visible`、`game_start`、`relax_start` 事件，`engaged = true`。

## 6. HTTP 接口

所有请求先过 Host 检查（沿用 v0.1：`127.0.0.1:PORT`、`localhost:PORT`；`lan=true` 时另外接受本机局域网 IP 加端口）。

**局域网令牌**：远端地址不是回环地址（127.0.0.1 / ::1）的请求，必须带 `?t=<lanToken>` 或请求头 `X-WR-Token: <lanToken>`，否则 401。`lan=false` 时服务只监听 127.0.0.1。

**写接口的 CSRF 防护**：所有 POST 必须同时满足：`Content-Type` 以 `application/json` 开头；`Origin` 请求头等于本服务自己的来源（`http://127.0.0.1:PORT`、`http://localhost:PORT`，或 `lan=true` 时的局域网来源）。不满足返回 403。请求体上限 4 KB。不回应 CORS 预检（OPTIONS 一律 405）。

| 方法 路径 | 返回 |
|---|---|
| `GET /` | 网页。`public/hub.html` 是**片段**（没有 doctype / html / head / body），服务端发送时包一层：`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>` + 片段 + `</body></html>`。响应头加 `Cache-Control: no-store`。 |
| `GET /api/health` | 沿用 v0.1 |
| `GET /api/state` | `{ app, version, now, platform, demo: false, config: { mode, autoOpen, delaySeconds, notify, quietHours, metrics, lan }, lanUrls: [...], sessions: [...] }`。`lanUrls` 只在 `lan=true` 且请求来自回环地址时给出，形如 `http://192.168.1.5:47823/?t=<token>`，否则为空数组。`?hub=1` 时刷新「网页在线」标记（沿用 v0.1）。 |
| `GET /api/stats?days=14` | 第 7 节的统计 |
| `GET /api/export` | 匿名汇总：第 7 节统计去掉所有项目名和会话 ID，加上 `{ exportedAt, version, mode }`。响应头 `Content-Disposition: attachment; filename="waiting-room-stats.json"` |
| `POST /api/event` | 请求体 `{ type, sid?, d? }`；只接受第 5 节里标「网页」的 type，其余 400。成功 `{ ok: true }`。`metrics=false` 时直接返回 `{ ok: true, skipped: true }` |
| `POST /api/config` | 请求体为第 3 节键的子集，只接受 `mode`、`autoOpen`、`delaySeconds`、`notify`、`quietHours`、`metrics`；`lan` 只能从回环地址改。校验失败 400 并返回 `{ error }`。成功返回新的 config（不含 lanToken）。`lan` 改变时服务重新监听。 |
| `POST /api/seen` | 请求体 `{ sid }`：用户在网页上确认看过了，`done`/`failed` 会话的 `status` 不变，但写入 `seenAt`，网页据此不再重复弹横幅 |

## 7. 统计（GET /api/stats）

```json
{
  "metricsEnabled": true,
  "firstSeen": "2026-11-05",
  "activeDays": 3,
  "retention": { "day1": true, "day7": null },
  "mode": "both",
  "modeHistory": [{ "t": 0, "from": "both", "to": "remind" }],
  "totals": {
    "turns": 120, "turnsOver30s": 40, "engagedOver30s": 11, "openRate": 0.275,
    "needsInput": 9, "autoOpens": 20, "notifies": 30,
    "gamesPlayed": 14, "playMs": 900000, "relaxCount": 3, "backClicks": 8,
    "medianTurnMs": 38000, "p90TurnMs": 260000,
    "buckets": { "lt30s": 80, "s30to5m": 30, "m5to45": 9, "gt45m": 1 },
    "byAgent": { "claude-code": 100, "codex": 20 }
  },
  "days": [
    { "date": "2026-11-05", "turns": 40, "turnsOver30s": 12, "engagedOver30s": 4, "openRate": 0.33, "gamesPlayed": 5, "playMs": 300000, "needsInput": 3 }
  ]
}
```

- `openRate = engagedOver30s / turnsOver30s`（分母为 0 时为 null）。这就是调研报告验证表里的「等待期打开率」。
- `retention.day1`：首次使用的次日有没有任何事件；`day7`：第 7 天有没有。还没到那天时为 null。
- `buckets` 对应调研里的等待三档：<30 秒、30 秒–5 分钟、5–45 分钟、>45 分钟。
- 统计只读事件流水，按本地时区分天。

## 8. 钩子（hooks/hooks.json）

沿用 v0.1 的 6 个钩子，另外：

- 如果当前 Claude Code 文档里有 `StopFailure` 事件，接上它，状态记为 `failed`。
- `UserPromptSubmit`：`mode=remind`、`autoOpen=false` 或处于勿扰时段时，不安排延迟打开。延迟打开时在网址后加 `?src=auto`。
- `Stop` / `Notification`：勿扰时段内不发系统通知。
- 所有钩子仍然必须：1 秒内返回、退出码 0、标准输出为空、任何错误都吞掉。

**其他 agent 的适配**（`docs/adapters.md`）：给 Codex CLI 和 Cursor 写配置示例，调用同一个 `bin/waiting-room hook <event> --agent codex`。先查对方当前官方文档确认钩子格式和 stdin 字段；没有在真实环境里试过的，文档里明确标「未实测」。

## 9. 网页（public/hub.html）

### 9.1 必须兼容两种运行方式

1. **本地模式**：由本地服务提供，`/api/state` 可用。
2. **演示模式**：`/api/state` 请求失败，或网址带 `?demo=1` 时进入。用于在 claude.ai Artifact 里发布，让没装插件的人也能体验。演示模式下所有数据都是模拟的，页面顶部显示「演示模式 · 数据为模拟」。

因为要能直接作为 Artifact 发布，`hub.html` 必须满足：

- 是片段：文件开头直接是 `<title>等一下</title>` 和 `<meta name="claude:viewport-fit-sides" content="cover">`，不写 doctype、html、head、body。
- 不加载任何外部资源（不用网络字体，用系统字体栈 `-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`）。
- 颜色全部是 `:root` 上的变量；深色模式写在 `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ... } }` 和 `:root[data-theme="dark"] { ... }` 两处；`body` 用变量设背景色。
- 左右留白写成 `padding-left: max(16px, env(safe-area-inset-left, 0px))` 和对应的 right。
- 375px 宽不出现横向滚动；所有 `localStorage` 读写包在 try/catch 里；不用 `alert` / `confirm` / `prompt`；浏览器通知、剪贴板、全屏等能力失败时安静降级。
- 尊重 `prefers-reduced-motion`；键盘可操作，焦点可见。

### 9.2 页面结构（从上到下）

1. **顶栏**：名称「等一下」+ 标语「Claude 好了叫你，等的时候玩一局」；右侧声音开关。演示模式下多一个「演示模式」标签。
2. **状态面板（主角）**：
   - 一行汇总，例如「2 个在干活 · 1 个等你确认」；全部空闲时写「现在没有 agent 在干活」。
   - 每个会话一张卡：agent 名（Claude Code / Codex / Cursor）、项目名、状态标签（干活中 / 等你确认 / 干完了 / 出错了，颜色 + 文字双重表达）、本回合已用时（实时走秒）、今天第几个回合、上一回合用时。
   - 排序：等你确认 > 干活中 > 刚干完 > 其余。
   - `needs_input` 和 `done` 卡片上有「知道了」按钮，点了调 `POST /api/seen`（演示模式下只改本地状态）。
3. **提醒横幅**（沿用 v0.1，加上 failed）：状态变成 done / needs_input / failed 时弹出；游戏和放松自动暂停；标签页标题闪烁；有声音（需用户先点过页面）；横幅按钮「回去看看」记 `back_click`，「继续玩」只关横幅。
4. **四个标签页**：
   - **小游戏**：沿用 v0.1 的三个原创游戏（萤火夜航、点灯、成双）。每局开始/结束上报 `game_start` / `game_end`。
   - **放松一下**：三种 30–60 秒的小练习。① 呼吸：方块呼吸（吸 4 秒、停 4 秒、呼 4 秒、停 4 秒），圆形动画跟着节奏，跑 4 轮约 64 秒；② 护眼：20-20-20（看 6 米外 20 秒），倒计时；③ 伸展：4 张卡片轮播（颈部、肩膀、手腕、起身走动），每张 15 秒。开始/结束上报 `relax_start` / `relax_end`。`prefers-reduced-motion` 时去掉缩放动画，只留文字倒计时。
   - **我的数据**：读 `/api/stats`。顶部 4 个数字：等待期打开率、超过 30 秒的回合数、本周游戏局数、活跃天数；下面一张 14 天的小柱状图（每天超过 30 秒的回合数，其中打开过网页的部分用深色），一张等待四档分布条；再下面是「调研里的验证门槛」对照：打开率 ≥ 20% 继续 / < 5% 止损，第 7 天留存，模式选择。底部「导出匿名汇总」按钮（本地模式下链接到 `/api/export`；演示模式下按钮禁用并说明）。数字旁边要写清楚口径。`metrics=false` 时显示「本机统计已关闭」和开启按钮。
   - **设置**：模式切换（「提醒 + 小游戏」/「只要提醒」，并说明区别）、自动打开开关和延迟秒数、系统通知开关、勿扰时段、本机统计开关、手机访问（显示是否开启；开启时显示 `lanUrls` 和安全提示：只在可信的家庭或公司网络开；开关本身只能用 `/agent-waiting-room:config` 改，网页上只显示说明）、隐私说明（存了什么、没存什么）。改动调 `POST /api/config`；演示模式下改动只存在 localStorage。
   - `mode=remind` 时隐藏「小游戏」和「放松一下」两个标签，只留状态面板、我的数据、设置；页面上提示「当前为只要提醒模式」。
5. **关于这个 Demo**（只在演示模式下作为第五个标签显示；本地模式下在设置页底部放一个折叠的「关于」）：内容见 9.4。
6. **页脚**：「只在这台电脑上运行，不上传任何数据」+ 连接状态。

### 9.3 演示模式的模拟器

- 三个模拟会话：`Claude Code · picpick-ios`、`Codex · api-gateway`、`Cursor · landing-page`。
- 每个会话循环：干活 25–90 秒（随机）→ 70% 干完、30% 等你确认 → 用户点「知道了」或 20 秒后自动开始下一回合。打开页面 8 秒内必须至少有一个会话从干活变成干完，让体验者马上看到横幅。
- 「我的数据」用一份固定的 14 天示例数据，标注「示例数据」；数字要合理（例如打开率 27%，超过 30 秒的回合每天 5–15 个）。
- 设置改动存在 localStorage，模式切换要真的生效（切到「只要提醒」后游戏标签消失）。

### 9.4 「关于这个 Demo」内容大纲

用中文，遵守下面第 10 节的可读性规则。分几个小节，每节两三段以内：

1. **这是什么**：一个 Claude Code 插件。agent 干活时帮你盯着，好了叫你；等的时候给你一局 30 秒能玩完、随时能停的小游戏，或者一段放松。
2. **为什么先做提醒**：等待游戏插件最高 127 star，盯状态的桌宠 Clawd on Desk 有 6,657 star，效率工具 ccstatusline 有 13,519 star（2026-11-05 GitHub 数据）。Claude Code 每轮工作的中位数约 45 秒，小游戏只在 30 秒到 5 分钟这一档说得通。
3. **怎么工作**：用一个简单的流程图（纯 HTML/CSS 或内联 SVG）表示：你提交任务 → 钩子记下「干活中」→ 超过 20 秒自动打开等候页 → 干完或要你确认时弹横幅和系统通知 → 你回去继续。
4. **隐私和边界**：第 1 节的隐私和合规边界，写成用户能看懂的话。
5. **怎么验证这个想法**：调研报告里的验证表（4 周 star ≥ 150 或首次打开 ≥ 500；等待期打开率 ≥ 20% 继续、< 5% 止损；第 7 天留存 ≥ 15%；关掉游戏只留提醒的人 > 70% 就转向纯状态工具；3 个月日活 < 200 就停）。说明「我的数据」页就是为了在本机算出这些指标。
6. **机会点**：按「近期可做 / 验证后再做 / 需要更多资源」三档列出：
   - 近期可做：多 agent 状态面板（调研里最强的需求信号）；Codex 和 Cursor 适配（同一套钩子脚本）；放松模式（开发者圈有「反刷屏」情绪，健康填空更容易被接受）；手机局域网查看。
   - 验证后再做：Claude 界面内的面板（mods，仍是 early access，只能画字符）；浏览器扩展覆盖网页版 ChatGPT、Claude、Gemini、豆包的普通用户；自有网页上接开发者广告（Carbon、EthicalAds，明确标注）或支持者包。
   - 需要更多资源：团队版（多人 agent 看板）；国内大众市场（需要公司主体、版号或备案）；合规的 AI 应用路线（海外 BYOK 客户端、国内接已备案模型）。
   - 明确不做：API 中转、账号池、静默换模型、擦边内容（附一句原因，详见调研报告）。
7. **风险**：宿主厂商自己做推送和宠物（Claude Code 手机推送、Codex Pets、/buddy）；推理变快会让短等待继续缩短；所以这个项目拼速度、没有壁垒，适合当低成本实验。
8. **怎么安装**：三步（复制文件夹、`claude plugin marketplace add`、`claude plugin install`），以及调研报告链接 https://claude.ai/artifact/TJDikQ9zK2XgnK5QK8XiVF （用普通 `<a href target="_blank">` 链接）。

## 10. 中文文案的可读性规则（所有界面文字和文档都要遵守）

1. 句间连接不许省：两个判断挨着放时，如果第二句不是第一句的直接延续，中间要有一句话交代关系。问题出现后，至少停一句话再展开回应。
2. 修饰语不超过两层：一个名词前的定语不超过两层嵌套。
3. 同一段内，抽象概念做主语并搭配动作动词的句子不超过两句；第三句起换成具体的人、事物或场景做主语。
4. 写完逐句检查名词和动词的搭配，日常口语里说不出来的就换掉。
5. 界面按钮写清楚会发生什么（「回去看看」「知道了」「导出匿名汇总」），避免「确定」「提交」这类空话。

## 11. 版本

`plugin.json` 和 `marketplace.json` 的 version 改为 `0.2.0`；`/api/state` 的 `version` 同步。

## 变更记录

（实现时如有偏离，写在这里。）
