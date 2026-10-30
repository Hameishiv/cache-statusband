# Cache Statusband

A status band and prompt-cache guard for coding agents. The main version is a Claude Code mod. It keeps a big chat's prompt cache warm, warns before an expensive cold rewrite, resumes chats cut short by spent usage, and draws a colour-blocked status band above the prompt with the numbers you'd otherwise need a status line for.

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
- **Weekly Fable usage.** Read from the same usage endpoint the app's usage card reads, through the session's own credential (the mod never sees the token). One check every 5 minutes per account (per seat when a seat file is set), shared by that account's open sessions, and it honours the server's `Retry-After`. A session that can name neither a seat nor an account (signed in, or with its sign-in check not yet answered) fetches for itself and shares nothing: it reads and writes no shared reading, lends no windows to other sessions and borrows none. No model tokens are spent.
- **Reopened chats are measured before you send.** When you resume or reopen a chat, the mod reads the end of its transcript: the last reply's token usage is what your first message will re-read, and its time says how cold the cache is. So you see the real context size and the cache's age straight away, and the cold-send guard can offer "compact first, then send" on your first message. A transcript over 4 MB is too big for the Desktop app to read, so the mod also keeps each chat's last context size and time in its own store and falls back on that. It also keeps the seat and the account that request ran on: a chat reopened on a different seat (compared only when both are on the same surface, terminal or Desktop), or else on a different account, reads cold, since that account's cache is empty. If neither can be compared, it is taken as unchanged, unless this session itself saw a rotation after the chat's last touch (its last reply in the transcript, or its record's last request or keep-warm ping), which makes it cold. After a rotator's wake-up, a seat or account that still looks unchanged (or an account file that reads empty) is treated as unknown for up to 3 minutes while the rotator finishes writing (the mod keeps looking, each file on its own, and takes a late change as that rotation, marking the cache cold if a request has run since. The account is what switches the credential and the seat label can be written before it, so a late account marks it even after a late seat, unless the wake-up itself already showed the seat change; a late seat never marks it once the account was already taken); a chat resumed meanwhile is compared by the fields that are known, or by time alone. After that the session keeps the seat and account it has, and a later change counts only with the next wake-up. Meanwhile, while the seat or the account is unknown, the session takes no plan usage reading, lends no usage windows to other sessions (and, while the account is unknown, names no account in its heartbeat), and neither borrows from them nor shows or resumes on the shared windows and Fable reading, since the key they are filed under may still name the old account (a reading would be filed under the wrong one); a plan fetch that was already out when the wake-up came is dropped. Once the seat or the account is known to have changed, whether at the wake-up or late, the session drops the old account's readings, its own 5-hour and weekly ones included, and moves a resume still pending that was armed from them to a minute from then, since the new account presumably has usage (the three-try cap still holds), until a request measures the new account's. A wake-up prompt is itself the resume, so one armed before it is not moved: the request the wake-up starts settles it, and until that request starts (or the 3 minutes end) a due resume waits. While the seat or the account is unknown a due resume waits, until the seat and account are both known or the 3 minutes end, without spending a try or compacting. A request already out when the account changed reports the old account's windows, which are ignored; if it fails on that account's usage, a resume is armed for a minute from then without spending a try. Until a new request measures, the band shows the readings it can borrow or fetch for the new account. Without a seat file the account is read when the session starts, so switching accounts with /login inside a running session isn't seen until it restarts (or a rotator's wake-up prompt, which reads it again); and a `--fork-session` started in a new process has no record, so it is judged from its transcript time alone. The stored time also counts keep-warm pings, which never reach the transcript.
- **Auto-resume after usage renews (opt-in).** When a turn is cut short because the plan's usage ran out, the band shows `⏸ resumes <time>` and the chat is sent "Resume" a minute after the full window resets. Only usage exhaustion arms it: a short throttle or an overload does not. A message that reaches the chat settles it: the request that message starts (any main-loop request; a subagent's does not) removes the pending resume, so a later account change does not bring it back. /clear and resuming another chat cancel it too. A rotator's wake-up is itself the resume: a due resume waits from the wake-up's arrival until its request starts. A local command such as /usage or /cache (but not /plan with a description, which goes to the model unless the chat is already in plan mode, where it only shows the plan: a mod is not told the permission mode, so it counts as a send either way), a message another hook drops, or a send you cancel in the cold-send dialog leaves it pending (the cold-send guard itself skips the same local commands, except `/btw` with a question, which sends the chat to the model and so gets the dialog on a cold chat; a bare `/btw` stays local, and so does `/btw` with a question while a turn is running, whose requests keep the cache warm), and a due resume waits while the guard's dialog is open, while any send handed on that is not this mod's own is being handed on or has not yet started its request (for at most 2 minutes), or while a compaction before your send is running. A resume still pending that was armed from a full window is tried a minute after the account changes (a rotator's wake-up) instead of at that window's reset, since the window was the old account's. With no known reset time it tries hourly, three times at most. On a big chat it compacts first, and while that runs a message that reaches the chat (another plugin's too), a rotator wake-up arriving, /clear, or resuming another chat cancels the Resume (a local command or a message another hook drops does not). A cold-send dialog open for a message of yours holds the Resume until it closes: Cancel lets it go, Send anyway or Compact first cancels it (a `/btw` question does not: it never reaches the chat). A Resume cancelled that way, with no request of any message starting within 2 minutes (for example a "Compact first" on a slash message, which goes back to the prompt box), is armed again 2 minutes after the cancel, the band showing `⏸ resumes` meanwhile; if that compaction succeeded, it goes without compacting again (nor does a "Compact first" answered after it compact again). If the Resume's compaction failed and you answered Cancel on a cold-send dialog for a message of yours while it compacted, the Resume is not sent uncompacted: it is armed again 2 minutes later, compacting again; if that compaction fails too, it is not sent at all and a toast says to send Resume yourself (for a `/btw` question, an answer other than Cancel, such as Send anyway, does not count: the Resume goes as typed; for an ordinary message Send anyway cancels the Resume, which is armed again). A rotator wake-up arriving while the Resume compacts waits for that compaction and uses it if it succeeded. A compaction still running after 15 minutes is abandoned, so a hung one does not hold the Resume, a message or a wake-up for good, but it may still finish: until it does, no send starts another compaction. The message you chose "Compact first" for, the wake-up's and any send that was waiting on that compaction when it was abandoned go back in the prompt box together, in the order sent, as one text (a slash command is never joined with other text: a toast quotes it to send again), and none of them is sent uncompacted. A message you send while that compaction is still out goes back behind the text of an earlier put-back that is still unsent in the box, so a later fill never removes it (a slash command is not joined: a toast quotes it), and the cold-send dialog then offers only Send anyway and Cancel and says an earlier compaction is still running. A Resume still pending waits until you send what was put back, you clear the chat, or 15 minutes have passed since the put-back, so it never goes ahead of a message you still have to send; while it waits the band shows `⏸ Resume waits for your message` instead of a time. A message that could not be put back, or a `/btw` question (it never reaches the chat), holds nothing. The Resume is tried again 2 minutes later without starting another compaction while the abandoned one is still out (a counted try, four in all; the last toast names the cause of the last failed try: a send refused, or compaction not finished). If the abandoned compaction finishes later and succeeded, the chat counts as compacted and later sends go without compacting again. A compaction started in a chat that has since been cleared or replaced is never remembered and never counts for the new chat: a message waiting on it is not sent into the new chat nor put back in its box (a toast says "Not sent, because the chat was cleared" and quotes it), a send in the new chat does not wait on it, and while it is still out the engine's compaction notices are ignored, so its late end does not mark the new chat compacted. The mark is forgotten when any later compaction succeeds (your own /compact too; one that started before a newer abandoned compaction does not forget that one), once a second 15 minutes have passed, and on /clear or resuming another chat. If the Resume cannot be sent at all, whether directly or after compacting, it is tried again 2 minutes later, four attempts in all, then a toast says to send it yourself; a request that starts or a chat that is cleared or replaced meanwhile settles it, so it is not tried again into that chat. The Desktop app's "Try again" prompt is drawn by the app itself, which a mod cannot remove, so it may stay on screen; the resume goes to the session either way.
- **Usage on a fresh or reopened chat.** Until a chat has made its own request, the 5-hour and weekly figures come from the freshest open chat on the same seat (or, with no seat file, the same signed-in account; a chat whose account is unknown borrows nothing), then from the usage check shared by that account's sessions (by seat when a seat file is set).

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

