# Cache Statusband for Codex

A small, truthful Codex port of the Claude Code Cache Keeper status band. It uses only extension points Codex actually exposes:

- Codex CLI's native status footer for live model, reasoning, context, quota, and account-supported cost data.
- A quiet `Stop` hook that saves numeric context state and a `SessionStart` hook that reports saved context, banked resets, and the session's starting account when a local session starts, resumes, or forks.
- Dependency-free `cache-statusband-codex board` and `usage` commands for local sessions and account limits.

It does **not** pretend Codex exposes a custom footer renderer, a prompt-cache warm/cold signal, or a keep-warm API.

## Requirements

- Codex CLI with plugin and hook support (tested with `codex-cli 0.169.0`).
- Node.js 20 or newer.
- PowerShell 7.2 or later for the provided installer.

## Install on Windows

From PowerShell:

```powershell
Set-Location <clone>\codex
.\install.ps1
```

The installer:

1. backs up an existing `%CODEX_HOME%\config.toml` into its own new folder under `%CODEX_HOME%\backups` (earlier backups are never overwritten);
2. registers this checkout as a local Codex marketplace;
3. installs and enables the plugin and hooks;
4. configures the native Codex CLI footer; and
5. runs `npm link` in the plugin package so `cache-statusband-codex` is available in terminals.

Codex runs the plugin's hooks from its own installed copy of the plugin (under `%CODEX_HOME%\plugins\cache`), not from your clone. After pulling updates, re-run `install.ps1` so Codex installs the new version. A relative `-CodexHome` resolves against the current PowerShell location, as a relative `-SeatFile` does.

Codex also marks a plugin's hooks **untrusted** until you review them, and untrusted hooks do not run. After installing, open `/hooks` in the Codex CLI to review and trust the two hooks this plugin adds (`SessionStart` and `Stop`); in the desktop app, review the hooks when Codex prompts. Codex remembers a hash of each reviewed hook, so the review repeats after an update that changes them.

On Windows the readers launch `codex.exe` found on `PATH`, or npm's `codex.cmd` through `cmd.exe`; set `CODEX_BIN` to choose a specific launcher. A `.cmd` or `.bat` path containing `%` is refused because `cmd.exe` cannot escape it: point `CODEX_BIN` at `codex.exe` or move the install. Such a wrapper is skipped when a usable `codex.exe` or `codex.cmd` appears later on `PATH`, and when none does, `usage` and `board` print the refusal on stderr.

Restart Codex after installation. In the CLI, `/statusline` can reorder or remove footer items. Use `-KeepExistingFooter` to preserve an existing footer, or `-SkipCliLink` to install only the Codex plugin:

```powershell
.\install.ps1 -KeepExistingFooter
.\install.ps1 -SkipCliLink
```

For an account rotator, optionally point the installer at the file containing the current seat label:

```powershell
.\install.ps1 -SeatFile (Join-Path $HOME ".codex\.active-account")
```

The setting is stored as `%CODEX_HOME%\cache-statusband-codex\settings.json`. When the file contains a nonempty label, companion output ends with `Seat <label>`. If a seat file is configured but is missing or empty, or `settings.json` itself cannot be read or parsed (only a missing `settings.json` means "no seat"), the seat is treated as unavailable: no label, no email and no usage reading is shown until it holds a label. Sessions started in the meantime record no identity and so never show usage: a resumed session is not re-captured, because today's login cannot establish the one it started under. Without any seat setting, output ends with the email returned by Codex. `CACHE_STATUSBAND_CODEX_SEAT_FILE` can override the saved path for one process. No seat is inferred when neither setting exists.

The installer and runtime never read `auth.json` or any token. The installer does copy `config.toml`: to a temporary file for validation (removed afterwards) and to a backup folder under `%CODEX_HOME%\backups` on every run, which is never pruned. Those backups hold whatever `config.toml` holds, including any secrets placed in it.

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

