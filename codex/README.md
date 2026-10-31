# Cache Statusband for Codex

A small, truthful Codex port of the Claude Code Cache Keeper status band. It uses only extension points Codex actually exposes:

- Codex CLI's native status footer for live model, reasoning, context, quota, and account-supported cost data.
- A quiet `Stop` hook that saves numeric context state and a `SessionStart` hook that reports saved context, banked resets, and the session's starting account when a local session starts, resumes, or forks.
- Dependency-free `cache-statusband-codex board` and `usage` commands for local sessions and account limits.

It does **not** pretend Codex exposes a custom footer renderer, a prompt-cache warm/cold signal, or a keep-warm API.

## Requirements

- Codex CLI with plugin and hook support (tested with `codex-cli 0.165.0`).
- Node.js 20 or newer.
- PowerShell 7.2 or newer for the provided installer.

## Install on Windows

From PowerShell:

```powershell
Set-Location <clone>\codex
.\install.ps1
```

The installer:

1. backs up an existing `%CODEX_HOME%\config.toml` under `%CODEX_HOME%\backups`;
2. registers this checkout as a local Codex marketplace;
3. installs and enables the plugin and hooks;
4. configures the native Codex CLI footer; and
5. runs `npm link` in the plugin package so `cache-statusband-codex` is available in terminals.

Restart Codex after installation. In the CLI, `/statusline` can reorder or remove footer items. Use `-KeepExistingFooter` to preserve an existing footer, or `-SkipCliLink` to install only the Codex plugin:

```powershell
.\install.ps1 -KeepExistingFooter
.\install.ps1 -SkipCliLink
```

For an account rotator, optionally point the installer at the file containing the current seat label:

```powershell
.\install.ps1 -SeatFile (Join-Path $env:CODEX_HOME ".active-account")
```

The setting is stored as `%CODEX_HOME%\cache-statusband-codex\settings.json`. When the file contains a nonempty label, companion output ends with `Seat <label>`; otherwise it ends with the email returned by Codex. `CACHE_STATUSBAND_CODEX_SEAT_FILE` can override the saved path for one process. No seat is inferred when neither setting exists.

`CODEX_BIN` names the Codex executable the usage reads launch; by default they run `codex` from `PATH` (through `cmd.exe` on Windows, so the npm `codex.cmd` shim works).

No token or credential is read, copied, printed, or stored by the installer or runtime.

## Codex CLI footer

The default preset is:

```toml
[tui]
status_line = ["model-with-reasoning", "context-remaining", "five-hour-limit", "weekly-limit", "estimated-thread-cost", "current-dir", "git-branch"]
status_line_use_colors = true
```

These are Codex-native components, not custom-rendered segments. `estimated-thread-cost` appears only when the signed-in workspace supplies an estimate; the port never guesses a price. Five-hour and weekly windows likewise appear only when Codex supplies them. Codex has no built-in banked-reset footer item, so that count appears in the companion command and resume hook instead.

## Session board

```powershell
cache-statusband-codex board
cache-statusband-codex board --all --limit 100
cache-statusband-codex board --json
cache-statusband-codex usage
cache-statusband-codex session "$env:CODEX_HOME\sessions\YYYY\MM\DD\rollout-....jsonl"
```

