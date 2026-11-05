import { expect, mock, test as kitTest } from 'claude-code/testing'
// The kit's 5 s per test fails whichever test is running when other sessions load the machine (2026-11-03)
const test = (name: string, a: any, b?: any) => (b ? kitTest(name, { timeoutMs: 30000, ...a }, b) : kitTest(name, { timeoutMs: 30000 }, a))
import { ago, borrowedLimits, capFirst, fableLimit, HUES, paint, pattern, resumeTime, spentWindows, lastContext, modelName, planWindows, untilText } from './register.mjs'

const COMPOSER = { kind: 'composer' } as never
let compactOutput = '' // what the engine's /compact prints: '' compacted, 'Not compacted · …' refused
// An example setup: an account rotator and a merge-pr workflow, as the README describes
const SETUP = { options: { seatFileTerminal: '~/.claude-cli-accounts/.active', seatFileDesktop: '~/.claude-app-seats/.active', rotatorWakePattern: String.raw`^\s*Usage reset:[^\n]*\baccount was rotated\b`, prPattern: String.raw`(?:^|\s)/?merge-pr\s+#?(\d+)` } }


// The engine beneath the mod: a terminal session on seat A, nothing on disk but the seat file
function engine($: any, on: any, seat = { label: 'A' }, kept?: Map<string, unknown>) {
  const clock = mock.clock(on)
  if (kept) {
    // a store already holding what an earlier run of this mod wrote
    on('store.get', (_: unknown, e: any) => ({ value: kept.get(e.key) }))
    on('store.set', (_: unknown, e: any) => (kept.set(e.key, e.value), { value: undefined }))
    on('store.delete', (_: unknown, e: any) => (kept.delete(e.key), { value: undefined }))
    on('store.keys', () => ({ value: [...kept.keys()] }))
  } else mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/Users/T', ...(desktopEntry ? { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' } : {}) })
  const seen = { compacts: 0, submits: [] as string[], asUsers: [] as unknown[], fills: [] as { text: string; mode?: string }[], asks: 0, toasts: [] as string[], order: [] as string[], attempts: [] as string[], log: '', logPath: '' }
  on('session.id', () => ({ value: 'sid-test' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.surface', () => ({ value: 'terminal' }))
  on('session.surfaces', () => ({ value: headlessRun ? [] : ['terminal'] }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] }))
  // the cold-compact log is a file that exists once something has been written to it
  on('fs.exists', (_: unknown, e: any) => ({ value: String(e.path ?? e).includes('.active') || (String(e.path ?? e).split(String.fromCharCode(92)).join('/').endsWith('/.claude-shared/state') && !noStateDir) || (String(e.path ?? e).includes('cold-compact-log') && seen.log !== '') }))
  on('fs.read', (_: unknown, e: any) => ({ value: String(e.path ?? e).includes('cold-compact-log') ? seen.log : seat.label }))
  on('command.run', (_: unknown, e: any) => {
    if (e.command === 'compact') seen.compacts++, seen.order.push('compact')
    if (e.command === 'compact' && hangCompact) return new Promise(() => {})
    if (e.command === 'compact' && holdCompact) return new Promise((res) => (releaseCompact = () => res({ text: compactOutput })))
    return { text: e.command === 'compact' ? compactOutput : '' }
  })
  on('prompt.submit', async (_: unknown, e: any) => {
    if (e.origin?.kind === 'plugin' && failSubmit && failSubmit.test(e.text)) throw new Error('not now')
    // a host that refuses the submit (Stop, its limit, another hook) resolves { drop }
    if (e.origin?.kind === 'plugin') seen.attempts.push(e.text)
    if (e.origin?.kind === 'plugin' && dropSubmit && dropSubmit.test(e.text)) return { drop: 'refused' }
    // the host shows asUser on the origin
    if (e.origin?.kind === 'plugin') seen.submits.push(e.text), seen.asUsers.push(e.origin.asUser), seen.order.push('send:' + e.text)
    if (e.origin?.kind === 'plugin' && duringSubmit) await duringSubmit(e)
    return { text: e.text }
  })
  on('prompt.fill', (_: unknown, e: any) => (seen.fills.push({ text: e.text, mode: e.mode }), { isFilled: true }))
  on('prompt.read', () => ({ value: { text: boxDraft, cursor: boxDraft.length } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.measure', () => ({ changed: [] }))
  on('ui.toast', (_: unknown, e: unknown) => (seen.toasts.push(JSON.stringify(e)), { value: undefined }))
  on('fs.write', (_: unknown, e: any) => ((seen.log = String(e.text)), (seen.logPath = String(e.path)), { value: undefined }))
  return { clock, seen }
}

// $.ui.ask reaches the engine as an AskUserQuestion tool call
// a plugin resend whose text matches this throws, as a host that refuses the submit would
let failSubmit: RegExp | null = null
// a plugin resend whose text matches this resolves { drop }, as a host that refuses it does without throwing
let dropSubmit: RegExp | null = null
// runs inside a plugin resend, while the drain is under way
let duringSubmit: ((e: any) => Promise<void>) | null = null
// the engine's /compact never settles
let hangCompact = false
// the engine's /compact waits until the test releases it
let holdCompact = false
let releaseCompact: () => void = () => {}
// no ~/.claude-shared/state folder: the cold-compact log is not written, and the folder is not made
let noStateDir = false
// a plain -p run: the session draws on no surface
let headlessRun = false
// the desktop app's entrypoint
let desktopEntry = false
// what the person has typed in the prompt box
let boxDraft = ''

function answer(on: any, seen: { asks: number; options?: string[] }, label: string | null) {
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    seen.asks++
    ;(seen as any).options = (e.questions?.[0]?.options ?? []).map((o: any) => o.label ?? o)
    if (label === null) throw new Error('asked')
    const q = e.questions?.[0]?.question ?? ''
    return { result: { questions: e.questions, answers: { [q]: label } } }
  })
}

async function start($: any, ctx: number, clock: any) {
  await clock.advance(60000) // a real clock never reads 0
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: ctx, window: 1000000, percent: ctx / 10000 }, rateLimits: [], changed: [] })
}

