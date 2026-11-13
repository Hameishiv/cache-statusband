# cache-statusband for Grok Build

A status line for [Grok Build](https://x.ai). It paints the session figures Grok already sends to a status-line command: model, reasoning effort, context window, prompt-cache token counts, and session cost. It also paints the weekly usage percentage and reset countdown from the credits reading `/usage` already fetched.

```
 Grok 4.7 ▶ High ▶ Ctx 29% · 287k/1M ▶ Cache read 80k · write 1.5k ▶ Week 40% · 3d2h ▶ Session $0.04
```

Each segment is a colour block. The arrow is `▶` (U+25B6), which does not need a special font. A figure that is neither in the status-line payload nor in a current weekly credits reading is left off the line. A zero Grok did send is shown as zero (except a context window size of zero, which is not a known size and is left off); a percent above zero that would round to 0 shows as `<0.1%` (the context percent, which Grok sends as a whole number, shows `<1%` or `>99%` when its token counts show it is not exactly 0 or 100), and one that would round to 100 without being 100 shows as `>99.9%` or `>100%`. The `40%` above is a sample. When the row is narrower than the band (Grok passes its width as `COLUMNS`), segments are dropped whole from the right until it fits, so a figure is never cut part-way. If even the first segment cannot fit on its own, the script prints nothing (a model name usually carries a version number too), and Grok then hides the row, so the transcript moves up a line. When the row comes back depends on Grok: it was not checked whether a hidden row is offered its width again after the pane is widened.

## What was ported

Grok Build 1.0.70 can run a script as the bottom row (`[ui.status_line]` `type = "command"`). This folder is that script, `statusline.mjs`.

| Claude mod feature | In this port |
| --- | --- |
| Model, effort, context size, session cost | Shown when Grok puts them on the status-line payload. After a resume, Grok counts the cost from the resume. |
| Cache token counts (`cache read`, `write`; `cache write` when only that count is sent) | Shown when `session_usage` includes them. These are cumulative counts, not a warm/cold flag. |
| Warm/cold cache, keep-warm pings, cold-send guard | Not ported. xAI prompt caching is automatic. Cache entries can be evicted at any time. There is no 5-minute or 1-hour lifetime you pay to rewrite, so there is nothing to keep warm and nothing to compact before a cold send. |
| Weekly usage and reset countdown | Shown when Grok's log has a current weekly credits reading: `creditUsagePercent` and a period whose type is weekly and whose end is still in the future. `/usage` shows this percentage. The status-line payload does not include it, so the script reads the newest `billing: fetched credits config` line Grok wrote and keeps only the percent, period type, period end, and fetch time. The figure is only as new as the last such line: grok 1.0.77 was seen logging it while a session starts, and not again during that session. Once the reading is an hour old the band shows its age, for example `Week 24% (read 16h00m ago) · 3d10h`. A reading whose time cannot be read, or is more than five minutes in the future, is marked `(read time unknown)`. |
| 5-hour usage | Not ported. The credits reading this script understands is the weekly period `/usage` shows. There is no 5-hour window in that reading. |
| Context measured from a reopened transcript | Not ported. The line uses `context_window.context_tokens` when Grok sends it. It does not parse the transcript. |
| `/board` of every local session | Not ported. Grok already lists sessions with `grok sessions list` and `/dashboard`. |

The script never reads, prints, or stores an auth token. It does not call a usage endpoint. Each readable log is re-read at most once every 290 seconds (a little under the suggested `refresh_interval`), even when it has no credits line (if the cache file cannot be read or written, every run re-reads it), and the result is kept per log in `cache-statusband-grok/usage.json` (under `%LOCALAPPDATA%` on Windows, under `$XDG_CACHE_HOME` or `~/.cache` elsewhere; a relative `XDG_CACHE_HOME`, `LOCALAPPDATA` or `CSB_USAGE_CACHE` is ignored, since the script runs in the repository Grok has open, and a relative `CSB_BILLING_LOG` or `GROK_HOME` shows no weekly segment; on Windows a path that starts with a single `\` or `/` counts as relative). A cache file that exists but cannot be read, was written in a newer format, or is not this cache at all (say a mistyped `CSB_USAGE_CACHE` naming another file), is left as it is, and every run then re-reads the log; only a file named `usage.json` that is empty, NUL-filled, carries a `v` of 2 in any other shape (its entries for other logs are then lost too), or is in the old format of this cache, is replaced. The temporary file the cache is written through is always created fresh, so a link or pipe left at its name is never followed. If the newest finished credits line cannot be parsed, or lacks the percent or the period, no weekly segment is shown; only an unparseable line with no newline after it, one Grok is still writing at the very end of the log, is passed over. A log that cannot be read is not throttled: it keeps the last reading and is tried again on the next run. A reset that has already passed drops the weekly segment until Grok logs a new one. Two limits follow from reading a log. The log is shared by every Grok session in one Grok home, so the band shows the newest credits reading any of them logged: sessions on different accounts in one home, or an account switch inside a running session, can show another account's figure until a session on the right account logs a new line, and for up to 290 seconds after it (the cached reading is kept that long). Two runs writing the cache at the same moment can also put back an older reading for up to 290 seconds, since each writes the whole file. The script does not check the payload's `schema_version`, so a later Grok that keeps a field's type but changes its meaning would be shown as is. And only the last 4 MB of the log are read, so once the newest credits line is more than 4 MB from the end, the cached reading stays in use (with its age shown once it is an hour old) even if that line would have replaced it.

## Credits

The Claude Code mod this is ported from, and the two projects it is built on, are MIT-licensed:

- **[Cache Keeper](https://github.com/nateherkai/claude-code-mods) by Nate Herk.** Warm/cold tracking, keep-warm, the cold-send guard, and `/board`.
- **[ccstatusline](https://github.com/sirmalloc/ccstatusline) by Matthew Breedlove (sirmalloc).** The coloured segments, the arrow between them, and the choice of model, effort, context, and usage windows. No ccstatusline code is included.
- **[cache-statusband](https://github.com/Hameishiv/cache-statusband)** for Claude Code, by Hameishiv. The status band, the usage readings, and measuring a reopened chat. This port started from that description. No file from that repo is copied here.

## Install

Requires Node.js on `PATH` (tested on Node v24.16.0; the tests need Node 20.11 or later, because they use `import.meta.dirname`) and Grok Build with the status-line command (this port was checked against `grok 1.0.70`).

Add this to `config.toml` in your Grok home (`$GROK_HOME`, by default `~/.grok`). A repository config cannot set the row. Leave any existing keys in that file as they are. If `[ui.status_line]` is already there, this replaces that table only. `command` is the full path to `statusline.cmd` in your clone. Clone to a path without spaces: how Grok handles a quoted or spaced `command` path on Windows was not checked.

```toml
[ui.status_line]
type = "command"
command = "C:/path/to/cache-statusband/grok/statusline.cmd"
refresh_interval = 300
```

The command is the `.cmd` file alone. With grok 1.0.70 on Windows, a command string that joins `node` and a `C:/...` path is one filename, and starting it fails with `os error 123`. `statusline.cmd` moves to `%SystemRoot%\System32` (a local folder, so a clone on a network path maps no drive letter; it stops if the move fails), starts the `node` on your `PATH` with the script's full path, forwards the payload, and exits with Node's exit code. It never runs a `node` program from the repository Grok has open, which is the folder Grok starts it in.

This port was run only on Windows. On macOS or Linux, where a `.cmd` file cannot run, set `command` to node's full path followed by the script's, for example `/usr/local/bin/node /path/to/cache-statusband/grok/statusline.mjs` (find node's path with `command -v node`), quoting a path that contains spaces as you would at a prompt. Grok runs that line through `sh -c` in the open repository, so a bare `node` could pick up a program named `node` there if your `PATH` has an empty entry. That setup is untested.

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
