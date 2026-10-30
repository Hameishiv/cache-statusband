// Cache Keeper: watches this session's prompt cache, keeps big caches warm on
// request, refuses a cold send without asking first, and shows every local
// session on one board (/board).
//
// Why: each request re-reads the whole context. From the cache that costs about
// a tenth of normal input. Once the cache expires (1 hour idle on a subscription,
// 5 minutes on the default API TTL), the next message writes the whole context
// again at 1.25x to 2x input. A cache read also restarts the timer, so a tiny
// ping before expiry costs a fraction of a rewrite.

import { rewriteCost, requestCost, totalInput, cachedShare, priceFor } from './pricing.mjs'
import { tokens, usd, minutes, clock, clip, basename, pad } from './fmt.mjs'
import { makeMasker } from './privacy.mjs'

const MIN = 60000
const HEARTBEAT_EVERY = 30000
const PANE = 'cache-board'

// This session
const S = {
  id: '',
  cwd: '',
  label: '',
  model: '',
  lastActivity: 0, // last main-loop request or keep-warm ping that touched the cache
  ctx: 0,
  window: 0,
  costUsd: 0,
  ttlMin: 60,
  ttlSource: 'default',
  coldRestarts: [],
  working: false,
  turnId: '', // the main loop's running (or last) turn
  waitingSince: 0,
  waitingFor: '',
  tool: '',
  lastTurnEnd: 0,
  keepWarm: false,
  keepWarmUntil: 0,
  pings: 0,
  pingUsd: 0,
  autoPingUsd: 0, // what auto keep warm's pings cost since the last real request
  keepWarmAuto: false, // the running keep warm began on its own, not by hand
  lastPingAt: 0,
  warnedFor: 0,
  agentsRunning: 0,
  rateLimits: [],
  seat: '', // the signed-in account label the rotator last wrote
  seatChangedAt: 0, // when that label last changed: the new account's cache is empty
  floor: 0, // context size right after the last compaction: what compacting can't shrink
  autoWarm: true, // false once keep warm is turned off by hand in this session
  pr: 0, // a merge-pr session's PR: keep warm stops once it merges or closes
  prCheckedAt: 0,
  effort: '', // the main loop's effort, as its last request named it
  account: '', // the signed-in account's email, shown when no seat file is configured
  resumeAt: 0, // when an out-of-usage chat sends itself "Resume" (also the re-arm of a cancelled Resume or one that could not be sent, 2 minutes on); 0 when none is pending
  fable: null, // { percentUsed, resetsAt } from the plan's per-model weekly limits
  planWindows: [], // 5h and weekly from the same reading, for a session that has sent nothing yet
}

const settings = { bigTokens: 150000, guard: true, ttlMin: 0, alerts: true, keepWarmHours: 4, autoWarmHours: 8 }
const names = { cache: 'cache', keepwarm: 'keepwarm', board: 'board', handoff: 'handoff' }

let now = 0
let home = ''
let lastHeartbeat = 0
let lastPrune = 0
let rec = { on: false, strict: false }
let mask = (s) => s
let fleet = [] // heartbeats of every session, this one included
const alerted = new Map() // sessionId -> state or warning key already announced
let paneOpen = false
let justCompacted = false
let compactedCold = false
let identityRead = false // session.start has read the seat and account: a chat's record can be compared with them
let pendingSeed = null // a startup or resume SessionStart's transcript that came before that, seeded once it has
let rotationSeenAt = 0 // when this process last saw a rotation: a process fact, kept across /clear, resume and fork
const WAKE_WINDOW = 3 * MIN // how long after a wake-up a late rewrite of the seat file or .claude.json is still taken as that rotation
let seatUnknown = false // after a wake-up, until the seat file names a new seat: the rotator may not have written it yet, so S.seat may be the old one: its plan fetch, borrowing and lending of usage windows, and the shared windows and Fable reading it shows wait for it
let accountUnknown = false // likewise for the account in .claude.json, which may not have switched though the seat label did: it holds back the same things (keyUnsure); a read with no account is not a change
let wakeWindowEnd = 0 // when the wake-up's window closes; 0 = no window
let accountMoved = false // the wake-up's re-read, or a late adoption since, has shown the account change: a seat label arriving after that is not a new rotation
let seatMoved = false // the wake-up's re-read already showed the seat change. A seat adopted late does not count: its label may be written before the credential switches, so the account can still arrive after it
let wakeCount = 0 // rotator wake-ups so far: a plan fetch that straddles one is dropped

// A field is unknown only while the window is open: a closed one stands even before the tick that clears the flags
function seatUnsure() {
  return seatUnknown && now < wakeWindowEnd
}
function accountUnsure() {
  return accountUnknown && now < wakeWindowEnd
}
// Whether the plan key, and the readings borrowed, lent or shown under it, may still be the old account's:
// the seat file and .claude.json are written separately, and the credential may not have switched when either has
function keyUnsure() {
  return seatUnsure() || accountUnsure()
}
let wakeSeat = '' // the seat and account as they were when that wake-up came
let wakeAccount = ''
let rotatedPending = false // a seat change, or a reopened chat's last request on another seat or account, that no request has landed on yet: this account's cache is empty
let signedIn = null // whether this session has a first-party sign-in (an API-key session has none); null until checked
let signCheckAt = 0
let handoffPending = false
let seatFile = ''
let onTerminal = false

// Setup-specific behaviour, all off unless the plugin's userConfig turns it on (see README)
const cfg = {
  seatFileTerminal: '', // a file holding the signed-in account's label, as an account rotator writes it
  seatFileDesktop: '',
  rotatorWake: null, // the prompt an unattended account rotator types after rotating: compact without asking
  prPattern: null, // a first prompt naming a PR: keep warm stops once that PR merges or closes
  autoResume: false, // send "Resume" to a chat cut short by exhausted usage once it renews
}

// A bad pattern in the settings turns that feature off rather than failing the load
export function pattern(text, flags) {
  if (!text) return null
  try {
    return new RegExp(text, flags)
  } catch {
    return null
  }
}

// The handoff flow. When /session-handoff runs (the band's button, /handoff, a
// typed command, or Claude calling the skill), the answer of the turn it starts
// is captured and saved to a file. "clear and continue" then runs /clear and
// sends the handoff as the fresh chat's first prompt.
const HANDOFF_SKILL = /(^|:)session-handoff$/
const H = {
  armed: false,
  notTurn: '', // a turn already running when the handoff was queued: not the handoff's
  askAfter: false, // /handoff asks "clear and continue?" once the handoff is in
  text: '',
  path: '',
  continuing: false,
}

function armHandoff(insideTurn) {
  H.armed = true
  H.notTurn = insideTurn ? '' : S.working ? S.turnId : ''
}

// The handoff without any preamble Claude put before its heading
function handoffBody(answer) {
  const text = String(answer || '').trim()
  const i = text.indexOf('# Session Handoff')
  return i > 0 ? text.slice(i) : text
}