test('the rotator wake-up compacts and resumes on its own, with no dialog', SETUP, async ($, on) => {
  const { clock, seen } = engine($, on)
  answer(on, seen, null)
  await start($, 300000, clock)
  const r = await $.prompt.submit({ text: 'Usage reset: the weekly limit capped, so the CLI account was rotated to G. Fresh weekly quota is available now - continue where you left off.', origin: COMPOSER, wait: false } as never)
  expect('drop' in (r as object)).toBe(true)
  await clock.advance(100)
  expect(seen.compacts).toBe(1)
  expect(seen.submits.length).toBe(1)
  expect(seen.submits[0]).toMatch(/^Usage reset:/)
  expect(seen.asks).toBe(0)
})

test('a small context woken by the rotator is sent as is', SETUP, async ($, on) => {
  const { clock, seen } = engine($, on)
  await start($, 100000, clock)
  const r = await $.prompt.submit({ text: 'Usage reset: the 5h limit capped, so the CLI account was rotated to C. Go on.', origin: COMPOSER, wait: false } as never)
  expect('drop' in (r as object)).toBe(false)
  await clock.advance(100)
  expect(seen.compacts).toBe(0)
})

test('"Compact first, then send" really compacts, then sends the message', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, 'Compact first, then send')
  await clock.advance(60000)
  // the chat's last reply, 77 minutes ago: past the 1-hour cache
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.prompt.submit({ text: 'approve, B', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
  expect('drop' in (r as object)).toBe(true)
  await clock.advance(100)
  expect(seen.compacts).toBe(1)
  expect(seen.submits).toEqual(['approve, B'])
  expect(seen.asUsers).toEqual([true]) // the person's own words stay the person's
  // owner 2026-11-03: compacting is the dialog's first, preselected option
  expect(seen.options[0]).toBe('Compact first, then send')
})

