import { expect, mock, test } from 'claude-code/testing'
import { ago, borrowedLimits, capFirst, fableLimit, HUES, paint, pattern, resumeText, resumeTime, spentWindows, lastContext, modelName, planWindows, untilText } from './register.mjs'

const COMPOSER = { kind: 'composer' } as never
// An example setup: an account rotator and a merge-pr workflow, as the README describes
const SETUP = { options: { seatFileTerminal: '~/.claude-cli-accounts/.active', seatFileDesktop: '~/.claude-app-seats/.active', rotatorWakePattern: String.raw`^\s*Usage reset:[^\n]*\baccount was rotated\b`, prPattern: String.raw`(?:^|\s)/?merge-pr\s+#?(\d+)` } }


// The engine beneath the mod: a terminal session on seat A, nothing on disk but the seat file
// `disk` adds files by name (a transcript, the account file); `holdAccount` makes reading the account file wait
function engine($: any, on: any, seat: { label: string; recording?: string } = { label: 'A' }, kept?: Map<string, unknown>, onGet?: (key: string) => Promise<void> | void, disk: { files?: Record<string, string>; holdAccount?: Promise<void> } = {}) {
  const clock = mock.clock(on)
  if (kept) {
    // a store already holding what an earlier run of this mod wrote
    on('store.get', async (_: unknown, e: any) => (await onGet?.(e.key), { value: kept.get(e.key) }))
    on('store.set', (_: unknown, e: any) => (kept.set(e.key, e.value), { value: undefined }))
    on('store.delete', (_: unknown, e: any) => (kept.delete(e.key), { value: undefined }))
    on('store.keys', () => ({ value: [...kept.keys()] }))
  } else mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/Users/T' })
  const seen = { compacts: 0, submits: [] as string[], asks: 0, toasts: [] as string[], failCompact: false, duringCompact: null as null | (() => Promise<unknown>) }
  on('session.id', () => ({ value: 'sid-test' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.surface', () => ({ value: 'terminal' }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] }))
  const isRecording = (e: any) => !!seat.recording && String(e.path ?? e).includes('recording')
  on('fs.exists', (_: unknown, e: any) => ({ value: String(e.path ?? e).includes('.active') || isRecording(e) }))
  const named = (e: any) => String(e.path ?? e).split('/').pop()!
  on('fs.read', async (_: unknown, e: any) => {
    if (named(e) === '.claude.json') await disk.holdAccount
    const file = disk.files?.[named(e)]
    return { value: file ?? (isRecording(e) ? seat.recording : seat.label) }
  })
  if (disk.files)
    on('fs.stat', (_: unknown, e: any) => {
      const file = disk.files?.[named(e)]
      if (file === undefined || named(e) === '.claude.json') throw new Error('no such file')
      return { value: { kind: 'file', size: file.length } }
    })
  on('command.run', async (_: unknown, e: any) => {
    if (e.command === 'compact') {
      seen.compacts++
      await seen.duringCompact?.()
      if (seen.failCompact) throw new Error('no room')
    }
    return { text: '' }
  })
  on('prompt.submit', (_: unknown, e: any) => {
    if (e.text === 'DROPME') return { drop: 'another guard' }
    if (e.text === 'SLOW') return clock.advance(40000).then(() => ({ text: e.text })) // a lower hook that takes 40 s to hand the message on
    if (e.origin?.kind === 'plugin') seen.submits.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.measure', () => ({ changed: [] }))
  on('ui.toast', (_: unknown, e: any) => (seen.toasts.push(JSON.stringify(e)), { value: undefined }))
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
  expect(borrowedLimits([{ seat: 'A', desktop: false, updatedAt: at, rateLimits: five(80, '2026-10-29T09:00:00Z') }], { seat: 'A', desktop: false }, at)).toEqual([])
  // a seated and an unseated session on one surface are not known to share an account
  const mixed = [{ seat: '', account: 'a@x', desktop: true, updatedAt: at, rateLimits: five(70, '2026-10-29T12:00:00Z') }, { seat: 'B', desktop: true, updatedAt: at, rateLimits: five(90, '2026-10-29T12:00:00Z') }]
  expect(borrowedLimits(mixed, { seat: 'A', account: 'a@x', desktop: true }, at)).toEqual([])
  expect(borrowedLimits(mixed.slice(1), { seat: '', account: 'a@x', desktop: true }, at)).toEqual([])
  expect(borrowedLimits(mixed, { seat: '', account: 'a@x', desktop: true }, at)[0].percentUsed).toBe(70)
  // with no seat on either side the accounts decide: another account, or one unknown on either side, borrows nothing
  expect(borrowedLimits(mixed, { seat: '', account: 'b@x', desktop: true }, at)).toEqual([])
  expect(borrowedLimits(mixed, { seat: '', account: '', desktop: true }, at)).toEqual([])
  expect(borrowedLimits(mixed, { seat: '', desktop: true }, at)).toEqual([])
  expect(borrowedLimits([{ ...mixed[0], account: undefined }], { seat: '', account: 'a@x', desktop: true }, at)).toEqual([])
  expect(borrowedLimits([{ ...mixed[0], account: undefined }], { seat: '', account: '', desktop: true }, at)).toEqual([])
  // the terminal's and the app's rotators name seats alone: the same name on another surface is not the same account
  const surfaces = [{ seat: 'A', desktop: true, updatedAt: at, rateLimits: five(60, '2026-10-29T12:00:00Z') }]
  expect(borrowedLimits(surfaces, { seat: 'A', desktop: false }, at)).toEqual([])
  expect(borrowedLimits(surfaces, { seat: 'A', desktop: true }, at)[0].percentUsed).toBe(60)
  // an API-key session's windows are not an account's
  const keyed = [{ seat: '', account: 'a@x', desktop: false, signedIn: false, updatedAt: at, rateLimits: five(30, '2026-10-29T12:00:00Z') }]
  expect(borrowedLimits(keyed, { seat: '', account: 'a@x', desktop: false }, at)).toEqual([])
  expect(borrowedLimits([{ ...keyed[0], signedIn: true }], { seat: '', account: 'a@x', desktop: false }, at)[0].percentUsed).toBe(30)
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

test('a throttle code beside "usage limit reached" is still spent usage', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: 'rate_limit_error: usage limit reached' })
  await clock.advance(70 * 60000)
  expect(seen.submits).toEqual(['Resume'])
})

test('an automatic message cancelled by one sent meanwhile says so once, even when the compaction failed', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  seen.failCompact = true
  on('classic.StopFailure', () => ({}))
  await start($, 300000, clock)
  const resetsAt = new Date(60000 + 30 * 60000).toISOString()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.duringCompact = () => $.prompt.submit({ text: 'hold on', origin: COMPOSER, wait: false } as never)
  await clock.advance(40 * 60000)
  expect(seen.submits).toEqual([])
  expect(seen.toasts.filter((t) => /Could not compact/.test(t))).toEqual([])
  expect(seen.toasts.filter((t) => /Compacted/.test(t))).toEqual([])
  expect(seen.toasts.filter((t) => /automatic one was not sent/.test(t)).length).toBe(1)
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
// A main-loop request (or a subagent's, with an agentId) starts and ends
async function mainStep($: any, agentId?: string) {
  const it = ($ as any).turn.step({ model: 'claude-opus-5-5', messages: [], ...(agentId ? { agentId } : {}) })
  if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
  else await it
}
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

test('a chat last answered on another seat, reopened by a new process, is cold and asks once', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'B' }, kept)
  answer(on, seen, 'Send anyway')
  await clock.advance(60000)
  // the chat's last request, 10 minutes ago: warm by the clock, but it ran on seat A and this process is on B
  kept.set('last:sid-test', { ctx: 300000, at: (await clock.now()) - 10 * 60000, model: 'claude-opus-5-5', seat: 'A', desktop: false })
  await clock.advance(10 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated since its last request \(now B\)/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
})

test('a chat last answered on this seat reopens warm, and its record names the seat', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'B' }, kept)
  answer(on, seen, 'Send anyway')
  const step = stepper($, on)
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: (await clock.now()) - 10 * 60000, model: 'claude-opus-5-5', seat: 'B', desktop: false })
  await clock.advance(10 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/account rotated/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(0)
  await step(usage({ cache_read_input_tokens: 300000 }))
  expect(kept.get('last:sid-test')).toMatchObject({ seat: 'B', desktop: false })
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
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } } // an account to key the reading by: a session with none shares nothing
  const { clock } = engine($, on, { label: 'A' }, kept, undefined, disk)
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  const fresh = { at: 999999999, next: 999999999 + 300000, fable: { percentUsed: 7 }, windows: [{ kind: 'five_hour', percentUsed: 5 }], why: 'ok' }
  on('http.fetch', () => {
    // another session lands its reading while this one's check is in flight
    kept.set('plan:account:a@x', fresh)
    return { value: { ok: false, status: 429, text: '', headers: { 'retry-after': '600' } } }
  })
  kept.set('plan:account:a@x', { at: 1, next: 2, fable: { percentUsed: 1 }, windows: [], why: 'ok' })
  await start($, 50000, clock)
  await clock.advance(70000)
  expect(kept.get('plan:account:a@x')).toEqual(fresh)
})