function fileStamp(ms) {
  const d = new Date(ms)
  const two = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`
}

async function saveHandoff($, text) {
  const project = basename(S.cwd).replace(/[^A-Za-z0-9-]+/g, '-') || 'session'
  const path = `${home || '.'}/.claude/mods-data/cache-keeper/handoffs/${fileStamp(now)}-${project}-${S.id.slice(0, 8)}.md`.replace(/\\/g, '/')
  await $.fs.write(path, text + '\n')
  return path
}

async function captureHandoff($, e) {
  H.armed = false
  H.notTurn = ''
  const askAfter = H.askAfter
  H.askAfter = false
  const body = e.reason === 'answer' ? handoffBody(e.answer) : ''
  if (body.length < 200) {
    $.ui.toast('The handoff turn ended without a handoff, so nothing was saved.', { timeoutMs: 8000 })
    return
  }
  H.text = body
  try {
    H.path = await saveHandoff($, body)
  } catch {
    H.path = ''
  }
  const saved = H.path ? `Handoff saved to ${H.path}.` : 'Handoff captured (the backup file could not be written).'
  $.ui.toast(`${saved} Press c on the band or type /${names.handoff} continue to clear and continue.`, { timeoutMs: 15000 })
  // Off the hook: the turn is ending, and a dialog would hold it open
  if (askAfter) $.clock.after(300, () => offerContinue($).catch(() => {}))
}

async function offerContinue($) {
  if (!H.text) return
  let answer = ''
  try {
    answer = await $.ui.ask('Handoff saved. Clear this chat and continue with it in a fresh context?', ['Clear and continue', 'Keep this chat'])
  } catch {
    return // dismissed: the band button and /handoff continue still work
  }
  if (answer === 'Clear and continue') await clearAndContinue($)
}

function continuationPrompt() {
  const where = H.path ? ` (saved at ${H.path})` : ''
  return `Handoff from my previous session${where}:\n\n${H.text}`
}

async function clearAndContinue($) {
  if (H.continuing) return
  if (!H.text) {
    $.ui.toast(`No handoff ready. Press h on the band or type /${names.handoff} first.`, { timeoutMs: 8000 })
    return
  }
  if (S.working) {
    $.ui.toast('Claude is still working. Clear and continue once this turn ends.', { timeoutMs: 8000 })
    return
  }
  const text = continuationPrompt()
  const path = H.path
  H.continuing = true
  $.ui.invalidate('ui.render')
  try {
    await $.command.run({ command: 'clear', args: '' })
  } catch (err) {
    H.continuing = false
    $.ui.invalidate('ui.render')
    $.ui.toast('Could not run /clear: ' + clip(String((err && err.message) || err), 100) + (path ? ` The handoff is saved at ${path}.` : ''), { timeoutMs: 10000 })
    return
  }
  H.text = ''
  H.path = ''
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch {
    // Not sent: leave it in the prompt box for one Enter
    let filled = false
    try {
      filled = !!(await $.prompt.fill({ text })).isFilled
    } catch {
      filled = false
    }
    $.ui.toast(filled ? 'Cleared. The handoff is in the prompt box: press Enter to send it.' : `Cleared, but the handoff could not be sent.${path ? ` It's saved at ${path}.` : ''}`, { timeoutMs: 10000 })
  } finally {
    H.continuing = false
    $.ui.invalidate('ui.render')
  }
}

// Runs the /session-handoff skill as if you typed it. The engine queues it
// until Claude finishes the current turn.
async function runHandoff($) {
  if (handoffPending) {
    $.ui.toast('Session handoff is already queued.')
    return
  }
  try {
    const commands = await $.command.list()
    const cmd = commands.find((c) => c.name === 'session-handoff') || commands.find((c) => HANDOFF_SKILL.test(c.name))
    if (!cmd) {
      H.askAfter = false
      $.ui.toast('No /session-handoff skill in this session.', { timeoutMs: 8000 })
      return
    }
    handoffPending = true
    armHandoff(false)
    $.ui.invalidate('ui.render')
    $.ui.toast(S.working ? 'Session handoff queued: it runs when Claude finishes this turn.' : 'Running /session-handoff.')
    await $.command.run({ command: cmd.name, args: '' })
  } catch (err) {
    H.armed = false
    H.askAfter = false
    $.ui.toast('Could not start /session-handoff: ' + clip(String((err && err.message) || err), 100), { timeoutMs: 8000 })
  } finally {
    handoffPending = false
    $.ui.invalidate('ui.render')
  }
}

function ttlMin() {
  return settings.ttlMin || S.ttlMin
}

// A rotation moves the session to another account, whose cache is empty, until a request lands on it;
// so does reopening a chat whose last request ran on another seat or account
function rotatedCold() {
  return rotatedPending
}

// A rotation seen in this process dates a chat the record cannot decide; one found on a reopened chat's record only says it came after its last request
function rotatedAgo() {
  return S.seatChangedAt ? ` ${minutes(now - S.seatChangedAt)} ago` : ' since its last request'
}

// The next request writes the shorter context: no TTL evidence and nothing to warn about.
// It also keeps the record a reopened chat reads: an `at` of 0 says it was compacted.
function markCompacted($) {
  // the several hooks of one compaction must not judge it again once lastActivity is zeroed
  if (!justCompacted) {
    // a compaction of a cold cache (Claude Code auto-compacts a big chat as it is sent) still pays a rewrite
    const left = msLeft(S.lastActivity, ttlMin())
    compactedCold = compactedCold || (left !== null && left <= 0) || rotatedCold()
  }
  justCompacted = true
  rotatedPending = false // the rotation is now part of compactedCold
  S.lastActivity = 0
  rememberCompacted($)
}

// Where the request ran, kept with the chat's record: the seat (a seat name belongs to one
// surface's rotator, so the surface goes with it) and the signed-in account
function whoRan() {
  // a field still unknown after a wake-up is left out, rather than recorded wrong
  return {
    ...(S.seat && !seatUnsure() ? { seat: S.seat } : {}),
    ...(S.account && !accountUnsure() ? { account: S.account } : {}),
    desktop: !onTerminal
  }
}

// What a record can be compared with this process by: seats when both sides have one on the same surface,
// else accounts. A field unknown on either side, or still unknown here after a wake-up, can't decide.
function comparableBy(r) {
  if (!r) return ''
  if (r.seat && S.seat && !seatUnsure() && !!r.desktop === !onTerminal) return 'seat'
  return r.account && S.account && !accountUnsure() ? 'account' : ''
}

// A record's request ran on another account than this process is on, so the cache it left is that account's.
// Only comparable fields count: with none, it is no change.
function ranElsewhere(r) {
  const by = comparableBy(r)
  return by === 'seat' ? r.seat !== S.seat : by === 'account' && r.account !== S.account
}

// The one judge of a reopened, resumed or startup-seeded chat's cache, which seeding defers until session.start
// has read this process's seat and account. `found` is what the transcript says, `last` the chat's record.
// The record decides where the last request ran when it can: it is not overtaken by a later request (the
// transcript's `at`, past the minute the two clocks may differ by, says nothing of where it ran) and it names
// a seat or account comparable with this process's (a field still unknown after a wake-up is not: it may be the old one).
// Only without one does this process's own rotation (rotationSeenAt) date it, when it came after the chat's last
// touch: the transcript's reply, or the record's request or keep-warm ping (not one that ran elsewhere).
// Sets rotatedPending and lastActivity, and seatChangedAt when the rotation is dated (seen here, not found on the record).
function judgeChat(found, last) {
  const lastTouch = last ? Math.max(last.at || 0, last.keptAt || 0) : 0
  const decides = !!last && lastTouch >= (found.at || 0) - MIN && !!comparableBy(last)
  const lastSeen = Math.max(found.at || 0, last && !ranElsewhere(last) ? lastTouch : 0)
  const dated = !decides && rotationSeenAt > 0 && lastSeen > 0 && rotationSeenAt > lastSeen
  rotatedPending = decides ? ranElsewhere(last) : dated
  if (dated) S.seatChangedAt = rotationSeenAt
  if (!found.compacted) {
    S.lastActivity = found.at // the cache's real age: the band and the cold-send guard read it
    // keep-warm pings reach the cache but not the transcript: a record of the same chat size dates them
    if (last && last.at > 0 && !ranElsewhere(last) && Math.abs(last.ctx - found.ctx) <= found.ctx * 0.05) S.lastActivity = Math.max(found.at || 0, last.at)
  }
}

// The compacted size isn't known until the next request: keep the one before it, as rememberLast shapes it (keptAt dates an `at` of 0 for the prune)
async function rememberCompacted($) {
  if (!S.id || !S.ctx) return
  try {
    await $.store.set('last:' + S.id, { ctx: S.ctx, at: 0, keptAt: now, model: S.model, effort: S.effort, cold: S.coldRestarts.slice(-50), ...whoRan() })
  } catch {
    // another session holds the store's lock: the next request writes it
  }
}

// The signed-in account, as Claude Code keeps it in .claude.json: what the band shows
// in place of a seat when no seat file is configured; false when it could not be read.
// A re-read after a wake-up (`keep`) that finds no account leaves the one it has: that is a file mid-rewrite, not a change.
async function readAccount($, keep = false) {
  try {
    const dir = await $.env.get('CLAUDE_CONFIG_DIR')
    const o = JSON.parse(String(await $.fs.read(`${(dir || home).replace(/\\/g, '/')}/.claude.json`))).oauthAccount || {}
    const account = String(o.emailAddress || o.displayName || '')
    if (account || !keep) S.account = account
    return true
  } catch {
    // an API-key session, or no file: no account to show
    return false
  }
}

// A running session keeps the account it signed in with: the seat file names the account the
// rotator moved to, which reaches only a session it then wakes. So the seat is read at start,
// and a change is taken only from the wake-up prompt (`adopt`), or from the ticks within WAKE_WINDOW
// after it (refreshIdentity). Terminal sessions run on the CLI rotator's accounts, desktop ones on the app rotator's seats.
async function readSeat($, adopt = false) {
  if (!seatFile || (S.seat && !adopt)) return
  let seat = ''
  try {
    if (!(await $.fs.exists(seatFile))) return
    seat = String(await $.fs.read(seatFile)).trim()
  } catch {
    return
  }
  // at a wake-up a seat appearing where there was none is a change too
  if (seat && seat !== S.seat && (S.seat || adopt)) {
    S.seatChangedAt = now
    rotationSeenAt = now
    rotatedPending = true
    dropReadings(!adopt) // at a wake-up the wake-up is itself the resume: a pending one is not re-armed
    S.seat = seat // before the await: planKey must name the new account while it runs
    await readAccount($, true)
  }
  if (seat) S.seat = seat
}

// The old account's readings, dropped once the account or seat moves: the new one's are borrowed or fetched until a request measures them.
// A resume still pending that was armed from them is not cancelled: it moves to a minute from now, when the new account presumably has usage, keeping its tries. One already settled, sent or cleared is not revived. While a wake-up is on its way (wakePendingId) nor does a late adoption re-arm one: the wake-up is itself the resume, and its request settles it.
// A request that started before the drop reports the old account's windows: identityGen lets its readings be told apart.
let identityGen = 0
let requestGen = 0 // identityGen as the latest main-loop request started: session.measure names no request, so the latest start stands for the one that reports (a subagent's reading carries the same account)
function dropReadings(rearm = true) {
  identityGen++
  S.rateLimits = []
  S.fable = null
  S.planWindows = []
  planNext = 0
  if (rearm && !wakePendingId && resumeFromReadings && S.resumeAt) { // only a resume still pending: one settled, fired or cleared stays so; not while a wake-up is on its way, whose turn settles it
    S.resumeAt = now + MIN
    resumeFromReadings = false
    resumeHeld = false
  }
}

// Compacting on a cold cache pays only when it frees a real share of the context
function worthCompacting() {
  return S.ctx >= settings.bigTokens && S.ctx - S.floor >= 100000
}

// Run off the hook: a command started inside a hook the session waits on is refused
// Auto-resume: a turn cut short by an exhausted plan window gets "Resume" once it renews.
// Only usage exhaustion: a short throttle, an overload or any other error is left alone.
const USAGE_SPENT = /usage limit|limit reached|hit your limit|out of (extra )?usage|limit will reset|resets? (at|in)\b/i
const THROTTLE = /rate[ _-]?limit/i // "rate limit reached" is a short throttle, not spent usage
const USAGE_MARKER = /usage limit|hit your limit|out of (extra )?usage|5-hour|weekly/i // a throttle's wording beside one of these is still spent usage
const RESUME_FALLBACK = 60 * MIN // no reset time known: try once an hour, three times at most
let resumeTries = 0
let sendFailures = 0 // Resume submits refused both ways in a row; cleared by a sent Resume, a new arm, a settled resume and a replaced chat
let staleArmedGen = -1 // the identityGen at which a failure of an earlier request was already given its free minute
let resumeFromReadings = false // the pending resume rests on plan windows, not on the error's wording (nor, after dropReadings, on a re-arm); cleared wherever resumeAt is
let submitsSeen = 0 // messages handed on to the chat so far (not dropped, not ours, not a local command), each "Compact first" answer, each wake-up that starts compacting and each /clear or resume, so an unattended send (rule B) can tell something was sent or chosen meanwhile
let dialogsOpen = 0 // cold-send dialogs open for the person: an unattended send that has compacted waits for them to close before it judges whether it was cancelled (Cancel lets it go; Send anyway or Compact first cancels it)
let dialogsClosed = [] // resolvers of the sends waiting for dialogsOpen to reach 0
let compacting = null // this mod's compaction in flight (a promise): a second send needing one waits for it and uses its result
let sendsHeld = 0 // a cold-send dialog is open, any send handed on that is not this mod's own is going down the chain, or a compact-then-send is in flight: a due resume waits
let wakePendingId = 0 // the wakeCount of a rotator wake-up that has arrived and whose own request has not started (0: none): a due resume waits and a drop of the readings does not re-arm it, as the wake-up's turn settles it. A wake-up lowers it only if it is still its own id, so an earlier one giving up cannot release a later one's hold
let sendPending = new Map() // id -> deadline: a send handed on that is not this mod's own (and the person's own message this mod sends again after Compact first) whose request has not started: a due resume waits. A main-loop request, /clear or resuming another chat lowers all; the deadline (SEND_SAFETY after hand-over) covers a send that never starts a request
let sendPendingId = 0
let stepsSeen = 0 // main-loop requests started so far
let realSends = 0 // messages handed on to the chat (submitsSeen without "Compact first" answers, wake-ups and /clear)
let chatGen = 0 // bumped when the chat is replaced (/clear, resuming another chat)
const CANCEL_REARM = 2 * MIN // a cancelled Resume with no request started since is armed again this long after the cancel (tries kept)
const SEND_SAFETY = 2 * MIN
let resumeHeld = false // the due resume is waiting for the seat and account to be known: it goes once they are, or at the window's end
// Built-in commands that run locally: they neither settle a pending resume nor cancel an unattended send.
// Checked against engine 2.1.314: each is a local or local-jsx command there (hooks/local-builtins.test.mjs checks only that top-level type). A prompt-type built-in (statusline, init, doctor) goes to the model and must not be listed.
// A local command that can also query the model is handled in code: `/plan <text>` (see isLocalBuiltin), and for the cold-send guard alone `/btw <question>` (see guardSkips).
export const LOCAL_BUILTINS = new Set(['usage', 'status', 'model', 'help', 'context', 'logout', 'config', 'memory', 'permissions', 'hooks', 'mcp', 'agents', 'ide', 'resume', 'export', 'theme', 'terminal-setup', 'add-dir', 'bug', 'release-notes', 'upgrade', 'privacy-settings', 'exit', 'fast', 'effort', 'plugin', 'output-style', 'tasks', 'copy', 'feedback', 'extra-usage', 'install-github-app', 'skills', 'plan', 'btw', 'rename', 'color', 'powerup'])

// Whether a command typed by the person runs locally: a LOCAL_BUILTINS name, except `/plan <description>`, which sends the description to the model (`/plan` alone, `open` and `share` stay local).
// Unless the chat is already in plan mode, where `/plan <text>` only shows the plan: prompt.submit carries no permission mode (only classic hooks do, after it and stale after a Shift+Tab), so it counts as a send either way
function isLocalBuiltin(command) {
  if (!command || !LOCAL_BUILTINS.has(command.name)) return false
  if (command.name !== 'plan') return true
  const arg = String(command.args || '').trim()
  return !arg || arg === 'open' || arg === 'share'
}

// What the cold-send guard lets by: the same, except `/btw <question>`, which sends the conversation to the model (a bare /btw stays local)
function guardSkips(command) {
  return isLocalBuiltin(command) && !(command.name === 'btw' && String(command.args || '').trim())
}

function sendIsPending() {
  for (const [id, until] of sendPending) if (until <= now) sendPending.delete(id)
  return sendPending.size > 0
}

// The windows that are full, from the freshest reading this session has
export function spentWindows(limits, fable, model) {
  const full = limits.filter((l) => (l.percentUsed || 0) >= 100)
  if (fable && fable.percentUsed >= 100 && /fable/i.test(String(model))) full.push({ kind: 'fable', ...fable })
  return full
}

// When to resume: a minute after the last full window resets; null when no reset time is known
export function resumeTime(full, at) {
  const times = full.map((l) => Date.parse(l.resetsAt || '')).filter((t) => t > at)
  return times.length ? Math.max(...times) + MIN : null
}

// The time of day, and how far off it is once that is more than a day away
export function resumeText(at, from) {
  return at - from > 24 * 60 * MIN ? `${clock(at)} in ${ago(at - from)}` : clock(at)
}

function armResume($, details) {
  const unsure = keyUnsure()
  let limits = stillOpen(S.rateLimits, now)
  if (!limits.length && signedIn !== false && !unsure) limits = borrowedLimits(fleet, { seat: S.seat, account: S.account, desktop: !onTerminal }, now) // not while the seat or account is unknown: the key may name the old one
  if (!limits.length && !unsure) limits = stillOpen(S.planWindows, now) // nor the shared windows or Fable reading while it is unknown: the old account's
  const full = spentWindows(limits, unsure ? null : S.fable, S.model)
  const text = String(details || '')
  if (!full.length && !(USAGE_SPENT.test(text) && (!THROTTLE.test(text) || USAGE_MARKER.test(text)))) return // not usage exhaustion
  sendFailures = 0 // a new arm: the refusals of an earlier one are not counted against it
  // A request that started before an account change failed on the old account's usage: the new one is tried a minute from now, no try spent.
  // Once per change, so a failure that reports no request start cannot loop.
  if (requestGen !== identityGen && staleArmedGen !== identityGen) {
    staleArmedGen = identityGen
    S.resumeAt = now + MIN
    resumeHeld = false
    resumeFromReadings = false // it rests on no reading
    $.ui.toast(`Out of usage. This chat resumes on its own at ${resumeText(S.resumeAt, now)}.`, { timeoutMs: 15000 })
    $.ui.invalidate('ui.render')
    return
  }
  const at = resumeTime(full, now)
  if (!at && resumeTries >= 3) {
    $.ui.toast('Auto-resume gave up: no reset time is known. Send a message once usage renews.', { timeoutMs: 15000 })
    return
  }
  S.resumeAt = at || now + RESUME_FALLBACK
  resumeHeld = false
  resumeFromReadings = full.length > 0
  if (!at) resumeTries++
  $.ui.toast(`Out of usage. This chat resumes on its own at ${resumeText(S.resumeAt, now)}.`, { timeoutMs: 15000 })
  $.ui.invalidate('ui.render')
}

// From the heartbeat tick: send "Resume" once its time has come, as the person's own word
async function resumeStep($) {
  if (!S.resumeAt || now < S.resumeAt || S.working || sendsHeld || wakePendingId || sendIsPending()) return // a send is being handed on or compacting, one was handed on and its request has not started, or a wake-up is on its way: its request settles the resume
  // the seat or the account is not known yet: the send waits until both are (refreshIdentity then brings it forward) or the window closes, without spending a try or compacting
  if (keyUnsure()) {
    S.resumeAt = wakeWindowEnd
    resumeHeld = true
    $.ui.invalidate('ui.render')
    return
  }
  S.resumeAt = 0
  resumeHeld = false
  resumeFromReadings = false
  $.ui.invalidate('ui.render')
  if (worthCompacting() && !justCompacted) { // not again after a compaction cancelled this one's send: the chat is already short
    compactThenSend($, { text: 'Resume' }, true)
    return
  }
  const before = { chat: chatGen, steps: stepsSeen }
  for (const asUser of [true, false]) {
    try {
      await $.prompt.submit({ text: 'Resume', ...(asUser ? { asUser } : {}) })
      sendFailures = 0
      return
    } catch {
      // try the plugin's own voice next
    }
  }
  await sendRefused($, before)
}

// A Resume neither submit way could send (the direct send and the unattended one after compacting): tried again 2 minutes on, four attempts in all, so it is not lost to one refusal.
// before: chatGen and stepsSeen from before the submits. A request that started or a chat replaced meanwhile settled it, and a re-arm made meanwhile stands: nothing is armed over either
async function sendRefused($, before) {
  const t = await $.clock.now() // read first: the check and the arm follow with no await between
  if (chatGen !== before.chat || stepsSeen !== before.steps || S.resumeAt) return
  if (++sendFailures > 3) {
    sendFailures = 0
    $.ui.toast('Could not send Resume after four tries. Send it yourself when ready.', { timeoutMs: 8000 })
    $.ui.invalidate('ui.render')
    return
  }
  S.resumeAt = t + CANCEL_REARM
  $.ui.toast(`Could not send Resume. Trying again at ${resumeText(S.resumeAt, t)}.`, { timeoutMs: 8000 })
  $.ui.invalidate('ui.render')
}

// wake: the id of the rotator wake-up this send is (0 for any other send)
function compactThenSend($, e, unattended, wake = 0) {
  const msg = { text: e.text, attachments: e.attachments, slash: !!e.command }
  const before = { seen: submitsSeen, real: realSends, chat: chatGen, steps: stepsSeen }
  sendsHeld++
  $.clock.after(50, () => runCompactThenSend($, msg, unattended, before, wake).catch(() => {}).finally(() => sendsHeld--))
  return { drop: 'cache-keeper: compacting first on a cold cache; the message is sent again once that finishes' }
}

// A wake-up that gives up releases the hold only if no later wake-up has taken it over
function lowerWake(id) {
  if (id && wakePendingId === id) wakePendingId = 0
}

async function runCompactThenSend($, msg, unattended, before, wake) {
  const cancelled = () => unattended && submitsSeen !== before.seen
  const resume = unattended && !wake // this mod's own Resume (a wake-up is the other unattended send)
  let compacted = false
  let hung = false
  let failure = '' // why our own compaction failed, said once it is known whether the message still goes
  while (compacting && !hung) { // our own compaction is already running: wait for it (at most SEND_SAFETY: a hung one must not hold every later send), and do not compact again if it succeeded
    hung = await Promise.race([compacting.then(() => false, () => false), new Promise((resolve) => $.clock.after(SEND_SAFETY, () => resolve(true)))])
  }
  try {
    if (justCompacted) compacted = true // a compaction finished with no request since: the chat is already short
    else if (!cancelled()) { // a send already cancelled does not compact for nothing
      const run = (async () => {
        await $.command.run({ command: 'compact', args: '' })
        markCompacted($)
      })()
      compacting = run
      try {
        await run
        compacted = true
      } finally {
        if (compacting === run) compacting = null
      }
    }
  } catch (err) {
    failure = clip(String((err && err.message) || err), 80)
  }
  // a cold-send dialog is open: what the person answers decides whether this one goes
  let dialog = false
  while (unattended && dialogsOpen > 0) {
    dialog = true
    await new Promise((resolve) => dialogsClosed.push(resolve))
  }
  // the Resume goes again 2 minutes on (resumeAt, shown in the band) unless another request starts, the chat is replaced or it is armed already. The time is read before the check: nothing that clears the re-arm can run between the check and the assignment
  const rearmResume = async () => {
    const t = await $.clock.now()
    const ok = chatGen === before.chat && stepsSeen === before.steps
    if (ok && !S.resumeAt) {
      S.resumeAt = t + CANCEL_REARM
      $.ui.invalidate('ui.render')
    }
    return { t, ok }
  }
  if (cancelled()) {
    // a message that reached the chat while compacting (another plugin's too), "Send anyway" or "Compact first" on a cold-send dialog, a wake-up that starts compacting, or /clear or a resume, cancels an automatic one (a local command, a dropped send or Cancel does not), and with it the wake-up's turn. A cancelled Resume is armed again when no request starts (resumeAt)
    lowerWake(wake)
    const { t, ok } = await rearmResume()
    const rearm = !wake && ok
    const handed = realSends !== before.real // a real message reached the chat
    const text = rearm
      ? handed ? `A message was sent meanwhile, so the automatic one waits until ${resumeText(S.resumeAt, t)} unless that message's request starts.` : `Something else was sent or chosen meanwhile, so the automatic one waits until ${resumeText(S.resumeAt, t)}.`
      : handed ? 'A message was sent meanwhile, so the automatic one was not sent.' : 'Something else was sent or chosen meanwhile, so the automatic one was not sent.'
    $.ui.toast((compacted ? 'Compacted. ' : '') + text, { timeoutMs: 8000 })
    return
  }
  if (resume && !compacted && dialog) {
    // the Resume waited on a cold-send dialog that closed without a send (Cancel), and its own compaction failed: sent uncompacted it would rewrite the context the dialog warned about. Armed again, which compacts again
    const { t, ok } = await rearmResume()
    if (ok) $.ui.toast(`Could not compact (${failure}), so the Resume waits until ${resumeText(S.resumeAt, t)}.`, { timeoutMs: 8000 })
    return
  }
  if (failure) $.ui.toast('Could not compact (' + failure + '), so the message goes as typed.', { timeoutMs: 8000 }) // an automatic message that was cancelled says only the cancel
  const send = { text: msg.text, ...(msg.attachments ? { attachments: msg.attachments } : {}) }
  // A plugin can't submit a "/" line: those go back in the prompt box
  if (!msg.slash) {
    const tried = { chat: chatGen, steps: stepsSeen }
    for (const asUser of unattended ? [true, false] : [true]) {
      try {
        const stepsBefore = stepsSeen
        await $.prompt.submit({ ...send, asUser })
        const t = await $.clock.now() // read first, then check and set with no await between
        if (resume) sendFailures = 0
        // the person's own message, handed on by this mod: its request may start later (not if one already did)
        if (!unattended && stepsSeen === stepsBefore) sendPending.set(++sendPendingId, t + SEND_SAFETY)
        return
      } catch {
        // try the next way, then the prompt box
      }
    }
    if (resume) { // not back in the prompt box: the Resume is tried again in 2 minutes
      await sendRefused($, tried)
      return
    }
  }
  let filled = false
  try {
    filled = !!(await $.prompt.fill({ text: msg.text })).isFilled
  } catch {
    filled = false
  }
  lowerWake(wake) // given up: no request of the wake-up's is on its way
  $.ui.toast(filled ? 'Compacted. Your message is back in the prompt box: press Enter to send it.' : 'Compacted, but the message could not be sent again: ' + clip(msg.text, 80), { timeoutMs: 15000 })
}