test('the rotator changing the seat file leaves a running chat alone: only its wake-up moves it', SETUP, async ($, on) => {
  const seat = { label: 'A' }
  const { clock, seen } = engine($, on, seat)
  answer(on, seen, 'Send anyway')
  await start($, 300000, clock)
  seat.label = 'H' // the rotator moved the merge-pr sessions to another account
  await clock.advance(5 * 60000)
  await $.prompt.submit({ text: 'what would it take?', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(0)
})

test('no compact prompt right after a compaction, nor for /compact itself', async ($, on) => {
  const seat = { label: 'A' }
  const { clock, seen } = engine($, on, seat)
  answer(on, seen, 'Send anyway')
  await start($, 300000, clock)
  seat.label = 'B'
  await clock.advance(31000)
  await $.prompt.submit({ text: '/compact', command: { name: 'compact', args: '' }, origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(0)
  await $.command.run({ command: 'compact', args: '' })
  await $.prompt.submit({ text: 'go on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(0)
})

const usage = (o: Record<string, unknown>) => ({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5', ...o })

test('the TTL comes from the API report: a 1-hour write reported after 20 idle minutes stays on 1 hour', async ($, on) => {
  const { clock } = engine($, on)
  let next: unknown = null
  on('turn.step', async function* () {
    return { answer: '', toolUses: [], usage: next }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => ({ value: {} }))
  await start($, 300000, clock)
  const step = async (u: unknown) => {
    next = u
    const it = ($ as any).turn.step({ model: 'claude-opus-5-5', messages: [] })
    // a streaming event: drain it to its result
    if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
    else await it
  }
  await step(usage({ cache_read_input_tokens: 290000, cache_creation_input_tokens: 0 }))
  await clock.advance(20 * 60000)
  await step(usage({ cache_creation_input_tokens: 290000, cache_creation: { ephemeral_1h_input_tokens: 290000, ephemeral_5m_input_tokens: 0 } }))
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/cache window 60 min \(reported by the API\)/)
})

// The real engine's usage has no cache_creation split: the idle gap alone must not drop to 5
test('a rewrite after 6 idle minutes with no TTL report stays on 1 hour', async ($, on) => {
  const { clock } = engine($, on)
  let next: unknown = null
  on('turn.step', async function* () {
    return { answer: '', toolUses: [], usage: next }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => ({ value: {} }))
  await start($, 300000, clock)
  const step = async (u: unknown) => {
    next = u
    const it = ($ as any).turn.step({ model: 'claude-opus-5-5', messages: [] })
    if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
    else await it
  }
  await step(usage({ cache_read_input_tokens: 290000, cache_creation_input_tokens: 0 }))
  await clock.advance(6 * 60000)
  await step(usage({ cache_creation_input_tokens: 290000 }))
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/cache window 60 min \(assumed; on the 5-minute API cache run \/cache ttl 5, which sets every session\)/)
  await $.command.run({ command: 'cache', args: 'ttl 5' })
  const set: any = await $.command.run({ command: 'cache', args: '' })
  expect(set.text).toMatch(/cache window 5 min \(set by you\)/)
  expect(set.text).not.toMatch(/assumed/)
})

// A TTL the API reports as 5 minutes is not "assumed", so the status line names no setting
test('a 5-minute TTL from the API split shows no hint, even without a write', async ($, on) => {
  const { clock } = engine($, on)
  on('turn.step', async function* () {
    return { answer: '', toolUses: [], usage: usage({ cache_read_input_tokens: 290000, cache_creation: { ephemeral_5m_input_tokens: 1 } }) }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => ({ value: {} }))
  await start($, 300000, clock)
  const it = ($ as any).turn.step({ model: 'claude-opus-5-5', messages: [] })
  if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
  else await it
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/cache window 5 min/)
  expect(r.text).not.toMatch(/assumed|ttl 5,/)
})

// A keep-warm ping that writes means the cache was already cold: on an assumed window, say how to set 5
for (const [ttl, hint] of [['', true], ['ttl 60', false], ['measured', false], ['5m split', false]] as const) {
  test(`a keep-warm ping that finds the cache cold ${hint ? 'names' : 'does not name'} /cache ttl 5 (${ttl || 'auto'})`, SETUP, async ($, on) => {
    const { clock, seen } = engine($, on)
    on('process.run', () => ({ value: { exitCode: 0, stdout: 'OPEN\n', stderr: '' } }))
    on('session.usage', () => ({ value: { context: { tokens: 300000, window: 1000000 } } }))
    on('turn.complete', () => ({ text: '' }))
    on('model.fork', () => ({ value: { text: 'ok', usage: usage({ cache_creation_input_tokens: 300000 }) } }))
    on('turn.step', async function* () {
      // '5m split': the API reports a 5-minute TTL with no write, so the window is 5 but not assumed
      const split = ttl === '5m split' ? { cache_creation: { ephemeral_5m_input_tokens: 1 } } : {}
      return { answer: '', toolUses: [], usage: usage({ cache_read_input_tokens: 290000, ...split }) }
    })
    await start($, 300000, clock)
    if (ttl === 'ttl 60') await $.command.run({ command: 'cache', args: ttl })
    const step = async () => {
      const it = ($ as any).turn.step({ model: 'claude-opus-5-5', messages: [] })
      if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
      else await it
    }
    await step()
    if (ttl === 'measured') {
      // a cache hit after 6 idle minutes measures the 1-hour TTL
      await clock.advance(6 * 60000)
      await step()
      const r: any = await $.command.run({ command: 'cache', args: '' })
      expect(r.text).toMatch(/cache window 60 min \(measured\)/)
    }
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'end_turn' } as never)
    await clock.advance(53 * 60000)
    const stop = seen.toasts.find((t) => /Keep warm off/.test(t)) ?? ''
    expect(stop).toMatch(/instead of reading the cache/)
    if (hint) expect(stop).toMatch(/\/cache ttl 5/)
    else expect(stop).not.toMatch(/ttl 5/)
  })
}

test('auto keep warm starts at turn end and stops once the merge-pr PR merges', SETUP, async ($, on) => {
  const { clock } = engine($, on)
  let state = 'OPEN'
  on('process.run', () => ({ value: { exitCode: 0, stdout: state + '\n', stderr: '' } }))
  on('session.usage', () => ({ value: { context: { tokens: 300000, window: 1000000 } } }))
  on('turn.complete', () => ({ text: '' }))
  on('model.fork', () => ({ value: { text: 'ok', usage: usage({ cache_read_input_tokens: 300000 }) } }))
  await start($, 300000, clock)
  await $.prompt.submit({ text: '/merge-pr 123', command: { name: 'merge-pr', args: '123' }, origin: COMPOSER, wait: false } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'end_turn' } as never)
  let r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/Keep warm is on/)
  state = 'MERGED'
  await clock.advance(16 * 60000)
  r = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/Keep warm is on/)
  expect(r.text).toMatch(/off in this session/)
})

test('the band reads the Fable weekly limit, the model and the reset clocks', async () => {
  const body = { limits: [
    { kind: 'weekly_scoped', scope: { model: { display_name: 'Sonnet' } }, percent: 2, resets_at: 1 },
    { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 6, resets_at: 1793055599 },
  ] }
  expect(fableLimit(body)).toEqual({ percentUsed: 6, resetsAt: new Date(1793055599 * 1000).toISOString() })
  expect(fableLimit({})).toBe(null)
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-fable-5-1[1m]')).toBe('Fable 5.1')
  const at = Date.parse('2026-10-29T08:00:00Z')
  expect(untilText('2026-10-29T11:30:00Z', at)).toBe('3h30m')
  expect(untilText('2026-11-04T22:00:00Z', at)).toBe('6d14h')
  expect(untilText('2026-10-30T07:05:00Z', at)).toBe('23h05m')
  expect(untilText('2026-10-29T08:40:00Z', at)).toBe('40m')
  expect(untilText('2026-10-28T00:00:00Z', at)).toBe('')
  expect(ago(177 * 3600000 + 48 * 60000)).toBe('7d9h')
})

test('an opened session measures its first request from the transcript tail', async () => {
  const reply = (ctx: number, ts: string, extra = {}) => JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: ts, effort: 'high', message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: ctx - 2002, cache_creation_input_tokens: 0, output_tokens: 2000 } }, ...extra })
  const lines = ['{"cut mid-row', reply(300000, '2026-10-28T10:00:00Z'), reply(5000, '2026-10-28T10:05:00Z', { isSidechain: true }), '{"type":"user"}', '']
  expect(lastContext(lines)).toEqual({ ctx: 300000, at: Date.parse('2026-10-28T10:00:00Z'), model: 'claude-opus-5-5', effort: 'high' })
  const compacted = [...lines, JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-28T11:00:00Z', compactMetadata: { postTokens: 155040 } })]
  expect(lastContext(compacted)).toEqual({ ctx: 155040, at: Date.parse('2026-10-28T11:00:00Z'), compacted: true })
  expect(lastContext(['', '{"type":"user"}'])).toBe(null)
})