test('a seat change while the plan reading is being fetched leaves the old seat\'s figures out of the new one', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  let release = () => {}
  const gate = new Promise<void>((r) => (release = r))
  let pending = false
  const { clock } = engine($, on, seat, kept, async (key) => {
    if (key === 'plan:cli:A') {
      pending = true
      await gate // the old seat's reading is still being read when the rotator's wake-up lands
    }
  })
  kept.set('plan:cli:A', { at: 1, next: 2, fable: { percentUsed: 77 }, windows: [{ kind: 'five_hour', percentUsed: 66 }], why: 'ok' })
  await start($, 50000, clock)
  await clock.advance(10)
  expect(pending).toBe(true)
  seat.label = 'B'
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  release()
  await clock.advance(70000)
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/77|66/)
  expect(JSON.stringify(kept.get('plan:cli:B') ?? {})).not.toMatch(/77|66/)
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

// A reply record as the transcript holds it
const reply = (at: number, tokens: number) => JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: new Date(at).toISOString(), message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: tokens, output_tokens: 2 } } }) + '\n'
const account = (email: string) => JSON.stringify({ oauthAccount: { emailAddress: email } })

test('a reopened chat whose coldness has no date says it is cold, not that it went cold 0m ago', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock } = engine($, on, { label: 'B' }, kept)
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: (await clock.now()) - 10 * 60000, model: 'claude-opus-5-5', seat: 'A', desktop: false })
  await clock.advance(10 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(30 * 60000)
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/Cache is cold\. The next message/)
  expect(r.text).not.toMatch(/went cold/)
  expect(r.text).toMatch(/account rotated since its last request/)
})

test('a plan reading fetched for the old seat is dropped even while the new seat\'s account is still being read', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const disk: { holdAccount?: Promise<void> } = {}
  const { clock } = engine($, on, seat, kept, undefined, disk)
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  let releaseFetch = () => {}
  const fetchGate = new Promise<void>((r) => (releaseFetch = r))
  let fetching = false
  on('http.fetch', async () => {
    fetching = true
    await fetchGate
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ five_hour: { utilization: 66, resets_at: 9999999999 }, limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 77 }] }) } }
  })
  kept.set('plan:cli:A', { at: 1, next: 2, windows: [], why: 'ok' })
  await start($, 50000, clock)
  await clock.advance(10)
  expect(fetching).toBe(true)
  let releaseRead = () => {}
  disk.holdAccount = new Promise<void>((r) => (releaseRead = r)) // the rotation's account read waits
  seat.label = 'B'
  const sub = $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(10)
  releaseFetch() // the old seat's fetch lands while the new seat's account is being read
  await clock.advance(10)
  disk.holdAccount = undefined
  releaseRead()
  await sub
  await clock.advance(70000)
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/77|66/)
  expect(JSON.stringify(kept.get('plan:cli:B') ?? {})).not.toMatch(/77|66/)
})

test('a keep-warm ping, which never reaches the transcript, still dates the cache of a reopened chat', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: {} }
  const { clock, seen } = engine($, on, { label: 'A' }, kept, undefined, disk)
  answer(on, seen, 'Send anyway')
  await clock.advance(60000)
  const replied = await clock.now()
  await clock.advance(3 * 60 * 60000) // the transcript's last reply is 3 hours old
  disk.files['sid-test.jsonl'] = reply(replied, 300000)
  // the last keep-warm ping, 10 minutes ago, on the same seat and at the same chat size
  kept.set('last:sid-test', { ctx: 300004, at: (await clock.now()) - 10 * 60000, model: 'claude-opus-5-5', seat: 'A', desktop: false })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/Cache is warm/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(0)
})

// Reopened in a terminal on CLI seat B, signed in as `email`; the record is from app seat X of a@
for (const [email, cold] of [['b@example.com', true], ['a@example.com', false]] as const) {
  test(`a chat last answered on an app seat, reopened on a CLI seat of ${cold ? 'another' : 'the same'} account, is ${cold ? 'cold' : 'warm'}`, SETUP, async ($, on) => {
    const kept = new Map<string, unknown>()
    const disk = { files: { '.claude.json': account(email) } }
    const { clock, seen } = engine($, on, { label: 'B' }, kept, undefined, disk)
    answer(on, seen, 'Send anyway')
    const step = stepper($, on)
    await clock.advance(60000)
    // seats of different surfaces are no comparison: the record's account decides
    kept.set('last:sid-test', { ctx: 300000, at: (await clock.now()) - 10 * 60000, model: 'claude-opus-5-5', seat: 'X', account: 'a@example.com', desktop: true })
    await clock.advance(10 * 60000)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const r: any = await $.command.run({ command: 'cache', args: '' })
    expect(/account rotated/.test(r.text)).toBe(cold)
    await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
    expect(seen.asks).toBe(cold ? 1 : 0)
    // the record of the request that lands now keeps the account beside the seat
    await step(usage({ cache_read_input_tokens: 300000 }))
    expect(kept.get('last:sid-test')).toMatchObject({ seat: 'B', account: email, desktop: false })
  })
}

test('a startup seed is deferred until the seat is read, then judged against the record', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: {} }
  const { clock, seen } = engine($, on, { label: 'B' }, kept, undefined, disk)
  answer(on, seen, 'Send anyway')
  on('classic.SessionStart', () => ({}))
  await clock.advance(60000)
  const at = (await clock.now()) - 5 * 60000
  disk.files['sid-test.jsonl'] = reply(at, 300000)
  kept.set('last:sid-test', { ctx: 300004, at, model: 'claude-opus-5-5', seat: 'A', desktop: false })
  // the startup handler seeds before session.start has read the seat
  await ($ as any).classic.SessionStart({ source: 'startup', transcript_path: '/h/sid-test.jsonl' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
})

test('a branch keeps its parent\'s pending "ran elsewhere" cold; a clear drops it', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock } = engine($, on, { label: 'B' }, kept)
  on('classic.SessionStart', () => ({}))
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: (await clock.now()) - 10 * 60000, model: 'claude-opus-5-5', seat: 'A', desktop: false })
  await clock.advance(10 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  let r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated/)
  kept.delete('last:sid-test') // the fork has a new id, so no record of its own
  await ($ as any).classic.SessionStart({ source: 'fork', transcript_path: '/h/other.jsonl' })
  r = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated/)
  await ($ as any).classic.SessionStart({ source: 'clear' })
  r = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/account rotated/)
})

test('a startup seed before the session starts still reads the chat\'s record: a keep-warm ping dates the cache', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: {} }
  const { clock, seen } = engine($, on, { label: 'A' }, kept, undefined, disk)
  answer(on, seen, 'Send anyway')
  on('classic.SessionStart', () => ({}))
  await clock.advance(60000)
  const replied = await clock.now()
  await clock.advance(3 * 60 * 60000)
  // the transcript's last reply is hours old; the record's `at` is a ping 10 minutes ago, on the same seat
  disk.files['sid-test.jsonl'] = reply(replied, 300000)
  kept.set('last:sid-test', { ctx: 300004, at: (await clock.now()) - 10 * 60000, model: 'claude-opus-5-5', seat: 'A', desktop: false })
  await ($ as any).classic.SessionStart({ source: 'startup', transcript_path: '/h/sid-test.jsonl' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/Cache is warm/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(0)
})

test('a resume whose record ran on the seat this process rotated to is warm, whatever the rotation time says', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const { clock, seen } = engine($, on, seat, kept)
  answer(on, seen, 'Send anyway')
  on('classic.SessionStart', () => ({}))
  await clock.advance(30 * 60000)
  await start($, 100000, clock)
  // chat X answered on seat B by another process 5 minutes before this one rotated to B
  const xAt = (await clock.now()) - 5 * 60000
  seat.label = 'B'
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: xAt, model: 'claude-opus-5-5', seat: 'B', desktop: false })
  await ($ as any).classic.SessionStart({ source: 'resume' })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/account rotated/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(0)
})

