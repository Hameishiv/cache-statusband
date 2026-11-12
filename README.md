# Cache Statusband

A status band and prompt-cache guard for coding agents. The main version is a Claude Code mod. It keeps a big chat's prompt cache warm, compacts a big chat before an expensive cold rewrite, resumes chats cut short by spent usage, and draws a colour-blocked status band above the prompt with the numbers you'd otherwise need a status line for.

```
 Opus 5.5 ▶ High ▶ Ctx 287k · Rewrite ≈ $2.29 ▶ ● Cache warm 42m ▶ Cold rewrites $4.10 (2) ▶ 5h 27% · 3h22m ▶ Week 33% · 5d19h ▶ Fable 6% ▶ Session $23 ▶ you@example.com
```

It works in the terminal and in the Desktop app's Code tab, so it replaces a command status line.

## Three versions

| Folder | Agent | What it covers |
|---|---|---|
| repository root | Claude Code | Everything below. |
| [`codex/`](codex/) | OpenAI Codex CLI | What Codex lets an add-on do: its built-in footer set up to show model, effort, context and 5-hour/weekly usage; a hook that reports a reopened session's last context size; a `board` command listing local sessions. |
| [`grok/`](grok/) | xAI Grok Build | A status-line command showing model, effort, context, cache token counts, weekly usage and session cost. |

The cache half (keep warm, the cold-send guard, rewrite costs) exists only in the Claude Code version. It is built around Anthropic's prompt cache, which expires after 5 minutes or an hour and charges extra to write again. OpenAI and xAI cache automatically, with no lifetime the user pays to renew, so there is nothing for it to act on there. Each port's README says what it ported, what it could not, and why.

## Credits and origin

Two MIT-licensed projects made this possible.

