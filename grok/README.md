# cache-statusband for Grok Build

A status line for [Grok Build](https://x.ai). It paints the session figures Grok already sends to a status-line command: model, reasoning effort, context window, prompt-cache token counts, and session cost. It also paints the weekly usage percentage and reset countdown from the credits reading `/usage` already fetched.

```
 Grok 4.7 ▶ High ▶ Ctx 29% · 287k/1M ▶ Cache read 80k · write 1.5k ▶ Week 40% · 3d2h ▶ Session $0.04
```

Each segment is a colour block. The arrow is `▶` (U+25B6), which does not need a special font. A figure that is neither in the status-line payload nor in a current weekly credits reading is left off the line. A zero Grok did send is shown as zero. The `40%` above is a sample.

## What was ported

Grok Build 1.0.70 can run a script as the bottom row (`[ui.status_line]` `type = "command"`). This folder is that script, `statusline.mjs`.

| Claude mod feature | In this port |
| --- | --- |
| Model, effort, context size, session cost | Shown when Grok puts them on the status-line payload. |
| Cache token counts (`cache read`, `write`) | Shown when `session_usage` includes them. These are cumulative counts, not a warm/cold flag. |
| Warm/cold cache, keep-warm pings, cold-send guard | Not ported. xAI prompt caching is automatic. Cache entries can be evicted at any time. There is no 5-minute or 1-hour lifetime you pay to rewrite, so there is nothing to keep warm and nothing to compact before a cold send. |
| Weekly usage and reset countdown | Shown when Grok's log has a current weekly credits reading: `creditUsagePercent` and a period whose type is weekly and whose end is still in the future. `/usage` shows this percentage. The status-line payload does not include it, so the script reads the newest `billing: fetched credits config` line Grok wrote and keeps only the percent, period type, period end, and fetch time. The figure is only as new as the last such line: grok 1.0.77 was seen logging it while a session starts, and not again during that session. Once the reading is an hour old the band shows its age, for example `Week 24% (read 16h00m ago) · 3d10h`. A reading whose time cannot be read, or is more than five minutes in the future, is marked `(read time unknown)`. |
| 5-hour usage | Not ported. The credits reading this script understands is the weekly period `/usage` shows. There is no 5-hour window in that reading. |
| Context measured from a reopened transcript | Not ported. The line uses `context_window.context_tokens` when Grok sends it. It does not parse the transcript. |
| `/board` of every local session | Not ported. Grok already lists sessions with `grok sessions list` and `/dashboard`. |

The script never reads, prints, or stores an auth token. It does not call a usage endpoint. Each readable log is re-read at most once every five minutes, even when it has no credits line (if the cache file cannot be written, every run re-reads it), and the result is kept per log in `cache-statusband-grok/usage.json` (under `%LOCALAPPDATA%` on Windows, under `$XDG_CACHE_HOME` or `~/.cache` elsewhere). If the newest complete credits line lacks the percent or the period, no weekly segment is shown. A log that cannot be read is not throttled: it keeps the last reading and is tried again on the next run. A reset that has already passed drops the weekly segment until Grok logs a new one.

## Credits

The Claude Code mod this is ported from, and the two projects it is built on, are MIT-licensed:

- **[Cache Keeper](https://github.com/nateherkai/claude-code-mods) by Nate Herk.** Warm/cold tracking, keep-warm, the cold-send guard, and `/board`.
- **[ccstatusline](https://github.com/sirmalloc/ccstatusline) by Matthew Breedlove (sirmalloc).** The coloured segments, the arrow between them, and the choice of model, effort, context, and usage windows. No ccstatusline code is included.
- **[cache-statusband](https://github.com/Hameishiv/cache-statusband)** for Claude Code, by Hameishiv. The status band, the usage readings, and measuring a reopened chat. This port started from that description. No file from that repo is copied here.

## Install

Requires Node.js on `PATH` (tested on Node v24.16.0; the tests need Node 20.11 or later, because they use `import.meta.dirname`) and Grok Build with the status-line command (this port was checked against `grok 1.0.70`).

Add this to `~/.grok/config.toml`. A repository config cannot set the row. Leave any existing keys in that file as they are. If `[ui.status_line]` is already there, this replaces that table only. `command` is the full path to `statusline.cmd` in your clone.

```toml
[ui.status_line]
type = "command"
command = "C:/path/to/cache-statusband/grok/statusline.cmd"
refresh_interval = 300
```

The command is the `.cmd` file alone. With grok 1.0.70 on Windows, a command string that joins `node` and a `C:/...` path is one filename, and starting it fails with `os error 123`. `statusline.cmd` moves to the `grok` folder, starts the `node` on your `PATH`, and forwards the payload. It never runs a `node` program from the repository Grok has open, which is the folder Grok starts it in.

This port was run only on Windows. On macOS or Linux, where a `.cmd` file cannot run, set `command` to `node /path/to/cache-statusband/grok/statusline.mjs` instead, quoting a path that contains spaces as you would at a prompt; that setup is untested.

`refresh_interval` re-runs the script while the session is idle, so the countdown moves, and a newer credits line shows up once Grok logs one (the script does not fetch the percent itself). That run reads the local log. It does not call the network. Restart Grok after editing `config.toml`. The row is hidden on the welcome screen and while a subagent is full screen.

To turn the row off later, set `type = "disabled"` and restart.

## Check it without installing

From PowerShell, in this folder:

```powershell
node --test statusline.test.mjs
'{"model":{"display_name":"Grok 4.7"},"effort":{"level":"high"},"context_window":{"used_percentage":29,"context_tokens":287000,"context_window_size":1000000,"session_usage":{"cache_read_input_tokens":80000,"cache_creation_input_tokens":1500}},"cost":{"total_cost_usd":0.04}}' | node statusline.mjs
```

## License

MIT. See [LICENSE](LICENSE).