test('a resume of a chat that ran on another seat is not dated by an earlier rotation of this process', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const { clock } = engine($, on, seat, kept)
  const step = stepper($, on)
  on('classic.SessionStart', () => ({}))
  await start($, 100000, clock)
  seat.label = 'B'
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await step(usage({ cache_read_input_tokens: 100000 }))
  await clock.advance(5 * 60 * 60000)
  kept.set('last:sid-test', { ctx: 300000, at: (await clock.now()) - 2 * 60000, model: 'claude-opus-5-5', seat: 'C', desktop: false })
  await ($ as any).classic.SessionStart({ source: 'resume' })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated.* since its last request/)
  expect(r.text).not.toMatch(/5h/)
})

test('a branch of a chat kept warm by pings stays warm: it shares its parent\'s cache', async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: {} }
  const { clock, seen } = engine($, on, { label: 'A' }, kept, undefined, disk)
  answer(on, seen, 'Send anyway')
  on('classic.SessionStart', () => ({}))
  on('model.fork', () => ({ value: { text: 'ok', usage: usage({ cache_read_input_tokens: 300000 }) } }))
  const step = stepper($, on)
  await start($, 300000, clock)
  await step(usage({ cache_read_input_tokens: 300000 }))
  const replied = await clock.now()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'end_turn' } as never)
  // keep warm pings the parent for hours: the transcript's last reply is far older than the cache
  await clock.advance(3 * 60 * 60000)
  let r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/Keep warm is on/)
  disk.files['fork.jsonl'] = reply(replied, 300000)
  kept.delete('last:sid-test') // the branch has a new id, so no record of its own
  await ($ as any).classic.SessionStart({ source: 'fork', transcript_path: '/h/fork.jsonl' })
  r = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/Cache is warm/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(0)
})

test('a resume that arrives before the session starts is judged once the seat is read', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: {} }
  const { clock, seen } = engine($, on, { label: 'A' }, kept, undefined, disk)
  answer(on, seen, 'Send anyway')
  on('classic.SessionStart', () => ({}))
  await clock.advance(60000)
  disk.files['sid-test.jsonl'] = reply(await clock.now(), 300000)
  kept.set('last:sid-test', { ctx: 300004, at: await clock.now(), model: 'claude-opus-5-5', seat: 'B', desktop: false })
  await clock.advance(5 * 60000)
  await ($ as any).classic.SessionStart({ source: 'resume', transcript_path: '/h/sid-test.jsonl' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
})

test('a wake-up with no seat file reads the account again: a resumed chat\'s record of the old account is cold', { options: { rotatorWakePattern: String.raw`account was rotated` } }, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, kept, undefined, disk)
  answer(on, seen, 'Send anyway')
  on('classic.SessionStart', () => ({}))
  const step = stepper($, on)
  await clock.advance(60000)
  const xAt = await clock.now()
  await clock.advance(10 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: 100000, window: 1000000, percent: 10 }, rateLimits: [], changed: [] } as never)
  // the rotator moved the signed-in account, and woke the session
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await step(usage({ cache_read_input_tokens: 100000 }))
  await clock.advance(60000)
  // chat X last answered on the old account before the rotation
  kept.set('last:sid-test', { ctx: 300000, at: xAt, model: 'claude-opus-5-5', account: 'a@x', desktop: false })
  await ($ as any).classic.SessionStart({ source: 'resume' })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
})

test('a wake-up whose account file could not be read leaves a record compared by account undecided, so the rotation dates it', { options: { rotatorWakePattern: String.raw`account was rotated` } }, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, kept, undefined, disk)
  answer(on, seen, 'Send anyway')
  on('classic.SessionStart', () => ({}))
  const step = stepper($, on)
  await clock.advance(60000)
  const xAt = await clock.now()
  await clock.advance(10 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: 100000, window: 1000000, percent: 10 }, rateLimits: [], changed: [] } as never)
  await clock.advance(60000)
  delete disk.files['.claude.json']
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await step(usage({ cache_read_input_tokens: 100000 }))
  await clock.advance(60000)
  disk.files['x.jsonl'] = reply(xAt, 300000)
  kept.set('last:sid-test', { ctx: 300000, at: xAt, model: 'claude-opus-5-5', account: 'a@x', desktop: false })
  await ($ as any).classic.SessionStart({ source: 'resume', transcript_path: '/h/x.jsonl' })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated.* 1m ago/)
})

// A rotation this process saw outlives a /clear and a resume of a chat whose record cannot say
for (const source of ['clear', 'resume']) {
  test(`a rotation this process saw still dates a chat resumed after a ${source}`, SETUP, async ($, on) => {
    const kept = new Map<string, unknown>()
    const seat = { label: 'A' }
    const disk: { files: Record<string, string> } = { files: {} }
    const { clock, seen } = engine($, on, seat, kept, undefined, disk)
    answer(on, seen, 'Send anyway')
    on('classic.SessionStart', () => ({}))
    const step = stepper($, on)
    await start($, 100000, clock)
    const xAt = await clock.now()
    disk.files['x.jsonl'] = reply(xAt, 300000)
    await clock.advance(10 * 60000)
    seat.label = 'B'
    await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
    await step(usage({ cache_read_input_tokens: 100000 }))
    await clock.advance(60000)
    // neither chat has a record of its own
    for (const k of [...kept.keys()]) if (k.startsWith('last:')) kept.delete(k)
    await ($ as any).classic.SessionStart({ source })
    for (const k of [...kept.keys()]) if (k.startsWith('last:')) kept.delete(k)
    await ($ as any).classic.SessionStart({ source: 'resume', transcript_path: '/h/x.jsonl' })
    const r: any = await $.command.run({ command: 'cache', args: '' })
    expect(r.text).toMatch(/account rotated.* 1m ago/)
    await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
    expect(seen.asks).toBe(1)
  })
}

const WAKE = { options: { rotatorWakePattern: String.raw`account was rotated` } }

// The rotator woke the session but has not rewritten the account file yet: a re-read gives the old account
test('a wake-up whose re-read shows the old account leaves the identity unknown: a resumed chat of that account is cold', WAKE, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, kept, undefined, disk)
  answer(on, seen, 'Send anyway')
  on('classic.SessionStart', () => ({}))
  const step = stepper($, on)
  await clock.advance(60000)
  const xAt = await clock.now()
  await clock.advance(10 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: 100000, window: 1000000, percent: 10 }, rateLimits: [], changed: [] } as never)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await step(usage({ cache_read_input_tokens: 100000 }))
  await clock.advance(1000)
  kept.set('last:sid-test', { ctx: 300000, at: xAt, model: 'claude-opus-5-5', account: 'a@x', desktop: false })
  await ($ as any).classic.SessionStart({ source: 'resume' })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
})

test('a wake-up whose seat file is unchanged leaves the identity unknown: a resumed chat of that seat is cold', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, 'Send anyway')
  on('classic.SessionStart', () => ({}))
  const step = stepper($, on)
  await clock.advance(30 * 60000)
  await start($, 100000, clock)
  const xAt = (await clock.now()) - 5 * 60000
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await step(usage({ cache_read_input_tokens: 100000 }))
  await clock.advance(1000)
  kept.set('last:sid-test', { ctx: 300000, at: xAt, model: 'claude-opus-5-5', seat: 'A', desktop: false })
  await ($ as any).classic.SessionStart({ source: 'resume' })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
})

test('a record written while the identity is unknown names neither seat nor account', WAKE, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock } = engine($, on, { label: 'A' }, kept, undefined, disk)
  const step = stepper($, on)
  await start($, 100000, clock)
  await step(usage({ cache_read_input_tokens: 100000 }))
  expect((kept.get('last:sid-test') as any).account).toBe('a@x')
  await clock.advance(60000)
  delete disk.files['.claude.json']
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await step(usage({ cache_read_input_tokens: 100000 }))
  const rec = kept.get('last:sid-test') as any
  expect(rec.account).toBeUndefined()
  expect(rec.seat).toBeUndefined()
  expect(rec.desktop).toBe(false)
})

test('a later tick that finds the account file rewritten makes the identity known again', WAKE, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, kept, undefined, disk)
  answer(on, seen, 'Send anyway')
  on('classic.SessionStart', () => ({}))
  const step = stepper($, on)
  await start($, 100000, clock)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await step(usage({ cache_read_input_tokens: 100000 }))
  await clock.advance(60000)
  disk.files['.claude.json'] = account('b@x') // the rotator wrote it at last
  await clock.advance(60000)
  const xAt = (await clock.now()) - 5 * 60000
  kept.set('last:sid-test', { ctx: 300000, at: xAt, model: 'claude-opus-5-5', account: 'b@x', desktop: false })
  await ($ as any).classic.SessionStart({ source: 'resume' })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/account rotated/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(0)
})