test('a session that has sent nothing takes 5h and weekly from the shared usage reading', async () => {
  const body = { five_hour: { utilization: 44, resets_at: '2026-10-29T11:49:59Z' }, seven_day: { utilization: 36, resets_at: 1793055599 }, seven_day_opus: null }
  expect(planWindows(body)).toEqual([
    { kind: 'five_hour', percentUsed: 44, resetsAt: '2026-10-29T11:49:59Z' },
    { kind: 'seven_day', percentUsed: 36, resetsAt: new Date(1793055599 * 1000).toISOString() },
  ])
  expect(planWindows({ five_hour: null })).toEqual([])
})

test('setup-specific features stay off unless configured, and a bad pattern turns its feature off', async () => {
  expect(pattern('')).toBe(null)
  expect(pattern('([')).toBe(null)
  expect(pattern(String.raw`merge-pr (\d+)`)?.exec('merge-pr 12')?.[1]).toBe('12')
})

test('a reopened chat borrows plan windows from the freshest session on the same account', async () => {
  const at = Date.parse('2026-10-29T10:00:00Z')
  const five = (pct: number, resetsAt: string) => [{ kind: 'five_hour', percentUsed: pct, resetsAt }]
  const list = [
    { seat: 'A', desktop: false, updatedAt: at - 60000, rateLimits: five(40, '2026-10-29T12:00:00Z') },
    { seat: 'A', desktop: false, updatedAt: at - 1000, rateLimits: five(44, '2026-10-29T12:00:00Z') },
    { seat: 'B', desktop: true, updatedAt: at, rateLimits: five(90, '2026-10-29T12:00:00Z') },
    { seat: 'A', desktop: false, updatedAt: at, rateLimits: five(1, '2026-10-29T12:00:00Z'), self: true },
  ]
  expect(borrowedLimits(list, { seat: 'A', desktop: false }, at)[0].percentUsed).toBe(44)
  expect(borrowedLimits(list, { seat: '', desktop: true }, at)[0].percentUsed).toBe(90)
  expect(borrowedLimits([{ seat: 'A', updatedAt: at, rateLimits: five(80, '2026-10-29T09:00:00Z') }], { seat: 'A', desktop: false }, at)).toEqual([])
})

test('auto-resume waits for the last full window to reset, and only for usage', async () => {
  const at = Date.parse('2026-10-29T10:00:00Z')
  const limits = [
    { kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-29T12:00:00Z' },
    { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-11-04T23:00:00Z' },
  ]
  expect(spentWindows(limits, null, 'claude-opus-5-5').map((l) => l.kind)).toEqual(['five_hour'])
  expect(resumeTime(spentWindows(limits, null, 'claude-opus-5-5'), at)).toBe(Date.parse('2026-10-29T12:00:00Z') + 60000)
  // Fable's weekly cap only stops a Fable chat
  const fable = { percentUsed: 100, resetsAt: '2026-11-04T23:00:00Z' }
  expect(spentWindows([], fable, 'claude-opus-5-5')).toEqual([])
  expect(resumeTime(spentWindows([], fable, 'claude-fable-5-1'), at)).toBe(Date.parse('2026-11-04T23:00:00Z') + 60000)
  // nothing full, or no reset time: no time to resume at
  expect(resumeTime(spentWindows([{ kind: 'five_hour', percentUsed: 80 }], null, ''), at)).toBe(null)
})

test('a chat cut short by spent usage sends "Resume" once the window renews; a throttle does not', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  const t0 = 60000 // the mock clock starts at 0 and start() advanced it a minute
  const resetsAt = new Date(t0 + 30 * 60000).toISOString()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(20 * 60000)
  expect(seen.submits).toEqual([])
  await clock.advance(12 * 60000)
  expect(seen.submits).toEqual(['Resume'])
})

test('a short throttle or an overload arms no resume', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: 'Too many requests, slow down' })
  await ($ as any).classic.StopFailure({ error: 'overloaded', error_details: 'Overloaded' })
  await clock.advance(70 * 60000) // past the hourly fallback a wrongly armed resume would use
  expect(seen.submits).toEqual([])
})

// WCAG contrast ratio of two #rrggbb colours
function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

test('neighbouring segments alternate dark and light, so any two neighbours contrast', async () => {
  const painted = paint([['a', 'blue'], ['b', 'cyan'], ['c', 'blue']])
  expect(painted.map(([, bg]) => bg)).toEqual([HUES.blue[0], HUES.cyan[1], HUES.blue[0]])
  for (const [dark, light] of Object.values(HUES)) {
    expect(contrast(dark, '#ffffff')).toBeGreaterThanOrEqual(4.5) // its text reads
    expect(contrast(light, '#1e1e1e')).toBeGreaterThanOrEqual(4.5)
    for (const [, otherLight] of Object.values(HUES)) expect(contrast(dark, otherLight)).toBeGreaterThanOrEqual(3) // any neighbour pair
  }
})

test('each segment starts with a capital, past a leading symbol', async () => {
  expect(capFirst('● cache warm 42m')).toBe('● Cache warm 42m')
  expect(capFirst('medium')).toBe('Medium')
  expect(capFirst('5h 27% · 3h22m')).toBe('5h 27% · 3h22m')
  expect(capFirst('⏸ resumes 3:10am')).toBe('⏸ Resumes 3:10am')
  expect(capFirst('you@example.com')).toBe('you@example.com')
})

test('a big chat the app reopens asks before a cold send, from the kept record when the transcript is too big to read', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, 'Send anyway')
  on('fs.stat', () => ({ value: { kind: 'file', size: 26 * 1024 * 1024 } }))
  on('process.run', () => {
    throw new Error('CLI only')
  })
  await clock.advance(60000)
  const at = await clock.now()
  // what this mod wrote after the chat's last reply, 77 minutes ago: past the 1-hour cache
  kept.set('last:sid-test', { ctx: 545000, at, model: 'claude-opus-5-5', effort: 'high' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Give me the e-mail', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
})

