# 等一下 / Waiting Room · v0.3 规格（公开发布版）

v0.3 不加新玩法，只做两件事：**中英双语**，以及**能从 GitHub 一条命令装上**。视频等内容功能留到 v0.4。

本文是前端、后端两条线共同遵守的契约。改动范围之外的行为（钩子、会话状态机、事件统计、手机访问、CSRF）沿用 `docs/SPEC.md`（v0.2），不要重写。

## 1. 对外身份

| 项 | 值 |
|---|---|
| 产品名 | 中文「等一下」，英文 **Waiting Room** |
| 插件 id | `agent-waiting-room`（不变，已装用户无缝升级） |
| 版本 | `0.3.0`（plugin.json 与 marketplace.json 同步） |
| 插件市场名 | **`waiting-room`**（原 `waiting-room-local` 作废） |
| 仓库 | `https://github.com/mancyyu/agent-waiting-room`（仓库根就是插件市场，插件在 `agent-waiting-room/` 子目录） |
| 安装命令 | `claude plugin marketplace add mancyyu/agent-waiting-room` → `claude plugin install agent-waiting-room@waiting-room` |
| 英文一句话 | Claude pings you when it's done. Play a round while you wait. |
| 中文一句话 | Claude 好了叫你，等的时候玩一局。 |
| displayName | `Waiting Room (等一下)` |
| description（manifest） | 英文在前、中文在后，各一句：`Status board for your coding agents: get a system notification when Claude finishes, fails, or needs your input, and a 30-second game while you wait. Local-only, no ads. ／ 多个 agent 会话的状态一眼看清，干完、出错或要你确认时提醒你，等待时给一局小游戏。数据只存本机。` |

## 2. 语言设置 `lang`

新增配置键 `lang`，取值 `auto` / `zh` / `en`，默认 `auto`。

**解析规则（两端一致）**

- `lang` 不是 `auto` 时，前后端都按它来。
- `lang` 为 `auto` 时：
  - 网页按浏览器 `navigator.languages`，第一个以 `zh` 开头的命中则 `zh`，否则 `en`。
  - 后端（系统通知、命令输出）按：环境变量 `WAITING_ROOM_LANG` → 网页上报的 `langHint` → `LC_ALL` / `LC_MESSAGES` / `LANG` 以 `zh` 开头则 `zh` → 否则 `en`。
- 网页在 `lang=auto` 时，每次加载把自己解析出的语言 `POST /api/lang-hint {"lang":"zh"}` 告诉后端；后端把它写进 `hub.json`（`langHint` 字段），不写进 `config.json`。这样通知和网页用同一种语言。

**命令行写法**：`waiting-room config lang=en`；别名 `language`、`语言`；值的别名 `中文`→`zh`，`English`/`英文`→`en`，`自动`→`auto`。

**接口**

- `GET /api/state` 的 `config` 里带 `lang`；另加顶层字段 `resolvedLang`（后端当前解析结果，`zh` 或 `en`）。
- `POST /api/lang-hint`，body `{"lang":"zh"|"en"}`，过和 `/api/config` 一样的 CSRF 检查；非法值回 400。
- `POST /api/config` 接受 `lang`，校验同上。

## 3. 前端（`public/hub.html`，只改这一个文件）

- 所有用户可见文字进字典：`const STR = { zh: {...}, en: {...} }`，取字 `t(key, vars)`。包括：标签页名、状态词、横幅、按钮、三个游戏的名字和玩法说明、放松练习的引导词、「我的数据」页的指标名和说明、设置页、隐私说明（「存了什么、没存什么」）、演示模式横幅、`document.title`、`<html lang>`。
- 语言切换：设置页加「语言 / Language」三选项（自动 / 中文 / English），写 `lang` 到 `/api/config`，保存后立即重绘，不用刷新。
- 建议的英文用词（保持一致）：

  | 中文 | English |
  |---|---|
  | 等一下 | Waiting Room |
  | 状态面板 | Status |
  | 小游戏 | Games |
  | 放松一下 | Relax |
  | 我的数据 | My Data |
  | 设置 | Settings |
  | 关于 | About |
  | 干活中 | Working |
  | 等你确认 | Needs you |
  | 干完了 | Done |
  | 出错了 | Failed |
  | 可能已结束 | Probably ended |
  | 刚干完 | Just finished |
  | 回去看看 | Back to terminal |
  | 只要提醒 | Remind only |
  | 提醒 + 小游戏 | Remind + games |
  | 勿扰时段 | Quiet hours |
  | 手机访问 | Phone access |
  | 本机统计 | Local stats |
  | 等待期打开率 | Open rate while waiting |
  | 萤火夜航 | Firefly Flight |
  | 点灯 | Light Up |
  | 成双 | Pairs |
  | 方块呼吸 | Box Breathing |
  | 护眼 20-20-20 | 20-20-20 Eye Break |
  | 伸展 | Stretch |