test('a later tick that finds the seat file rewritten adopts the seat without dating a second rotation', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const { clock, seen } = engine($, on, seat, kept)
  answer(on, seen, 'Send anyway')
  on('classic.SessionStart', () => ({}))
  await start($, 100000, clock)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // no request lands yet
  await clock.advance(60000)
  seat.label = 'B'
  await clock.advance(60000)
  let r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated 2m ago \(now B\)/)
  // the identity is known again: a record of seat B, written after the wake-up, is the new account's cache
  kept.set('last:sid-test', { ctx: 300000, at: (await clock.now()) - 30000, model: 'claude-opus-5-5', seat: 'B', desktop: false })
  await ($ as any).classic.SessionStart({ source: 'resume' })
  r = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/account rotated/)
})

test('a keep-warm ping after a rotation this process saw keeps the resumed chat warm', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const disk: { files: Record<string, string> } = { files: {} }
  const { clock, seen } = engine($, on, seat, kept, undefined, disk)
  answer(on, seen, 'Send anyway')
  on('classic.SessionStart', () => ({}))
  const step = stepper($, on)
  await start($, 100000, clock)
  const xAt = await clock.now()
  disk.files['x.jsonl'] = reply(xAt, 300000)
  await clock.advance(10 * 60000)
  seat.label = 'B'
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await step(usage({ cache_read_input_tokens: 100000 }))
  await clock.advance(10 * 60000)
  // the chat's last ping, after the rotation, from a process that kept no seat or account
  for (const k of [...kept.keys()]) if (k.startsWith('last:')) kept.delete(k)
  kept.set('last:sid-test', { ctx: 300004, at: (await clock.now()) - 60000, model: 'claude-opus-5-5' })
  await ($ as any).classic.SessionStart({ source: 'resume', transcript_path: '/h/x.jsonl' })
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/Cache is warm/)
  expect(r.text).not.toMatch(/account rotated/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(0)
})

test('a second wake-up of an already rotated chat dates the rotation anew', WAKE, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  await start($, 100000, clock)
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(10 * 60000)
  disk.files['.claude.json'] = account('c@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(60000)
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated 1m ago/)
})

// The rotator writes .claude.json and the seat file separately: each is taken on its own for a few minutes after the wake-up
test('the account rewritten before the seat file: the seat is still adopted a minute later', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock } = engine($, on, seat, kept, undefined, disk)
  const step = stepper($, on)
  await start($, 100000, clock)
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(60000)
  seat.label = 'B'
  await clock.advance(60000)
  await step(usage({ cache_read_input_tokens: 100000 }))
  const rec = kept.get('last:sid-test') as any
  expect(rec.seat).toBe('B')
  expect(rec.account).toBe('b@x')
})

test('the seat file rewritten before the account: the account is still adopted a minute later', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock } = engine($, on, seat, kept, undefined, disk)
  const step = stepper($, on)
  await start($, 100000, clock)
  seat.label = 'B'
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(60000)
  disk.files['.claude.json'] = account('b@x')
  await clock.advance(60000)
  await step(usage({ cache_read_input_tokens: 100000 }))
  const rec = kept.get('last:sid-test') as any
  expect(rec.seat).toBe('B')
  expect(rec.account).toBe('b@x')
})

test('a wake-up that showed no change leaves the identity unknown only for the window: later records carry seat and account', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('b@x') } }
  const { clock } = engine($, on, { label: 'B' }, kept, undefined, disk)
  const step = stepper($, on)
  await start($, 100000, clock)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await step(usage({ cache_read_input_tokens: 100000 }))
  let rec = kept.get('last:sid-test') as any
  expect(rec.seat).toBeUndefined() // still unknown inside the window
  expect(rec.account).toBeUndefined()
  await clock.advance(6 * 60 * 60000)
  await step(usage({ cache_read_input_tokens: 100000 }))
  rec = kept.get('last:sid-test') as any
  expect(rec.seat).toBe('B')
  expect(rec.account).toBe('b@x')
})

test('a rotation meant for other sessions, hours after a no-change wake-up and with no new wake-up, is not adopted', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'B' }
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('b@x') } }
  const { clock } = engine($, on, seat, kept, undefined, disk)
  const step = stepper($, on)
  await start($, 100000, clock)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // nothing changed
  await step(usage({ cache_read_input_tokens: 100000 }))
  await clock.advance(3 * 60 * 60000)
  seat.label = 'C'
  disk.files['.claude.json'] = account('c@x')
  await clock.advance(60000)
  await step(usage({ cache_read_input_tokens: 100000 }))
  const rec = kept.get('last:sid-test') as any
  expect(rec.seat).toBe('B')
  expect(rec.account).toBe('b@x')
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/now C/)
})

test('a seat adopted after a request landed since the wake-up marks the cache cold when the wake-up showed no change', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const { clock, seen } = engine($, on, seat, kept)
  answer(on, seen, 'Send anyway')
  const step = stepper($, on)
  await start($, 300000, clock)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // the seat file is not written yet
  await clock.advance(1000)
  await step(usage({ cache_read_input_tokens: 300000 })) // the wake-up's request lands, perhaps on the old account
  await clock.advance(60000)
  seat.label = 'B'
  await clock.advance(60000)
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated 1m ago \(now B\)/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
})

test('while the seat is unknown after a wake-up, the old seat gets no new plan reading and the heartbeat offers no windows', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock } = engine($, on, seat, kept, undefined, disk)
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  let fetches = 0
  on('http.fetch', () => {
    fetches++
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ five_hour: { utilization: 88, resets_at: 9999999999 }, limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 88 }] }) } }
  })
  await clock.advance(60000)
  const t0 = await clock.now()
  const reading = { at: t0, next: t0 + 5 * 60000, fable: { percentUsed: 11 }, windows: [], why: 'ok' }
  kept.set('plan:cli:A', reading)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: 100000, window: 1000000, percent: 10 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2099-01-01T00:00:00Z' }], changed: [] } as never)
  await clock.advance(30000)
  expect((kept.get('hb:sid-test') as any).rateLimits.length).toBe(1) // known seat: its own reading is offered
  await clock.advance(3.5 * 60000)
  const before = fetches
  disk.files['.claude.json'] = account('b@x') // the account moved; the seat file is not written yet
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(90000) // inside the window, and A's plan slot comes due
  expect(fetches).toBe(before)
  expect(kept.get('plan:cli:A')).toEqual(reading)
  expect((kept.get('hb:sid-test') as any).rateLimits).toEqual([])
  seat.label = 'B'
  await clock.advance(30000) // the seat is known now: the first tick reads B's plan
  expect(fetches).toBeGreaterThan(before)
  expect(kept.get('plan:cli:A')).toEqual(reading)
})

test('an account read with no account inside the window is not a change: the real account is taken when it arrives', WAKE, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock } = engine($, on, { label: 'A' }, kept, undefined, disk)
  const step = stepper($, on)
  await start($, 100000, clock)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  disk.files['.claude.json'] = '{}' // mid-rotation: signed out
  await clock.advance(30000)
  disk.files['.claude.json'] = account('b@x')
  await clock.advance(60000)
  await clock.advance(10 * 60000)
  await step(usage({ cache_read_input_tokens: 100000 }))
  expect((kept.get('last:sid-test') as any).account).toBe('b@x')
})

test('a wake-up that already showed the seat changed is not marked cold again when the account arrives late', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, seat, kept, undefined, disk)
  answer(on, seen, 'Send anyway')
  const step = stepper($, on)
  await start($, 300000, clock)
  seat.label = 'B'
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(1000)
  await step(usage({ cache_creation_input_tokens: 300000 })) // the wake-up's request ran on the new account
  await clock.advance(30000)
  disk.files['.claude.json'] = account('b@x')
  await clock.advance(30000)
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/account rotated/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(0)
})

test('a request right after the window closes, before any tick sees it close, already carries seat and account', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('b@x') } }
  const { clock } = engine($, on, { label: 'B' }, kept, undefined, disk)
  const step = stepper($, on)
  await start($, 100000, clock) // ticks fall 30s apart from the start
  await clock.advance(1000) // the wake-up is off the tick grid: its window ends 1s after a tick
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // no change
  await clock.advance(180000) // the last tick inside the window ran at +179s; the next is 29s off
  await clock.advance(1500) // past the window's end, no tick since
  await step(usage({ cache_read_input_tokens: 100000 }))
  const rec = kept.get('last:sid-test') as any
  expect(rec.seat).toBe('B')
  expect(rec.account).toBe('b@x')
})