test('a cold send that Claude Code auto-compacts still counts as a cold rewrite, and the count is kept for a reopen', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock } = engine($, on, { label: 'A' }, kept)
  let next: unknown = null
  on('turn.step', async function* () {
    return { answer: '', toolUses: [], usage: next }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => ({ value: {} }))
  await start($, 300000, clock)
  const step = async (u: unknown) => {
    next = u
    const it = ($ as any).turn.step({ model: 'claude-opus-5-5', messages: [] })
    if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
    else await it
  }
  const oneHour = (n: number) => ({ cache_creation_input_tokens: n, cache_creation: { ephemeral_1h_input_tokens: n, ephemeral_5m_input_tokens: 0 } })
  await step(usage(oneHour(400000)))
  await clock.advance(77 * 60000) // the 1-hour cache lapses
  await $.command.run({ command: 'compact', args: '' }) // as the auto-compaction marks it
  await step(usage(oneHour(260000)))
  const rec = kept.get('last:sid-test') as { cold: unknown[] }
  expect(rec.cold.length).toBe(1)
})

// The resend runs through several host round trips after the timer fires: wait for it, a few ticks at a time
async function settle(clock: any, done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await clock.advance(10)
}

// Owner 2026-11-02: a cold, big, idle chat woken by another session compacts BEFORE the message is processed
const PEER = { kind: 'peer' } as never
async function coldPeer($: any, on: any, idleMin: number, ctx = 300000, origin: unknown = PEER) {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, null) // nobody is there to answer a dialog
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(idleMin * 60000)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: 'PR 12 merged; pick up the next one', origin, wait: false } as never)
  await clock.advance(100)
  await settle(clock, () => seen.submits.length + seen.fills.length >= 1)
  return { r, seen }
}

test('a cold, large session woken by another session compacts before the message runs, with no dialog', async ($, on) => {
  const { r, seen } = await coldPeer($, on, 77)
  expect('drop' in (r as object)).toBe(true) // the message did not reach the model on the cold cache
  expect(seen.asks).toBe(0)
  expect(seen.order).toEqual(['compact', 'send:[peer message, resent by cache-keeper after /compact]\nPR 12 merged; pick up the next one'])
  expect(seen.asUsers).toEqual([undefined]) // a peer's message is framed as the mod's, never the person's own words
})

// R10 2026-11-03: a refused /compact still returns; it must not be logged, or treated, as a compaction
test('a cold compact the compactor refuses is logged as skipped, not as compacted', async ($, on) => {
  compactOutput = 'Not compacted · fast-jev: below 5% minimum: 2% reduction'
  try {
    const { seen } = await coldPeer($, on, 77)
    expect(seen.log).toContain('"action":"compact-skipped"')
    expect(seen.log).not.toContain('"action":"compacted"')
    expect(seen.order).toEqual(['compact', 'send:[peer message, resent by cache-keeper after /compact]\nPR 12 merged; pick up the next one'])
  } finally {
    compactOutput = ''
  }
})

// Pre-push review 2026-11-05: a second message during the compaction waits; it must not overtake the first
test('a message that arrives while the cold compact runs goes after the first one, not before', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, null)
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const a = await $.prompt.submit({ text: 'first', origin: PEER, wait: false } as never)
  const b = await $.prompt.submit({ text: 'second', origin: { kind: 'task-notification' } as never, wait: false } as never)
  await clock.advance(100)
  await settle(clock, () => seen.submits.length >= 2)
  expect('drop' in (a as object)).toBe(true)
  expect('drop' in (b as object)).toBe(true)
  expect(seen.compacts).toBe(1)
  expect(seen.order).toEqual(['compact', 'send:[peer message, resent by cache-keeper after /compact]\nfirst', 'send:[task-notification message, resent by cache-keeper after /compact]\nsecond'])
})

// Pre-push review round 2: a resend that cannot be submitted stops the rest, so none overtakes or overwrites it
test('when a queued resend cannot be submitted, it goes back to the prompt box with the messages behind it', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, null)
  failSubmit = /first/
  try {
    await clock.advance(60000)
    kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
    await clock.advance(77 * 60000)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await $.prompt.submit({ text: 'first', origin: PEER, wait: false } as never)
    await $.prompt.submit({ text: 'second', origin: PEER, wait: false } as never)
    await clock.advance(100)
    await settle(clock, () => seen.fills.length >= 1)
    expect(seen.order).toEqual(['compact'])
    // both go back in the prompt box, the failed one first, appended to whatever is there
    expect(seen.fills).toEqual([{ text: '[peer message, resent by cache-keeper after /compact]\nfirst\n\n[peer message, resent by cache-keeper after /compact]\nsecond', mode: 'append' }])
    expect(seen.toasts.some((t) => /2 messages are back in the prompt box/.test(t))).toBe(true)
  } finally {
    failSubmit = null
  }
})

// Review round 3: a submit the host refuses RESOLVES { drop }; it is a failure, not a delivery
test('a resend the host refuses with a drop goes back to the prompt box with the messages behind it', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, null)
  dropSubmit = /first/
  try {
    await clock.advance(60000)
    kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
    await clock.advance(77 * 60000)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await $.prompt.submit({ text: 'first', origin: PEER, wait: false } as never)
    await $.prompt.submit({ text: 'second', origin: PEER, wait: false } as never)
    await clock.advance(100)
    await settle(clock, () => seen.fills.length >= 1)
    expect(seen.submits).toEqual([])
    expect(seen.fills.length).toBe(1)
    expect(seen.fills[0].mode).toBe('append')
    expect(seen.fills[0].text).toMatch(/first[\s\S]*\n\n[\s\S]*second/)
    expect(seen.log).not.toContain('not-resent') // put back, not lost
  } finally {
    dropSubmit = null
  }
})

