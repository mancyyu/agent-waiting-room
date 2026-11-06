---
name: open
description: Open the Waiting Room hub (a local web page) in the browser right now, to see the status of every agent session and play a quick game or relax while waiting. 立刻在浏览器打开「等一下」等候室（本地网页）：看各个 agent 会话的状态，等的时候玩一局小游戏或放松一下。
disable-model-invocation: true
allowed-tools:
  - Bash(waiting-room open)
---

The user wants to open the Waiting Room (等一下) hub now.

Run exactly this one command with the Bash tool, and no other command:

```
waiting-room open
```

If the shell says `waiting-room` cannot be found, run this instead:

```
sh "${CLAUDE_PLUGIN_ROOT}/bin/waiting-room" open
```

The command prints a single line in the user's configured language (Chinese or English). Relay that line to the user in one sentence that includes the URL. If the line says the port is in use or the local server did not start, pass it on as-is and mention that `/agent-waiting-room:config port=47824` switches to another port.

Do nothing else: do not read or write any files, and do not run other commands.

Reply in the language the user wrote in.