function findPr(text) {
  const m = cfg.prPattern && String(text || '').match(cfg.prPattern)
  return m && m[1] ? Number(m[1]) || 0 : 0
}

async function prState($) {
  try {
    const r = await $.process.run(['gh', 'pr', 'view', String(S.pr), '--json', 'state', '-q', '.state'], { cwd: S.cwd, timeoutMs: 20000 })
    return r.exitCode === 0 ? String(r.stdout).trim() : ''
  } catch {
    return ''
  }
}

// Plan limit windows as the API reports them: five_hour, seven_day, spend_limit
const LIMIT_LABEL = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }

function limitsText(limits) {
  return limits.map((l) => `${LIMIT_LABEL[l.kind] || l.kind} ${Math.round(l.percentUsed)}%`).join(' · ')
}

function money(v) {
  return rec.strict ? '$•••' : usd(v)
}

function msLeft(lastActivity, ttl) {
  if (!lastActivity) return null
  return ttl * MIN - (now - lastActivity)
}

// `left` is null for a cold cache of no known age (a reopened chat's last request ran on another account)
function cacheState(hb) {
  if (hb.rotated) return { kind: 'cold', left: hb.seatChangedAt ? hb.seatChangedAt - now : null }
  const left = msLeft(hb.lastActivity, hb.ttlMin)
  if (left === null) return { kind: 'unknown', left: 0 }
  if (hb.keepWarm) return { kind: 'kept', left }
  if (left <= 0) return { kind: 'cold', left }
  if (left <= 5 * MIN) return { kind: 'cooling', left }
  return { kind: 'warm', left }
}

function myHeartbeat() {
  const coldUsd = S.coldRestarts.reduce((a, c) => a + c.usd, 0)
  let state = 'idle'
  if (S.waitingSince && now - S.waitingSince > 5000) state = 'waiting'
  else if (S.working) state = 'working'
  return {
    id: S.id,
    label: S.label,
    cwd: S.cwd,
    model: S.model,
    state,
    waitingFor: S.waitingFor,
    tool: S.tool,
    ctx: S.ctx,
    window: S.window,
    ttlMin: ttlMin(),
    lastActivity: S.lastActivity,
    rotated: rotatedCold(),
    seatChangedAt: S.seatChangedAt,
    keepWarm: S.keepWarm,
    keepWarmUntil: S.keepWarmUntil,
    pings: S.pings,
    pingUsd: S.pingUsd,
    costUsd: S.costUsd,
    coldCount: S.coldRestarts.length,
    coldUsd,
    agentsRunning: S.agentsRunning,
    lastTurnEnd: S.lastTurnEnd,
    seat: S.seat,
    ...(S.account && !accountUnsure() ? { account: S.account } : {}), // what an unseated session's windows are borrowed by; left out while unknown after a wake-up
    desktop: !onTerminal,
    signedIn, // an API-key session's windows are not an account's: others must not borrow them
    rateLimits: keyUnsure() || unidentified() ? [] : S.rateLimits, // the engine's own reading, which a reopened chat borrows; none while the seat or account is unknown, as it may be the old account's, nor from a session that has neither
    updatedAt: now,
  }
}