test('an account adopted late re-marks the cache cold even after a late seat: the label may be written before the credential switches', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, seat, kept, undefined, disk)
  answer(on, seen, 'Send anyway')
  const step = stepper($, on)
  await start($, 300000, clock)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // nothing written yet
  await clock.advance(1000)
  await step(usage({ cache_read_input_tokens: 300000 })) // the wake-up's request lands, perhaps on the old account
  await clock.advance(30000)
  seat.label = 'B'
  await clock.advance(30000) // the seat is adopted: the cache is cold
  let r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
  await step(usage({ cache_creation_input_tokens: 300000 })) // the credential may not have switched yet: this request may have run on the old account
  await clock.advance(30000)
  disk.files['.claude.json'] = account('b@x')
  await clock.advance(30000) // the account is adopted: the cache is cold again
  r = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated/)
  await $.prompt.submit({ text: 'and again', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(2)
})

test('a seat adopted late after the account was already adopted does not re-mark the cache cold: that request ran on the new account', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, seat, kept, undefined, disk)
  answer(on, seen, 'Send anyway')
  const step = stepper($, on)
  await start($, 300000, clock)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // nothing written yet
  await clock.advance(1000)
  await step(usage({ cache_read_input_tokens: 300000 })) // the wake-up's request lands, perhaps on the old account
  await clock.advance(30000)
  disk.files['.claude.json'] = account('b@x')
  await clock.advance(30000) // the account is adopted: the cache is cold
  let r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/account rotated/)
  await $.prompt.submit({ text: 'carry on', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
  await step(usage({ cache_creation_input_tokens: 300000 })) // that request ran on the new account: the cache is warm
  await clock.advance(30000)
  seat.label = 'B'
  await clock.advance(30000) // the seat is adopted, but it is the same rotation
  r = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/account rotated/)
  await $.prompt.submit({ text: 'and again', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
})

// A plan fetch started before a wake-up is the old account's reading, though the seat file may not show it yet
function planFetchHeld($: any, on: any, kept: Map<string, unknown>, disk: { files: Record<string, string> }) {
  const held = { release: () => {}, hold: false, fetches: 0 }
  const seat = { label: 'A' }
  const { clock } = engine($, on, seat, kept, undefined, disk)
  kept.set('plan:cli:A', { at: 1, next: 2, windows: [], why: 'ok' }) // a reading long past due
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  on('http.fetch', async () => {
    held.fetches++
    if (held.hold) await new Promise<void>((r) => (held.release = r))
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ five_hour: { utilization: held.hold ? 55 : 7, resets_at: 9999999999 } }) } }
  })
  return { held, clock }
}

test('a plan fetch still out when the wake-up comes is dropped, though only .claude.json showed the rotation', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { held, clock } = planFetchHeld($, on, kept, disk)
  await clock.advance(60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(31000) // the first tick reads the plan
  const first = kept.get('plan:cli:A') as any
  expect(first.windows[0].percentUsed).toBe(7)
  held.hold = true
  await clock.advance(5 * 60000) // a tick fetches, and the fetch is held
  expect(held.fetches).toBe(2)
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // the seat file is not written yet
  held.release()
  await clock.advance(10)
  expect((kept.get('plan:cli:A') as any).at).toBe(first.at)
  expect((kept.get('plan:cli:A') as any).windows[0].percentUsed).toBe(7)
})

test('a plan fetch still out across a wake-up is dropped even when it returns after the window has closed', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { held, clock } = planFetchHeld($, on, kept, disk)
  await clock.advance(60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(31000) // the first tick reads the plan
  const first = kept.get('plan:cli:A') as any
  held.hold = true
  await clock.advance(5 * 60000)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // nothing written
  await clock.advance(4 * 60000) // the window has closed: the seat is not unknown any more
  held.release()
  await clock.advance(10)
  expect((kept.get('plan:cli:A') as any).at).toBe(first.at)
})

// The shared plan reading is the seat's: while the seat is unknown it may be the old account's
const RESUME = { options: { ...SETUP.options, autoResume: true } }
const fullWeek = (at: number) => [{ kind: 'seven_day', percentUsed: 100, resetsAt: new Date(at + 30 * 60000).toISOString() }]

test('while the seat is unknown after a wake-up, the old seat\'s full weekly window arms no resume', RESUME, async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  on('classic.StopFailure', () => ({}))
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  await clock.advance(60000)
  const t0 = await clock.now()
  kept.set('plan:cli:A', { at: t0, next: t0 + 60 * 60000, fable: null, windows: fullWeek(t0), why: 'ok' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(30000) // the tick takes the stored reading
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // the seat file still names A
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: 'Too many requests, slow down' })
  await clock.advance(60 * 60000)
  expect(seen.submits).toEqual([])
})

test('a wake-up that already shows a new account drops the shared windows, which are the old account\'s', { options: { rotatorWakePattern: WAKE.options.rotatorWakePattern, autoResume: true } }, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, kept, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  await clock.advance(60000)
  const t0 = await clock.now()
  kept.set('plan:account:a@x', { at: t0, next: t0 + 60 * 60000, fable: null, windows: fullWeek(t0), why: 'ok' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(30000)
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: 'Too many requests, slow down' })
  await clock.advance(60 * 60000)
  expect(seen.submits).toEqual([])
})

test('an account adopted after the wake-up drops the shared windows, which are the old account\'s', { options: { rotatorWakePattern: WAKE.options.rotatorWakePattern, autoResume: true } }, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, kept, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  await clock.advance(60000)
  const t0 = await clock.now()
  kept.set('plan:account:a@x', { at: t0, next: t0 + 60 * 60000, fable: null, windows: fullWeek(t0), why: 'ok' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(30000)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  disk.files['.claude.json'] = account('b@x')
  await clock.advance(30000)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: 'Too many requests, slow down' })
  await clock.advance(60 * 60000)
  expect(seen.submits).toEqual([])
})

test('with no seat file, no plan reading is fetched while the account is unknown after a wake-up', WAKE, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock } = engine($, on, { label: 'A' }, kept, undefined, disk)
  kept.set('plan:account:a@x', { at: 1, next: 2, windows: [], why: 'ok' }) // a reading long past due
  let fetches = 0
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  on('http.fetch', async () => {
    fetches++
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ five_hour: { utilization: 7, resets_at: 9999999999 } }) } }
  })
  await clock.advance(60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(31000) // the first tick reads the plan under the account's key
  expect((kept.get('plan:account:a@x') as any).windows[0].percentUsed).toBe(7)
  await clock.advance(3 * 60000)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // .claude.json not rewritten yet
  const before = fetches
  await clock.advance(2 * 60000 + 50000) // the reading falls due inside the window: its key may name the old account
  expect(fetches).toBe(before)
  disk.files['.claude.json'] = account('b@x')
  await clock.advance(30000) // the new account is adopted and read under its own key
  expect(fetches).toBeGreaterThan(before)
  expect(kept.get('plan:account:b@x')).toBeTruthy()
})

// No seat file: the readings are the signed-in account's, which .claude.json names
const RESUME_WAKE = { options: { rotatorWakePattern: WAKE.options.rotatorWakePattern, autoResume: true } }
const throttle = { error: 'rate_limit', error_details: 'Too many requests, slow down' }
const fiveFull = (at: number) => [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(at + 2 * 60 * 60000).toISOString() }]

test('with no seat file, the old account\'s full week arms no resume while the account is unknown, nor once the new account is adopted', RESUME_WAKE, async ($, on) => {
  const kept = new Map<string, unknown>()
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, kept, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  await clock.advance(60000)
  const t0 = await clock.now()
  kept.set('plan:account:a@x', { at: t0, next: t0 + 60 * 60000, fable: null, windows: fullWeek(t0), why: 'ok' })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(30000) // the tick takes the stored reading
  expect((kept.get('hb:sid-test') as any).account).toBe('a@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // .claude.json not rewritten yet
  await ($ as any).classic.StopFailure(throttle)
  expect(seen.toasts.some((t) => /resumes on its own/.test(t))).toBe(false) // nothing is armed from the old account's week
  await clock.advance(30000)
  expect((kept.get('hb:sid-test') as any).account).toBeUndefined() // the account is unknown: it names no one's windows
  disk.files['.claude.json'] = account('b@x')
  await clock.advance(30000)
  expect((kept.get('hb:sid-test') as any).account).toBe('b@x')
  await ($ as any).classic.StopFailure(throttle) // the old week is gone: the new account has no full window to arm from
  expect(seen.toasts.some((t) => /resumes on its own/.test(t))).toBe(false)
  await clock.advance(60 * 60000)
  expect(seen.submits).toEqual([])
})

test('a resume armed from the old account\'s own windows while the account is unknown is re-armed for a minute after the new account is adopted', RESUME_WAKE, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // .claude.json not rewritten yet
  await mainStep($) // the wake-up's own request starts, on the old account
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" }) // armed from the old account's window
  disk.files['.claude.json'] = account('b@x')
  await clock.advance(30000) // adopted: the resume moves to a minute from now
  await clock.advance(30000)
  expect(seen.submits).toEqual([]) // not at the old window's reset, hours off, and not yet the minute
  await clock.advance(40000)
  expect(seen.submits).toEqual(['Resume'])
  await clock.advance(3 * 60 * 60000)
  expect(seen.submits).toEqual(['Resume']) // once
})

