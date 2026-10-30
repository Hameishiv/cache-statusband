import { expect, mock, test } from 'claude-code/testing'
import { ago, borrowedLimits, capFirst, fableLimit, HUES, paint, pattern, resumeText, resumeTime, spentWindows, lastContext, modelName, planWindows, untilText } from './register.mjs'

const COMPOSER = { kind: 'composer' } as never
// An example setup: an account rotator and a merge-pr workflow, as the README describes
const SETUP = { options: { seatFileTerminal: '~/.claude-cli-accounts/.active', seatFileDesktop: '~/.claude-app-seats/.active', rotatorWakePattern: String.raw`^\s*Usage reset:[^\n]*\baccount was rotated\b`, prPattern: String.raw`(?:^|\s)/?merge-pr\s+#?(\d+)` } }


// The engine beneath the mod: a terminal session on seat A, nothing on disk but the seat file
function engine($: any, on: any, seat: { label: string; recording?: string } = { label: 'A' }, kept?: Map<string, unknown>) {
  const clock = mock.clock(on)
  if (kept) {
    // a store already holding what an earlier run of this mod wrote
    on('store.get', (_: unknown, e: any) => ({ value: kept.get(e.key) }))
    on('store.set', (_: unknown, e: any) => (kept.set(e.key, e.value), { value: undefined }))
    on('store.delete', (_: unknown, e: any) => (kept.delete(e.key), { value: undefined }))
    on('store.keys', () => ({ value: [...kept.keys()] }))
  } else mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/Users/T' })
  const seen = { compacts: 0, submits: [] as string[], asks: 0, duringCompact: null as null | (() => Promise<unknown>) }
  on('session.id', () => ({ value: 'sid-test' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.surface', () => ({ value: 'terminal' }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] }))
  const isRecording = (e: any) => !!seat.recording && String(e.path ?? e).includes('recording')
  on('fs.exists', (_: unknown, e: any) => ({ value: String(e.path ?? e).includes('.active') || isRecording(e) }))
  on('fs.read', (_: unknown, e: any) => ({ value: isRecording(e) ? seat.recording : seat.label }))
  on('command.run', async (_: unknown, e: any) => {
    if (e.command === 'compact') {
      seen.compacts++
      await seen.duringCompact?.()
    }
    return { text: '' }
  })
  on('prompt.submit', (_: unknown, e: any) => {
    if (e.origin?.kind === 'plugin') seen.submits.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.measure', () => ({ changed: [] }))
  on('ui.toast', () => ({ value: undefined }))
  return { clock, seen }
}

// $.ui.ask reaches the engine as an AskUserQuestion tool call
function answer(on: any, seen: { asks: number }, label: string | null) {
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    seen.asks++
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

test('the TTL comes from the API report, so a rewrite after 20 idle minutes stays on 1 hour', async ($, on) => {
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
  expect(borrowedLimits(list, { seat: '', desktop: true }, at)).toEqual([]) // an unseated session does not borrow a seated one's
  expect(borrowedLimits([{ seat: 'A', updatedAt: at, rateLimits: five(80, '2026-10-29T09:00:00Z') }], { seat: 'A', desktop: false }, at)).toEqual([])
  // a seated and an unseated session on one surface are not known to share an account
  const mixed = [{ seat: '', desktop: true, updatedAt: at, rateLimits: five(70, '2026-10-29T12:00:00Z') }, { seat: 'B', desktop: true, updatedAt: at, rateLimits: five(90, '2026-10-29T12:00:00Z') }]
  expect(borrowedLimits(mixed, { seat: 'A', desktop: true }, at)).toEqual([])
  expect(borrowedLimits(mixed.slice(1), { seat: '', desktop: true }, at)).toEqual([])
  expect(borrowedLimits(mixed, { seat: '', desktop: true }, at)[0].percentUsed).toBe(70)
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

test('"rate limit reached" is a throttle and arms no resume; "5-hour limit reached" and "Weekly limit reached" do', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: 'Rate limit reached' })
  await clock.advance(70 * 60000)
  expect(seen.submits).toEqual([])
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: '5-hour limit reached' })
  await clock.advance(70 * 60000)
  expect(seen.submits).toEqual(['Resume'])
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: 'Weekly limit reached' })
  await clock.advance(70 * 60000)
  expect(seen.submits).toEqual(['Resume', 'Resume'])
})

test('a /clear drops the resume armed in the last chat', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  on('classic.SessionStart', () => ({}))
  await start($, 50000, clock)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await ($ as any).classic.SessionStart({ source: 'clear' })
  await clock.advance(70 * 60000)
  expect(seen.submits).toEqual([])
})