// A session that has sent nothing has no plan windows of its own: borrow the freshest
// reading another session on the same account took, dropping a window that has since reset
export function stillOpen(limits, at) {
  return limits.filter((l) => !l.resetsAt || Date.parse(l.resetsAt) > at)
}

export function borrowedLimits(list, self, at) {
  // a seat on either side must match, on the same surface (each rotator names its seats alone): a seated and an unseated session are not known to share an account.
  // With no seat on either side the signed-in accounts decide: both must be known, and equal
  const same = (hb) => hb.desktop === self.desktop && (self.seat || hb.seat ? hb.seat === self.seat : !!self.account && hb.account === self.account)
  const best = list
    .filter((hb) => !hb.self && hb.signedIn !== false && Array.isArray(hb.rateLimits) && hb.rateLimits.length && same(hb))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]
  if (!best) return []
  return stillOpen(best.rateLimits, at)
}

async function registerCommand($, name, description, argumentHint, immediate) {
  const spec = immediate ? { name, description, argumentHint, immediate: true } : { name, description, argumentHint }
  try {
    await $.command.register(spec)
    return name
  } catch {
    try {
      await $.command.register({ ...spec, name: 'ck-' + name })
      return 'ck-' + name
    } catch {
      return null
    }
  }
}

async function readRecording($) {
  try {
    const path = (home || '.') + '/.claude/mods-data/recording.json'
    if (!(await $.fs.exists(path))) {
      rec = { on: false, strict: false }
    } else {
      const flag = JSON.parse(await $.fs.read(path))
      rec = { on: !!flag.on, strict: !!flag.on && !!flag.strict }
    }
  } catch {
    rec = { on: false, strict: false }
  }
  mask = rec.on ? makeMasker({ strict: rec.strict }) : (s) => s
}

async function heartbeat($, force) {
  if (!S.id) return
  if (!force && now - lastHeartbeat < 5000) return
  lastHeartbeat = now
  try {
    const agents = await $.agent.list()
    S.agentsRunning = agents.filter((a) => a.status === 'running').length
  } catch {
    // agent list unavailable: keep the last count
  }
  try {
    await $.store.set('hb:' + S.id, myHeartbeat())
  } catch {
    // another session holds the store's lock: the next beat writes it
  }
}

// The plan's per-model weekly limits (Fable) aren't in session.measure, so read the
// usage endpoint the app's usage card reads. One fetch per 5 minutes per account (per seat when a seat file
// is set), shared through the store by that account's sessions; a 429 backs those sessions off the same 5 minutes.
const PLAN_EVERY = 5 * MIN
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
let planWhy = ''
let planNext = 0
// One reading per account, shared by its sessions: the endpoint rate-limits a second schedule within seconds.
// An older version kept one reading under this bare key for every account: a signed-in session never reads it, nor writes it.
const PLAN_KEY = 'plan'

// Each account has its own limits: with a seat file configured, a reading per surface and seat
// (the terminal's and the app's rotators name their seats independently), else one per signed-in account
function planKey() {
  if (S.seat) return `${PLAN_KEY}:${onTerminal ? 'cli' : 'app'}:${S.seat}`
  return S.account ? `${PLAN_KEY}:account:${S.account}` : PLAN_KEY
}

// A session that can name neither seat nor account has no key of its own: the bare one would be shared with sessions on other accounts.
// If signed in (or not yet known to be, where the sign-in check failed) it fetches for itself, shares nothing, lends no windows and borrows none.
function unidentified() {
  return signedIn !== false && !S.seat && !S.account // an unchecked sign-in counts: it cannot be told from one that will turn out signed in
}