// A put-back message must not run into what the person has typed
test('messages put back in the prompt box start a blank line after the draft', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, null)
  dropSubmit = /first/
  boxDraft = 'half typed'
  try {
    await clock.advance(60000)
    kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
    await clock.advance(77 * 60000)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await $.prompt.submit({ text: 'first', origin: PEER, wait: false } as never)
    await clock.advance(100)
    await settle(clock, () => seen.fills.length >= 1)
    expect(seen.fills[0].mode).toBe('append')
    expect(seen.fills[0].text.startsWith('\n\n[peer message')).toBe(true)
  } finally {
    dropSubmit = null
    boxDraft = ''
  }
})

// Messages queued for one chat never go into the next one after /clear
test('a /clear during a compaction puts the queued messages back instead of sending them to the new chat', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, null)
  on('classic.SessionStart', () => ({}))
  hangCompact = true
  try {
    await clock.advance(60000)
    kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
    await clock.advance(77 * 60000)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await $.prompt.submit({ text: 'first', origin: PEER, wait: false } as never)
    await clock.advance(100)
    await settle(clock, () => seen.compacts >= 1)
    await ($ as any).classic.SessionStart({ source: 'clear', transcript_path: '' })
    await settle(clock, () => seen.toasts.some((t) => /meant for the previous chat/.test(t)))
    expect(seen.fills[0].text).toContain('first')
    expect(seen.toasts.some((t) => /meant for the previous chat/.test(t))).toBe(true)
    // a later message in the new chat is not held behind the old chat's queue
    await $.prompt.submit({ text: 'new chat', origin: PEER, wait: false } as never)
    await clock.advance(200)
    expect(seen.log).toContain('"event":"guard-pass"') // the new chat's message went through, so the next line is not vacuous
    expect(seen.log).not.toContain('"queued-behind-compact","text":"new chat"')
  } finally {
    hangCompact = false
  }
})

// The old chat's compaction ending after /clear leaves the new chat as it found it
test('a compaction that ends after /clear does not mark the new chat compacted', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, null)
  on('classic.SessionStart', () => ({}))
  holdCompact = true
  try {
    await clock.advance(60000)
    kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
    await clock.advance(77 * 60000)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await $.prompt.submit({ text: 'first', origin: PEER, wait: false } as never)
    await clock.advance(100)
    await settle(clock, () => seen.compacts >= 1)
    await ($ as any).classic.SessionStart({ source: 'clear', transcript_path: '' })
    await settle(clock, () => seen.fills.length >= 1)
    releaseCompact()
    await clock.advance(200)
    await $.prompt.submit({ text: 'later', origin: PEER, wait: false } as never)
    await clock.advance(200)
    // the new chat's message is logged with the guard's view of it: not compacted by the old chat's run
    expect(seen.log).toContain('"event":"guard-pass"')
    expect(seen.log).not.toContain('"justCompacted":true')
    expect(seen.submits).toEqual([]) // nothing of the old chat's was resent into the new one
  } finally {
    holdCompact = false
  }
})

// A /clear during the last resend must not leave the queue open with no drain
test('a /clear during the last resend leaves no queue behind to swallow the next message', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, null)
  on('classic.SessionStart', () => ({}))
  duringSubmit = async () => {
    duringSubmit = null
    await ($ as any).classic.SessionStart({ source: 'clear', transcript_path: '' })
  }
  try {
    await clock.advance(60000)
    kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
    await clock.advance(77 * 60000)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await $.prompt.submit({ text: 'first', origin: PEER, wait: false } as never)
    await clock.advance(100)
    await settle(clock, () => seen.submits.length >= 1)
    await clock.advance(200)
    const r = await $.prompt.submit({ text: 'later', origin: PEER, wait: false } as never)
    await clock.advance(200)
    // the new chat's message is not held behind a queue nobody will drain
    expect('drop' in (r as object)).toBe(false)
    expect(seen.log).not.toContain('"queued-behind-compact","text":"later"')
  } finally {
    duringSubmit = null
  }
})

// A resend the host refuses is not tried again as the mod: Stop or another hook meant it
test('a refused resend is not retried under another identity', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, null)
  holdCompact = true
  dropSubmit = /wake/
  try {
    await clock.advance(60000)
    kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
    await clock.advance(77 * 60000)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await $.prompt.submit({ text: 'first', origin: PEER, wait: false } as never)
    await clock.advance(100)
    await settle(clock, () => seen.compacts >= 1)
    // no origin: queued as possibly the person's, so it would try asUser and then without it
    await $.prompt.submit({ text: 'wake', wait: false } as never)
    releaseCompact()
    await settle(clock, () => seen.fills.length >= 1)
    expect(seen.attempts.filter((t) => t === 'wake')).toEqual(['wake'])
    expect(seen.fills[0].text).toContain('wake')
  } finally {
    holdCompact = false
    dropSubmit = null
  }
})

// A message arriving while the queue drains is appended to it, so it cannot overtake an earlier one
test('a message that arrives during the drain goes after the queued ones', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, null)
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'first', origin: PEER, wait: false } as never)
  await $.prompt.submit({ text: 'second', origin: PEER, wait: false } as never)
  // the third arrives while the first is being resent, mid-drain
  let late: unknown
  duringSubmit = async (e) => {
    if (/first/.test(e.text) && !late) late = await $.prompt.submit({ text: 'third', origin: PEER, wait: false } as never)
  }
  try {
    await clock.advance(100)
  await settle(clock, () => seen.submits.length >= 3)
  } finally {
    duringSubmit = null
  }
  expect('drop' in (late as object)).toBe(true) // queued behind, not sent ahead
  expect(seen.compacts).toBe(1)
  expect(seen.order.filter((o) => o.startsWith('send:')).map((o) => o.split('\n')[1])).toEqual(['first', 'second', 'third'])
})