test('a message sent while a big chat compacts for its resume cancels the "Resume"', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 300000, clock)
  const resetsAt = new Date(60000 + 30 * 60000).toISOString()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  // the person types while the compaction runs
  seen.duringCompact = () => $.prompt.submit({ text: 'hold on', origin: COMPOSER, wait: false } as never)
  await clock.advance(40 * 60000)
  expect(seen.compacts).toBe(1)
  expect(seen.submits).toEqual([])
})

test('a big chat compacts before its resume, which is then sent', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 300000, clock)
  const resetsAt = new Date(60000 + 30 * 60000).toISOString()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(40 * 60000)
  expect(seen.compacts).toBe(1)
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

// A main-loop request: drives turn.step with a given usage
function stepper($: any, on: any) {
  let next: unknown = null
  on('turn.step', async function* () {
    return { answer: '', toolUses: [], usage: next }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => ({ value: {} }))
  return async (u: unknown) => {
    next = u
    const it = $.turn.step({ model: 'claude-opus-5-5', messages: [] })
    if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
    else await it
  }
}

const oneHourWrite = (n: number) => ({ cache_creation_input_tokens: n, cache_creation: { ephemeral_1h_input_tokens: n, ephemeral_5m_input_tokens: 0 } })
const ROTATE = 'Usage reset: the CLI account was rotated to B. Go on.'

test('a compaction after a rotation that a request already landed on is not a cold rewrite', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const { clock } = engine($, on, seat, kept)
  on('classic.PostCompact', () => ({}))
  const step = stepper($, on)
  await start($, 100000, clock)
  await step(usage({ cache_read_input_tokens: 100000 }))
  seat.label = 'B'
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // the rotation reaches the chat
  await step(usage(oneHourWrite(100000))) // the rotation's own rewrite
  expect((kept.get('last:sid-test') as { cold: unknown[] }).cold.length).toBe(1)
  await clock.advance(60000)
  // two of the hooks one compaction fires
  await $.command.run({ command: 'compact', args: '' })
  await ($ as any).classic.PostCompact({})
  await step(usage(oneHourWrite(60000)))
  expect((kept.get('last:sid-test') as { cold: unknown[] }).cold.length).toBe(1)
})

test('a compaction right after a rotation is one cold rewrite, however many hooks mark it', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const { clock } = engine($, on, seat, kept)
  on('classic.PostCompact', () => ({}))
  const step = stepper($, on)
  await start($, 100000, clock)
  await step(usage({ cache_read_input_tokens: 100000 }))
  seat.label = 'B'
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await $.command.run({ command: 'compact', args: '' })
  await ($ as any).classic.PostCompact({})
  await step(usage(oneHourWrite(60000)))
  expect((kept.get('last:sid-test') as { cold: unknown[] }).cold.length).toBe(1)
})

test('a rotation does not leave the band cold once the chat is cleared', SETUP, async ($, on) => {
  const seat = { label: 'A' }
  const { clock } = engine($, on, seat)
  on('classic.SessionStart', () => ({}))
  await start($, 100000, clock)
  seat.label = 'B'
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  let r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated/)
  await ($ as any).classic.SessionStart({ source: 'clear' })
  r = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/account rotated/)
})

test('a chat resumed after a rotation, last answered on the old account, is cold and asks once', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const { clock, seen } = engine($, on, seat, kept)
  answer(on, seen, 'Send anyway')
  on('classic.SessionStart', () => ({}))
  await clock.advance(30 * 60000)
  await start($, 100000, clock)
  seat.label = 'B'
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // the rotation reaches this small chat
  await clock.advance(60000)
  // the resumed chat's last request: 20 minutes ago, before the rotation, so on account A
  kept.set('last:sid-test', { ctx: 300000, at: (await clock.now()) - 20 * 60000, model: 'claude-opus-5-5' })
  await ($ as any).classic.SessionStart({ source: 'resume' })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
})

test('a compaction is kept for a reopened chat as a record with an `at` of 0', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock } = engine($, on, { label: 'A' }, kept)
  const step = stepper($, on)
  await start($, 300000, clock)
  await step(usage(oneHourWrite(300000)))
  await $.command.run({ command: 'compact', args: '' })
  await clock.advance(10)
  expect(kept.get('last:sid-test')).toMatchObject({ ctx: 300010, at: 0 })
})