test('a wake-up that already shows a new account drops the old account\'s own 5h window: no resume, and /cache does not show it', RESUME_WAKE, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/5h 100%/)
  await ($ as any).classic.StopFailure(throttle)
  await clock.advance(3 * 60 * 60000)
  expect(seen.submits).toEqual([])
})

test('an account adopted after the wake-up drops the old account\'s own 5h window too', RESUME_WAKE, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  disk.files['.claude.json'] = account('b@x')
  await clock.advance(30000)
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/5h 100%/)
  await ($ as any).classic.StopFailure(throttle)
  await clock.advance(3 * 60 * 60000)
  expect(seen.submits).toEqual([])
})

test('a request that started before an account change reports the old account\'s windows: neither session.measure nor turn.complete takes them', RESUME_WAKE, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  let t0 = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  on('turn.step', async function* () {
    await gate
    return { answer: '', toolUses: [], usage: null }
  })
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => ({ value: { rateLimits: fiveFull(t0) } }))
  await start($, 50000, clock)
  t0 = await clock.now()
  const step = async () => {
    const it = ($ as any).turn.step({ model: 'claude-opus-5-5', messages: [] })
    if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
    else await it
  }
  const request = step()
  await clock.advance(10) // the request is out
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // the account moves while it runs
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  release()
  await request
  let r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/5h 100%/)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'end_turn' } as never)
  r = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/5h 100%/)
  // a request that starts after the change reports the new account's
  await step()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  r = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/5h 100%/)
})

// Signed in, but no seat file and no account in .claude.json: the bare 'plan' key would be shared by such sessions, whatever their accounts
const fableBody = (pct: number) => JSON.stringify({ five_hour: { utilization: 7, resets_at: 9999999999 }, limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: pct }] })

test('a signed-in session with neither seat nor account does not take the bare plan reading, and lends no windows', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock } = engine($, on, { label: 'A' }, kept)
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  await clock.advance(60000)
  const t0 = await clock.now()
  const shared = { at: t0, next: t0 + 60 * 60000, fable: { percentUsed: 77, resetsAt: '2099-01-01T00:00:00Z' }, windows: [], why: 'ok' }
  kept.set('plan', shared)
  kept.set('hb:other', { ...otherHb('a@x', t0), account: undefined })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: 100000, window: 1000000, percent: 10 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2099-01-01T00:00:00Z' }], changed: [] } as never)
  await clock.advance(31000) // the tick checks the sign-in and the plan
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/77%/)
  expect(kept.get('plan')).toEqual(shared)
  expect((kept.get('hb:sid-test') as any).signedIn).toBe(true)
  expect((kept.get('hb:sid-test') as any).rateLimits).toEqual([])
})

test('a signed-in session with neither seat nor account fetches for itself and writes nothing to the bare plan key', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock } = engine($, on, { label: 'A' }, kept)
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  let fetches = 0
  on('http.fetch', () => (fetches++, { value: { ok: true, status: 200, headers: {}, text: fableBody(20) } }))
  await clock.advance(10 * 60000)
  const stale = { at: 1, next: 2, fable: { percentUsed: 77, resetsAt: '2099-01-01T00:00:00Z' }, windows: [], why: 'ok' }
  kept.set('plan', stale) // long past due, and another account's
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(31000)
  expect(fetches).toBe(1)
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).toMatch(/Fable weekly: 20% used/)
  expect(kept.get('plan')).toEqual(stale)
  await clock.advance(2 * 60000)
  expect(fetches).toBe(1) // its own planNext holds the next fetch back, with nothing in the store to do it
})

// Two unseated sessions on one surface: another session's heartbeat in the store
const otherHb = (account: string | undefined, at: number) => ({ id: 'other', label: 'other', desktop: false, signedIn: true, seat: '', ...(account ? { account } : {}), updatedAt: at, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(at + 30 * 60000).toISOString() }] })

for (const [theirs, borrows] of [['b@x', false], ['a@x', true], [undefined, false]] as const) {
  test(`with no seat file, a session on a@x ${borrows ? 'borrows' : 'does not borrow'} the windows of one on ${theirs ?? 'an unknown account'}`, { options: { autoResume: true } }, async ($, on) => {
    const kept = new Map<string, unknown>()
    const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
    const { clock, seen } = engine($, on, { label: 'A' }, kept, undefined, disk)
    on('classic.StopFailure', () => ({}))
    await start($, 50000, clock)
    kept.set('hb:other', otherHb(theirs, await clock.now()))
    await clock.advance(30000) // the tick reads the fleet
    await ($ as any).classic.StopFailure(throttle)
    await clock.advance(40 * 60000)
    expect(seen.submits).toEqual(borrows ? ['Resume'] : [])
  })
}

test('a seat file naming a new seat at the wake-up, with .claude.json unchanged, holds the plan fetch until the account is adopted', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock } = engine($, on, seat, kept, undefined, disk)
  kept.set('plan:cli:A', { at: 1, next: 2, windows: [], why: 'ok' }) // a reading long past due
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  let fetches = 0
  on('http.fetch', () => (fetches++, { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ five_hour: { utilization: 7, resets_at: 9999999999 } }) } }))
  await clock.advance(60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(31000) // the first tick reads A's plan
  expect(kept.get('plan:cli:A')).toBeTruthy()
  await clock.advance(3 * 60000)
  seat.label = 'B' // the seat is written, the credential may not have switched
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  const before = fetches
  await clock.advance(90000)
  expect(fetches).toBe(before)
  expect(kept.get('plan:cli:B')).toBeUndefined()
  disk.files['.claude.json'] = account('b@x')
  await clock.advance(30000)
  expect(fetches).toBeGreaterThan(before)
  expect(kept.get('plan:cli:B')).toBeTruthy()
})

test('a seat file naming a new seat at the wake-up, with .claude.json unchanged, takes the plan fetch once the window closes', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: 'A' }
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock } = engine($, on, seat, kept, undefined, disk)
  kept.set('plan:cli:A', { at: 1, next: 2, windows: [], why: 'ok' }) // a reading long past due
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  let fetches = 0
  on('http.fetch', () => (fetches++, { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ five_hour: { utilization: 7, resets_at: 9999999999 } }) } }))
  await clock.advance(60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(31000)
  await clock.advance(3 * 60000)
  seat.label = 'B'
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  const before = fetches
  await clock.advance(2 * 60000)
  expect(fetches).toBe(before)
  await clock.advance(90000) // the window is over: the account stands as it is
  expect(fetches).toBeGreaterThan(before)
  expect(kept.get('plan:cli:B')).toBeTruthy()
})

test('a seat that appears at the wake-up, where the session had none, drops the readings the session held', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const seat = { label: '' } // the seat file is empty when the session starts
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock } = engine($, on, seat, kept, undefined, disk)
  kept.set('plan:account:a@x', { at: 1, next: 2, windows: [], why: 'ok' }) // a reading long past due
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  let down = false
  on('http.fetch', () => ({ value: down ? { ok: false, status: 500, headers: {}, text: '' } : { ok: true, status: 200, headers: {}, text: JSON.stringify({ five_hour: { utilization: 61, resets_at: 9999999999 }, limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 61 }] }) } }))
  await clock.advance(60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: 100000, window: 1000000, percent: 10 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2099-01-01T00:00:00Z' }], changed: [] } as never)
  await clock.advance(31000) // the first tick reads the account's plan
  expect((kept.get('plan:account:a@x') as any).fable.percentUsed).toBe(61)
  down = true // B's own check fails, so only what the session held could fill its reading
  seat.label = 'B'
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(4 * 60000) // the window closes, and B's slot comes due
  const b = kept.get('plan:cli:B') as any
  expect(b).toBeTruthy()
  expect(b.windows).toEqual([])
  expect(b.fable ?? null).toBe(null)
  expect((kept.get('hb:sid-test') as any).rateLimits).toEqual([])
})