- **[Cache Keeper](https://github.com/nateherkai/claude-code-mods) by Nate Herk.** The Claude Code version started from his version 1.0.0, and his code is still its core: the warm/cold tracking, keep warm, the cold-send guard, `/board`, `/handoff`, the session-handoff skill, the pricing table and recording-mode masking. 
- **[ccstatusline](https://github.com/sirmalloc/ccstatusline) by Matthew Breedlove (sirmalloc).** The band's look (coloured segments, powerline-style arrows) and the choice of what to show (model, effort, context, 5-hour and weekly usage with reset times) follow ccstatusline. No ccstatusline code is used.

## What it adds to Cache Keeper

- **A status band, always shown.** Coloured segments for:
  - model and effort (terminal only, since the app's composer already shows them)
  - context size and the cost of rewriting it
  - cache state, and what this chat has already paid to rewrite cold caches (kept when the chat is reopened)
  - 5-hour and weekly usage with time to reset
  - weekly Fable usage
  - session cost
  - the signed-in account's email (terminal only; masked while recording mode is on), or a seat label when a seat file is configured
- **Weekly Fable usage.** Read from the same usage endpoint the app's usage card reads, through the session's own credential (the mod never sees the token). One check every 5 minutes, shared by every open session, and it honours the server's `Retry-After`. No model tokens are spent.
- **Reopened chats are measured before you send.** When you resume or reopen a chat, the mod reads the end of its transcript: the last reply's token usage is what your first message will re-read, and its time says how cold the cache is. So you see the real context size and the cache's age straight away, and the cold-send guard can compact before your first message goes. A transcript over 4 MB is too big for the Desktop app to read, so the mod also keeps each chat's last context size and time in its own store and falls back on that.
- **A cold chat compacts first.** When a chat over the guard's size has sat past its cache's lifetime and a message arrives, whether you typed it or it came from something else (another session, a task notification, a schedule, the app itself), the mod runs `/compact` and then sends the message, with no dialog, so the cold read is of a short summary rather than the whole chat. The same goes for a big chat reopened, or moved to another account, since its last reply, and for Claude Code's own continue after a usage limit resets (it then reports that its automatic continue did not run, and a toast says the mod sends it after compacting; if that resend fails under the same reset, Claude Code does not retry it). It skips attachments (a resend would drop the file, so when a compaction would otherwise have run you are asked to send yours anyway or cancel, and otherwise it goes as typed; anything but "Send anyway", including text typed under Other, cancels, and Cancel puts its text back in the prompt box when it can and says so when it cannot), a plain `claude -p` run's prompt, slash commands from anyone but you (yours goes back in the prompt box after compacting; your own `/compact`, `/clear`, this mod's own commands and a typed `/session-handoff` are never compacted first), engine notices (an idle notice or a delivery receipt; a message from another session is not one), chats that have grown by less than 100k tokens since their last compaction (or since a compaction the compactor refused), a second try within 2 minutes of one that failed (a rotation's wake-up and auto-resume may retry, since the new account may succeed), or while one is still running. A message that arrives while the compaction runs waits and goes after it, in order (a slash command, an attachment, an engine notice, a plain `claude -p` run's prompt, or a prompt of yours with an `@` mention does not wait), and a message that cannot be sent again is put back in the prompt box, together with the ones behind it (if the prompt box cannot take them, as under a dialog, or a slash command was already put back there, they are logged and the toast says how many), after a blank line so it does not run into what you have typed. If you `/clear`, `/resume` or `/fork` while a compaction is running, the messages waiting on it are put back in the prompt box rather than sent into the new chat (a slash command among them is logged instead, so one Enter cannot run it in the new chat); a message from another session or a task is resent marked with who sent it, as a message from the mod and not as the person's own words (another plugin's prompt sent as the person's own words is resent as the person's). A resend Claude Code holds for over 10 minutes is left to it, and the ones behind it go back to the prompt box; a slash command is never put back over what you have typed. Each decision is logged, in local time, to `~/.claude-shared/state/cache-keeper-cold-compact-log-<session id>.txt` when that folder exists; past 512 Ki characters a file keeps only its newest lines, and a message over 32 Ki characters is logged cut to its first 32 Ki, with its full length. Any message that could be neither resent nor put back, up to 4 MiB, is also kept whole in `cache-keeper-lost-<session id>-<epoch ms>-<n>.txt`; so is one over 32 Ki characters waiting on a compaction, in case a mod reload drops the queue, so a file there does not by itself mean the message was lost. A prompt of yours with an `@` mention goes back in the prompt box after compacting, since a resend would not attach the file.
- **Auto-resume after usage renews (opt-in).** When a turn is cut short because the plan's usage ran out, the band shows `⏸ resumes <time>` and the chat is sent "Resume" a minute after the full window resets. Only usage exhaustion arms it: a short throttle or an overload does not. Anything sent to the chat first cancels it. The Desktop app's "Try again" prompt is drawn by the app itself, which a mod cannot remove, so it may stay on screen; the resume goes to the session either way.
- **Usage on a fresh or reopened chat.** Until a chat has made its own request, the 5-hour and weekly figures come from the freshest open chat on the same account, then from the shared usage check.

## Requirements

- Claude Code with mods turned on for your account (run `claude plugin test` in any folder: "no hooks module to load" means mods can load).
- `gh` (GitHub CLI) only if you use the PR setting below.

## Install

At the prompt of a terminal session:

```
/plugin install cache-statusband --marketplace Hameishiv/cache-statusband
```

From a shell:

```bash
claude plugin install cache-statusband --marketplace Hameishiv/cache-statusband
```

In the Desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Hameishiv/cache-statusband`, then **Add plugin**.

If you also have Nate Herk's `cache-keeper` installed, turn one of them off: they track the same thing.

## Commands

| Command | What it does |
|---|---|
| `/cache` | Status and settings: `ttl 5\|60\|auto` (`auto` assumes the 1-hour cache unless a request reports its TTL, and so do keep warm, the cold-send guard and the cost figures; on the 5-minute API cache set `ttl 5`; like every `/cache` setting it applies to every session on this machine), `guard on\|off`, `big 150k`, `alerts on\|off`, `autowarm 8\|off` |
| `/keepwarm [hours\|off]` | Keep this chat's cache warm (default 4 hours) |
| `/board` | Every local Claude Code chat: state, context, cache, cost |
| `/handoff [continue]` | Session handoff, then clear this chat and continue with it |

## Optional settings

Everything below is off by default. Set the values in Claude Code's config menu, or in `~/.claude/settings.json` under `pluginConfigs`:

| Setting | What it does |
|---|---|
| `seatFileTerminal` | For account rotators: a file holding the active seat's label (e.g. `~/.claude-cli-accounts/.active`). Read when a session starts: the band shows `seat <label>` in place of the account email. A running session keeps the account it signed in with, so a change counts (and marks the cache cold) only once the rotator's wake-up prompt reaches that session. |
| `seatFileDesktop` | The same for sessions the Desktop app runs, so each seat keeps its own usage reading. |
| `rotatorWakePattern` | A regular expression matching the prompt an unattended account rotator types after rotating. That prompt is compacted first without asking, since nobody is there to answer. |
| `autoResume` | `true` to turn on auto-resume (above). Off by default because it spends usage without asking. |
| `prPattern` | A regular expression whose first group is a PR number, matched against a chat's first prompt (e.g. `(?:^\|\s)/?merge-pr\s+#?(\d+)`). Keep warm then stops once `gh` reports that PR merged or closed. |

## Fonts

The arrows are `▶` (U+25B6), which every font has. The true Powerline arrow (U+E0B0) needs a Nerd Font in the terminal and has no font in the Desktop app.

## License

MIT. See [LICENSE](LICENSE), which keeps Nate Herk's copyright notice.
