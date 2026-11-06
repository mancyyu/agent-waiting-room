# 让 Codex CLI 和 Cursor 也接上「等一下」

「等一下」靠钩子知道 agent 在干什么。Claude Code 装好插件就自动接上了；Codex CLI 和 Cursor 也有自己的钩子机制，只要在它们的钩子配置里调用同一个 `bin/waiting-room` 命令，再加上 `--agent codex` 或 `--agent cursor`，等候室就能显示它们的会话，干完时也会弹通知。

> **未实测**：下面的配置格式和字段名，来自 2026-11-05 查阅的 Codex 和 Cursor 官方文档。我们没有在真实的 Codex 或 Cursor 里跑过这些配置。命令行这一侧有自动化测试：`tests/run-tests.js` 用模拟的 Codex、Cursor 输入跑过一遍，测的是字段兼容和事件对应，不能代替真机验证。

## 准备

1. 找到插件文件夹的绝对路径，例如 `/Users/你/waiting-room-dev/agent-waiting-room`。下文用 `<插件目录>` 代替它。
2. 确认电脑上装了 Node.js（终端里 `node -v` 能看到版本号）。
3. 下面的例子用 `sh` 运行脚本，适用于 macOS 和 Linux。Windows 上没有 `sh`，这些例子不能直接用。

先在终端里手动试一次，确认命令能跑通：

```bash
echo '{"session_id":"adapter-test","cwd":"/tmp/demo"}' | sh "<插件目录>/bin/waiting-room" hook prompt --agent codex
sh "<插件目录>/bin/waiting-room" status
echo '{"session_id":"adapter-test"}' | sh "<插件目录>/bin/waiting-room" hook end --agent codex
```

第二条命令应该列出「Codex · demo — 工作中」。第三条命令会把这条测试会话删掉。

## 命令格式

```
sh "<插件目录>/bin/waiting-room" hook <事件> --agent <codex|cursor> [--json]
```

| 事件 | 含义 | 会话变成 |
| --- | --- | --- |
| `prompt` | 你发出了一条消息 | 工作中，开始计时 |
| `stop` | agent 这一回合结束了 | 干完了（Cursor 的 `status` 为 `error` 时记为出错了） |
| `fail` | 回合因为出错而结束 | 出错了 |
| `permission` | agent 在等你批准一个操作 | 等你确认 |
| `tool` | 一个工具跑完了 | 如果原来是等你确认，回到工作中 |
| `interrupt` | 你自己打断了这一回合 | 干完了，但不发通知 |
| `end` | 会话结束 | 从等候室里移除 |

几点补充：

- 事件名也可以直接写对方的原生名字，比如 `UserPromptSubmit`、`PermissionRequest`、`beforeSubmitPrompt`、`sessionEnd`，命令会自动对应。不写事件名时，命令会读 stdin 里的 `hook_event_name`。
- `--json` 会让命令往标准输出打印一个「放行」用的 JSON：`prompt` 事件打印 `{"continue":true}`，其他事件打印 `{}`。有的 agent 要求钩子输出 JSON，就加上它。Claude Code 不需要这个参数。
- 命令出任何错都以退出码 0 结束，不会挡住 agent 干活。

### 从 stdin 读哪些字段

| 用途 | 读的字段 | 说明 |
| --- | --- | --- |
| 会话 ID | `session_id`，其次 `conversation_id`、`sessionId`、`conversationId`、`thread_id` | Claude Code 和 Codex 用 `session_id`，Cursor 用 `conversation_id` |
| 项目名 | `cwd`，其次 `workspace_roots` 的第一项 | 只取最后一级文件夹名。Cursor 没有 `cwd`，用的是 `workspace_roots` |
| 回合结果 | `status`（Cursor 的 `stop`） | `completed` 记为干完了；`aborted` 记为干完了、不发通知；`error` 记为出错了 |
| 错误类型 | `error` | 只认 Claude Code `StopFailure` 文档列出的类型，其余记为 `unknown` |

除了上表，其他字段一概不读。你的提示词、agent 的回复、要执行的命令内容都不会被存下来。

## Codex CLI（未实测）

官方文档：<https://developers.openai.com/codex/hooks>（2026-11-05 查阅时跳转到 learn.chatgpt.com/docs/hooks）

**配置文件放在哪**：

- 全局：`~/.codex/hooks.json`
- 只对某个仓库：`<仓库>/.codex/hooks.json`。这个仓库的 `.codex/` 要先被 Codex 信任，项目里的钩子才会加载。
- 也可以写在 `~/.codex/config.toml` 的 `[hooks]` 表里。同一层里两种写法都有时，Codex 会合并它们并在启动时给出警告，所以二选一就好。

**要注意的开关**：文档说钩子默认开启。如果你的 `config.toml` 里写过 `[features]` 下的 `hooks = false`（旧名字叫 `codex_hooks`），要改回 `true`。另外，新加的钩子要在 Codex 里输入 `/hooks` 审核并信任之后才会运行。

**用到的事件**：Codex 会把 `session_id`、`cwd`、`hook_event_name` 等字段通过 stdin 传给钩子，`turn_id` 只出现在部分事件里。我们用下面 6 个事件：

| Codex 事件 | 对应的命令 |
| --- | --- |
| `UserPromptSubmit` | `hook prompt` |
| `PermissionRequest` | `hook permission` |
| `PostToolUse` | `hook tool` |
| `Stop` | `hook stop --json` |
| `Interrupt` | `hook interrupt` |
| `SessionEnd` | `hook end` |