test('a compact boundary without its size still ends the walk back through the transcript', async () => {
  const reply = JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: '2026-10-28T10:00:00Z', message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: 300000, output_tokens: 2 } } })
  const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-28T11:00:00Z' })
  expect(lastContext([reply, boundary])).toEqual({ ctx: 0, at: Date.parse('2026-10-28T11:00:00Z'), compacted: true })
})

test('a dated model id keeps its major version and drops the date', async () => {
  expect(modelName('claude-sonnet-4-20250514')).toBe('Sonnet 4')
  expect(modelName('claude-opus-4-1-20250805')).toBe('Opus 4.1')
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
})

test('a resume days away says how far off it is, one under a day is just the time', async () => {
  const from = Date.parse('2026-10-29T08:00:00Z')
  expect(resumeText(from + 5 * 3600000, from)).toBe(resumeText(from + 5 * 3600000, from + 1))
  expect(resumeText(from + 5 * 3600000, from)).not.toMatch(/ in /)
  expect(resumeText(from + 6 * 86400000 + 3 * 3600000, from)).toMatch(/ in 6d3h$/)
})

test('a stale full window alone does not arm a resume for a throttle', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  const past = new Date(30000).toISOString() // reset since the reading
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: past }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: 'Too many requests, slow down' })
  await clock.advance(70 * 60000)
  expect(seen.submits).toEqual([])
})

test('auto keep warm stops once its pings cost as much as the rewrite; one started by hand goes on', async ($, on) => {
  const { clock } = engine($, on)
  let pings = 0
  on('model.fork', () => {
    pings++
    return { value: { text: 'ok', usage: usage({ cache_read_input_tokens: 300000 }) } }
  })
  const step = stepper($, on)
  await start($, 300000, clock)
  await $.command.run({ command: 'cache', args: 'ttl 5' })
  await step(usage({ cache_read_input_tokens: 300000 }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'end_turn' } as never)
  let r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/Keep warm is on/)
  await clock.advance(5 * 3600000)
  r = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/Keep warm is on/)
  const auto = pings
  expect(auto).toBeGreaterThan(3)
  expect(auto).toBeLessThan(30)
  // by hand: no cap
  await $.command.run({ command: 'keepwarm', args: '8' })
  await step(usage({ cache_read_input_tokens: 300000 }))
  await clock.advance(5 * 3600000)
  expect(pings - auto).toBeGreaterThan(auto)
  r = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/Keep warm is on/)
})

test('a failed plan check does not overwrite a newer reading another session took', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock } = engine($, on, { label: 'A' }, kept)
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  const fresh = { at: 999999999, next: 999999999 + 300000, fable: { percentUsed: 7 }, windows: [{ kind: 'five_hour', percentUsed: 5 }], why: 'ok' }
  on('http.fetch', () => {
    // another session lands its reading while this one's check is in flight
    kept.set('plan', fresh)
    return { value: { ok: false, status: 429, text: '', headers: { 'retry-after': '600' } } }
  })
  kept.set('plan', { at: 1, next: 2, fable: { percentUsed: 1 }, windows: [], why: 'ok' })
  await start($, 50000, clock)
  await clock.advance(70000)
  expect(kept.get('plan')).toEqual(fresh)
})

test('a session without a first-party sign-in neither shows nor writes the shared plan reading', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock } = engine($, on, { label: 'A' }, kept)
  on('session.authorize', () => ({ value: null }))
  const shared = { at: 5, next: 99999999999, fable: { percentUsed: 33 }, windows: [{ kind: 'five_hour', percentUsed: 44 }], why: 'ok' }
  kept.set('plan', shared)
  await start($, 50000, clock)
  await clock.advance(70000)
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/Fable weekly: no reading yet \(last check: no first-party sign-in\)/)
  expect(kept.get('plan')).toEqual(shared)
})

test('the seat label is masked in recording mode like the email', SETUP, async ($, on) => {
  const seat = { label: 'A', recording: '{"on":true,"strict":true}' }
  const { clock } = engine($, on, seat)
  await start($, 100000, clock)
  seat.label = 'jane.doe@example.com' // a rotator often labels seats by email
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated/)
  expect(r.text).not.toMatch(/jane.doe/)
})