async function refreshPlan($) {
  if (keyUnsure()) return // the key may name the old account: it would take the new account's reading, and planNext waits for the real one
  const key = planKey() // one account's reading throughout, though the seat can change while the fetch is out
  const wake = wakeCount
  // a seat change or a wake-up during an await below: the reading is the old account's, or may be
  const stale = () => planKey() !== key || wakeCount !== wake || keyUnsure()
  // An API-key session has no first-party sign-in: the shared reading is another account's
  if (signedIn === null || (signedIn === false && now >= signCheckAt)) {
    try {
      signedIn = !!(await $.session.authorize())
    } catch {
      signedIn = null // can't tell: carry on as before
    }
    signCheckAt = now + PLAN_EVERY
  }
  // a seat or account change, or a wake-up, during any await below: don't restore the old account's readings
  if (stale()) return
  if (signedIn === false) return noSignIn()
  const alone = unidentified() // once: a seat or account change during an await makes stale() return
  let cached = null
  try {
    cached = alone ? null : await $.store.get(key)
  } catch {
    cached = null
  }
  if (stale()) return
  const prior = cached && typeof cached === 'object' ? cached : {}
  if (Array.isArray(prior.windows) && prior.windows.length) S.planWindows = prior.windows
  // an older version writes null after a failed check: never let that wipe a good reading
  if (prior.fable) S.fable = prior.fable
  planWhy = prior.why || planWhy
  // the store's backoff, or this session's own where a held lock kept it out of the store
  if (now < Math.max(prior.next || (prior.at || 0) + PLAN_EVERY, planNext)) return
  planNext = now + PLAN_EVERY
  // claim the slot first, so a session that wakes meanwhile finds it taken
  try {
    if (!alone) await $.store.set(key, { ...prior, next: now + PLAN_EVERY })
  } catch {
    // lock held: this session's own planNext still holds it back
  }
  if (stale()) return
  let fable = prior.fable || S.fable
  let windows = Array.isArray(prior.windows) && prior.windows.length ? prior.windows : S.planWindows
  let at = prior.at || 0 // when the reading was taken: a failure keeps the last good one
  let next = now + PLAN_EVERY
  let why = 'ok' // the last attempt's outcome, kept with the reading for /cache
  let fetched = false
  try {
    const auth = await $.session.authorize()
    if (!auth) {
      if (stale()) return
      signedIn = false
      return noSignIn()
    }
    signedIn = true
    const r = await $.http.fetch(USAGE_URL, { auth: auth.handle, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
    if (r.ok) {
      const body = JSON.parse(r.text)
      fable = fableLimit(body)
      windows = planWindows(body)
      at = now
      fetched = true
    } else why = 'HTTP ' + r.status
    // a 429 names how long to stay away; every session on this key waits it out, an hour at most
    const wait = Number(r.headers && r.headers['retry-after'])
    if (!r.ok && wait > 0) next = now + Math.min(60 * MIN, Math.max(PLAN_EVERY, wait * 1000))
  } catch (err) {
    why = clip(String((err && err.message) || err), 120) // offline or refused: keep the last reading
  }
  // the seat moved on meanwhile, or a wake-up came: this is the old account's reading, and the new one's slot is untouched
  if (stale()) return
  planNext = next
  S.fable = fable
  S.planWindows = windows
  planWhy = why
  try {
    // a failed check must not put its older reading over one another session took meanwhile
    if (alone) return
    const stored = fetched ? null : await $.store.get(key)
    if (stale()) return
    if (stored && typeof stored === 'object' && (stored.at || 0) > (prior.at || 0)) {
      if (Array.isArray(stored.windows) && stored.windows.length) S.planWindows = stored.windows
      if (stored.fable) S.fable = stored.fable
      return
    }
    await $.store.set(key, { at, next, fable, windows, why })
  } catch {
    // lock held: another session is writing the same reading
  }
}

// Nothing to read or write: the shared plan reading would be another account's
function noSignIn() {
  S.fable = null
  S.planWindows = []
  planWhy = 'no first-party sign-in'
}

// An opened or resumed session has sent nothing yet, so measure its first request from the
// transcript: the last main-loop reply's usage is what that request re-reads, and its time
// says how long the cache has been idle. A compaction after it leaves its own smaller size.
export function lastContext(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let j
    try {
      j = JSON.parse(lines[i])
    } catch {
      continue // the tail's first line is cut mid-row
    }
    if (!j || j.isSidechain) continue
    const at = Date.parse(j.timestamp || '') || 0
    const meta = j.compactMetadata
    // any compaction boundary ends the walk: what lies before it was compacted away
    if (j.type === 'system' && j.subtype === 'compact_boundary') return { ctx: (meta && meta.postTokens) || 0, at, compacted: true }
    const u = j.type === 'assistant' && j.message && j.message.usage
    // the next request re-reads that reply too, so its output counts
    if (u && totalInput(u) > 0) return { ctx: totalInput(u) + (u.output_tokens || 0), at, model: j.message.model, effort: typeof j.effort === 'string' ? j.effort : '' }
  }
  return null
}

const TAIL_BYTES = 1024 * 1024
// $.fs.read stops at 4 MiB and has no offset, so a long transcript's tail comes through node
const TAIL_JS = "const fs=require('fs'),p=process.argv[1],s=fs.statSync(p).size,n=Math.min(s," + TAIL_BYTES + "),b=Buffer.alloc(n),fd=fs.openSync(p,'r');fs.readSync(fd,b,0,n,s-n);process.stdout.write(b)"

// A chat's last request, kept past the session: the app has no $.process.run, so it cannot
// read a transcript over 4 MiB, and a big chat is exactly the one the cold-send guard is for
const LAST_KEEP = 30 * 24 * 60 * MIN
async function rememberLast($) {
  if (!S.id || !S.ctx) return
  try {
    // the chat's cold rewrites too, so their cost survives a reopen
    await $.store.set('last:' + S.id, { ctx: S.ctx, at: S.lastActivity, model: S.model, effort: S.effort, cold: S.coldRestarts.slice(-50), ...whoRan() })
  } catch {
    // another session holds the store's lock: the next request writes it
  }
}

async function seedFromTranscript($, path) {
  let found = null
  try {
    const st = await $.fs.stat(path)
    if (st.kind === 'file' && st.size) {
      const text = st.size <= 4 * 1024 * 1024 ? String(await $.fs.read(path)) : (await $.process.run(['node', '-e', TAIL_JS, path], { timeoutMs: 15000 })).stdout
      found = lastContext(String(text).split('\n'))
    }
  } catch {
    // no transcript yet, or too big to read here (the app): fall back on what this mod kept
  }
  let last = null
  try {
    last = S.id ? await $.store.get('last:' + S.id) : null
  } catch {
    last = null
  }
  if (last && Array.isArray(last.cold) && !S.coldRestarts.length) S.coldRestarts = last.cold
  if (!found && S.id) {
    try {
      // before its first record, a chat open under an earlier version still has its heartbeat
      const hb = last ? null : await $.store.get('hb:' + S.id)
      const r = last || (hb && { ctx: hb.ctx, at: hb.lastActivity, model: hb.model, effort: hb.effort })
      // an `at` of 0 was written between a compaction and the next request
      if (r && r.ctx) found = { ctx: r.ctx, at: r.at, model: r.model, effort: r.effort, compacted: !r.at }
    } catch {
      // store unavailable: the first request measures it
    }
  }
  if (!found) return
  S.ctx = found.ctx
  if (found.model && !S.model) S.model = found.model // the session's own model wins: it may have been switched
  if (found.effort) S.effort = found.effort
  judgeChat(found, last)
  if (found.compacted) {
    // the next request writes the compacted context whatever happens: nothing to ask
    S.floor = found.ctx
    markCompacted($)
  }
  $.ui.invalidate('ui.render')
}

// The response's `limits` carries { kind: 'weekly_scoped', scope: { model: { display_name } }, percent, resets_at }
// The same response's five_hour and seven_day, as { utilization, resets_at }, in session.measure's shape
export function planWindows(body) {
  return ['five_hour', 'seven_day'].flatMap((kind) => {
    const w = body && body[kind]
    if (!w || typeof w.utilization !== 'number') return []
    return [{ kind, percentUsed: w.utilization, resetsAt: resetIso(w.resets_at) }]
  })
}

function resetIso(at) {
  return typeof at === 'number' ? new Date(at * 1000).toISOString() : typeof at === 'string' ? at : undefined
}

export function fableLimit(body) {
  const list = body && Array.isArray(body.limits) ? body.limits : []
  const hit = list.find((l) => l && l.kind === 'weekly_scoped' && /fable/i.test(String(l.scope && l.scope.model && l.scope.model.display_name)))
  if (!hit || typeof hit.percent !== 'number') return null
  return { percentUsed: hit.percent, resetsAt: resetIso(hit.resets_at) }
}

async function readFleet($) {
  const all = await $.store.keys()
  // a chat untouched for a month will not be reopened to send: drop its record
  if (now - lastPrune > 60 * MIN) {
    lastPrune = now
    for (const k of all.filter((k) => k.startsWith('last:'))) {
      const r = await $.store.get(k)
      if (!r || now - (r.at || r.keptAt || now) > LAST_KEEP) await $.store.delete(k)
    }
  }
  const keys = all.filter((k) => k.startsWith('hb:'))
  const list = []
  for (const k of keys) {
    const hb = await $.store.get(k)
    if (!hb || typeof hb !== 'object') continue
    if (hb.id === S.id) continue
    // a session that stopped heartbeating an hour ago has ended or crashed
    if (now - (hb.updatedAt || 0) > 60 * MIN) {
      await $.store.delete(k)
      continue
    }
    list.push({ ...hb, stale: now - (hb.updatedAt || 0) > 3 * MIN })
  }
  list.push({ ...myHeartbeat(), self: true })
  fleet = list
}

// Commands another session's board sent this one, through the shared store
async function applyRemoteCommands($) {
  const c = await $.store.get('cmd:' + S.id)
  if (!c) return
  await $.store.delete('cmd:' + S.id)
  if (c.keepWarm === true) {
    S.autoWarm = true
    startKeepWarm($, settings.keepWarmHours)
  }
  if (c.keepWarm === false) {
    S.autoWarm = false
    stopKeepWarm($, 'stopped from the board')
  }
}

function startKeepWarm($, hours, auto = false) {
  S.keepWarm = true
  S.keepWarmAuto = auto
  S.keepWarmUntil = now + hours * 60 * MIN
  $.ui.toast(`Keeping this cache warm until ${clock(S.keepWarmUntil)}. A ping reads the cache before it expires.`)
}

function stopKeepWarm($, why) {
  if (!S.keepWarm) return
  S.keepWarm = false
  $.ui.toast(`Keep warm off (${why}). ${S.pings} ping(s), ${money(S.pingUsd)}.`, { timeoutMs: 8000 })
}

async function keepWarmStep($) {
  if (!S.keepWarm) return
  if (now >= S.keepWarmUntil) return stopKeepWarm($, 'time limit reached')
  if (S.pr && now - S.prCheckedAt > 15 * MIN) {
    S.prCheckedAt = now
    const state = await prState($)
    if (state === 'MERGED' || state === 'CLOSED') {
      S.autoWarm = false
      return stopKeepWarm($, `PR #${S.pr} is ${state.toLowerCase()}`)
    }
  }
  // After a rotation a ping would pay the whole rewrite: leave that to the next real turn
  if (S.working || !S.lastActivity || rotatedCold()) return
  const ttl = ttlMin()
  const margin = ttl >= 60 ? 8 * MIN : 90000
  if (now - S.lastActivity < ttl * MIN - margin) return
  let reply = null
  try {
    reply = await $.model.fork({ prompt: 'cache-keeper keep-alive ping. Reply with only: ok' })
  } catch {
    reply = null
  }
  if (!reply || !reply.usage) {
    return stopKeepWarm($, 'the ping got no answer, so the cache may already be cold')
  }
  const u = reply.usage
  S.pings += 1
  S.lastPingAt = now
  const pingCost = requestCost(u, S.model, ttl)
  S.pingUsd += pingCost
  if (S.keepWarmAuto) S.autoPingUsd += pingCost
  // A ping that writes instead of reading did not hit the cache: stop paying for it
  if ((u.cache_creation_input_tokens || 0) > 0.1 * Math.max(1, u.cache_read_input_tokens || 0)) {
    return stopKeepWarm($, `the ping wrote ${tokens(u.cache_creation_input_tokens)} tokens instead of reading the cache`)
  }
  S.lastActivity = now
  await rememberLast($)
  // Auto keep warm only pays while it costs less than the rewrite it protects: on a 5-minute cache the pings catch up fast
  if (S.keepWarmAuto && S.autoPingUsd >= rewriteCost(S.ctx, S.model, ttl)) {
    return stopKeepWarm($, `its pings have cost as much as rewriting the cache (${money(S.autoPingUsd)})`)
  }
}

function warnStep($) {
  if (!settings.alerts) return
  for (const hb of fleet) {
    if (hb.stale || hb.keepWarm || (hb.ctx || 0) < settings.bigTokens) continue
    const st = cacheState(hb)
    if (st.kind !== 'cooling') continue
    const key = 'cool:' + hb.lastActivity
    if (alerted.get(hb.id) === key) continue
    alerted.set(hb.id, key)
    const cost = money(rewriteCost(hb.ctx, hb.model, hb.ttlMin))
    const who = hb.self ? 'This session' : `"${mask(hb.label)}"`
    const how = hb.self ? `type /${names.keepwarm} or press 1` : `open /${names.board} to keep it warm`
    $.ui.toast(`${who}: ${tokens(hb.ctx)}-token cache goes cold in ${minutes(st.left)}. Rewriting it costs about ${cost}. ${how}.`, { timeoutMs: 15000 })
  }
  // Another session started waiting on a permission or a question
  for (const hb of fleet) {
    if (hb.self || hb.stale) continue
    const prev = alerted.get('state:' + hb.id)
    alerted.set('state:' + hb.id, hb.state)
    if (hb.state === 'waiting' && prev && prev !== 'waiting') {
      $.ui.toast(`"${mask(hb.label)}" is waiting on you${hb.waitingFor ? ': ' + hb.waitingFor : ''}`, { timeoutMs: 10000 })
    }
  }
}

// The rotator writes .claude.json and the seat file separately, at times we don't know. So for WAKE_WINDOW after a
// wake-up, a field still unchanged (or an account that reads empty) is unknown and the ticks look again, each file on its own; once the window is over
// the session keeps the seat and account it has. Outside a window a change is never taken: only a wake-up carries one.
// A request that landed since the wake-up may have run on the old account: adopting then marks the cache cold.
// The account is what switches the credential, and the seat label can be written before it, so an account adopted late re-marks
// whatever the seat did, unless the wake-up already showed the seat change. A seat adopted after the account was already known
// never re-marks: that request ran on the new account.
async function refreshIdentity($) {
  if (!wakeWindowEnd) return
  if (now >= wakeWindowEnd) {
    seatUnknown = false
    accountUnknown = false
    wakeWindowEnd = 0
    wakePendingId = 0 // the window is over: a wake-up whose request never started no longer holds the resume
    return
  }
  if (!seatUnknown && !accountUnknown) return
  let adopted = false
  let accountAdopted = false
  try {
    if (accountUnknown && (await readAccount($, true)) && S.account !== wakeAccount) {
      // the readings were the old account's, as at a wake-up that already shows the new one
      dropReadings()
      accountUnknown = false
      adopted = true
      accountAdopted = true
    }
    if (seatUnknown && (await $.fs.exists(seatFile))) {
      const seat = String(await $.fs.read(seatFile)).trim()
      if (seat && seat !== wakeSeat) {
        // the old account's readings, as readSeat drops them
        dropReadings()
        S.seat = seat
        seatUnknown = false
        adopted = true
      }
    }
  } catch {
    // unreadable now: the next tick looks again
  }
  if (adopted) {
    if ((accountAdopted ? !seatMoved : !accountMoved) && S.lastActivity > rotationSeenAt) {
      rotatedPending = true
      S.seatChangedAt = now
      rotationSeenAt = now
    }
    if (accountAdopted) accountMoved = true
  }
  // the seat and account are both known now: a due resume that waited for them goes at once, not at the window's end
  if (resumeHeld && !keyUnsure()) {
    resumeHeld = false
    if (S.resumeAt) {
      S.resumeAt = now
      $.ui.invalidate('ui.render')
    }
  }
}

async function tick($) {
  now = await $.clock.now()
  try {
    await refreshIdentity($)
    await resumeStep($)
    await refreshPlan($)
    try {
      await loadSettings($) // /cache set in another session applies here too
    } catch {
      // a store lock held by another session: the settings stay as they were
    }
    await readRecording($)
    try {
      await applyRemoteCommands($)
    } catch {
      // a bad command record must not skip the keep-warm, heartbeat and fleet reads
    }
    await keepWarmStep($)
    await heartbeat($, true)
    await readFleet($)
    warnStep($)
  } finally {
    // a store lock held by another session must not freeze the band's clocks
    $.ui.invalidate('ui.render')
  }
}

async function loadSettings($) {
  const saved = await $.store.get('settings')
  if (saved && typeof saved === 'object') Object.assign(settings, saved)
}

function statusText() {
  const st = cacheState(myHeartbeat())
  const ttl = ttlMin()
  const lines = []
  lines.push(`Cache Keeper: ${tokens(S.ctx)} tokens in context on ${priceFor(S.model).id}, cache window ${ttl} min (${settings.ttlMin ? 'set by you' : S.ttlSource}).`)
  if (st.kind === 'unknown') lines.push('No request yet this session, so the cache state is unknown.')
  if (st.kind === 'warm' || st.kind === 'cooling') lines.push(`Cache is warm for about ${minutes(st.left)} more.`)
  if (st.kind === 'cold') lines.push(`Cache ${st.left === null ? 'is cold' : `went cold ${minutes(-st.left)} ago`}. The next message rewrites it for about ${money(rewriteCost(S.ctx, S.model, ttl))}.`)
  if (rotatedCold()) lines.push(`The account rotated${rotatedAgo()} (now ${mask(S.seat || S.account)}), so the cache is cold.`)
  if (S.keepWarm) lines.push(`Keep warm is on until ${clock(S.keepWarmUntil)}: ${S.pings} ping(s), ${money(S.pingUsd)} so far.`)
  if (S.rateLimits.length) lines.push(`Plan limits used: ${limitsText(S.rateLimits)}.`)
  if (keyUnsure()) lines.push('Fable weekly: waiting for the rotator to name the new seat or account.')
  else lines.push(S.fable ? `Fable weekly: ${Math.round(S.fable.percentUsed)}% used.` : `Fable weekly: no reading yet${planWhy && planWhy !== 'ok' ? ` (last check: ${planWhy})` : ''}.`)
  lines.push(`Session cost so far: ${money(S.costUsd)}. Cold restarts this session: ${S.coldRestarts.length} (${money(S.coldRestarts.reduce((a, c) => a + c.usd, 0))}).`)
  lines.push(`Cold-send guard: ${settings.guard ? 'on' : 'off'} for contexts over ${tokens(settings.bigTokens)} tokens. Alerts: ${settings.alerts ? 'on' : 'off'}.`)
  lines.push(`Auto keep warm: ${settings.autoWarmHours ? `on, until ${settings.autoWarmHours}h after the last turn (sooner once its pings cost as much as the rewrite), for contexts over ${tokens(settings.bigTokens)}${S.autoWarm ? '' : ' (off in this session)'}` : 'off'}.`)
  lines.push(`Settings: /${names.cache} ttl 5|60|auto, /${names.cache} guard on|off, /${names.cache} big 150k, /${names.cache} alerts on|off, /${names.cache} autowarm 8|off. Board: /${names.board}.`)
  return lines.join('\n')
}

function parseTokens(text) {
  const m = String(text || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/)
  if (!m) return null
  return Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1))
}