`Stop` 加 `--json` 是因为文档写着 Stop 钩子退出码为 0 时「期望 stdout 是 JSON」，纯文本算无效。同一份文档的通用规则又说「退出码 0、没有输出」算成功，两处说法不完全一致，所以输出一个空对象 `{}` 最稳妥。

`PermissionRequest` 钩子没有给出决定时，Codex 会照常弹出批准请求。我们的命令只记录「等你确认」，不替你做批准或拒绝的决定。

`Interrupt` 和 `SessionEnd` 的超时默认只有 1 秒，最多 3 秒，所以下面给它们设了 3 秒。

**`~/.codex/hooks.json` 示例**（把 `<插件目录>` 换成真实路径）：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "sh \"<插件目录>/bin/waiting-room\" hook prompt --agent codex", "timeout": 5 } ] }
    ],
    "PermissionRequest": [
      { "hooks": [ { "type": "command", "command": "sh \"<插件目录>/bin/waiting-room\" hook permission --agent codex", "timeout": 5 } ] }
    ],
    "PostToolUse": [
      { "hooks": [ { "type": "command", "command": "sh \"<插件目录>/bin/waiting-room\" hook tool --agent codex", "timeout": 5 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "sh \"<插件目录>/bin/waiting-room\" hook stop --agent codex --json", "timeout": 5 } ] }
    ],
    "Interrupt": [
      { "hooks": [ { "type": "command", "command": "sh \"<插件目录>/bin/waiting-room\" hook interrupt --agent codex", "timeout": 3 } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "sh \"<插件目录>/bin/waiting-room\" hook end --agent codex", "timeout": 3 } ] }
    ]
  }
}
```

更喜欢写在 `config.toml` 里的话，每个事件写成两层表。以 Stop 为例：

```toml
[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = 'sh "<插件目录>/bin/waiting-room" hook stop --agent codex --json'
timeout = 5
```

**Codex 这边的限制（未实测）**：

- Codex 的事件列表里没有单独的「出错」事件。回合因为出错而结束时，等候室可能显示「干完了」，也可能一直显示「工作中」。后一种情况超过 10 分钟会被标记为「可能已经停了」。
- 文档没写钩子命令用哪个 shell 解释。示例里显式写了 `sh`，就是为了不依赖默认 shell。

## Cursor（未实测）

官方文档：<https://cursor.com/docs/agent/hooks>

**配置文件放在哪**：

- 用户级：`~/.cursor/hooks.json`。命令从 `~/.cursor/` 目录启动。
- 项目级：`<项目>/.cursor/hooks.json`。命令从项目根目录启动。
- 文件顶层必须有 `"version": 1`。
- 命令可以是任意 shell 字符串。建议写插件的绝对路径，这样不受启动目录影响。

**用到的事件**：Cursor 传给所有钩子的公共字段里有 `conversation_id`、`hook_event_name`、`workspace_roots`，但没有 `cwd`；`stop` 事件另外带 `status`。我们用下面 4 个事件：

| Cursor 事件 | 对应的命令 |
| --- | --- |
| `beforeSubmitPrompt` | `hook prompt --json`（输出 `{"continue":true}`，明确放行这条消息） |
| `postToolUse` | `hook tool` |
| `stop` | `hook stop --json`（输出 `{}`，表示不追加后续消息） |
| `sessionEnd` | `hook end` |

`beforeSubmitPrompt` 加 `--json`，是因为文档没写清楚「什么都不输出」会被怎样对待。显式输出 `{"continue":true}` 是文档里列出的合法写法，不会挡住你发消息。

**`~/.cursor/hooks.json` 示例**：

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      { "command": "sh \"<插件目录>/bin/waiting-room\" hook prompt --agent cursor --json" }
    ],
    "postToolUse": [
      { "command": "sh \"<插件目录>/bin/waiting-room\" hook tool --agent cursor" }
    ],
    "stop": [
      { "command": "sh \"<插件目录>/bin/waiting-room\" hook stop --agent cursor --json" }
    ],
    "sessionEnd": [
      { "command": "sh \"<插件目录>/bin/waiting-room\" hook end --agent cursor" }
    ]
  }
}
```

**千万不要接到这几个事件上**：`beforeShellExecution`、`beforeMCPExecution`、`beforeReadFile`、`preToolUse`、`subagentStart`。Cursor 文档把它们叫作「权限钩子」，权限钩子的输出不是合法 JSON 时，Cursor 会直接拦下这个操作。我们的命令不输出权限决定，接上去会挡住 agent 干活。

**Cursor 这边的限制（未实测）**：

- Cursor 没有「等你批准」或「通知」类的事件，所以 Cursor 会话不会显示「等你确认」，只有「工作中」「干完了」「出错了」三种状态。
- `stop` 的 `status` 为 `aborted` 时，我们当作你自己打断了这一回合，记为干完了、不发通知。

## 怎么确认接上了

在 Codex 或 Cursor 里发一条需要干一会儿的消息，然后在终端运行：

```bash
sh "<插件目录>/bin/waiting-room" status
```

列表里应该出现「Codex · 项目名 — 工作中」或「Cursor · 项目名 — 工作中」。等候室网页上也会多一张对应的卡片。如果什么都没有，先用上面「准备」一节的手动命令确认脚本能跑，再查看 `~/.claude/waiting-room/waiting-room.log` 里有没有报错。

## 参考

- Claude Code 钩子文档（`StopFailure` 等事件）：<https://code.claude.com/docs/en/hooks>
- Codex 钩子文档：<https://developers.openai.com/codex/hooks>
- Cursor 钩子文档：<https://cursor.com/docs/agent/hooks>