test('the wake-up is itself the resume: a resume armed before it is settled, and the account change it shows does not arm another', RESUME_WAKE, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, turnId: 't1', wait: false } as never) // the wake-up is itself the resume, queued behind a running turn
  await clock.advance(5 * 60000) // not re-armed for a minute from now meanwhile
  expect(seen.submits).toEqual([])
  await mainStep($) // the wake-up's turn starts: it settles the resume
  await clock.advance(3 * 60 * 60000)
  expect(seen.submits).toEqual([])
})

test('a resume the person settled by sending is not revived by a later account change', RESUME_WAKE, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await $.prompt.submit({ text: 'never mind', origin: COMPOSER, wait: false } as never)
  await mainStep($) // its request starts: that settles the resume
  await clock.advance(10 * 60000)
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(5 * 60000)
  expect(seen.submits).toEqual([])
})

test('a resume armed in the last chat does not come back into the cleared one on a later account change', RESUME_WAKE, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('classic.SessionStart', () => ({}))
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await ($ as any).classic.SessionStart({ source: 'clear' })
  await clock.advance(60000)
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(5 * 60000)
  expect(seen.submits).toEqual([])
})

test('a resume that already fired is not sent again by a later account change', RESUME_WAKE, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(2 * 60 * 60000 + 2 * 60000)
  expect(seen.submits).toEqual(['Resume'])
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(5 * 60000)
  expect(seen.submits).toEqual(['Resume'])
})

test('a resume re-armed by a late seat waits while the account is still unknown: nothing is sent until the window closes, then once', { options: { ...SETUP.options, autoResume: true } }, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x'), '.active': 'A' } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never) // nothing on disk changed: seat and account unknown
  await clock.advance(100) // the wake-up's own compaction and send
  await mainStep($) // its request starts, on the old account
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" }) // armed from the old windows
  seen.submits.length = 0
  seen.compacts = 0
  disk.files['.active'] = 'B'
  await clock.advance(30000) // the seat is adopted: the resume moves to a minute from now, the account still unknown
  await clock.advance(80000)
  expect({ compacts: seen.compacts, submits: seen.submits }).toEqual({ compacts: 0, submits: [] })
  await clock.advance(90000) // the window has closed
  expect(seen.submits).toEqual(['Resume'])
  await clock.advance(3 * 60 * 60000)
  expect(seen.submits).toEqual(['Resume'])
})

test('a usage failure of a request that started before an account change arms a resume for a minute from now and spends no try', RESUME_WAKE, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  let release: () => void = () => {}
  let gate = new Promise<void>((r) => (release = r))
  on('turn.step', async function* () {
    await gate
    return { answer: '', toolUses: [], usage: null }
  })
  await start($, 50000, clock)
  const step = async () => {
    const it = ($ as any).turn.step({ model: 'claude-opus-5-5', messages: [] })
    if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
    else await it
  }
  const old = step()
  await clock.advance(10) // the request is out on a@x
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, turnId: 't1', wait: false } as never) // the account moves while it runs; the wake-up queued over the turn is withdrawn, so no turn of its own follows
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" }) // a@x's cap, from the old request
  release()
  await old
  expect(seen.toasts.filter((t) => /resumes on its own/.test(t)).length).toBe(1)
  await clock.advance(30000)
  expect(seen.submits).toEqual([])
  await clock.advance(70000) // a minute on, but the wake-up's request has not started: the resume waits for the window
  expect(seen.submits).toEqual([])
  await clock.advance(120000) // the 3 minutes are over, and a tick on: not hours
  expect(seen.submits).toEqual(['Resume'])
  // no try was spent: the full three fallback tries remain, and only the fourth gives up
  gate = Promise.resolve()
  for (let i = 0; i < 3; i++) {
    await step() // a request that starts on b@x
    await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
    await clock.advance(61 * 60000)
    expect(seen.submits.length).toBe(2 + i)
  }
  await step()
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  expect(seen.toasts.some((t) => /Auto-resume gave up/.test(t))).toBe(true)
})

test('typing a local command while a resume is pending does not cancel it', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(60000)
  await $.prompt.submit({ text: '/cache', command: { name: 'cache', args: '' }, origin: COMPOSER, wait: false } as never) // runs locally: never reaches the chat
  await clock.advance(3 * 60 * 60000)
  expect(seen.submits).toEqual(['Resume'])
})

test('a send the cold-send guard cancels does not cancel a pending resume', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  answer(on, seen, 'Cancel')
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await mainStep($) // the last request, so the cache's age is known
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 90 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(70 * 60000) // the cache has gone cold
  await $.prompt.submit({ text: 'are we back?', origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
  expect(seen.toasts.filter((t) => /Not sent/.test(t)).length).toBe(1)
  await clock.advance(40 * 60000)
  expect(seen.submits.filter((t) => t === 'Resume').length + seen.compacts).toBeGreaterThan(0) // the resume still fires (on a big chat it compacts first)
})

test('a subagent request starting does not settle a pending resume, a main-loop one does', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await mainStep($, 'agent-1')
  await clock.advance(3 * 60 * 60000)
  expect(seen.submits).toEqual(['Resume'])
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await mainStep($)
  await clock.advance(3 * 60 * 60000)
  expect(seen.submits).toEqual(['Resume'])
})

test('a wake-up typed over a running request is delivered after it fails on the old account: its turn settles the resume, no Resume follows', RESUME_WAKE, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  on('turn.step', async function* () {
    await gate
    return { answer: '', toolUses: [], usage: null }
  })
  await start($, 50000, clock)
  const old = ($ as any).turn.step({ model: 'claude-opus-5-5', messages: [] })
  const draining = (async () => {
    if (old && typeof old[Symbol.asyncIterator] === 'function') for await (const _ of old) void _
    else await old
  })()
  await clock.advance(10)
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, turnId: 't1', wait: false } as never) // typed over the running turn: queued
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" }) // the old account's cap
  release()
  await draining
  await mainStep($) // the queued wake-up's own turn, on b@x
  await clock.advance(5 * 60000)
  expect(seen.submits).toEqual([])
})

test('a subagent request starting after an account change does not hide a stale main request\'s failure: the resume is a minute off and spends no try', RESUME_WAKE, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  on('turn.step', async function* (_: unknown, e: any) {
    if (!e.agentId) await gate
    return { answer: '', toolUses: [], usage: null }
  })
  await start($, 50000, clock)
  const drain = async (it: any) => {
    if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
    else await it
  }
  const old = drain(($ as any).turn.step({ model: 'claude-opus-5-5', messages: [] }))
  await clock.advance(10)
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, turnId: 't1', wait: false } as never) // the wake-up queued over the turn is withdrawn
  await drain(($ as any).turn.step({ model: 'claude-opus-5-5', messages: [], agentId: 'agent-1' })) // a subagent starts on b@x
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" }) // the main request's failure, on a@x
  release()
  await old
  await clock.advance(30000)
  expect(seen.submits).toEqual([])
  await clock.advance(70000) // a minute on, but the wake-up's request has not started: the resume waits for the window
  expect(seen.submits).toEqual([])
  await clock.advance(120000) // the 3 minutes are over, and a tick on: not an hour
  expect(seen.submits).toEqual(['Resume'])
})

test('a session with no seat or account whose first sign-in check threw neither shows nor overwrites the bare plan reading', async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock } = engine($, on, { label: 'A' }, kept)
  let calls = 0
  on('session.authorize', () => { calls++; if (calls === 1) throw new Error('transient'); return { value: { handle: 'h' } } })
  on('http.fetch', () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ five_hour: { utilization: 7, resets_at: 9999999999 }, limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, percent: 20 }] }) } }))
  await clock.advance(10 * 60000)
  const stale = { at: 1, next: 2, fable: { percentUsed: 77, resetsAt: '2099-01-01T00:00:00Z' }, windows: [], why: 'ok' }
  kept.set('plan', stale)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.advance(31000)
  expect(calls).toBeGreaterThanOrEqual(2) // the check was retried at the fetch
  expect(kept.get('plan')).toEqual(stale)
  const r: any = await $.command.run({ command: 'cache', args: '' })
  expect(r.text).not.toMatch(/77%/)
})


test('a wake-up queued behind a running request, showing a new seat and account (seat file), leaves no Resume besides it', RESUME, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const seat = { label: 'A' }
  const { clock, seen } = engine($, on, seat, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seat.label = 'B'
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, turnId: 't1', wait: false } as never)
  await clock.advance(5 * 60000)
  expect(seen.submits).toEqual([])
})

test('a local command typed while the Resume compacts does not cancel the Resume', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 300000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.duringCompact = async () => {
    await $.prompt.submit({ text: '/cache', command: { name: 'cache', args: '' }, origin: COMPOSER, wait: false } as never)
  }
  await clock.advance(3 * 60 * 60000)
  expect(seen.compacts).toBe(1)
  expect(seen.submits).toEqual(['Resume'])
})