// A refused compaction leaves the context as big as it was: retrying on every wake would refuse again
test('a refused compaction sets the floor, so the next cold peer wake is skipped', async ($, on) => {
  compactOutput = 'Not compacted · fast-jev: below 5% minimum: 2% reduction'
  try {
    const kept = new Map<string, unknown>()
    const { clock, seen } = engine($, on, { label: 'A' }, kept)
    answer(on, seen, null)
    await clock.advance(60000)
    kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
    await clock.advance(77 * 60000)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await $.prompt.submit({ text: 'one', origin: PEER, wait: false } as never)
    await clock.advance(100)
    await settle(clock, () => seen.submits.length >= 1)
    expect(seen.compacts).toBe(1)
    // past the 2-minute retry pause, and the cache is cold again
    await clock.advance(3 * 60000)
    const r = await $.prompt.submit({ text: 'two', origin: PEER, wait: false } as never)
    await clock.advance(100)
    await settle(clock, () => seen.log.includes('skip-floor'))
    expect('drop' in (r as object)).toBe(false) // goes through as is
    expect(seen.compacts).toBe(1)
    expect(seen.log).toContain('"action":"skip-floor"')
  } finally {
    compactOutput = ''
  }
})

// Anything the host could not classify may be the person at the prompt: it gets the dialog, not the silent compact
async function unknownOrigin($: any, on: any, origin: unknown) {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, 'Send anyway')
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: 'who am I', ...(origin ? { origin } : {}), wait: false } as never)
  await clock.advance(100)
  expect(seen.asks).toBe(1)
  expect(seen.compacts).toBe(0)
  expect('drop' in (r as object)).toBe(false)
  expect(seen.log).toContain('"event":"asked"')
  expect(seen.log).not.toContain('compact-first')
}
test('a prompt with an unclassified origin is asked, not auto-compacted', ($, on) => unknownOrigin($, on, { kind: 'unclassified' }))
test('a prompt with no origin is asked, not auto-compacted', ($, on) => unknownOrigin($, on, undefined))
// A plain -p run's prompt is the person's: dropping it to compact could end the run
test('an sdk prompt in a plain -p run is asked, not auto-compacted', async ($, on) => {
  headlessRun = true
  try {
    await unknownOrigin($, on, { kind: 'sdk' })
  } finally {
    headlessRun = false
  }
})
// while an sdk turn in a session that draws on a surface (not a plain -p run) still compacts first
test('an sdk turn in a session with a surface compacts first', async ($, on) => {
  const { r, seen } = await coldPeer($, on, 77, 300000, { kind: 'sdk' })
  expect('drop' in (r as object)).toBe(true)
  expect(seen.compacts).toBe(1)
})
// the app may not have attached a surface yet: its entrypoint says it is the app all the same
test("the desktop app's own sdk turn compacts first before the app attaches", async ($, on) => {
  headlessRun = true
  desktopEntry = true
  try {
    const { r, seen } = await coldPeer($, on, 77, 300000, { kind: 'sdk' })
    expect('drop' in (r as object)).toBe(true)
    expect(seen.compacts).toBe(1)
  } finally {
    headlessRun = false
    desktopEntry = false
  }
})
test("an auto-continuation prompt (after the person's own click) is asked, not auto-compacted", ($, on) => unknownOrigin($, on, { kind: 'auto-continuation' }))

// A plugin's resend leaves an @ mention unexpanded: the person's prompt with one does not join the queue
test('a prompt of the person with an @ mention does not wait behind a running compaction', async ($, on) => {
  hangCompact = true
  try {
    const kept = new Map<string, unknown>()
    const { clock, seen } = engine($, on, { label: 'A' }, kept)
    answer(on, seen, null)
    await clock.advance(60000)
    kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
    await clock.advance(77 * 60000)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await $.prompt.submit({ text: 'first', origin: PEER, wait: false } as never)
    await clock.advance(100)
    expect(seen.compacts).toBe(1)
    const plain = await $.prompt.submit({ text: 'and this', origin: COMPOSER, wait: false } as never)
    const mention = await $.prompt.submit({ text: 'look at @src/x.ts', origin: COMPOSER, wait: false } as never)
    expect('drop' in (plain as object)).toBe(true) // queued behind the compaction
    expect('drop' in (mention as object)).toBe(false) // goes as typed, its mention expanded
    expect(seen.asks).toBe(0) // and is not asked while the compaction runs
  } finally {
    hangCompact = false
  }
})

// The dialog waits on the person: a compaction that ran meanwhile is not followed by a second one. It is
// refused here, so nothing else (justCompacted) stands in for the guard under test
test('"Compact first" answered after a compaction ran during the dialog does not compact again', async ($, on) => {
  compactOutput = 'Not compacted · fast-jev: below 5% minimum: 2% reduction'
  try {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  let ran = false
  on('tool.call', async (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    seen.asks++
    if (!ran) {
      ran = true
      // while the person reads the dialog, a peer's message compacts first and is resent
      await $.prompt.submit({ text: 'from a peer', origin: PEER, wait: false } as never)
      await settle(clock, () => seen.submits.length >= 1)
    }
    const q = e.questions?.[0]?.question ?? ''
    return { result: { questions: e.questions, answers: { [q]: 'Compact first, then send' } } }
  })
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: 'mine', origin: COMPOSER, wait: false } as never)
  await clock.advance(200)
  expect(seen.asks).toBe(1)
  expect(seen.compacts).toBe(1)
  expect('drop' in (r as object)).toBe(false)
  } finally {
    compactOutput = ''
  }
})

