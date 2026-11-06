---
name: config
description: View or change Waiting Room settings - reminder mode, auto-open, delay seconds, system notifications, quiet hours, local stats, phone access, language, local port. 查看或修改「等一下」的设置：提醒模式、自动打开、等待秒数、系统通知、勿扰时段、本机统计、手机访问、语言、本地端口。
disable-model-invocation: true
argument-hint: "[e.g. remind only / quiet hours 11pm-8am / delay 40s / switch to English / 只要提醒 / 勿扰 23:00-08:00 / 打开手机访问]"
allowed-tools:
  - Bash(waiting-room config)
  - Bash(waiting-room config *)
---

The user's request about Waiting Room (等一下) settings: $ARGUMENTS

Use only the Bash tool and only the command `waiting-room config ...` to view or change settings. Do not edit any files directly and do not run any other command. If the shell says `waiting-room` cannot be found, replace the start of the command with `sh "${CLAUDE_PLUGIN_ROOT}/bin/waiting-room"` and keep the arguments unchanged.

**If the request above is empty**: run `waiting-room config` and briefly list the current settings (mode, auto-open, notifications, quiet hours, local stats, phone access, language is enough). Then give two examples of changes, such as `/agent-waiting-room:config remind only` and `/agent-waiting-room:config quiet hours 23:00-08:00`.

**If the user asked for a change**: translate the request into `key=value` pairs from the table below and run them in one command, for example `waiting-room config mode=remind quietHours=23:00-08:00`.

| Key | Values | Meaning |
| --- | --- | --- |
| `mode` | `both` / `remind` | `both` = remind + games; `remind` = remind only: the page hides games and relaxation, never auto-opens, and only sends notifications |
| `autoOpen` | `true` / `false` | open the waiting room in the browser once an agent has worked longer than `delaySeconds` (ignored when `mode=remind`) |
| `delaySeconds` | integer 0–3600 | seconds to wait before auto-opening |
| `notify` | `true` / `false` | system notification when an agent finishes, needs input, or fails |
| `quietHours` | a window like `23:00-08:00`, or `off` | quiet hours: no auto-open and no notifications in that window; may cross midnight |
| `metrics` | `true` / `false` | keep usage stats on this computer only (never uploaded); the "My Data" page depends on them |
| `lan` | `true` / `false` | phone access: phones on the same Wi-Fi can open the waiting room with a token |
| `lanToken` | only `reset` | generate a new phone-access token; old phone links stop working |
| `lang` | `auto` / `zh` / `en` | language of notifications and command output; `auto` follows the web page, otherwise the system locale |
| `port` | integer 1024–65535 | local web port; change it only when the default port is taken |

Common phrasings and the keys they map to:

| What the user says | Run |
| --- | --- |
| "remind only", "no games", "turn off the games", 「只要提醒」「不要小游戏」 | `mode=remind` |
| "bring the games back", "remind + games", 「恢复小游戏」 | `mode=both` |
| "quiet hours 11pm to 8am", "don't disturb me at night" (ask for the window if not given), 「晚上别打扰我」 | `quietHours=23:00-08:00` |
| "turn off quiet hours", 「关掉勿扰」 | `quietHours=off` |
| "wait 40 seconds before opening", "delay 40s", 「延迟 40 秒」 | `delaySeconds=40` |
| "don't open the browser automatically", 「别自动打开」 | `autoOpen=false` |
| "turn off notifications", 「关掉通知」 | `notify=false` |
| "stop recording stats", 「别记统计」 | `metrics=false` |
| "I want to see it on my phone", "phone access", 「手机也想看」「打开手机访问」 | `lan=true` |
| "switch to English", "use English", 「用英文」 | `lang=en` |
| "switch to Chinese", 「切换成中文」「用中文」 | `lang=zh` |
| "follow the system language", 「语言自动」 | `lang=auto` |

The command also accepts Chinese values on the command line (`mode=只要提醒`, `lang=中文`, `lang=英文`, `lan=开`), but the English keys above are the safest form.

**When phone access is involved, add one sentence**: after `lan=true`, tell the user to enable it only on a trusted home or office network; the phone URL carries a token and is shown on the Settings page after opening the waiting room on this computer. The command output never shows the token, and you must not look for it elsewhere. If the user worries that the link leaked, run `lanToken=reset`.

After running, tell the user in one sentence what changed. If the output starts with "Not saved" / 「没有保存」, relay the reason and state the valid range for that key.

Reply in the language the user wrote in.