export function register(on, options = {}) {
  cfg.seatFileTerminal = String(options.seatFileTerminal || '')
  cfg.seatFileDesktop = String(options.seatFileDesktop || '')
  cfg.rotatorWake = pattern(options.rotatorWakePattern, 'i')
  cfg.prPattern = pattern(options.prPattern)
  cfg.autoResume = options.autoResume === true
  on('session.start', async ($, e, next) => {
    now = await $.clock.now()
    home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    S.id = await $.session.id()
    S.cwd = await $.session.cwd()
    S.label = basename(S.cwd)
    S.model = await $.session.model()
    try {
      await loadSettings($)
    } catch {
      // a store lock held by another session: the defaults stand until the next tick
    }
    await readRecording($)
    let surface = null
    try {
      surface = e.surface || (await $.session.surface())
    } catch {
      surface = null
    }
    onTerminal = surface === 'terminal'
    // the app starts a session with no surface yet (null), so only 'terminal' means the CLI's rotator
    const seatPath = onTerminal ? cfg.seatFileTerminal : cfg.seatFileDesktop
    seatFile = seatPath ? seatPath.replace(/^~(?=[\\/])/, home).replace(/\\/g, '/') : ''
    await readSeat($)
    await readAccount($)
    identityRead = true
    try {
      // the plan windows the status line already holds: free, and there before the first send
      const usage = await $.session.usage()
      // not a request that started before an account change: its windows are the old account's
      if (Array.isArray(usage.rateLimits) && usage.rateLimits.length && requestGen === identityGen) S.rateLimits = usage.rateLimits
    } catch {
      // none yet: the first measure fills them
    }
    try {
      const first = (await $.session.messages()).find((m) => m.role === 'user' && findPr(m.text))
      if (first) S.pr = findPr(first.text)
    } catch {
      // no transcript yet: the first prompt sets it
    }
    names.cache = (await registerCommand($, 'cache', 'Cache Keeper status and settings', '[ttl 5|60|auto] [guard on|off] [big 150k] [alerts on|off]')) || names.cache
    names.keepwarm = (await registerCommand($, 'keepwarm', 'Keep this session\'s prompt cache warm (default 4 hours), or /keepwarm off (also stops auto keep warm here)', '[hours|off]', true)) || names.keepwarm
    names.board = (await registerCommand($, 'board', 'Every local Claude Code session: state, context, cache, cost', '', true)) || names.board
    names.handoff = (await registerCommand($, 'handoff', 'Session handoff, then clear this chat and continue with it (/handoff continue)', '[continue]')) || names.handoff
    $.clock.every(HEARTBEAT_EVERY, () => tick($).catch(() => {}))
    await heartbeat($, true)
    $.clock.after(0, () => readFleet($).catch(() => {}).then(() => refreshPlan($)).then(() => $.ui.invalidate('ui.render')).catch(() => {}))
    // A startup or resume SessionStart that came first left its transcript for here, where the seat and account are known.
    // The app reopens a chat without one that names the transcript: find it by id
    const queued = pendingSeed
    pendingSeed = null
    if (!S.ctx && S.id && S.cwd) {
      const config = ((await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`).replace(/\\/g, '/')
      await seedFromTranscript($, queued || `${config}/projects/${S.cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${S.id}.jsonl`)
    }
    return next(e)
  })

  // /clear starts from an unknown cache; /resume is seeded from its transcript; /branch shares its parent's cache.
  // The process goes on under a new session id, and no session.start fires for it. (A resume in a fresh process, claude --resume or
  // --continue, can arrive before session.start: its transcript waits in pendingSeed and is seeded there.)
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    // the branch's first request reads the same cached prefix as its parent's: what the parent had stands
    if (e.source !== 'fork') {
      S.seatChangedAt = 0
      rotatedPending = false
      S.lastActivity = 0
      // the last chat's compaction says nothing about this one, and would mute its cold-send guard
      justCompacted = false
      compactedCold = false
      S.floor = 0
      S.ctx = 0 // the last chat's size; a resumed chat's own is seeded below (a cleared one starts at 0)
      pendingSeed = null // a transcript still waiting for session.start belongs to the chat this one replaces
    }
    S.keepWarm = false
    H.armed = false
    S.coldRestarts = [] // a resumed chat's own come back with its seed
    // a resume armed in the last chat must not fire into this one
    S.resumeAt = 0
    resumeFromReadings = false
    resumeHeld = false
    wakePendingId = 0
    sendPending.clear()
    chatGen++
    resumeTries = 0
    sendFailures = 0
    submitsSeen++ // the chat is replaced: an unattended send still compacting (our Resume, a wake-up) must not go into the new one
    $.ui.invalidate('ui.render')
    try {
      S.id = (await $.session.id()) || S.id
    } catch {
      // keep the old id
    }
    S.label = basename(S.cwd)
    // a fork keeps its parent's cache, so only a resume seeds; before session.start has read the seat and account it waits for there
    if (e.source === 'resume') {
      if (identityRead) await seedFromTranscript($, e.transcript_path)
      else pendingSeed = e.transcript_path
    }
    return next(e)
  })

  // A session opened with its history (the app reopening an old chat). claude --continue may arrive here or as a resume above
  on('classic.SessionStart', { source: ['startup'] }, async ($, e, next) => {
    // before session.start has read the seat and account, the record cannot be compared: seed there
    if (identityRead) await seedFromTranscript($, e.transcript_path)
    else pendingSeed = e.transcript_path
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (S.id) await $.store.delete('hb:' + S.id)
    return next(e)
  })

  // The first prompt names the session on the board
  on('prompt.submit', async ($, e, next) => {
    now = await $.clock.now()
    if (S.label === basename(S.cwd) && e.origin && e.origin.kind === 'composer' && e.text) {
      S.label = basename(S.cwd) + ' · ' + clip(e.text, 40)
    }
    // A new message in this chat makes a waiting handoff out of date (its file stays)
    if (H.text && !H.continuing && e.origin && e.origin.kind === 'composer' && !String(e.text || '').trim().startsWith('/')) {
      H.text = ''
      H.path = ''
      $.ui.invalidate('ui.render')
    }
    if (!S.pr) S.pr = findPr(e.command ? `/${e.command.name} ${e.command.args}` : e.text)
    const fromUser = e.origin && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')
    const wake = fromUser && !!cfg.rotatorWake && cfg.rotatorWake.test(String(e.text || ''))
    let wakeId = 0 // this wake-up's id, to lower only its own hold
    if (wake) {
      // The wake-up is the rotation reaching this session: take the new seat now; a late rewrite is taken within WAKE_WINDOW
      wakeCount++
      wakePendingId = wakeId = wakeCount // before anything is re-read: a re-read must not re-arm a pending resume, nor may one fire; the wake-up's own request settles it
      wakeSeat = S.seat
      wakeAccount = S.account
      wakeWindowEnd = now + WAKE_WINDOW
      await readSeat($, true)
      rotationSeenAt = now
      // the seat file may be absent or unchanged: the account is what moved
      await readAccount($, true)
      // a field still as it was, or an account that read empty, is unknown: the rotator may not have written it yet, the ticks look again for the window
      seatUnknown = !!seatFile && S.seat === wakeSeat
      accountUnknown = !S.account || S.account === wakeAccount
      seatMoved = !!seatFile && S.seat !== wakeSeat
      accountMoved = !accountUnknown
      if (accountMoved) dropReadings(false) // the account is known to have moved: the readings are the old account's, as on a seat change; the wake-up is itself the resume (wakePendingId), so a pending one is not re-armed
      S.seatChangedAt = now // a second wake-up of an already rotated chat dates it anew
      rotatedPending = true
    }
    const ttl = ttlMin()
    const left = msLeft(S.lastActivity, ttl)
    const rotated = rotatedCold()
    const isCold = rotated || (left !== null && left <= 0)
    // These run locally or start afresh: a cold cache costs them nothing
    const local = e.command && ['compact', 'clear', names.cache, names.keepwarm, names.board, names.handoff].includes(e.command.name)
    // a message handed on and not dropped by a later hook reaches the chat: the unattended sends see it. Not a local command (isLocalBuiltin), nor this mod's own Resume or send. Whether it settles a pending resume is up to its request (turn.step)
    const counts = !local && !isLocalBuiltin(e.command) && !(e.origin && e.origin.kind === 'plugin' && e.origin.name === $.plugin.name)
    const mine = counts || fromUser // a send handed on that is not this mod's own, or any command of the person's: a due resume waits while it is handed on, whether or not the guard asked
    const through = async () => {
      if (mine) sendsHeld++
      const pendingId = counts ? ++sendPendingId : 0 // handed on and not this mod's own: its request may start well after next() returns
      if (pendingId) sendPending.set(pendingId, now + SEND_SAFETY)
      let handed = false
      try {
        const r = await next(e)
        if (counts && !(r && r.drop)) {
          submitsSeen++
          realSends++
          handed = true
        } else if (wake && r && r.drop) lowerWake(wakeId) // dropped further down: no request of the wake-up's is on its way
        return r
      } finally {
        if (mine) sendsHeld--
        if (handed) {
          const t = await $.clock.now() // read first: a request starting during the read clears sendPending, and must not be followed by a set
          if (sendPending.has(pendingId)) sendPending.set(pendingId, t + SEND_SAFETY) // the safety runs from the hand-over
        } else sendPending.delete(pendingId) // dropped or failed: no request follows
      }
    }
    if (!settings.guard || !fromUser || !isCold || local || guardSkips(e.command) || justCompacted || S.ctx < settings.bigTokens || e.turnId) return through()
    // an attachment's handle lives only while this submit is in flight: a resend after compacting would drop it
    const media = Array.isArray(e.attachments) && e.attachments.length > 0
    if (wake) {
      if (!worthCompacting() || media) return through()
      submitsSeen++ // the wake-up is a message of the chat's own: an unattended send still compacting (the Resume) must not go next to it
      return compactThenSend($, e, true, wakeId)
    }
    const cost = money(rewriteCost(S.ctx, S.model, ttl))
    const why = rotated ? `The account rotated to ${mask(S.seat || S.account) || 'another seat'}${rotatedAgo()}, so the cache is cold.` : `Cache went cold ${minutes(-left)} ago.`
    const floor = S.floor ? ` Compacting last left ${tokens(S.floor)}.` : ''
    sendsHeld++ // the dialog is open: a due resume waits, until the send is handed on or given up
    dialogsOpen++ // an unattended send that has compacted waits for the answer
    try {
      let answer = 'Send anyway'
      try {
        answer = await $.ui.ask(
          `${why} Sending now rewrites ${tokens(S.ctx)} tokens of context (about ${cost}).${floor}${media ? ' (Compacting first would drop the attachment: run /compact yourself, then send again.)' : ''} What should happen?`,
          media ? ['Send anyway', 'Cancel'] : ['Send anyway', 'Compact first, then send', 'Cancel'],
        )
      } catch {
        // nobody to ask (a -p run, or the dialog was dismissed): send as typed
        return await through()
      }
      // $.session.compact() is refused on SDK hosts (the desktop app), so this queues /compact. It takes its own hold, until it has sent or given up
      if (answer === 'Compact first, then send') {
        submitsSeen++ // the person's own message goes next: an unattended send still compacting (the Resume) must not go beside it
        return compactThenSend($, e, false)
      }
      if (answer === 'Send anyway') return await through()
      $.ui.toast('Not sent. A fresh session with a short handoff avoids the rewrite entirely.', { timeoutMs: 8000 })
      return { drop: 'Cancelled by cache-keeper before a cold cache rewrite' }
    } finally {
      sendsHeld--
      if (--dialogsOpen === 0) for (const resolve of dialogsClosed.splice(0)) resolve() // lowered after a Send anyway has been handed on (through counted it)
    }
  })

  on('turn.start', async ($, e, next) => {
    now = await $.clock.now()
    S.working = true
    sendPending.clear() // the request the sends handed on started
    if (e.turnId) S.turnId = e.turnId
    await heartbeat($, true)
    return next(e)
  })

  // Each main-loop request: did it read the cache, or rewrite it?
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      requestGen = identityGen
      // a main-loop request started: what was sent reached the chat, so a pending resume is settled (our own "Resume" zeroes it before it sends), and a wake-up's own request has arrived. Nothing else settles it: a prompt passing through, even the guard's Send anyway, may still be dropped or fail to start
      wakePendingId = 0
      sendPending.clear()
      stepsSeen++
      resumeHeld = false
      resumeFromReadings = false // settled: a later account change must not bring it back
      sendFailures = 0
      if (S.resumeAt) {
        S.resumeAt = 0
        $.ui.invalidate('ui.render')
      }
    }
    const startedAt = await $.clock.now()
    if (!e.agentId) {
      S.model = e.model || S.model
      S.effort = e.effort === undefined ? '' : String(e.effort)
    }
    const result = yield* next(e)
    if (e.agentId || !result || !result.usage) return result
    now = await $.clock.now()
    const u = result.usage
    const total = totalInput(u)
    const written = u.cache_creation_input_tokens || 0
    const gap = S.lastActivity ? startedAt - S.lastActivity : 0
    S.model = u.model || S.model
    const afterCompact = justCompacted
    justCompacted = false
    // The API names the TTL each write used: that beats any guess from idle gaps
    const split = u.cache_creation
    if (split && !settings.ttlMin) {
      if ((split.ephemeral_1h_input_tokens || 0) > 0) S.ttlMin = 60
      else if ((split.ephemeral_5m_input_tokens || 0) > 0) S.ttlMin = 5
      if (written > 0) S.ttlSource = 'reported by the API'
    }
    if (afterCompact) {
      // the first request after a compaction writes the new, shorter context: expected,
      // but on a cache that had gone cold it is the cold rewrite, only smaller
      S.floor = total
      if (compactedCold && written > 30000) S.coldRestarts.push({ at: now, tokens: written, usd: rewriteCost(written, S.model, ttlMin()), gapMin: 0 })
      compactedCold = false
    } else if (S.lastActivity && total > 30000 && written / total > 0.5) {
      // Without the API's word: a rewrite after 5-60 idle minutes suggests the 5-minute TTL,
      // unless a rotation emptied the cache (a compaction already cleared lastActivity)
      if (!settings.ttlMin && !split && !rotatedCold() && gap > 5.5 * MIN && gap < S.ttlMin * MIN) {
        S.ttlMin = 5
        S.ttlSource = 'measured'
      }
      S.coldRestarts.push({ at: now, tokens: written, usd: rewriteCost(written, S.model, ttlMin()), gapMin: Math.round(gap / MIN) })
    } else if (S.lastActivity && total > 30000 && gap > 5.5 * MIN && cachedShare(u) > 0.8) {
      // A hit after more than 5 idle minutes proves the 1-hour TTL
      if (!settings.ttlMin) {
        S.ttlMin = 60
        S.ttlSource = 'measured'
      }
    }
    S.ctx = total
    S.lastActivity = now
    S.autoPingUsd = 0 // a real request ends the idle stretch the pings were protecting
    rotatedPending = false
    await rememberLast($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    now = await $.clock.now()
    S.working = false
    S.waitingSince = 0
    S.tool = ''
    S.lastTurnEnd = now
    if (e.reason === 'answer') resumeTries = 0 // usage is back: a later cap starts its fallback tries afresh
    try {
      const usage = await $.session.usage()
      if (usage.context && usage.context.tokens) S.ctx = usage.context.tokens
      if (usage.context && usage.context.window) S.window = usage.context.window
      if (usage.cost) S.costUsd = usage.cost.usd
      // not a request that started before an account change: its windows are the old account's
      if (Array.isArray(usage.rateLimits) && usage.rateLimits.length && requestGen === identityGen) S.rateLimits = usage.rateLimits
    } catch {
      // usage unavailable: keep the per-request figures
    }
    if (H.armed && e.turnId !== H.notTurn) await captureHandoff($, e)
    // Auto keep warm: a big chat stays warm until autoWarmHours after its last turn, or sooner once its pings cost as much as the rewrite
    if (settings.autoWarmHours > 0 && S.autoWarm && S.ctx >= settings.bigTokens) {
      if (!S.keepWarm) startKeepWarm($, settings.autoWarmHours, true)
      S.keepWarmUntil = Math.max(S.keepWarmUntil, now + settings.autoWarmHours * 60 * MIN)
    }
    await heartbeat($, true)
    $.ui.invalidate('ui.render')
    return r
  })

  // A compaction arrives by several roads (typed /compact, auto-compact, a plugin,
  // the desktop host running it inside a turn); each one marks it
  on('session.compact', async ($, e, next) => {
    now = await $.clock.now()
    const r = await next(e)
    if (!e.agentId) markCompacted($)
    return r
  })
  on('classic.PostCompact', async ($, e, next) => {
    markCompacted($)
    return next(e)
  })
  on('classic.SessionStart', { source: ['compact'] }, async ($, e, next) => {
    markCompacted($)
    return next(e)
  })
  on('command.run', { command: ['compact'] }, async ($, e, next) => {
    const r = await next(e)
    markCompacted($)
    return r
  })

  // A main-loop turn the API cut short: arm a resume if what ran out was the plan's usage
  on('classic.StopFailure', async ($, e, next) => {
    // a usage cap may be classified rate_limit or unknown; armResume checks it really is usage
    if (cfg.autoResume && !e.agent_id && (e.error === 'rate_limit' || e.error === 'unknown')) {
      now = await $.clock.now()
      armResume($, e.error_details)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.context && e.context.tokens) S.ctx = e.context.tokens
    if (e.context && e.context.window) S.window = e.context.window
    if (e.cost) S.costUsd = e.cost.usd
    if (Array.isArray(e.rateLimits) && e.rateLimits.length && requestGen === identityGen) S.rateLimits = e.rateLimits // as in turn.complete
    return next(e)
  })

  // Waiting on the person: a permission prompt or a question
  on('tool.check', async ($, e, next) => {
    const d = await next(e)
    if (d && d.decision === 'ask' && !S.waitingSince) {
      now = await $.clock.now()
      S.waitingSince = now
      S.waitingFor = 'permission for ' + e.tool
    }
    return d
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) S.tool = e.tool
    // Claude calling the handoff skill itself: this turn's answer is the handoff
    if (!e.agentId && e.tool === 'Skill' && HANDOFF_SKILL.test(String(e.skill || ''))) armHandoff(true)
    if (e.tool === 'AskUserQuestion') {
      now = await $.clock.now()
      S.waitingSince = now
      S.waitingFor = 'a question'
    }
    try {
      return await next(e)
    } finally {
      if (S.waitingSince) {
        S.waitingSince = 0
        S.waitingFor = ''
      }
    }
  })

  // /session-handoff from anywhere (typed, the band, /handoff): watch for its answer
  on('command.run', async ($, e, next) => {
    if (HANDOFF_SKILL.test(String(e.command || ''))) armHandoff(false)
    return next(e)
  })

  // /handoff runs the handoff and then asks to clear and continue (the band's
  // buttons draw only in the terminal); /handoff continue does the second half.
  // Both run off the hook: a command started inside a hook the session is
  // waiting on is refused.
  on('command.run', { command: ['handoff', 'ck-handoff'] }, async ($, e) => {
    now = await $.clock.now()
    const arg = String(e.args || '').trim().toLowerCase()
    if (arg === 'continue' || arg === 'go') {
      if (!H.text) return { text: `No handoff ready yet. Type /${names.handoff} to make one.` }
      $.clock.after(50, () => clearAndContinue($).catch(() => {}))
      return { text: 'Clearing this chat and continuing with the handoff.' }
    }
    H.askAfter = true
    $.clock.after(50, () => runHandoff($).catch(() => {}))
    return { text: 'Running the session handoff. When it finishes, you can clear this chat and continue with it.' }
  })

  on('command.run', { command: ['cache', 'ck-cache'] }, async ($, e) => {
    now = await $.clock.now()
    const [key, value] = String(e.args || '').trim().toLowerCase().split(/\s+/)
    if (key === 'ttl') {
      settings.ttlMin = value === '5' ? 5 : value === '60' ? 60 : 0
    } else if (key === 'guard' || key === 'alerts') {
      settings[key] = value !== 'off'
    } else if (key === 'autowarm') {
      settings.autoWarmHours = value === 'off' || value === '0' ? 0 : Number(value) > 0 ? Math.min(24, Number(value)) : 8
    } else if (key === 'big') {
      const n = parseTokens(value)
      if (n) settings.bigTokens = n
    }
    if (key) {
      await $.store.set('settings', settings)
      $.ui.invalidate('ui.render')
    }
    return { text: statusText() }
  })

  on('command.run', { command: ['keepwarm', 'ck-keepwarm'] }, async ($, e) => {
    now = await $.clock.now()
    const arg = String(e.args || '').trim().toLowerCase()
    if (arg === 'off' || (arg === '' && S.keepWarm)) {
      S.autoWarm = false
      stopKeepWarm($, 'turned off')
    } else {
      S.autoWarm = true
      const hours = Number(arg) > 0 ? Math.min(24, Number(arg)) : settings.keepWarmHours
      startKeepWarm($, hours)
    }
    await heartbeat($, true)
    $.ui.invalidate('ui.render')
    return {}
  })

  on('command.run', { command: ['board', 'ck-board'] }, async ($, e) => {
    now = await $.clock.now()
    await heartbeat($, true)
    await readFleet($)
    const surface = await $.session.surface()
    if (!surface) return { text: boardText() }
    paneOpen = true
    await $.ui.open({ id: PANE, title: 'Sessions', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  // The band above the prompt: this session's cache at a glance
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    // Drawn whenever there's no survey: an unknown cache (a new chat, or just after
    // /clear or a compaction) still has a model, an effort and plan limits
    if (e.props && e.props.hasSurvey) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    // Powerline look: each segment ends in an arrow in its own colour, on the next one's.
    // ▶, not the Powerline glyph U+E0B0, which neither the app's font nor the terminal's has
    const segs = bandSegments()
    const parts = segs.map(([text, bg, fg], i) => Box({ flexDirection: 'row', flexShrink: 0, children: [
      Text({ backgroundColor: bg, color: fg, children: [` ${text} `] }),
      // the last segment ends square
      ...(segs[i + 1] ? [Text({ color: bg, backgroundColor: segs[i + 1][1], children: ['▶'] })] : []),
    ] }))
    const left = Box({ flexDirection: 'row', flexWrap: 'wrap', flexShrink: 1, children: parts })
    // the buttons stay together on one row, however the segments wrap
    const actions = []
    const st = cacheState(myHeartbeat())
    const big = S.ctx >= settings.bigTokens
    if (st.kind === 'cooling' && big) {
      actions.push(Button({ key: 'keepwarm', label: 'K.W.', hotkey: '1', plain: true, onPress: async () => { now = await $.clock.now(); S.autoWarm = true; startKeepWarm($, settings.keepWarmHours); await heartbeat($, true); $.ui.invalidate('ui.render') } }))
    } else if (st.kind === 'kept') {
      actions.push(Button({ key: 'keepwarm', label: 'Stop K.W.', hotkey: '1', plain: true, onPress: async () => { now = await $.clock.now(); S.autoWarm = false; stopKeepWarm($, 'turned off'); await heartbeat($, true); $.ui.invalidate('ui.render') } }))
    }
    // Right edge: one click runs /session-handoff (h while the band has the focus;
    // a letter never fires from the prompt box, unlike a digit). Once a handoff
    // is in, c clears this chat and sends it as the fresh chat's first prompt.
    const busy = handoffPending || H.armed
    const handoff = Button({ key: 'handoff', label: handoffPending ? 'Handoff queued' : H.armed ? 'Handoff running' : 'Handoff', hotkey: 'h', plain: true, dimColor: busy, onPress: () => runHandoff($) })
    if (H.text || H.continuing) actions.push(Button({ key: 'continue', label: H.continuing ? 'Clearing' : 'Clear and continue', hotkey: 'c', plain: true, onPress: () => clearAndContinue($) }))
    actions.push(handoff)
    const right = Box({ flexDirection: 'row', flexShrink: 0, columnGap: 2, children: actions })
    const mine = Box({ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', width: '100%', columnGap: 2, children: [left, right] })
    return Box({ flexDirection: 'column', children: below ? [mine, below] : [mine] })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    return drawBoard($, e)
  })

  // The band is terminal-only. The footer also draws in the Desktop app, so it
  // carries a short label, only when there's something to act on.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const label = footerLabel()
    if (!label) return next(e)
    const modes = Array.isArray(e.props && e.props.modes) ? e.props.modes : []
    return next({ ...e, props: { ...e.props, modes: [...modes, label] } })
  })
}

// The band's segments, ccstatusline style: each names a hue, and paint() picks that hue's
// dark or light shade by position, alternating, so neighbours always contrast
const LIGHT = '#ffffff'
const DARK = '#1e1e1e'
export const HUES = {
  red: ['#a51d2d', '#ffa3a3'],
  yellow: ['#6b4b00', '#f6d32d'],
  blue: ['#1a4f99', '#99c1f1'],
  green: ['#1d5c3d', '#8ff0a4'],
  cyan: ['#0a5960', '#7fe0e0'],
  gray: ['#4a4950', '#c0bfbc'],
  purple: ['#5a3d8a', '#c9a8f0'],
  pink: ['#74305f', '#f0a8dc'],
  salmon: ['#7f302a', '#f5a99f'],
  orange: ['#8a3700', '#ffbe6f'],
  teal: ['#175858', '#88d8c8'],
}
const WARN = 'orange'
const HOT = 'red'

// Every segment's first word capitalised, past a leading symbol (● cache → ● Cache); "5h" stays
export function capFirst(text) {
  if (/^\S+@\S+$/.test(text)) return text // an email stays as written
  return String(text).replace(/^([^\p{L}\p{N}]*)(\p{Ll})/u, (_, lead, letter) => lead + letter.toUpperCase())
}

// [text, hue] -> [text, background, foreground], dark and light shades in turn
export function paint(segs) {
  return segs.map(([text, hue], i) => {
    const dark = i % 2 === 0
    return [capFirst(text), (HUES[hue] || HUES.gray)[dark ? 0 : 1], dark ? LIGHT : DARK]
  })
}

export function modelName(id) {
  const m = String(id || '').toLowerCase().match(/(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/)
  if (!m) return String(id || '') || 'model ?'
  return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '')
}

// 42m, 3h30m, 7d9h: days once past a day
export function ago(ms) {
  const h = Math.floor(ms / (60 * MIN))
  return h >= 24 ? Math.floor(h / 24) + 'd' + (h % 24) + 'h' : minutes(ms)
}

// "3h30m", "6d14h"; '' when the time is unknown or past
export function untilText(iso, at) {
  const ms = Date.parse(iso || '') - at
  return ms > 0 ? ago(ms) : ''
}

function limitSegment(label, limit, hue, showReset = true) {
  const pct = limit.percentUsed || 0
  const left = showReset ? untilText(limit.resetsAt, now) : ''
  return [`${label} ${Math.round(pct)}%${left ? ' · ' + left : ''}`, pct >= 95 ? HOT : pct >= 80 ? WARN : hue]
}

function bandSegments() {
  const st = cacheState(myHeartbeat())
  const ttl = ttlMin()
  const big = S.ctx >= settings.bigTokens
  const out = []
  // the app's composer already shows the model and effort
  if (onTerminal) out.push([modelName(S.model), 'red'])
  if (onTerminal && S.effort) out.push([S.effort, 'yellow'])
  const rewrite = money(rewriteCost(S.ctx, S.model, ttl))
  out.push([`Ctx ${tokens(S.ctx)} · ${st.kind === 'cold' && big ? 'Next send rewrites ≈ ' : 'Rewrite ≈ '}${rewrite}`, st.kind === 'cold' && big ? HOT : 'blue'])
  if (st.kind === 'kept') out.push([`◆ K.W. until ${clock(S.keepWarmUntil)} · ${S.pings} ping${S.pings === 1 ? '' : 's'} ${money(S.pingUsd)}`, 'cyan'])
  else if (st.kind === 'warm') out.push([`● cache warm ${minutes(st.left)}`, 'green'])
  else if (st.kind === 'cooling') out.push([`◐ cache cools in ${minutes(st.left)}`, WARN])
  else if (st.kind === 'cold') out.push([`○ cache cold${st.left === null ? '' : ' ' + ago(-st.left)}`, big ? HOT : 'gray'])
  else out.push(['cache –', 'gray'])
  // what this chat has already paid to rewrite cold caches, beside the next send's estimate
  if (S.coldRestarts.length) out.push([`Cold rewrites ${money(S.coldRestarts.reduce((a, c) => a + c.usd, 0))} (${S.coldRestarts.length})`, 'gray'])
  // the engine's own reading once a request has run; before that another session's on the same account, then the shared usage reading
  let limits = stillOpen(S.rateLimits, now) // a window that reset since is stale
  if (!limits.length && signedIn !== false && !keyUnsure()) limits = borrowedLimits(fleet, { seat: S.seat, account: S.account, desktop: !onTerminal }, now) // not while the seat or account is unknown: the key may name the old one
  if (!limits.length && !keyUnsure()) limits = S.planWindows // the shared reading waits for it too: it may be the old account's
  const five = limits.find((l) => l.kind === 'five_hour')
  const week = limits.find((l) => l.kind === 'seven_day')
  if (five) out.push(limitSegment('5h', five, 'purple'))
  if (week) out.push(limitSegment('Week', week, 'green'))
  // its reset is the weekly one's, already shown; the reading waits for the seat and account like the windows
  if (S.fable && !keyUnsure()) out.push(limitSegment('Fable', S.fable, 'pink', false))
  for (const l of S.rateLimits) if (l.kind !== 'five_hour' && l.kind !== 'seven_day') out.push(limitSegment(LIMIT_LABEL[l.kind] || l.kind, l, 'gray'))
  out.push([`session ${money(S.costUsd)}`, 'salmon'])
  if (S.resumeAt) out.push([`⏸ resumes ${resumeText(S.resumeAt, now)}`, WARN])
  // who the terminal session runs as: a configured seat's label, else the signed-in account
  const who = S.seat ? `seat ${mask(S.seat)}` : S.account ? mask(S.account) : ''
  if (onTerminal && who) out.push([who, 'teal'])
  return paint(out)
}

function footerLabel() {
  const parts = []
  const st = cacheState(myHeartbeat())
  const big = S.ctx >= settings.bigTokens
  if (st.kind === 'kept') parts.push('cache kept warm')
  else if (st.kind === 'cooling' && big) parts.push(`cache cools in ${minutes(st.left)} · /keepwarm`)
  else if (st.kind === 'cold' && big) parts.push(`cache cold · rewrite ≈ ${money(rewriteCost(S.ctx, S.model, ttlMin()))}`)
  const high = S.rateLimits.filter((l) => (l.percentUsed || 0) >= 80)
  if (high.length) parts.push(limitsText(high))
  if (H.text) parts.push(`handoff ready · /${names.handoff} continue`)
  return parts.join(' · ')
}

function sortFleet(list) {
  const rank = { waiting: 0, working: 1, idle: 2 }
  return [...list].sort((a, b) => {
    const r = (rank[a.state] ?? 3) - (rank[b.state] ?? 3)
    if (r !== 0) return r
    const la = msLeft(a.lastActivity, a.ttlMin) ?? Infinity
    const lb = msLeft(b.lastActivity, b.ttlMin) ?? Infinity
    return la - lb
  })
}

function cacheCell(hb) {
  const st = cacheState(hb)
  if (st.kind === 'kept') return ['kept warm', 'cyan']
  if (st.kind === 'warm') return ['warm ' + minutes(st.left), 'green']
  if (st.kind === 'cooling') return ['cools in ' + minutes(st.left), 'yellow']
  if (st.kind === 'cold') return [st.left === null ? 'cold' : 'cold ' + minutes(-st.left), (hb.ctx || 0) >= settings.bigTokens ? 'red' : 'gray']
  return ['–', 'gray']
}

function stateCell(hb) {
  if (hb.stale) return ['? silent', 'gray']
  if (hb.state === 'waiting') return ['⏳ waiting', 'magenta']
  if (hb.state === 'working') return ['● working', 'cyan']
  return ['○ idle', 'gray']
}

// Text props for a colour name; 'gray' draws dim, which every theme has
function tone(color, extra = {}) {
  return color === 'gray' ? { ...extra, dimColor: true } : { ...extra, color }
}

function boardText() {
  const rows = sortFleet(fleet).map((hb) => {
    const [state] = stateCell(hb)
    const [cache] = cacheCell(hb)
    return `${pad(state, 11)} ${pad(clip(mask(hb.label), 40), 41)} ${pad(tokens(hb.ctx), 6)} ${pad(cache, 13)} ${money(hb.costUsd)}${hb.agentsRunning ? '  ' + hb.agentsRunning + ' agents' : ''}${hb.self ? '  (this one)' : ''}`
  })
  return ['Sessions on this machine:', ...rows].join('\n')
}

function drawBoard($, e) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const width = Math.max(60, (e.props && e.props.bodyColumns) || 100)
  const labelWidth = Math.max(16, Math.min(44, width - 62))
  const list = sortFleet(fleet)
  const header = Text({ dimColor: true, children: [`${pad('STATE', 11)} ${pad('SESSION', labelWidth + 1)} ${pad('CONTEXT', 8)} ${pad('CACHE', 14)} ${pad('COST', 7)} AGENTS`] })
  const rows = list.map((hb, i) => {
    const [state, stateColor] = stateCell(hb)
    const [cache, cacheColor] = cacheCell(hb)
    const label = clip(mask(hb.label || hb.id), labelWidth) + (hb.self ? ' ◂' : '')
    const ctx = tokens(hb.ctx) + (hb.window ? ' ' + Math.round((100 * (hb.ctx || 0)) / hb.window) + '%' : '')
    const cells = [
      Text(tone(stateColor, { children: [pad(state, 11) + ' '] })),
      Text({ bold: !!hb.self, children: [pad(label, labelWidth + 1) + ' '] }),
      Text({ children: [pad(ctx, 8) + ' '] }),
      Text(tone(cacheColor, { children: [pad(cache, 14) + ' '] })),
      Text({ children: [pad(money(hb.costUsd), 7) + ' '] }),
      Text({ dimColor: !hb.agentsRunning, children: [String(hb.agentsRunning || 0) + '  '] }),
    ]
    const big = (hb.ctx || 0) >= settings.bigTokens
    if (big && !hb.stale && i < 9) {
      cells.push(
        Button({
          key: 'kw-' + hb.id,
          label: hb.keepWarm ? 'stop warm' : 'keep warm',
          hotkey: String(i + 1),
          plain: true,
          dimColor: !hb.keepWarm && cacheState(hb).kind !== 'cooling',
          onPress: async () => {
            now = await $.clock.now()
            if (hb.self) {
              S.autoWarm = !S.keepWarm
              if (S.keepWarm) stopKeepWarm($, 'turned off')
              else startKeepWarm($, settings.keepWarmHours)
              await heartbeat($, true)
            } else {
              await $.store.set('cmd:' + hb.id, { keepWarm: !hb.keepWarm, at: now })
              $.ui.toast(`Sent to "${mask(hb.label)}". It applies within 30 seconds.`)
            }
            await readFleet($)
            $.ui.invalidate('ui.render')
          },
        }),
      )
    }
    const line = Box({ flexDirection: 'row', children: cells })
    const detail = []
    if (hb.state === 'waiting' && hb.waitingFor) detail.push(`needs you: ${hb.waitingFor}`)
    else if (hb.state === 'working' && hb.tool) detail.push(`running ${hb.tool}`)
    if (hb.coldCount) detail.push(`${hb.coldCount} cold restart${hb.coldCount === 1 ? '' : 's'} ${money(hb.coldUsd)}`)
    if (hb.keepWarm) detail.push(`warm until ${clock(hb.keepWarmUntil)}, ${hb.pings} ping(s) ${money(hb.pingUsd)}`)
    if (detail.length === 0) return line
    return Box({ flexDirection: 'column', children: [line, Text({ dimColor: true, children: ['            └ ' + detail.join(' · ')] })] })
  })
  const totalCost = list.reduce((a, hb) => a + (hb.costUsd || 0), 0)
  const totalCold = list.reduce((a, hb) => a + (hb.coldUsd || 0), 0)
  const waiting = list.filter((hb) => hb.state === 'waiting').length
  const footer = Text({
    dimColor: true,
    children: [`${list.length} session${list.length === 1 ? '' : 's'} · ${money(totalCost)} total · ${waiting} waiting on you · cold restarts ${money(totalCold)} · keep warm reads the cache before it expires · Esc closes`],
  })
  return Box({ flexDirection: 'column', children: [header, ...rows, Text({ children: [' '] }), footer] })
}