- 「关于」页加：版本号、GitHub 仓库链接、「Star on GitHub」、「报告问题 / Report an issue」（指向仓库 issues）、一个「复制安装命令」按钮（复制第 1 节的两条命令，用 `navigator.clipboard`，失败时退回显示文本框）。
- 轻量的 star 提示：当「我的数据」里活跃天数 ≥ 7 且用户没关过时，在状态面板下方显示一张可关闭的小卡片「用了一周了，喜欢的话去 GitHub 点个 star」；关闭状态存 `localStorage`（读写都 try/catch）。只显示一次，不弹窗。
- 不加视频页，不加任何外链脚本；页面仍然是单文件 fragment（由 `web.js` 的 `wrapHub` 套壳），不写 `<!doctype>`、`<html>`、`<head>`。
- 演示模式（非本机 host）逻辑不变，但演示数据里的项目名、文字也要走字典。

## 4. 后端（`scripts/*.js`、`skills/*/SKILL.md`、`tests/run-tests.js`、两个 manifest）

- `lib.js`：`DEFAULTS` 加 `lang: 'auto'`；加 `resolveLang(cfg)`；旧 `config.json` 没有 `lang` 时按 `auto` 处理，不报错。
- 新建 `scripts/strings.js`：`t(lang, key, vars)`，中英两套，供 `lib.js`（通知）和 `cli.js`（命令输出）用。通知文案：
  - 干完：zh「干完了 · {project}」/ en「Done · {project}」，正文带本回合用时；
  - 等你确认：zh「等你确认 · {project}」/ en「Needs your input · {project}」，正文说明是权限还是提问；
  - 出错：zh「出错了 · {project}」/ en「Failed · {project}」。
- `cli.js`：`config` 子命令解析 `lang`；`describeConfig`、保存结果、`open` 的输出按解析语言输出；「没有保存」的报错也双语。
- `server.js`：`/api/state` 加 `resolvedLang`；新增 `POST /api/lang-hint`；`/api/config` 校验 `lang`。
- `skills/open/SKILL.md`、`skills/config/SKILL.md`：正文改成英文为主（Claude 读的是它），保留中文说法到键值的对照表，并加英文说法（"remind only" → `mode=remind`，"quiet hours 11pm to 8am" → `quietHours=23:00-08:00`，"switch to English" → `lang=en`）；最后一句改为「用用户提问的语言回复」。`description` 和 `argument-hint` 写成英文在前、中文在后。
- `plugin.json`、`../.claude-plugin/marketplace.json`：按第 1 节改名字、描述、版本；marketplace 加 `owner.url`（仓库地址）、`metadata.homepage`。
- 测试：新增 `lang` 解析、`resolveLang` 优先级、`/api/lang-hint` 正常与非法值、`/api/config` 里的 `lang` 校验、通知文案两种语言；原有 64 项全部保持通过。
- `docs/CHANGES-backend.md` 追加 v0.3 一节。

## 5. 不做的事

- 不做视频页，不接任何外部内容源。
- 不加遥测、不加任何上报；「大家用不用」只看 GitHub star、marketplace add 次数和用户主动贴的匿名汇总。
- 不改钩子事件、会话状态机、事件统计口径、手机访问和 CSRF 规则。
- 不运行任何 `claude plugin` 命令（`validate` 除外），不碰 `~/.claude/waiting-room`、`~/.claude/settings.json`、`~/waiting-room-dev`。
