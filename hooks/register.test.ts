import { expect, mock, test } from 'claude-code/testing'
import { ago, borrowedLimits, fableLimit, pattern, resumeTime, spentWindows, lastContext, modelName, planWindows, untilText } from './register.mjs'

const COMPOSER = { kind: 'composer' } as never
// An example setup: an account rotator and a merge-pr workflow, as the README describes
const SETUP = { options: { seatFileTerminal: '~/.claude-cli-accounts/.active', seatFileDesktop: '~/.claude-app-seats/.active', rotatorWakePattern: String.raw`^\s*Usage reset:[^\n]*\baccount was rotated\b`, prPattern: String.raw`(?:^|\s)/?merge-pr\s+#?(\d+)` } }


// The engine beneath the mod: a terminal session on seat A, nothing on disk but the seat file
function engine($: any, on: any, seat = { label: 'A' }) {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/Users/T' })
  const seen = { compacts: 0, submits: [] as string[], asks: 0 }
  on('session.id', () => ({ value: 'sid-test' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.surface', () => ({ value: 'terminal' }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', (_: unknown, e: any) => ({ value: String(e.path ?? e).includes('.active') }))
  on('fs.read', () => ({ value: seat.label }))
  on('command.run', (_: unknown, e: any) => {
    if (e.command === 'compact') seen.compacts++
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
  const seat = { label: 'A' }
  const { clock, seen } = engine($, on, seat)
  answer(on, seen, 'Compact first, then send')
  await start($, 300000, clock)
  seat.label = 'B' // the rotator moved this session to another account
  await clock.advance(31000)
  const r = await $.prompt.submit({ text: 'approve, B', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
  expect('drop' in (r as object)).toBe(true)
  await clock.advance(100)
  expect(seen.compacts).toBe(1)
  expect(seen.submits).toEqual(['approve, B'])
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
  const resetsAt = new Date(t0 + 2 * 3600000).toISOString()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(3600000)
  expect(seen.submits).toEqual([])
  await clock.advance(3600000 + 2 * 60000)
  expect(seen.submits).toEqual(['Resume'])
})

test('a short throttle or an overload arms no resume', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: 'Too many requests, slow down' })
  await ($ as any).classic.StopFailure({ error: 'overloaded', error_details: 'Overloaded' })
  await clock.advance(4 * 3600000)
  expect(seen.submits).toEqual([])
})
