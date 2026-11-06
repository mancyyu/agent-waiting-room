# Changelog

## 0.4.0 — 2026-11-06

- New setting `notifyMinSeconds` (default 10): turns shorter than this no longer send the *Done* notification. *Needs input* and *Failed* always notify. Also on the Settings tab.
- System notifications on Linux (`notify-send`) and on Windows and WSL (PowerShell toast). Not yet verified on real hardware.
- A one-time note at the top of the page the first time it opens on its own: what opened it, why, and how to switch to remind-only.
- Plugin icon.

## 0.3.1 — 2026-11-06

- Fix: after a plugin upgrade, an older local server left running on the port (it never idles out while the page is open) kept serving the old page. The hooks now compare the running server's version and replace it.

## 0.3.0 — 2026-11-06

Public release.

- English and Chinese UI, notifications and command output. New `lang` setting (`auto` / `zh` / `en`); `auto` follows the browser for the page and the OS locale for notifications.
- Installable from GitHub: `claude plugin marketplace add mancyyu/agent-waiting-room`. The marketplace is now named `waiting-room` (was `waiting-room-local`).
- About tab with version, GitHub link and copyable install commands.
- Slash-command skills rewritten in English, with the Chinese phrase table kept.
- New endpoint `POST /api/lang-hint` so the page can tell the backend which language it resolved; stored in `hub.json`, not in config.

## 0.2.0 — 2026-11-05

- Status board for several sessions at once; *Needs you* sorts first; *Probably ended* after 10 minutes of silence; stale sessions cleaned up after 2 hours.
- *Remind only* mode (`mode=remind`): no auto-open, notifications only, Games and Relax tabs hidden.
- Quiet hours, configurable auto-open delay, notification toggle.
- Relax tab: Box Breathing, 20-20-20 eye break, stretches.
- My Data tab: open rate while waiting, turns over 30 s, games played, active days, 14-day sparkline, waiting-time histogram, anonymised export.
- Optional phone access on the LAN with a per-machine token; Host allowlist, CSRF checks, 4 KB body limit.
- `StopFailure` hook → *Failed* state. 64 automated tests.

## 0.1.0 — 2026-11-04

- First prototype: hooks for submit / stop / notification, a local page with one game, macOS notification when Claude finishes.
