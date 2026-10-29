# Cache Statusband

A Claude Code mod that keeps a big chat's prompt cache warm, warns before an expensive cold restart, and draws a colour-blocked status band above the prompt with the numbers you'd otherwise need a status line for.

```
 Opus 5.5 ▶ high ▶ ctx 287k · rewrite ≈ $2.29 ▶ ● cache warm 42m ▶ 5h 27% · 3h22m ▶ week 33% · 5d19h ▶ Fable wk 6% ▶ session $23 ▶ you@example.com ▶
```

It works in the terminal and in the Desktop app's Code tab, so it replaces a command status line.

## Credits

This mod is built on two projects. Both are MIT-licensed.

- **[Cache Keeper](https://github.com/nateherkai/claude-code-mods) by Nate Herk.** The whole cache side is his: the warm/cold tracking, keep warm, the cold-send guard, `/board`, `/handoff` and the session-handoff skill. This repository started from his version 1.0.0.
- **[ccstatusline](https://github.com/sirmalloc/ccstatusline) by Matthew Breedlove (sirmalloc).** The band's look (coloured segments, powerline-style arrows) and the choice of what to show (model, effort, context, 5-hour and weekly usage with reset times) follow ccstatusline. No ccstatusline code is used.

## What it adds to Cache Keeper

- **A status band, always shown.** Coloured segments for:
  - model and effort (terminal only, since the app's composer already shows them)
  - context size and the cost of rewriting it
  - cache state
  - 5-hour and weekly usage with time to reset
  - weekly Fable usage
  - session cost
  - the signed-in account's email (terminal only; masked while recording mode is on), or a seat label when a seat file is configured
- **Weekly Fable usage.** Read from the same usage endpoint the app's usage card reads, through the session's own credential (the mod never sees the token). One check every 5 minutes, shared by every open session, and it honours the server's `Retry-After`. No model tokens are spent.
- **Reopened chats are measured before you send.** When you resume or reopen a chat, the mod reads the end of its transcript: the last reply's token usage is what your first message will re-read, and its time says how cold the cache is. So you see the real context size and the cache's age straight away, and the cold-send guard can offer "compact first, then send" on your first message.
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
| `/cache` | Status and settings: `ttl 5\|60\|auto`, `guard on\|off`, `big 150k`, `alerts on\|off`, `autowarm 8\|off` |
| `/keepwarm [hours\|off]` | Keep this chat's cache warm (default 4 hours) |
| `/board` | Every local Claude Code chat: state, context, cache, cost |
| `/handoff [continue]` | Session handoff, then clear this chat and continue with it |

## Optional settings

Everything below is off by default. Set the values in Claude Code's config menu, or in `~/.claude/settings.json` under `pluginConfigs`:

| Setting | What it does |
|---|---|
| `seatFileTerminal` | For account rotators: a file holding the active seat's label (e.g. `~/.claude-cli-accounts/.active`). The band shows `seat <label>` in place of the account email, and a change marks the cache cold. |
| `seatFileDesktop` | The same for sessions the Desktop app runs (only used to notice a rotation). |
| `rotatorWakePattern` | A regular expression matching the prompt an unattended account rotator types after rotating. That prompt is compacted first without asking, since nobody is there to answer. |
| `prPattern` | A regular expression whose first group is a PR number, matched against a chat's first prompt (e.g. `(?:^\|\s)/?merge-pr\s+#?(\d+)`). Keep warm then stops once `gh` reports that PR merged or closed. |

## Fonts

The arrows are `▶` (U+25B6), which every font has. The true Powerline arrow (U+E0B0) needs a Nerd Font in the terminal and has no font in the Desktop app.

## License

MIT. See [LICENSE](LICENSE), which keeps Nate Herk's copyright notice.
