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
  fable: null, // { percentUsed, resetsAt } from the plan's per-model weekly limits
  planWindows: [], // 5h and weekly from the same reading, for a session that has sent nothing yet
}

const settings = { bigTokens: 150000, guard: true, ttlMin: 0, alerts: true, keepWarmHours: 4, autoWarmHours: 8 }
const names = { cache: 'cache', keepwarm: 'keepwarm', board: 'board', handoff: 'handoff' }

let now = 0
let home = ''
let lastHeartbeat = 0
let rec = { on: false, strict: false }
let mask = (s) => s
let fleet = [] // heartbeats of every session, this one included
const alerted = new Map() // sessionId -> state or warning key already announced
let paneOpen = false
let justCompacted = false
let handoffPending = false
let seatFile = ''
let onTerminal = false

// Setup-specific behaviour, all off unless the plugin's userConfig turns it on (see README)
const cfg = {
  seatFileTerminal: '', // a file holding the signed-in account's label, as an account rotator writes it
  seatFileDesktop: '',
  rotatorWake: null, // the prompt an unattended account rotator types after rotating: compact without asking
  prPattern: null, // a first prompt naming a PR: keep warm stops once that PR merges or closes
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

// A rotation moves the session to another account, whose cache is empty
function rotatedCold() {
  return S.seatChangedAt > S.lastActivity
}

// The next request writes the shorter context: no TTL evidence and nothing to warn about
function markCompacted() {
  justCompacted = true
  S.lastActivity = 0
}

// Terminal sessions run on the CLI rotator's accounts, desktop ones on the app rotator's seats
// The signed-in account, as Claude Code keeps it in .claude.json: what the band shows
// in place of a seat when no seat file is configured
async function readAccount($) {
  try {
    const dir = await $.env.get('CLAUDE_CONFIG_DIR')
    const o = JSON.parse(String(await $.fs.read(`${(dir || home).replace(/\\/g, '/')}/.claude.json`))).oauthAccount || {}
    S.account = String(o.emailAddress || o.displayName || '')
  } catch {
    // an API-key session, or no file: no account to show
  }
}

async function readSeat($) {
  if (!seatFile) return
  let seat = ''
  try {
    if (!(await $.fs.exists(seatFile))) return
    seat = String(await $.fs.read(seatFile)).trim()
  } catch {
    return
  }
  if (S.seat && seat && seat !== S.seat) {
    S.seatChangedAt = now
    // the old account's readings: borrow or fetch the new one's until a request measures them
    S.rateLimits = []
    S.fable = null
    S.planWindows = []
    planNext = 0
    await readAccount($)
  }
  if (seat) S.seat = seat
}

// Compacting on a cold cache pays only when it frees a real share of the context
function worthCompacting() {
  return S.ctx >= settings.bigTokens && S.ctx - S.floor >= 100000
}

// Run off the hook: a command started inside a hook the session waits on is refused
function compactThenSend($, e, unattended) {
  const msg = { text: e.text, attachments: e.attachments, slash: !!e.command }
  $.clock.after(50, () => runCompactThenSend($, msg, unattended).catch(() => {}))
  return { drop: 'cache-keeper: compacting first on a cold cache; the message is sent again once that finishes' }
}

async function runCompactThenSend($, msg, unattended) {
  try {
    await $.command.run({ command: 'compact', args: '' })
    markCompacted()
  } catch (err) {
    $.ui.toast('Could not compact (' + clip(String((err && err.message) || err), 80) + '), so the message goes as typed.', { timeoutMs: 8000 })
  }
  const send = { text: msg.text, ...(msg.attachments ? { attachments: msg.attachments } : {}) }
  // A plugin can't submit a "/" line: those go back in the prompt box
  if (!msg.slash) {
    for (const asUser of unattended ? [true, false] : [true]) {
      try {
        await $.prompt.submit({ ...send, asUser })
        return
      } catch {
        // try the next way, then the prompt box
      }
    }
  }
  let filled = false
  try {
    filled = !!(await $.prompt.fill({ text: msg.text })).isFilled
  } catch {
    filled = false
  }
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

function cacheState(hb) {
  if (hb.rotated) return { kind: 'cold', left: (hb.seatChangedAt || now) - now }
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
    desktop: !onTerminal,
    rateLimits: S.rateLimits, // the engine's own reading, which a reopened chat borrows
    updatedAt: now,
  }
}

// A session that has sent nothing has no plan windows of its own: borrow the freshest
// reading another session on the same account took, dropping a window that has since reset
export function borrowedLimits(list, self, at) {
  const same = (hb) => (self.seat && hb.seat ? hb.seat === self.seat : hb.desktop === self.desktop)
  const best = list
    .filter((hb) => !hb.self && Array.isArray(hb.rateLimits) && hb.rateLimits.length && same(hb))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]
  if (!best) return []
  return best.rateLimits.filter((l) => !l.resetsAt || Date.parse(l.resetsAt) > at)
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
// usage endpoint the app's usage card reads. One fetch per 5 minutes across every
// session, shared through the store; a 429 backs every session off the same 5 minutes.
const PLAN_EVERY = 5 * MIN
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
let planWhy = ''
let planNext = 0
// One reading for every session: the endpoint rate-limits a second schedule within seconds.
// A session still on an older version writes it without `windows`; those stay as they were.
const PLAN_KEY = 'plan'

// Each account has its own limits: with a seat file configured, a reading per surface and seat
// (the terminal's and the app's rotators name their seats independently)
function planKey() {
  return S.seat ? `${PLAN_KEY}:${onTerminal ? 'cli' : 'app'}:${S.seat}` : PLAN_KEY
}

async function refreshPlan($) {
  let cached = null
  try {
    cached = await $.store.get(planKey())
  } catch {
    cached = null
  }
  const prior = cached && typeof cached === 'object' ? cached : {}
  if (Array.isArray(prior.windows) && prior.windows.length) S.planWindows = prior.windows
  // an older version writes null after a failed check: never let that wipe a good reading
  if (prior.fable) S.fable = prior.fable
  planWhy = prior.why || planWhy
  // the store's backoff, or this session's own where a held lock kept it out of the store
  if (now < Math.max(prior.next || (prior.at || 0) + PLAN_EVERY, planNext)) return
  planNext = now + PLAN_EVERY
  let fable = prior.fable || S.fable
  let windows = Array.isArray(prior.windows) && prior.windows.length ? prior.windows : S.planWindows
  let at = prior.at || 0 // when the reading was taken: a failure keeps the last good one
  let next = now + PLAN_EVERY
  let why = 'ok' // the last attempt's outcome, kept with the reading for /cache
  try {
    const auth = await $.session.authorize()
    if (!auth) why = 'no first-party sign-in'
    else {
      const r = await $.http.fetch(USAGE_URL, { auth: auth.handle, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
      if (r.ok) {
        const body = JSON.parse(r.text)
        fable = fableLimit(body)
        windows = planWindows(body)
        at = now
      } else why = 'HTTP ' + r.status
      // a 429 names how long to stay away; every session waits it out, an hour at most
      const wait = Number(r.headers && r.headers['retry-after'])
      if (!r.ok && wait > 0) next = now + Math.min(60 * MIN, Math.max(PLAN_EVERY, wait * 1000))
    }
  } catch (err) {
    why = clip(String((err && err.message) || err), 120) // offline or refused: keep the last reading
  }
  planNext = next
  S.fable = fable
  S.planWindows = windows
  planWhy = why
  try {
    await $.store.set(planKey(), { at, next, fable, windows, why })
  } catch {
    // lock held: another session is writing the same reading
  }
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
    if (j.type === 'system' && j.subtype === 'compact_boundary' && meta && meta.postTokens) return { ctx: meta.postTokens, at, compacted: true }
    const u = j.type === 'assistant' && j.message && j.message.usage
    // the next request re-reads that reply too, so its output counts
    if (u && totalInput(u) > 0) return { ctx: totalInput(u) + (u.output_tokens || 0), at, model: j.message.model, effort: typeof j.effort === 'string' ? j.effort : '' }
  }
  return null
}

const TAIL_BYTES = 1024 * 1024
// $.fs.read stops at 4 MiB and has no offset, so a long transcript's tail comes through node
const TAIL_JS = "const fs=require('fs'),p=process.argv[1],s=fs.statSync(p).size,n=Math.min(s," + TAIL_BYTES + "),b=Buffer.alloc(n),fd=fs.openSync(p,'r');fs.readSync(fd,b,0,n,s-n);process.stdout.write(b)"

async function seedFromTranscript($, path) {
  if (!path) return
  let found = null
  try {
    const st = await $.fs.stat(path)
    if (st.kind !== 'file' || !st.size) return
    const text = st.size <= 4 * 1024 * 1024 ? String(await $.fs.read(path)) : (await $.process.run(['node', '-e', TAIL_JS, path], { timeoutMs: 15000 })).stdout
    found = lastContext(String(text).split('\n'))
  } catch {
    return // no transcript yet (a new chat) or unreadable: the first request measures it
  }
  if (!found) return
  S.ctx = found.ctx
  if (found.model && !S.model) S.model = found.model // the session's own model wins: it may have been switched
  if (found.effort) S.effort = found.effort
  if (found.compacted) {
    // the next request writes the compacted context whatever happens: nothing to ask
    S.floor = found.ctx
    markCompacted()
  } else {
    S.lastActivity = found.at // the cache's real age: the band and the cold-send guard read it
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
  const keys = (await $.store.keys()).filter((k) => k.startsWith('hb:'))
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

function startKeepWarm($, hours) {
  S.keepWarm = true
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
  S.pingUsd += requestCost(u, S.model, ttl)
  // A ping that writes instead of reading did not hit the cache: stop paying for it
  if ((u.cache_creation_input_tokens || 0) > 0.1 * Math.max(1, u.cache_read_input_tokens || 0)) {
    return stopKeepWarm($, `the ping wrote ${tokens(u.cache_creation_input_tokens)} tokens instead of reading the cache`)
  }
  S.lastActivity = now
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

async function tick($) {
  now = await $.clock.now()
  try {
    await refreshPlan($)
    await loadSettings($) // /cache set in another session applies here too
    await readSeat($)
    await readRecording($)
    await applyRemoteCommands($)
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
  if (st.kind === 'cold') lines.push(`Cache went cold ${minutes(-st.left)} ago. The next message rewrites it for about ${money(rewriteCost(S.ctx, S.model, ttl))}.`)
  if (rotatedCold()) lines.push(`The account rotated ${minutes(now - S.seatChangedAt)} ago (now ${S.seat}), so the cache is cold.`)
  if (S.keepWarm) lines.push(`Keep warm is on until ${clock(S.keepWarmUntil)}: ${S.pings} ping(s), ${money(S.pingUsd)} so far.`)
  if (S.rateLimits.length) lines.push(`Plan limits used: ${limitsText(S.rateLimits)}.`)
  lines.push(S.fable ? `Fable weekly: ${Math.round(S.fable.percentUsed)}% used.` : `Fable weekly: no reading yet${planWhy && planWhy !== 'ok' ? ` (last check: ${planWhy})` : ''}.`)
  lines.push(`Session cost so far: ${money(S.costUsd)}. Cold restarts this session: ${S.coldRestarts.length} (${money(S.coldRestarts.reduce((a, c) => a + c.usd, 0))}).`)
  lines.push(`Cold-send guard: ${settings.guard ? 'on' : 'off'} for contexts over ${tokens(settings.bigTokens)} tokens. Alerts: ${settings.alerts ? 'on' : 'off'}.`)
  lines.push(`Auto keep warm: ${settings.autoWarmHours ? `on, until ${settings.autoWarmHours}h after the last turn, for contexts over ${tokens(settings.bigTokens)}${S.autoWarm ? '' : ' (off in this session)'}` : 'off'}.`)
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
  on('session.start', async ($, e, next) => {
    now = await $.clock.now()
    home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    S.id = await $.session.id()
    S.cwd = await $.session.cwd()
    S.label = basename(S.cwd)
    S.model = await $.session.model()
    await loadSettings($)
    await readRecording($)
    let surface = null
    try {
      surface = e.surface || (await $.session.surface())
    } catch {
      surface = null
    }
    onTerminal = surface === 'terminal'
    const seatPath = surface === 'desktop' ? cfg.seatFileDesktop : cfg.seatFileTerminal
    seatFile = seatPath ? seatPath.replace(/^~(?=[\\/])/, home).replace(/\\/g, '/') : ''
    await readSeat($)
    await readAccount($)
    try {
      // the plan windows the status line already holds: free, and there before the first send
      const usage = await $.session.usage()
      if (Array.isArray(usage.rateLimits) && usage.rateLimits.length) S.rateLimits = usage.rateLimits
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
    // The app reopens a chat without a SessionStart that names the transcript: find it by id
    if (!S.ctx && S.id && S.cwd) {
      const config = ((await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`).replace(/\\/g, '/')
      await seedFromTranscript($, `${config}/projects/${S.cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${S.id}.jsonl`)
    }
    return next(e)
  })

  // /clear, /resume and /branch start from an unknown cache. The process goes
  // on under a new session id, and no session.start fires for it.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    S.lastActivity = 0
    S.keepWarm = false
    H.armed = false
    // the last chat's compaction says nothing about this one, and would mute its cold-send guard
    justCompacted = false
    S.floor = 0
    try {
      S.id = (await $.session.id()) || S.id
    } catch {
      // keep the old id
    }
    S.label = basename(S.cwd)
    if (e.source === 'resume') await seedFromTranscript($, e.transcript_path)
    return next(e)
  })

  // A session opened with its history (the app reopening an old chat, claude --continue)
  on('classic.SessionStart', { source: ['startup'] }, async ($, e, next) => {
    await seedFromTranscript($, e.transcript_path)
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
    if (wake) {
      // The wake-up itself proves the rotation, even before the seat file is read again
      await readSeat($)
      if (!rotatedCold()) S.seatChangedAt = now
    }
    const ttl = ttlMin()
    const left = msLeft(S.lastActivity, ttl)
    const rotated = rotatedCold()
    const isCold = rotated || (left !== null && left <= 0)
    // These run locally or start afresh: a cold cache costs them nothing
    const local = e.command && ['compact', 'clear', names.cache, names.keepwarm, names.board, names.handoff].includes(e.command.name)
    if (!settings.guard || !fromUser || !isCold || local || justCompacted || S.ctx < settings.bigTokens || e.turnId) return next(e)
    // an attachment's handle lives only while this submit is in flight: a resend after compacting would drop it
    const media = Array.isArray(e.attachments) && e.attachments.length > 0
    if (wake) return worthCompacting() && !media ? compactThenSend($, e, true) : next(e)
    const cost = money(rewriteCost(S.ctx, S.model, ttl))
    const why = rotated ? `The account rotated to ${S.seat || 'another seat'} ${minutes(now - S.seatChangedAt)} ago, so the cache is cold.` : `Cache went cold ${minutes(-left)} ago.`
    const floor = S.floor ? ` Compacting last left ${tokens(S.floor)}.` : ''
    let answer = 'Send anyway'
    try {
      answer = await $.ui.ask(
        `${why} Sending now rewrites ${tokens(S.ctx)} tokens of context (about ${cost}).${floor}${media ? ' (Compacting first would drop the attachment: run /compact yourself, then send again.)' : ''} What should happen?`,
        media ? ['Send anyway', 'Cancel'] : ['Send anyway', 'Compact first, then send', 'Cancel'],
      )
    } catch {
      // nobody to ask (a -p run, or the dialog was dismissed): send as typed
      return next(e)
    }
    // $.session.compact() is refused on SDK hosts (the desktop app), so this queues /compact
    if (answer === 'Compact first, then send') return compactThenSend($, e, false)
    if (answer === 'Send anyway') return next(e)
    $.ui.toast('Not sent. A fresh session with a short handoff avoids the rewrite entirely.', { timeoutMs: 8000 })
    return { drop: 'Cancelled by cache-keeper before a cold cache rewrite' }
  })

  on('turn.start', async ($, e, next) => {
    now = await $.clock.now()
    S.working = true
    if (e.turnId) S.turnId = e.turnId
    await heartbeat($, true)
    return next(e)
  })

  // Each main-loop request: did it read the cache, or rewrite it?
  on('turn.step', async function* ($, e, next) {
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
      // the first request after a compaction writes the new, shorter context: expected
      S.floor = total
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
    try {
      const usage = await $.session.usage()
      if (usage.context && usage.context.tokens) S.ctx = usage.context.tokens
      if (usage.context && usage.context.window) S.window = usage.context.window
      if (usage.cost) S.costUsd = usage.cost.usd
      if (Array.isArray(usage.rateLimits) && usage.rateLimits.length) S.rateLimits = usage.rateLimits
    } catch {
      // usage unavailable: keep the per-request figures
    }
    if (H.armed && e.turnId !== H.notTurn) await captureHandoff($, e)
    // Auto keep warm: a big chat stays warm until autoWarmHours after its last turn
    if (settings.autoWarmHours > 0 && S.autoWarm && S.ctx >= settings.bigTokens) {
      if (!S.keepWarm) startKeepWarm($, settings.autoWarmHours)
      S.keepWarmUntil = Math.max(S.keepWarmUntil, now + settings.autoWarmHours * 60 * MIN)
    }
    await heartbeat($, true)
    $.ui.invalidate('ui.render')
    return r
  })

  // A compaction arrives by several roads (typed /compact, auto-compact, a plugin,
  // the desktop host running it inside a turn); each one marks it
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) markCompacted()
    return r
  })
  on('classic.PostCompact', async ($, e, next) => {
    markCompacted()
    return next(e)
  })
  on('classic.SessionStart', { source: ['compact'] }, async ($, e, next) => {
    markCompacted()
    return next(e)
  })
  on('command.run', { command: ['compact'] }, async ($, e, next) => {
    const r = await next(e)
    markCompacted()
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.context && e.context.tokens) S.ctx = e.context.tokens
    if (e.context && e.context.window) S.window = e.context.window
    if (e.cost) S.costUsd = e.cost.usd
    if (Array.isArray(e.rateLimits) && e.rateLimits.length) S.rateLimits = e.rateLimits
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
    // /clear, /resume or a compaction) still has a model, an effort and plan limits
    if (e.props && e.props.hasSurvey) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    // Powerline look: each segment ends in an arrow in its own colour, on the next one's.
    // ▶, not the Powerline glyph U+E0B0, which neither the app's font nor the terminal's has
    const segs = bandSegments()
    const parts = segs.map(([text, bg, fg], i) => Box({ flexDirection: 'row', flexShrink: 0, children: [
      Text({ backgroundColor: bg, color: fg, children: [` ${text} `] }),
      Text(segs[i + 1] ? { color: bg, backgroundColor: segs[i + 1][1], children: ['▶'] } : { color: bg, children: ['▶'] }),
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

// The band's segments, ccstatusline style: [text, background, foreground]
const LIGHT = '#ffffff'
const DARK = '#1e1e1e'
const ALERT = { warn: ['#e5a50a', DARK], hot: ['#c01c28', LIGHT] }

export function modelName(id) {
  const m = String(id || '').toLowerCase().match(/(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/)
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

function limitSegment(label, limit, bg, fg, showReset = true) {
  const pct = limit.percentUsed || 0
  const [b, f] = pct >= 95 ? ALERT.hot : pct >= 80 ? ALERT.warn : [bg, fg]
  const left = showReset ? untilText(limit.resetsAt, now) : ''
  return [`${label} ${Math.round(pct)}%${left ? ' · ' + left : ''}`, b, f]
}

function bandSegments() {
  const st = cacheState(myHeartbeat())
  const ttl = ttlMin()
  const big = S.ctx >= settings.bigTokens
  const out = []
  // the app's composer already shows the model and effort
  if (onTerminal) out.push([modelName(S.model), '#a33a3a', LIGHT])
  if (onTerminal && S.effort) out.push([S.effort, '#d4a72c', DARK])
  const rewrite = money(rewriteCost(S.ctx, S.model, ttl))
  out.push([`ctx ${tokens(S.ctx)} · ${st.kind === 'cold' && big ? 'next send rewrites ≈ ' : 'rewrite ≈ '}${rewrite}`, ...(st.kind === 'cold' && big ? ALERT.hot : ['#3d6fb4', LIGHT])])
  if (st.kind === 'kept') out.push([`◆ K.W. until ${clock(S.keepWarmUntil)} · ${S.pings} ping${S.pings === 1 ? '' : 's'} ${money(S.pingUsd)}`, '#1c71d8', LIGHT])
  else if (st.kind === 'warm') out.push([`● cache warm ${minutes(st.left)}`, '#2e8540', LIGHT])
  else if (st.kind === 'cooling') out.push([`◐ cache cools in ${minutes(st.left)}`, ...ALERT.warn])
  else if (st.kind === 'cold') out.push([`○ cache cold ${ago(-st.left)}`, ...(big ? ['#7a1f2b', LIGHT] : ['#5e5c64', LIGHT])])
  else out.push(['cache –', '#5e5c64', LIGHT])
  // the engine's own reading once a request has run; before that another session's on the same account, then the shared usage reading
  let limits = S.rateLimits.filter((l) => !l.resetsAt || Date.parse(l.resetsAt) > now) // a window that reset since is stale
  if (!limits.length) limits = borrowedLimits(fleet, { seat: S.seat, desktop: !onTerminal }, now)
  if (!limits.length) limits = S.planWindows
  const five = limits.find((l) => l.kind === 'five_hour')
  const week = limits.find((l) => l.kind === 'seven_day')
  if (five) out.push(limitSegment('5h', five, '#7b5ea7', LIGHT))
  if (week) out.push(limitSegment('week', week, '#8fbf8f', DARK))
  // its reset is the weekly one's, already shown
  if (S.fable) out.push(limitSegment('Fable wk', S.fable, '#d38fc5', DARK, false))
  for (const l of S.rateLimits) if (l.kind !== 'five_hour' && l.kind !== 'seven_day') out.push(limitSegment(LIMIT_LABEL[l.kind] || l.kind, l, '#5e5c64', LIGHT))
  out.push([`session ${money(S.costUsd)}`, '#c0605a', LIGHT])
  if (S.coldRestarts.length) out.push([`${S.coldRestarts.length} cold restart${S.coldRestarts.length === 1 ? '' : 's'} ${money(S.coldRestarts.reduce((a, c) => a + c.usd, 0))}`, '#5e5c64', LIGHT])
  // who the terminal session runs as: a configured seat's label, else the signed-in account
  const who = S.seat ? `seat ${S.seat}` : S.account ? mask(S.account) : ''
  if (onTerminal && who) out.push([who, '#2a7f8f', LIGHT])
  return out
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
  if (st.kind === 'cold') return ['cold ' + minutes(-st.left), (hb.ctx || 0) >= settings.bigTokens ? 'red' : 'gray']
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