`usage` captures the configured seat or signed-in email once with `account/read`, then reads five-hour/weekly limits and `rateLimitResetCredits.availableCount` through Codex app-server ([official account protocol](https://learn.chatgpt.com/docs/app-server#1-check-auth-state), [official rate-limit protocol](https://learn.chatgpt.com/docs/app-server#8-earned-rate-limit-resets-chatgpt)). `refreshToken` is false. `board` prints the same usage header, ending with that captured email or seat, then scans active rollout JSONL files under `%CODEX_HOME%\sessions`; `--all` also includes `%CODEX_HOME%\archived_sessions`. It extracts only session metadata and the latest token-count record; prompt and response fields are never inspected, printed, or retained. It does not depend on Codex's private SQLite schema.

Human-readable `usage` output lists every reset detail Codex returns, with an absolute date/time in the machine's local timezone and a relative countdown. `usage --json` retains the raw Unix-seconds `expiresAt` value. The compact board header and resume hook show only the nearest countdown. If Codex returns an authoritative count without detail rows, the command says that expiration details were not supplied instead of inventing dates.

Usage reads are shared under `%CODEX_HOME%\cache-statusband-codex` separately for each captured account/seat: at most one rate-limit attempt every five minutes per identity. A server `Retry-After` extends that delay up to one hour. Failed checks retain the complete last-good reading and change only attempt/error timing. Cache filenames contain only one-way identity hashes. Only the sanitized email, aggregate reset count, display title/expiry, limit percentages, and cache timestamps are stored. Account IDs, reset IDs, descriptions, raw responses, and credentials are discarded. The port never calls `account/rateLimitResetCredit/consume`; it can display a banked reset but cannot spend one.

Companion segments capitalize their first word, matching the current original. Email casing and digit-led labels such as `5h` are preserved. Codex owns capitalization in its native footer.

This is an external command, not `/board`: Codex does not expose third-party slash-command registration.

## Codex desktop app

The plugin and `SessionStart` hook also load in the local Codex desktop app. On a session with a saved token report, the hook shows a short message such as:

```text
Cache Statusband Codex: restored current-model/high; saved context 83.4k/258k (32%); last token report 4m ago. Prompt-cache warm/cold state is not exposed by Codex. Banked resets: 2; next expires in 1d4h Account: <email>.
```

The desktop app does not expose a custom persistent footer slot, so the CLI status line is not injected into the app. The board can still be run in a terminal, including a terminal panel opened from Codex.

## What ported

| Original feature | Codex port |
|---|---|
| Coloured model and effort band | Native CLI `model-with-reasoning` footer item with theme colours; no custom powerline renderer |
| Context used/window | Native live footer plus saved context in the resume hook and board |
| Five-hour and weekly usage/reset | Native live footer items plus the cached `usage`/`board` read |
| Banked earned resets | `usage`, the board header, and the CLI/desktop resume hook; read-only, never redeemed |
| Signed-in account | Sanitized `account/read` email in `usage`, board, and the CLI/desktop resume hook; an explicitly configured seat file overrides it |
| Session cost | Native `estimated-thread-cost` only when the workspace supplies it; never synthesized |
| Reopened-session measurement before first send | `Stop` saves a small numeric snapshot after replies; `SessionStart` prefers the bounded transcript read and falls back to that snapshot |
| `/board` of local sessions | `cache-statusband-codex board`; external because custom slash commands are unavailable |

## What did not port, and why

| Feature | Why it was not ported | Closest truthful Codex behavior |
|---|---|---|
| Prompt-cache warm/cold state | Codex reports what a completed request read or wrote, but exposes no supported signal proving whether the **next** request will hit the same cache | Show prior cached-token accounting only; label next-request state unknown |
| Cache rewrite countdown / Claude's 5-minute-or-1-hour state | Codex does not expose a user-selected cache TTL or a per-session expiry timestamp. OpenAI caching is automatic, and a documented minimum lifetime is not a guaranteed eviction time | No countdown is shown |
| Keep-warm pings | Hooks have neither a background timer nor a supported “refresh this cache” call. A synthetic turn would consume quota and still would not guarantee routing to the same cache | Send nothing; let Codex manage caching automatically |
| Auto-resume after usage renews | A shared-daemon CLI watcher can receive typed `UsageLimitExceeded`, read the real reset time, and later invoke `codex queue`. However, checking the latest turn and queuing `Resume` are separate server operations: `turn/start` and the thread queue APIs expose no expected-turn precondition, so a user message can win the gap without reliably canceling the automatic spend. The desktop app also keeps its app-server on private stdio | No setting or watcher is installed. Codex needs an atomic “start only if this failed turn is still current” operation before the original cancellation rule can be guaranteed |
| Cold-send warning or block | Without an authoritative next-request cache state, warning that a send is cold—or estimating a rewrite charge—would be false precision and could block a perfectly valid send | The resume message reports saved context age and explicitly says cache state is unknown |
| Arbitrary colour blocks and powerline arrows | `tui.status_line` accepts built-in component IDs; it cannot run an external command, interpolate a template, or accept arbitrary ANSI segments | Native theme-coloured footer components |
| Banked resets as a persistent footer segment | `account/rateLimits/read` exposes the data, but `/statusline` has no banked-reset component and Codex has no custom footer slot | Show the count in `usage`, `board`, and the resume hook |
| Account email as a persistent footer segment | `account/read` exposes the email, but `/statusline` has no account/workspace/custom-text item | Show the email or configured seat in companion output and the resume hook |
| Recording-aware account masking | Codex exposes no plugin-visible recording-mode flag equivalent to the original's local recording state | No automatic masking is claimed; use a seat label when the email should not be displayed |
| General dollar-cost calculation | ChatGPT subscription quota is not API billing, and Codex supplies no universal per-thread dollar total. Guessing from public model prices would misstate subscription usage | Native `estimated-thread-cost` only when the workspace supplies it |
| Claude/Fable-specific weekly usage | Fable is an Anthropic model/bucket and has no Codex equivalent | Codex's own five-hour, weekly, and named account buckets when supplied |
| `/board` as a slash command | Codex does not expose third-party slash-command registration | External `cache-statusband-codex board` command |
| Persistent band inside the desktop app | The desktop app supports hooks but does not expose the CLI TUI footer or a plugin footer slot | Resume `systemMessage`; board/usage in a terminal panel |

OpenAI prompt caching is automatic. Current OpenAI API documentation describes minimum cache lifetimes and cache-write/read pricing, but Codex does not expose a user-controlled cache policy or reliable warm/cold state through its supported configuration and hook surface. See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## Privacy and network behavior

- A read-only `account/read` (`refreshToken: false`) captures identity at command/hook start; `account/rateLimits/read` is shared per identity and attempted at most once per five minutes.
- A longer structured or textual `Retry-After` delays the next attempt up to one hour; failures retain the last good data and never become a fake zero.
- No direct usage HTTP request and no reset-consumption call.
- No reads of authentication files, environment tokens, or private SQLite tables.
- The cache stores the sanitized email but no account ID, reset ID, description, credential, token, or raw app-server response.
- Rollout parsing is bounded to a 256 KiB head and 2 MiB tail and never extracts, emits, or stores message content.
- After a reply, `Stop` atomically saves only context tokens/window, model, effort, and report time in a small per-session file. `SessionStart` uses it when a rollout cannot provide an equally recent report.
- Hook errors fail open with an empty response; they never block a Codex session.

Codex documents transcript JSONL as convenient but unstable. The parser is defensive, and an unknown future record shape produces missing fields rather than invented numbers.

## Development and tests

```powershell
Set-Location <clone>\codex
.\test\install.test.ps1
Push-Location .\plugins\cache-statusband-codex
npm test
node .\bin\cache-statusband-codex.mjs board --limit 2
Pop-Location
```

The Node suite covers malformed/in-progress JSONL, latest-token selection, bounded large-transcript parsing, persisted context fallback, out-of-order state protection, active/archived discovery, the resume/stop hooks, account/token/ID sanitization, immutable session identity, per-account five-minute caching, last-good failure behavior, the one-hour `Retry-After` cap, first-word capitalization, the seat-file fallback, plain spaces in formatted times, the documented app-server protocol, compact reset/age formatting, absolute local expiration formatting, and missing-detail handling. The PowerShell test separately proves that installation replaces a multiline footer under a commented `[tui]` header, preserves unrelated TOML, validates the candidate, and leaves the live file unchanged after rejection.

## Credits

This port exists because of:

- [Cache Keeper](https://github.com/nateherkai/claude-code-mods) by **Nate Herk** (MIT). Its cache/session workflow is the origin of the mod family.
- [ccstatusline](https://github.com/sirmalloc/ccstatusline) by **Matthew Breedlove / sirmalloc** (MIT). Its status-band design and choice of live fields inspired the original display. No ccstatusline code is included.
- The [Claude Code original, cache-statusband](https://github.com/Hameishiv/cache-statusband), which combined those ideas and supplied the feature set evaluated for this Codex port.

## License

MIT. See [LICENSE](LICENSE). The upstream copyright notices are retained.