`usage` captures the configured seat or signed-in email with `account/read` (with a seat configured, the signed-in login is read a second time, on the same app-server connection, after the seat file is last checked, and the capture fails if no one is signed in or the login changed), then reads five-hour/weekly limits and `rateLimitResetCredits.availableCount` through Codex app-server ([official account protocol](https://learn.chatgpt.com/docs/app-server#1-check-auth-state), [official rate-limit protocol](https://learn.chatgpt.com/docs/app-server#8-earned-rate-limit-resets-chatgpt)). `refreshToken` is false. `board` prints the same usage header, ending with that captured email or seat, then scans active rollout JSONL files under `%CODEX_HOME%\sessions`; `--all` also includes `%CODEX_HOME%\archived_sessions`. It extracts only session metadata and the latest token-count record; prompt and response fields are never inspected, printed, or retained. It does not depend on Codex's private SQLite schema.

Human-readable `usage` output lists up to 20 reset details Codex returns, with an absolute date/time in the machine's local timezone and a relative countdown; a reset whose `expiresAt` Codex sent as an explicit `null` reads "does not expire", while one with no usable `expiresAt` reads "expiration not supplied". `usage --json` retains the raw Unix-seconds `expiresAt` value. When a seat is configured, `usage --json` and `board --json` omit `accountEmail` and `identityKey`, since the seat label is then the displayed identity. The compact board header and resume hook show only the nearest countdown. If Codex returns an authoritative count without detail rows, the command says that expiration details were not supplied instead of inventing dates. At most 20 detail rows are kept; if Codex sent more, the command says how many more are not shown, which is different from rows Codex did not supply. Rows Codex sent beyond its own count are described against that count ("N more rows beyond Codex's count of X not shown").

Usage reads are shared under `%CODEX_HOME%\cache-statusband-codex` separately for each verified account email: at most one rate-limit attempt every five minutes per account, even when two seat labels refer to it. A server `Retry-After` extends that delay up to one hour. Failed checks retain the complete last-good reading and change only attempt/error timing. Each usage read asks Codex for the signed-in account first and sends `account/rateLimits/read` only if that email matches the captured one (compared without regard to case). If the login differs or no one is signed in, no rate-limit request is made at all: the login is checked immediately before the rate-limit request is sent; the check is recorded as a failed one and nothing is stored for the other account. A seat label never authorizes another account's readings. Upgrading a seat-keyed cache preserves its polling deadline while discarding its unverified values. Cache filenames contain only one-way identity hashes. Only the sanitized email, aggregate reset count, display title/expiry (with a flag when Codex said a reset does not expire), the number of detail rows that were cut, limit percentages, and cache timestamps are stored. When the shared attempt marker cannot be written (a cache that cannot be written at all), no live read is made, so the five-minute limit holds; the stored reading, if any, is shown as stale. Account IDs, reset IDs, descriptions, raw responses, and credentials are discarded. The port never calls `account/rateLimitResetCredit/consume`; it can display a banked reset but cannot spend one.

`SessionStart` stores its initial account key and display label once per session ID using `getSessionIdentity` in `src/session-state.mjs`. Resuming that ID reuses the saved identity, even after a shared seat file or login changes. Simultaneous starts publish one complete record without overwriting an existing one. If the start-time capture is unavailable (a timeout, no signed-in account, or the login or seat changing mid-read), the session remains unknown and never shows usage, because a resumed session is not captured again; a corrupt or unreadable record is not replaced with a later account. Sessions resumed from an older plugin version without an identity record also remain unknown: the original login cannot be reconstructed from today's account. Standalone `usage` and `board` commands capture the current identity for each invocation. No cache-warm/cold state is inferred from any account change.

Companion segments capitalize their first word, matching the current original. Email casing and digit-led labels such as `5h` are preserved. Codex owns capitalization in its native footer.

This is an external command, not `/board`: Codex does not expose third-party slash-command registration.

The board selects candidates by filesystem modification time and applies `--limit` before parsing transcript bodies, continuing to the next candidate if a file moved during the scan. Directory discovery and file metadata are still scanned, but old transcript bodies beyond the limit are not read.

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
| Seat label for account rotators (`seatFileTerminal`, `seatFileDesktop`) | `install.ps1 -SeatFile` or `CACHE_STATUSBAND_CODEX_SEAT_FILE`. One file serves the CLI and the desktop app (the original has one per surface), is read when a session starts and is bound to the verified account; `rotatorWakePattern` has no counterpart because no cache state is tracked |
| Usage on a fresh or reopened chat | One shared, per-account usage reading (at most one rate-limit request every five minutes) used by `usage`, `board` and the resume hook. The original also borrows the freshest open chat's figures; the port has no such source, and the native footer carries Codex's own live numbers |

## What did not port, and why

| Feature | Why it was not ported | Closest truthful Codex behavior |
|---|---|---|
| Prompt-cache warm/cold state | Codex reports what a completed request read or wrote, but exposes no supported signal proving whether the **next** request will hit the same cache | Show prior cached-token accounting only; label next-request state unknown |
| Cache rewrite countdown / Claude's 5-minute-or-1-hour state | Codex does not expose a user-selected cache TTL or a per-session expiry timestamp. OpenAI caching is automatic, and a documented minimum lifetime is not a guaranteed eviction time | No countdown is shown |
| Keep-warm pings | Hooks have neither a background timer nor a supported “refresh this cache” call. A synthetic turn would consume quota and still would not guarantee routing to the same cache | Send nothing; let Codex manage caching automatically |
| Auto-resume after usage renews | A shared-daemon CLI watcher can receive typed `UsageLimitExceeded`, read the real reset time, and later invoke `codex queue`. However, checking the latest turn and queuing `Resume` are separate server operations: `turn/start` and the thread queue APIs expose no expected-turn precondition, so a user message can win the gap without reliably canceling the automatic spend. The desktop app also keeps its app-server on private stdio | No setting or watcher is installed. Codex needs an atomic “start only if this failed turn is still current” operation before the original cancellation rule can be guaranteed |
| Cold-chat guard: compact a big cold chat, then send the message (`/cache guard`, `/cache big`) | The original needs two things the Codex surface does not give this port. First, a cold/warm verdict (see the first row: Codex exposes no signal for whether the next request will hit the cache). Second, holding a prompt on its way out, compacting the live chat and sending the prompt after it, including the continue Claude Code sends after a usage limit resets. Codex 0.169's protocol schema lists a `userPromptSubmit` hook and a `thread/compact/start` request, but this port has not verified that a hook can hold a prompt, start a compaction on the running thread and send the prompt afterwards. Estimating a rewrite charge instead would be false precision and could delay a perfectly valid send | Nothing is compacted or held. The resume message reports saved context age and explicitly says cache state is unknown |
| `/cache` status and settings (`ttl`, `guard`, `big`, `alerts`, `autowarm`) | Every one of these tunes cache behaviour that does not exist here (a cache lifetime, the cold-chat guard, cool-down alerts, automatic keep warm), and Codex has no third-party slash commands to carry them | The port's own settings are `install.ps1` flags (`-SeatFile`, `-KeepExistingFooter`, `-SkipCliLink`) and the `CACHE_STATUSBAND_CODEX_SEAT_FILE` variable |
| `/keepwarm [hours\|off]`, automatic keep warm and the `prPattern` stop | Same reason as the keep-warm pings row: there is nothing to keep warm, and a hook cannot run on a timer | None |
| Cool-down and "waiting on you" alerts (`/cache alerts`) | The cool-down alert counts down to a cache expiry that Codex does not expose, and this port's hooks run only when a session starts or a reply finishes, so they have no timer to raise an alert from | None |
| Rewrite cost estimate (`Rewrite ≈ $`) and cold-rewrite tally (`Cold rewrites $ (n)`) | Both price a cache rewrite, which needs the cold/warm state and a per-token price table; neither exists for Codex, and guessing a price from public model prices would misstate subscription usage | None; native `estimated-thread-cost` appears only when the workspace supplies it |
| `/handoff [continue]` and the Cache Keeper handoff button | A slash command, a clickable button on the band, and driving `/clear` followed by sending the handoff as the new chat's first prompt are all mod abilities Codex does not offer a plugin | None; ask the agent for a handoff in the session by hand |
| The `session-handoff` skill | Not included in this port. This is a gap, not a Codex limit: the 0.169 plugin schema lists skills a plugin can carry. The skill's text is written for Claude Code (it reads `~/.claude/plans`, Claude memory files and `run_in_background` shells), so it needs a Codex rewrite that was not done here | None |
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

- A read-only `account/read` (`refreshToken: false`) captures identity at command/hook start; `account/rateLimits/read` is shared per identity, sent only after `account/read` confirms the expected account, and attempted at most once per five minutes.
- A longer structured or textual `Retry-After` delays the next attempt up to one hour; failures retain the last good data and never become a fake zero.
- No direct usage HTTP request and no reset-consumption call.
- A usage read starts a short-lived Codex app-server in your `CODEX_HOME`. A `SessionStart` makes at most two such starts: one for the identity capture (with a seat configured, both account reads share it) and one for the usage read, which is skipped while the shared five-minute reading is fresh; a resumed session makes no capture, so at most one. `usage` and `board` make the same two. Codex does its own startup work there (for example its curated-plugin sync) and may leave small temporary folders under `%CODEX_HOME%\.tmp`, as Codex itself does.
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

The current Node suite has 95 tests covering malformed/in-progress JSONL, latest-token selection, bounded large-transcript parsing, persisted context fallback, out-of-order state protection, active/archived discovery, the resume/stop hooks, account/token/ID sanitization, immutable session identity, per-account five-minute caching, last-good failure behavior, the one-hour `Retry-After` cap, first-word capitalization, the documented app-server protocol, compact reset/age formatting, absolute local expiration formatting, and missing-detail handling. Account regressions in `test/usage.test.mjs` prove that rotation and missing account emails cannot replace a good reading, rotation during capture produces no guessed binding, and legacy cache deadlines survive migration. Session regressions in `test/rollouts.test.mjs` prove identity survives resume, simultaneous starts keep one identity, an initially unknown identity stays unknown, and legacy sessions do not adopt today's login. Further regressions cover Windows `codex.cmd` launching, ignoring server messages that reuse a response id, fail-closed identity capture (including an unreadable seat), the SessionStart deadline, a hung app-server (including the real server behind npm's `codex.cmd`) being stopped and not holding the process open, refusal of a `codex.cmd` path containing `%`, a cache-only read when SessionStart cannot give a read its full three seconds (after the half-second margin before the deadline), the SessionStart deadline measured from the hook's start, `--json` output omitting the email and account key when a seat is configured, one shared control-character sanitizer (C0, DEL, C1, the bidirectional embedding/override/isolate controls and U+2028/U+2029, while Hebrew letters and emoji joiners survive), token-owned locks with best-effort stale reclaim (a narrow race can rarely give two processes the lock, costing a duplicate poll or a skipped save), per-session Stop locking (a busy save lock is retried briefly before the save is skipped), the bounded head/tail transcript read, rate-limit whitelisting, control-character stripping, and the staleness suffix on banked resets. The board-limit regression proves only recent candidates are parsed and a missing candidate is skipped. Round-3 regressions prove that a hook that reaches its deadline stops the Codex app-server it started, that an app-server whose exit is already known is not signalled (its pid may be reused), that a `codex.cmd` under a `%` path is skipped for a usable `codex.exe` or refused once on stderr, and that bidirectional controls and line separators are stripped. Round-4 regressions prove that a login other than the captured one is detected before any rate-limit request is sent (counted in a fake app-server's request log), that transcript fields of the wrong type are ignored so one odd session cannot break `board`, that `--json` escapes C1, U+2028/U+2029 and bidirectional characters, and that with a seat configured a signed-out or changing login fails the capture. The PowerShell test separately proves that installation into a fresh Codex home with no `config.toml` works, that a failed registration restores the original `config.toml`, that a blank `-SeatFile` is rejected before anything is changed or registered, and that installation preserves its marketplace registration and enabled plugin, replaces a multiline footer under a commented `[tui]` header, preserves unrelated TOML, validates the candidate, and leaves the live file unchanged after rejection. The installer validates preferences before registration, then re-reads Codex's updated configuration and validates the final merged candidate before replacement. Validation is by difference: if Codex's strict config check already rejects the current `config.toml` (for example because of a retired key that plain startup tolerates), the installer warns once, then checks the candidate with plain Codex startup (no `--strict-config`) instead: a candidate that plain startup rejects while the original loaded (a duplicate table, say) aborts the install, and one Codex accepts continues. A candidate that fails the strict check after a passing original still aborts. The installer also refuses, naming the table, a `config.toml` that defines `tui` or `features` with top-level dotted keys, an inline table or a quoted header, since appending a plain `[tui]` or `[features]` table would duplicate it. When a check fails, the message carries Codex's own reason (the `detail` of its JSON error, with `WARNING:` lines dropped) and is shortened only as a last resort. Round-5 regressions prove that Windows renames are retried, that both seat reads share one app-server start, that the rate-limit reader refuses to run without an expected account, that wrongly typed timestamps are ignored, that cut reset rows are reported as not shown, and that a hook waits for in-flight server cleanup. Round-6 regressions prove that a reset the server marked `null` reads "does not expire" while a missing or invalid expiry stays "not supplied", that a malformed or unreadable `settings.json` (a leading byte-order mark is tolerated) fails closed with no email anywhere, including in `--json`, that a cache whose attempt marker cannot be written makes no rate-limit request, that a single-read connection ignores a stray id-4 response, that no tracked text file under `codex/` holds a C0 control character other than tab, CR or LF, and, in the PowerShell test, that a footer defined with dotted keys, an inline table or a quoted header is refused with the config untouched, that a candidate plain startup rejects is refused even when the original already fails the strict check, and that the strict-check warning is printed once. If registration or that final validation fails, the installer restores the backed-up `config.toml`, warns, and rethrows; when there was no earlier `config.toml` there is nothing to restore, so the file is left as Codex wrote it and the warning says so. A relative `-SeatFile` or `-CodexHome` resolves against the current PowerShell location, and the installer warns when the file does not exist yet.

## Credits

This port exists because of:

- [Cache Keeper](https://github.com/nateherkai/claude-code-mods) by **Nate Herk** (MIT). Its cache/session workflow is the origin of the mod family.
- [ccstatusline](https://github.com/sirmalloc/ccstatusline) by **Matthew Breedlove / sirmalloc** (MIT). Its status-band design and choice of live fields inspired the original display. No ccstatusline code is included.
- The [Claude Code original, cache-statusband](https://github.com/Hameishiv/cache-statusband), which combined those ideas and supplied the feature set evaluated for this Codex port.

## License

MIT. See [LICENSE](LICENSE). The upstream copyright notices are retained.