// An unclassified prompt the engine marks isMeta is an engine notice, not the person: never asked, and never
// compacted for, since a resend could not carry isMeta and would turn a receipt into a turn of its own
test('an unclassified engine notice (isMeta) goes through as is, unasked', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, 'Send anyway')
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: 'idle notice', origin: { kind: 'unclassified' }, isMeta: true, wait: false } as never)
  await clock.advance(100)
  expect(seen.asks).toBe(0)
  expect(seen.compacts).toBe(0)
  expect('drop' in (r as object)).toBe(false)
  expect(seen.log).toContain('skip-meta')
})

// A compaction that never settles must not hold the queue forever
test('a compaction that does not settle in 10 minutes lets the queue go as typed', async ($, on) => {
  hangCompact = true
  try {
    const kept = new Map<string, unknown>()
    const { clock, seen } = engine($, on, { label: 'A' }, kept)
    answer(on, seen, null)
    await clock.advance(60000)
    kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
    await clock.advance(77 * 60000)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await $.prompt.submit({ text: 'first', origin: PEER, wait: false } as never)
    await clock.advance(9 * 60000)
    expect(seen.submits).toEqual([]) // still waiting
    await clock.advance(2 * 60000)
    expect(seen.submits.length).toBe(1)
    expect(seen.log).toContain('"action":"compact-timeout"')
  } finally {
    hangCompact = false
  }
})

test('the cold-compact log is one file per session, stamped in local time', async ($, on) => {
  const { seen } = await coldPeer($, on, 77)
  expect(seen.logPath).toMatch(/cache-keeper-cold-compact-log-sid-test\.txt$/)
  expect(seen.log).toMatch(/"t":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d"/)
})

test('a cold compact that went through is logged as compacted', async ($, on) => {
  const { seen } = await coldPeer($, on, 77)
  expect(seen.log).toContain('"action":"compacted"')
})

test("a warm session takes another session's message as is", async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  on('turn.step', async function* () {
    return { answer: '', toolUses: [], usage: usage({ cache_read_input_tokens: 300000 }) }
  })
  on('session.usage', () => ({ value: {} }))
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(2 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  // a reply in this process: its cache is this process's own, and warm
  const it = ($ as any).turn.step({ model: 'claude-opus-5-5', messages: [] })
  if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
  else await it
  await clock.advance(20 * 60000)
  const r = await $.prompt.submit({ text: 'PR 12 merged; pick up the next one', origin: PEER, wait: false } as never)
  expect('drop' in (r as object)).toBe(false)
  expect(seen.compacts).toBe(0)
})

// Owner 2026-11-03 ("no longer prompting to compact on cold cache starts"): a reopened chat
// misses its cache inside the hour too, so the guard asks before its first send
test('a big chat reopened inside the hour asks before its first send', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, 'Send anyway')
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 260000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(31 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Try again', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
})

// A reload of this mod (an update, an enable) fires session.start again in the live process: its own
// heartbeat is moments old, so a warm chat is not taken for a reopened one and is not compacted
test('a reload of the mod does not make a warm chat look reopened', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, 'Send anyway')
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(5 * 60000)
  kept.set('hb:sid-test', { id: 'sid-test', ctx: 300000, lastActivity: (await clock.now()) - 5 * 60000, reopenedAt: 0, updatedAt: (await clock.now()) - 20000 })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: 'from a peer', origin: PEER, wait: false } as never)
  await clock.advance(100)
  expect(seen.compacts).toBe(0)
  expect(seen.asks).toBe(0)
  expect('drop' in (r as object)).toBe(false)
})

// Without the shared state folder there is no log, and none is made
test('with no ~/.claude-shared/state folder the cold-compact log is not written', async ($, on) => {
  noStateDir = true
  try {
    const kept = new Map<string, unknown>()
    const { clock, seen } = engine($, on, { label: 'A' }, kept)
    answer(on, seen, null)
    await clock.advance(60000)
    kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
    await clock.advance(77 * 60000)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
    await $.prompt.submit({ text: 'first', origin: PEER, wait: false } as never)
    await clock.advance(100)
    await settle(clock, () => seen.submits.length >= 1)
    expect(seen.compacts).toBe(1)
    expect(seen.log).toBe('')
  } finally {
    noStateDir = false
  }
})

test('a big prompt the guard lets through is logged with why', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  on('turn.step', async function* () {
    return { answer: '', toolUses: [], usage: usage({ cache_read_input_tokens: 300000 }) }
  })
  on('session.usage', () => ({ value: {} }))
  await clock.advance(60000)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const it = ($ as any).turn.step({ model: 'claude-opus-5-5', messages: [] })
  if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
  else await it
  await clock.advance(10 * 60000)
  await $.prompt.submit({ text: 'next', origin: COMPOSER, wait: false } as never)
  await settle(clock, () => seen.log !== '') // the hot path does not wait on the log
  expect(seen.log).toContain('"event":"guard-pass"')
  expect(seen.log).toContain('"isCold":false')
  expect(seen.log).toContain('"idleMin":10')
})

test('the dialog answer is logged', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, 'Send anyway')
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 260000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(31 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'Try again', origin: COMPOSER, wait: false } as never)
  await settle(clock, () => seen.log.includes('"asked"')) // the hot path does not wait on the log
  expect(seen.log).toContain('"event":"asked"')
  expect(seen.log).toContain('"answer":"Send anyway"')
})

test("a small cold session takes another session's message as is", async ($, on) => {
  const small = await coldPeer($, on, 77, 100000)
  expect('drop' in (small.r as object)).toBe(false)
  expect(small.seen.compacts).toBe(0)
})