test('a resume due while the person\'s "Compact first, then send" compaction runs is settled by that send: no Resume besides it', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  answer(on, seen, 'Compact first, then send')
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await mainStep($)
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 90 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(90 * 60000) // just before the resume (reset + 1 min)
  let compacting = 0
  seen.duringCompact = async () => {
    compacting++
    if (compacting === 1) await clock.advance(2 * 60000) // a big chat's compaction takes two minutes
  }
  await $.prompt.submit({ text: 'are we back?', origin: COMPOSER, wait: false } as never)
  await clock.advance(100) // the compaction, then the send
  await mainStep($) // the message's own request starts: that settles the resume
  await clock.advance(5 * 60000)
  expect(seen.asks).toBe(1)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: ['are we back?'], compacts: 1 })
})

test('a wake-up on a big chat (seat file) compacts for two minutes: one compaction, and the pending resume is not sent besides', RESUME, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const seat = { label: 'A' }
  const { clock, seen } = engine($, on, seat, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seat.label = 'B'
  disk.files['.claude.json'] = account('b@x')
  let compacting = 0
  seen.duringCompact = async () => {
    compacting++
    if (compacting === 1) await clock.advance(2 * 60000)
  }
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(5 * 60000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: [ROTATE], compacts: 1 })
})

test('an account written late while the wake-up compacts (no seat file) does not re-arm the resume besides the wake-up', RESUME_WAKE, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  let compacting = 0
  seen.duringCompact = async () => {
    compacting++
    if (compacting === 1) {
      disk.files['.claude.json'] = account('b@x')
      await clock.advance(2 * 60000)
    }
  }
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(5 * 60000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: [ROTATE], compacts: 1 })
})

test('a resume due while the cold-send dialog is open is not sent under it', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('tool.call', async (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    seen.asks++
    await clock.advance(2 * 60000) // the person reads the dialog for two minutes
    const q = e.questions?.[0]?.question ?? ''
    return { result: { questions: e.questions, answers: { [q]: 'Send anyway' } } }
  })
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await mainStep($)
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 90 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(90 * 60000)
  await $.prompt.submit({ text: 'are we back?', origin: COMPOSER, wait: false } as never)
  await mainStep($) // the message's own request starts: that settles the resume
  await clock.advance(5 * 60000)
  expect({ submits: seen.submits.filter((t) => t === 'Resume'), compacts: seen.compacts }).toEqual({ submits: [], compacts: 0 })
})

test('a built-in local command (/usage) typed while a resume is pending does not cancel it', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(60000)
  await $.prompt.submit({ text: '/usage', command: { name: 'usage', args: '' }, origin: COMPOSER, wait: false } as never)
  await clock.advance(3 * 60 * 60000)
  expect(seen.submits).toEqual(['Resume'])
})

test('a prompt dropped by a later hook does not settle a pending resume', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(60000)
  const r: any = await $.prompt.submit({ text: 'DROPME', origin: COMPOSER, wait: false } as never)
  await clock.advance(3 * 60 * 60000)
  expect({ r, submits: seen.submits }).toEqual({ r: { drop: 'another guard' }, submits: ['Resume'] })
})

test('a dropped prompt does not cancel the Resume while it compacts', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 300000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.duringCompact = () => $.prompt.submit({ text: 'DROPME', origin: COMPOSER, wait: false } as never)
  await clock.advance(3 * 60 * 60000)
  expect({ compacts: seen.compacts, submits: seen.submits }).toEqual({ compacts: 1, submits: ['Resume'] })
})

test('/clear typed while the Resume compacts cancels it: no Resume into the cleared chat', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 300000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.duringCompact = async () => {
    await $.prompt.submit({ text: '/clear', command: { name: 'clear', args: '' }, origin: COMPOSER, wait: false } as never)
    await ($ as any).classic.SessionStart({ source: 'clear' })
  }
  await clock.advance(3 * 60 * 60000)
  expect(seen.compacts).toBe(1)
  expect(seen.submits).toEqual([])
})

test("another plugin's prompt that reaches the chat while the Resume compacts cancels it", { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 300000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.duringCompact = () => $.prompt.submit({ text: 'from elsewhere', origin: { kind: 'plugin', name: 'some-other-plugin' }, wait: false } as never)
  await clock.advance(3 * 60 * 60000)
  expect(seen.compacts).toBe(1)
  expect(seen.submits).toEqual(['from elsewhere'])
})

test('"Compact first" on a slash command goes back to the prompt box, so no request of the message\'s starts: the pending resume still goes', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  answer(on, seen, 'Compact first, then send')
  let fills = 0
  on('prompt.fill', () => (fills++, { isFilled: true }))
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await mainStep($)
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 90 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(70 * 60000)
  await $.prompt.submit({ text: '/merge-pr 1', command: { name: 'merge-pr', args: '1' }, origin: COMPOSER, wait: false } as never)
  await clock.advance(3 * 60 * 60000)
  expect({ fills, submits: seen.submits, compacts: seen.compacts }).toEqual({ fills: 1, submits: ['Resume'], compacts: 2 }) // the person's compaction, then the Resume's own
})

test('a resume held for the seat and account goes once both are taken, not at the window end', { options: { ...SETUP.options, autoResume: true } }, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x'), '.active': 'A' } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(100)
  await mainStep($) // the wake-up's own request starts, on the old account
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.submits.length = 0
  seen.compacts = 0
  disk.files['.active'] = 'B'
  await clock.advance(30000) // seat adopted, resume moved to a minute on
  await clock.advance(80000) // due while the account is unknown: held
  expect({ compacts: seen.compacts, submits: seen.submits }).toEqual({ compacts: 0, submits: [] })
  disk.files['.claude.json'] = account('b@x')
  await clock.advance(31000) // account adopted: seat and account both taken, well before the window's end
  await clock.advance(1000)
  expect({ compacts: seen.compacts, submits: seen.submits }).toEqual({ compacts: 1, submits: ['Resume'] })
})

test('a plain send handed on slowly while the resume falls due holds it: no Resume besides the message', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 90 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(91 * 60000 - 10000) // just before the resume is due
  await $.prompt.submit({ text: 'SLOW', origin: COMPOSER, wait: false } as never) // the resume falls due while a lower hook still holds the message
  await mainStep($) // the message's own request starts
  await clock.advance(5 * 60000)
  expect(seen.submits).toEqual([])
})

test('Compact first while the Resume compacts cancels the Resume: only the person\'s message goes', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  answer(on, seen, 'Compact first, then send')
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await mainStep($)
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 90 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) await $.prompt.submit({ text: 'hold on', origin: COMPOSER, wait: false } as never) } // the Resume is compacting when the person sends into the cold chat
  await clock.advance(3 * 60 * 60000)
  expect({ asks: seen.asks, submits: seen.submits }).toEqual({ asks: 1, submits: ['hold on'] })
})

test('a wake-up giving up does not release the hold of a later wake-up: the Resume waits for the later one\'s request', RESUME_WAKE, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  answer(on, seen, 'Send anyway')
  on('classic.StopFailure', () => ({}))
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  let steps = 0
  on('turn.step', async function* () {
    if (++steps === 1) await gate // only the old request waits
    return { answer: '', toolUses: [], usage: null }
  })
  await start($, 300000, clock)
  const old = ($ as any).turn.step({ model: 'claude-opus-5-5', messages: [] }) // a request on the old account, still running
  const draining = (async () => {
    if (old && typeof old[Symbol.asyncIterator] === 'function') for await (const _ of old) void _
    else await old
  })()
  await clock.advance(10)
  disk.files['.claude.json'] = account('b@x')
  const ROTATE2 = 'Usage reset: the CLI account was rotated to C. Go on.'
  let compacting = 0
  seen.duringCompact = async () => {
    if (++compacting !== 1) return
    await $.prompt.submit({ text: 'meanwhile', origin: COMPOSER, wait: false } as never) // the person sends on: wake-up 1 will give up
    disk.files['.claude.json'] = account('c@x')
    await $.prompt.submit({ text: ROTATE2, origin: COMPOSER, wait: false } as never) // wake-up 2 arrives (the account moved on again), compacting next
  }
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(1000) // wake-up 1 gave up, wake-up 2 compacted and sent
  expect(seen.submits).toEqual([ROTATE2])
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" }) // the old request's failure arms a resume a minute off
  await clock.advance(90000) // due, but wake-up 2's request has not started
  expect(seen.submits).toEqual([ROTATE2])
  await mainStep($) // wake-up 2's request starts: it settles the resume
  release()
  await draining
  await clock.advance(60 * 60000)
  expect(seen.submits).toEqual([ROTATE2])
})