Auto keep warm (the default for big chats, `/cache autowarm 8|off`) stops on its own once its pings since your last message have cost as much as the rewrite they protect. On a 5-minute cache that happens much sooner than on a 1-hour one. `/keepwarm` started by hand is not capped this way.

## Optional settings

Everything below is off by default. Set the values in Claude Code's config menu, or in `~/.claude/settings.json` under `pluginConfigs`:

| Setting | What it does |
|---|---|
| `seatFileTerminal` | For account rotators: a file holding the active seat's label (e.g. `~/.claude-cli-accounts/.active`). Read when a session starts: the band shows `Seat <label>` in place of the account email (the label is masked in recording mode, like the email). A running session keeps the account it signed in with, so a change counts (and marks the cache cold) only once the rotator's wake-up prompt reaches that session, or within 3 minutes after it. |
| `seatFileDesktop` | The same for sessions the Desktop app runs, so each seat keeps its own usage reading. |
| `rotatorWakePattern` | A regular expression matching the prompt an unattended account rotator types after rotating. That prompt is compacted first without asking, since nobody is there to answer. |
| `autoResume` | `true` to turn on auto-resume (above). Off by default because it spends usage without asking. |
| `prPattern` | A regular expression whose first group is a PR number, matched against a chat's first prompt (e.g. `(?:^\|\s)/?merge-pr\s+#?(\d+)`). Keep warm then stops once `gh` reports that PR merged or closed. |

## Development

The `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`. That folder is generated by Claude Code and is not committed (it is in `.gitignore`), so the editor's type checking works only once Claude Code has generated it.

Tests: `claude plugin test` runs the mod's own. `node --test hooks/local-builtins.test.mjs` checks that every command the mod treats as local is a local one in the installed engine (it is skipped when the engine's files cannot be read, and sees only each command's top-level type).

## Fonts

The arrows are `▶` (U+25B6), which every font has. The true Powerline arrow (U+E0B0) needs a Nerd Font in the terminal and has no font in the Desktop app.

## License

MIT. See [LICENSE](LICENSE), which keeps Nate Herk's copyright notice.
