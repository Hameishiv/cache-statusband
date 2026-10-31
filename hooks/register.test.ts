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
  const seen = { compacts: 0, submits: [] as string[], asks: 0, toasts: [] as string[], failCompact: false, failSubmit: false, duringCompact: null as null | (() => Promise<unknown>), duringSubmit: null as null | (() => Promise<unknown>) }
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
    if (seen.failSubmit && e.origin?.kind === 'plugin') return Promise.resolve(seen.duringSubmit?.()).then(() => { throw new Error('refused') }) // this mod's own sends are refused, both ways, after whatever the test does while the submit is out
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

test('an automatic message cancelled by a real message sent meanwhile says so once, and that it waits for that message\'s request, even when the compaction failed', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  seen.failCompact = true
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 300000, clock)
  const resetsAt = new Date(60000 + 30 * 60000).toISOString()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.duringCompact = () => $.prompt.submit({ text: 'hold on', origin: COMPOSER, wait: false } as never)
  await cancelledThenRequest($, clock, seen)
  await clock.advance(40 * 60000)
  expect(seen.submits).toEqual([])
  expect(seen.toasts.filter((t) => /Could not compact/.test(t))).toEqual([])
  expect(seen.toasts.filter((t) => /Compacted/.test(t))).toEqual([])
  expect(seen.toasts.filter((t) => /A message was sent meanwhile, so the automatic one waits until .* unless that message's request starts/.test(t)).length).toBe(1) // no request had started when it was cancelled: the Resume is armed again
  expect(seen.toasts.filter((t) => /was not sent|Something else/.test(t))).toEqual([])
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
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 300000, clock)
  const resetsAt = new Date(60000 + 30 * 60000).toISOString()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  // the person types while the compaction runs
  seen.duringCompact = () => $.prompt.submit({ text: 'hold on', origin: COMPOSER, wait: false } as never)
  await cancelledThenRequest($, clock, seen)
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
// The Resume's compact-then-send was cancelled: the message that did it has its own request start (the Resume goes again if none does)
async function cancelledThenRequest($: any, clock: any, seen: { toasts: string[] }) {
  for (let i = 0; i < 300 && !seen.toasts.some((t) => /automatic one/.test(t)); i++) await clock.advance(60000)
  await mainStep($)
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
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: fiveFull(t0), changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.duringCompact = () => $.prompt.submit({ text: 'from elsewhere', origin: { kind: 'plugin', name: 'some-other-plugin' }, wait: false } as never)
  await cancelledThenRequest($, clock, seen)
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
  expect({ fills, submits: seen.submits, compacts: seen.compacts }).toEqual({ fills: 1, submits: ['Resume'], compacts: 1 }) // the person's compaction only: no request since, so the chat is already short and the Resume goes without compacting again
})

test('a resume held for the seat and account goes once both are taken, not at the window end', { options: { ...SETUP.options, autoResume: true } }, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x'), '.active': 'A' } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0 } } }) // a request with usage ends the wake-up's compaction (justCompacted) and says it left 100k, so the Resume compacts afresh
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
  await cancelledThenRequest($, clock, seen)
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

// A `/plan` typed while the Resume compacts: with a description it reaches the model, alone it is local
for (const [args, goes] of [['fix x', false], ['', true], ['open', true]] as const) {
  test(`"/plan ${args}" typed while the Resume compacts ${goes ? 'leaves it going' : 'cancels it, as it reaches the model'}`, { options: { autoResume: true } }, async ($, on) => {
    const { clock, seen } = engine($, on)
    on('classic.StopFailure', () => ({}))
    on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
    await start($, 300000, clock)
    const t0 = await clock.now()
    await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: fiveFull(t0), changed: [] } as never)
    await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
    let n = 0
    seen.duringCompact = async () => { if (++n === 1) await $.prompt.submit({ text: `/plan ${args}`.trim(), command: { name: 'plan', args }, origin: COMPOSER, wait: false } as never) }
    if (!goes) await cancelledThenRequest($, clock, seen)
    await clock.advance(3 * 60 * 60000)
    expect(seen.submits).toEqual(goes ? ['Resume'] : [])
  })
}

// A plain send returns from the chain at once, but its request may start much later
async function resumeDueAfterSend(on: any, $: any) {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 90 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(91 * 60000 - 20000) // the resume is due 20 s from now
  await $.prompt.submit({ text: 'hello', origin: COMPOSER, wait: false } as never) // handed on at once
  return { clock, seen }
}

test('a send handed on at once whose request starts 40 s later holds a due resume until then: no Resume besides the message', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeDueAfterSend(on, $)
  await clock.advance(40000) // the resume fell due 20 s ago, the request has not started
  expect(seen.submits).toEqual([])
  await mainStep($) // the message's own request starts
  await clock.advance(5 * 60000)
  expect(seen.submits).toEqual([])
})

test('a send that never starts a request holds a due resume only for the 2-minute safety, then the Resume goes', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeDueAfterSend(on, $)
  await clock.advance(100000) // inside the safety
  expect(seen.submits).toEqual([])
  await clock.advance(60000) // past it
  expect(seen.submits).toEqual(['Resume'])
})

test('the person\'s message sent again after "Compact first" whose request starts 40 s later holds a due resume until then', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  answer(on, seen, 'Compact first, then send')
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await mainStep($)
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 90 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(91 * 60000 - 20000) // the resume is due 20 s from now
  await $.prompt.submit({ text: 'hello', origin: COMPOSER, wait: false } as never)
  await clock.advance(100) // compacted and sent again
  await clock.advance(40000) // the resume fell due, the message's request has not started
  expect(seen.submits).toEqual(['hello'])
  await mainStep($)
  await clock.advance(5 * 60000)
  expect(seen.submits).toEqual(['hello'])
})

async function resumeCompactingThenCompactFirst($: any, on: any, before?: () => void) {
  const { clock, seen } = engine($, on)
  before?.() // hooks beneath the plugins go in before the first call on $
  answer(on, seen, 'Compact first, then send')
  const fills: string[] = []
  on('prompt.fill', (_: unknown, e: any) => (fills.push(e.text), { isFilled: true }))
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await mainStep($)
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 90 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) await $.prompt.submit({ text: '/merge-pr 1', command: { name: 'merge-pr', args: '1' }, origin: COMPOSER, wait: false } as never) } // the Resume is compacting when the person answers "Compact first" on a slash message
  return { clock, seen, fills }
}

test('the Resume cancelled by "Compact first" on a slash message (put back in the prompt box, never sent) goes again 2 minutes later', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen, fills } = await resumeCompactingThenCompactFirst($, on)
  await clock.advance(91 * 60000 + 1000) // the resume falls due and compacts, and the person's message cancels it
  expect(seen.toasts.filter((t) => /Something else was sent or chosen meanwhile, so the automatic one waits/.test(t)).length).toBe(1)
  expect(seen.toasts.filter((t) => /A message was sent meanwhile/.test(t))).toEqual([])
  await clock.advance(60000)
  expect(seen.submits).toEqual([]) // still inside the 2 minutes
  await clock.advance(100000) // past it, at the next tick
  expect({ fills, submits: seen.submits }).toEqual({ fills: ['/merge-pr 1'], submits: ['Resume'] })
})

test('the Resume cancelled by "Compact first" is not armed again once a request of the main loop starts', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeCompactingThenCompactFirst($, on)
  await clock.advance(91 * 60000 + 1000) // the resume falls due and compacts, and the person's message cancels it
  await clock.advance(30000)
  await mainStep($) // some request starts within the 2 minutes
  await clock.advance(10 * 60000)
  expect(seen.submits).toEqual([])
})

test('the Resume cancelled by a /clear is not armed again', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeCompactingThenCompactFirst($, on)
  seen.duringCompact = async () => { await ($ as any).classic.SessionStart({ source: 'clear' }) }
  await clock.advance(91 * 60000 + 1000) // the resume falls due and compacts, and the person's message cancels it
  expect(seen.toasts.filter((t) => /so the automatic one was not sent/.test(t)).length).toBe(1)
  await clock.advance(10 * 60000)
  expect(seen.submits).toEqual([])
})

const engineDraws = () => ({ type: 'Text', props: {}, children: ['engine'] }) as never
// The band's pending-resume segment as drawn, or null when it shows none
async function bandResume($: any) {
  const ui = await $.ui.mount({ plugin: 'test', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 200, rows: 30 }, props: {} } as never)
  const seg: any = await ui.find({ type: 'Text', text: /⏸ Resumes/ })
  return seg ? String(seg.text).trim() : null
}
// The Resume has fallen due on a big chat that has been cold for a while: its compaction is running
async function resumeCompacting($: any, on: any, before?: () => void) {
  const e = engine($, on)
  on('ui.render', engineDraws)
  before?.()
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } })
  await start($, 300000, e.clock)
  const t0 = await e.clock.now()
  await mainStep($)
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 90 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  return e
}

test('the Resume re-armed after a cancel does not compact a second time, and neither does the "Compact first" that cancelled it: the chat is already short (1 compaction, not 3)', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen, fills } = await resumeCompactingThenCompactFirst($, on)
  await clock.advance(91 * 60000 + 1000) // the Resume compacts and the person's "Compact first" on a slash message cancels it: it finds the chat just compacted and does not compact again
  await clock.advance(60000)
  await clock.advance(100000) // the re-armed Resume falls due
  expect({ compacts: seen.compacts, submits: seen.submits, fills }).toEqual({ compacts: 1, submits: ['Resume'], fills: ['/merge-pr 1'] })
})

test('a cold-send dialog open when the Resume\'s compaction ends holds it, and "Send anyway" cancels it: no Resume beside the message', { options: { autoResume: true } }, async ($, on) => {
  let release: (label: string) => void = () => {}
  const gate = new Promise<string>((r) => { release = r })
  let asks = 0
  const { clock, seen } = await resumeCompacting($, on, () => on('tool.call', async (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    asks++
    const label = await gate
    const q = e.questions?.[0]?.question ?? ''
    return { result: { questions: e.questions, answers: { [q]: label } } }
  }))
  let sent: Promise<unknown> | null = null
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) sent = $.prompt.submit({ text: 'hold on', origin: COMPOSER, wait: false } as never) } // the person sends into the cold chat while the Resume compacts: the dialog opens
  await clock.advance(91 * 60000 + 1000) // the Resume falls due and compacts; the dialog is still open when the compaction ends
  await clock.advance(5000)
  expect({ asks, submits: seen.submits }).toEqual({ asks: 1, submits: [] })
  expect(seen.toasts.filter((t) => /automatic one/.test(t))).toEqual([]) // nothing decided while the dialog is open
  release('Send anyway')
  await sent
  await clock.advance(5000)
  expect(seen.toasts.filter((t) => /A message was sent meanwhile, so the automatic one waits until/.test(t)).length).toBe(1)
  expect(seen.submits).toEqual([]) // the person's message is handed on, and no Resume beside it
  await mainStep($) // its request starts
  await clock.advance(10 * 60000)
  expect(seen.submits).toEqual([])
})

test('a cold-send dialog open when the Resume\'s compaction ends and answered Cancel: the Resume goes as soon as it is closed, without compacting again', { options: { autoResume: true } }, async ($, on) => {
  let release: (label: string) => void = () => {}
  const gate = new Promise<string>((r) => { release = r })
  const { clock, seen } = await resumeCompacting($, on, () => on('tool.call', async (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    const label = await gate
    const q = e.questions?.[0]?.question ?? ''
    return { result: { questions: e.questions, answers: { [q]: label } } }
  }))
  let sent: Promise<unknown> | null = null
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) sent = $.prompt.submit({ text: 'hold on', origin: COMPOSER, wait: false } as never) }
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(5000)
  expect(seen.submits).toEqual([]) // not while the dialog is open
  release('Cancel')
  await sent
  await clock.advance(1000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: ['Resume'], compacts: 1 })
  expect(seen.toasts.filter((t) => /automatic one/.test(t))).toEqual([]) // nothing cancelled it
})

test('a wake-up on a cold big chat arriving while the Resume compacts cancels the Resume: only the wake-up goes', { options: { rotatorWakePattern: WAKE.options.rotatorWakePattern, autoResume: true } }, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await mainStep($)
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 90 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) { disk.files['.claude.json'] = account('b@x'); await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never); await clock.advance(1000) } } // the wake-up arrives while the Resume compacts, and its own send starts (50 ms on) while that compaction is still running
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(5000)
  expect(seen.submits.filter((t) => t === 'Resume')).toEqual([])
  expect(seen.submits).toEqual([ROTATE]) // the wake-up's own compaction ended and it went
  expect(seen.compacts).toBe(1) // it used the Resume's compaction
})

test('the cancel toast and the band show the pending Resume when a real message was handed on: it waits until 2 minutes after the cancel unless that message\'s request starts', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeCompacting($, on)
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) await $.prompt.submit({ text: 'hold on', origin: COMPOSER, wait: false } as never) } // a real message handed on to the chat, its request not started
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(5000)
  expect(seen.toasts.filter((t) => /A message was sent meanwhile, so the automatic one waits until .* unless that message's request starts/.test(t)).length).toBe(1)
  expect(seen.toasts.filter((t) => /was not sent|Something else/.test(t))).toEqual([])
  expect(await bandResume($)).toMatch(/^⏸ Resumes \d{1,2}:\d\d/)
  await mainStep($) // the message's request starts: nothing is pending
  expect(await bandResume($)).toBe(null)
})

test('the band shows no pending Resume once /clear replaced the chat the Resume was cancelled in', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeCompactingThenCompactFirst($, on, () => (on('ui.render', engineDraws), on('classic.SessionStart', () => ({}))))
  await clock.advance(91 * 60000 + 1000)
  expect(await bandResume($)).toMatch(/^⏸ Resumes/)
  await ($ as any).classic.SessionStart({ source: 'clear' })
  expect(await bandResume($)).toBe(null)
  await clock.advance(10 * 60000)
  expect(seen.submits).toEqual([])
})

test('a local built-in typed on a cold big chat while the Resume compacts gets no cold-send dialog: the Resume goes right after the compaction', { options: { autoResume: true } }, async ($, on) => {
  let asked = 0
  const { clock, seen } = await resumeCompacting($, on, () => on('tool.call', (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    asked++
    const q = e.questions?.[0]?.question ?? ''
    return { result: { questions: e.questions, answers: { [q]: 'Send anyway' } } }
  }))
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) await $.prompt.submit({ text: '/usage', command: { name: 'usage', args: '' }, origin: COMPOSER, wait: false } as never) }
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(5000)
  expect({ asked, submits: seen.submits, compacts: seen.compacts }).toEqual({ asked: 0, submits: ['Resume'], compacts: 1 })
  expect(seen.toasts.filter((t) => /automatic one/.test(t))).toEqual([])
})

test('a wake-up is not cancelled by a cold-send dialog the person answers Cancel: its text goes after its compaction', { options: { rotatorWakePattern: WAKE.options.rotatorWakePattern } }, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  let release: (label: string) => void = () => {}
  const gate = new Promise<string>((r) => { release = r })
  on('tool.call', async (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    seen.asks++
    const label = await gate
    const q = e.questions?.[0]?.question ?? ''
    return { result: { questions: e.questions, answers: { [q]: label } } }
  })
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } })
  await start($, 300000, clock)
  await mainStep($)
  let sent: Promise<unknown> | null = null
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) sent = $.prompt.submit({ text: 'hold on', origin: COMPOSER, wait: false } as never) } // the person sends into the cold chat while the wake-up compacts
  disk.files['.claude.json'] = account('b@x')
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(1000)
  expect({ asks: seen.asks, submits: seen.submits }).toEqual({ asks: 1, submits: [] }) // the dialog is open: the wake-up waits
  release('Cancel')
  await sent
  await clock.advance(1000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: [ROTATE], compacts: 1 })
  expect(seen.toasts.filter((t) => /was not sent|automatic one/.test(t))).toEqual([])
})

test('a wake-up arriving while the Resume compacts uses that compaction: one compaction, only the wake-up\'s text goes', { options: { rotatorWakePattern: WAKE.options.rotatorWakePattern, autoResume: true } }, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await mainStep($)
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 90 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) { disk.files['.claude.json'] = account('b@x'); await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never); await clock.advance(1000) } } // the wake-up's own send starts while the Resume's compaction is still running
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(5000)
  expect({ compacts: seen.compacts, submits: seen.submits }).toEqual({ compacts: 1, submits: [ROTATE] })
})

test('a Resume neither submit way could send is tried again 2 minutes on, and says so', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.failSubmit = true
  await clock.advance(60 * 60000 + 30000) // no reset time is known: the Resume falls due an hour on, and both ways are refused
  expect(seen.toasts.filter((t) => /Could not send Resume\. Trying again at/.test(t)).length).toBe(1)
  expect(seen.submits).toEqual([])
  seen.failSubmit = false
  await clock.advance(30000)
  expect(seen.submits).toEqual([]) // still inside the 2 minutes
  await clock.advance(100000)
  expect(seen.submits).toEqual(['Resume'])
})

test('a Resume refused every time gives up after four tries in all, and says so once', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.failSubmit = true
  await clock.advance(60 * 60000 + 30000)
  for (let i = 0; i < 5; i++) await clock.advance(2 * 60000 + 30000)
  expect(seen.toasts.filter((t) => /Trying again at/.test(t)).length).toBe(3)
  expect(seen.toasts.filter((t) => /after four tries/.test(t)).length).toBe(1)
  seen.failSubmit = false
  await clock.advance(10 * 60000)
  expect(seen.submits).toEqual([])
})

test('a refusal count left by a settled arm does not cut the next arm short', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 50000, clock)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.failSubmit = true
  await clock.advance(60 * 60000 + 30000)
  await clock.advance(2 * 60000 + 30000)
  await clock.advance(2 * 60000 + 30000)
  expect(seen.toasts.filter((t) => /Trying again at/.test(t)).length).toBe(3)
  await mainStep($) // the person's own message settles it
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(60 * 60000 + 30000) // the new arm's first refusal
  expect(seen.toasts.filter((t) => /after four tries/.test(t)).length).toBe(0)
  expect(seen.toasts.filter((t) => /Trying again at/.test(t)).length).toBe(4)
})

test('a new arm while the Resume is pending again after refusals starts its count afresh', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  await start($, 50000, clock)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.failSubmit = true
  await clock.advance(60 * 60000 + 30000)
  await clock.advance(2 * 60000 + 30000)
  await clock.advance(2 * 60000 + 30000)
  expect(seen.toasts.filter((t) => /Trying again at/.test(t)).length).toBe(3)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" }) // armed anew, nothing settled
  await clock.advance(60 * 60000 + 30000)
  expect(seen.toasts.filter((t) => /after four tries/.test(t)).length).toBe(0)
  expect(seen.toasts.filter((t) => /Trying again at/.test(t)).length).toBe(4)
})

test('a refused Resume is not armed again in a chat cleared while the submit was out', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  on('classic.SessionStart', () => ({}))
  await start($, 50000, clock)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.failSubmit = true
  let n = 0
  seen.duringSubmit = async () => { if (++n === 1) await ($ as any).classic.SessionStart({ source: 'clear' }) }
  await clock.advance(60 * 60000 + 30000)
  seen.failSubmit = false
  await clock.advance(10 * 60000)
  expect(seen.submits).toEqual([])
  expect(seen.toasts.filter((t) => /Trying again at/.test(t))).toEqual([])
})

test('a refused Resume is not armed again once a request of the main loop settled it while the submit was out', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 50000, clock)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.failSubmit = true
  let n = 0
  seen.duringSubmit = async () => { if (++n === 1) await mainStep($) }
  await clock.advance(60 * 60000 + 30000)
  seen.failSubmit = false
  await clock.advance(10 * 60000)
  expect(seen.submits).toEqual([])
  expect(seen.toasts.filter((t) => /Trying again at/.test(t))).toEqual([])
})

test('a Resume sent after compacting and refused both ways is tried again 2 minutes on, not put in the prompt box', { options: { autoResume: true } }, async ($, on) => {
  const fills: string[] = []
  const { clock, seen } = await resumeCompacting($, on, () => on('prompt.fill', (_: unknown, e: any) => (fills.push(e.text), { isFilled: true })))
  seen.failSubmit = true
  await clock.advance(91 * 60000 + 1000) // the Resume falls due, compacts, and both ways of sending it are refused
  expect(seen.toasts.filter((t) => /Could not send Resume\. Trying again at/.test(t)).length).toBe(1)
  expect(await bandResume($)).toMatch(/Resumes/)
  seen.failSubmit = false
  await clock.advance(60000)
  expect(seen.submits).toEqual([]) // still inside the 2 minutes
  await clock.advance(100000)
  expect({ submits: seen.submits, compacts: seen.compacts, fills }).toEqual({ submits: ['Resume'], compacts: 1, fills: [] }) // the chat is already short: no second compaction
})

test('a Resume sent after compacting and refused every time gives up after four tries in all, and says so once', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeCompacting($, on)
  seen.failSubmit = true
  await clock.advance(91 * 60000 + 1000)
  for (let i = 0; i < 5; i++) await clock.advance(2 * 60000 + 30000)
  expect(seen.toasts.filter((t) => /Trying again at/.test(t)).length).toBe(3)
  expect(seen.toasts.filter((t) => /after four tries/.test(t)).length).toBe(1)
})

test('a send cancelled while it waits on a shared compaction that failed does not compact again', { options: { rotatorWakePattern: WAKE.options.rotatorWakePattern, autoResume: true } }, async ($, on) => {
  const disk: { files: Record<string, string> } = { files: { '.claude.json': account('a@x') } }
  const { clock, seen } = engine($, on, { label: 'A' }, undefined, undefined, disk)
  on('classic.StopFailure', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } })
  await start($, 300000, clock)
  const t0 = await clock.now()
  await mainStep($)
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 90 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  seen.failCompact = true
  let n = 0
  // while the Resume compacts: the account rotates, the wake-up waits on that compaction, and a /clear cancels the wake-up before the compaction fails
  seen.duringCompact = async () => { if (++n === 1) { disk.files['.claude.json'] = account('b@x'); await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never); await clock.advance(1000); await ($ as any).classic.SessionStart({ source: 'clear' }) } }
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(5000)
  expect({ compacts: seen.compacts, submits: seen.submits }).toEqual({ compacts: 1, submits: [] })
})

test('a Resume whose compaction failed while a cold-send dialog was open, answered Cancel, waits and compacts again instead of going uncompacted', { options: { autoResume: true } }, async ($, on) => {
  let release: (label: string) => void = () => {}
  const gate = new Promise<string>((r) => { release = r })
  const { clock, seen } = await resumeCompacting($, on, () => on('tool.call', async (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    const label = await gate
    const q = e.questions?.[0]?.question ?? ''
    return { result: { questions: e.questions, answers: { [q]: label } } }
  }))
  seen.failCompact = true
  let sent: Promise<unknown> | null = null
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) sent = $.prompt.submit({ text: 'hold on', origin: COMPOSER, wait: false } as never) }
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(5000)
  expect(seen.submits).toEqual([]) // not while the dialog is open
  release('Cancel')
  await sent
  await clock.advance(1000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: [], compacts: 1 }) // not sent uncompacted
  expect(seen.toasts.filter((t) => /Could not compact \(.*\), so the Resume waits until/.test(t)).length).toBe(1)
  expect(seen.toasts.filter((t) => /so the message goes as typed/.test(t))).toEqual([])
  expect(await bandResume($)).toMatch(/Resumes/)
  seen.failCompact = false
  await clock.advance(60000)
  expect(seen.submits).toEqual([]) // still inside the 2 minutes
  await clock.advance(100000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: ['Resume'], compacts: 2 }) // it compacted again first
})

test('a Resume whose compaction failed with no dialog open still goes as typed', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeCompacting($, on)
  seen.failCompact = true
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(5000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: ['Resume'], compacts: 1 })
  expect(seen.toasts.filter((t) => /Could not compact \(.*\), so the message goes as typed/.test(t)).length).toBe(1)
})

// A cold-send dialog whose answer the test gives later (release), for tests that open one while the Resume compacts
function gatedAsk(on: any) {
  let release: (label: string) => void = () => {}
  const gate = new Promise<string>((r) => { release = r })
  on('tool.call', async (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    const label = await gate
    const q = e.questions?.[0]?.question ?? ''
    return { result: { questions: e.questions, answers: { [q]: label } } }
  })
  return release
}

// Two "Compact first" sends on a cold big chat: the first runs the compaction, held until the test lets it finish (hang) or never
async function twoCompactFirst($: any, on: any, hold: (n: number) => Promise<unknown>) {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  const fills: string[] = []
  on('prompt.fill', (_: unknown, e: any) => (fills.push(e.text), { isFilled: true }))
  answer(on, seen, 'Compact first, then send')
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  let n = 0
  seen.duringCompact = () => hold(++n)
  await $.prompt.submit({ text: 'one', origin: COMPOSER, wait: false } as never)
  await clock.advance(100)
  await $.prompt.submit({ text: 'two', origin: COMPOSER, wait: false } as never)
  await clock.advance(100)
  return { clock, seen, fills }
}

test('a compaction that takes 2.5 minutes is waited on: two "Compact first" sends compact once and go in order', SETUP, async ($, on) => {
  let finishFirst: () => void = () => {}
  const { clock, seen } = await twoCompactFirst($, on, (n) => (n === 1 ? new Promise<void>((r) => { finishFirst = r }) : Promise.resolve()))
  await clock.advance(150000) // well past the 2 minutes the waiter used to give up after
  expect({ compacts: seen.compacts, submits: seen.submits }).toEqual({ compacts: 1, submits: [] })
  finishFirst()
  await clock.advance(1000)
  expect({ compacts: seen.compacts, submits: seen.submits }).toEqual({ compacts: 1, submits: ['one', 'two'] })
})

test('a compaction that never finishes is abandoned after 15 minutes: that message and the send that waited on it go back in the prompt box in ONE fill, in order, and neither is sent uncompacted nor compacts again', SETUP, async ($, on) => {
  const { clock, seen, fills } = await twoCompactFirst($, on, (n) => (n === 1 ? new Promise(() => {}) : Promise.resolve()))
  await clock.advance(14 * 60000)
  expect({ compacts: seen.compacts, submits: seen.submits, fills }).toEqual({ compacts: 1, submits: [], fills: [] }) // still waiting
  await clock.advance(61000)
  expect({ compacts: seen.compacts, submits: seen.submits, fills }).toEqual({ compacts: 1, submits: [], fills: ['one\n\ntwo'] })
  expect(seen.toasts.filter((t) => /Compaction has not finished after 15 minutes; your message is back in the prompt box/.test(t)).length).toBe(1)
  expect(seen.toasts.filter((t) => /The earlier compaction is still running; your message is back in the prompt box/.test(t)).length).toBe(1) // the waiter's
})

test('a compaction that never finishes holds a due Resume while the put-back message is unsent, for 15 minutes at most: nothing is sent beside it and no second /compact until then', { options: { ...SETUP.options, autoResume: true } }, async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, 'Compact first, then send')
  on('prompt.fill', () => ({ isFilled: true }))
  on('classic.StopFailure', () => ({}))
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve()) // the person's compaction hangs
  await clock.advance(50 * 60000) // the Resume is due 10 minutes after this
  await $.prompt.submit({ text: 'one', origin: COMPOSER, wait: false } as never)
  await clock.advance(100)
  await clock.advance(14 * 60000) // abandoned at 15 minutes: 'one' is in the prompt box and the Resume, due since, waits for it
  await clock.advance(14 * 60000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: [], compacts: 1 })
  expect(seen.toasts.filter((t) => /Compaction has not finished after 15 minutes/.test(t)).length).toBe(1)
  expect(seen.toasts.filter((t) => /Resume was not sent|Trying again|four tries/.test(t))).toEqual([]) // held, not tried and failed
  await clock.advance(5 * 60000) // 15 minutes after the put-back the hold lapses, as does the abandoned mark: the Resume goes
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: ['Resume'], compacts: 2 })
})

test('a Resume whose own compaction never finishes is not sent uncompacted after 15 minutes: it is tried again 2 minutes on, without a second compaction while the first is out, and gives up after four tries saying compaction did not finish', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeCompacting($, on)
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve())
  await clock.advance(91 * 60000 + 1000) // the Resume falls due and compacts, and the compaction hangs
  await clock.advance(14 * 60000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: [], compacts: 1 })
  await clock.advance(61000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: [], compacts: 1 })
  expect(seen.toasts.filter((t) => /Compaction has not finished after 15 minutes; the Resume was not sent\. Trying again at/.test(t)).length).toBe(1)
  await clock.advance(200000) // the second try finds the first compaction still out and starts no other
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: [], compacts: 1 })
  expect(seen.toasts.filter((t) => /The earlier compaction is still running; the Resume was not sent\. Trying again at/.test(t)).length).toBe(1)
  await clock.advance(10 * 60000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: [], compacts: 1 })
  expect(seen.toasts.filter((t) => /Compaction did not finish, so the Resume was not sent after four tries\. Send it yourself when ready\./.test(t)).length).toBe(1)
  expect(seen.toasts.filter((t) => /Could not send Resume/.test(t))).toEqual([])
})

test('a rotator wake-up whose compaction never finishes goes back in the prompt box after 15 minutes', { options: { rotatorWakePattern: WAKE.options.rotatorWakePattern } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  const fills: string[] = []
  on('prompt.fill', (_: unknown, e: any) => (fills.push(e.text), { isFilled: true }))
  await start($, 300000, clock)
  seen.duringCompact = () => new Promise(() => {})
  await $.prompt.submit({ text: ROTATE, origin: COMPOSER, wait: false } as never)
  await clock.advance(14 * 60000)
  expect({ submits: seen.submits, fills }).toEqual({ submits: [], fills: [] })
  await clock.advance(61000)
  expect({ submits: seen.submits, fills }).toEqual({ submits: [], fills: [ROTATE] })
})

test('a Resume due during the person\'s hung "Compact first": the message goes back in the prompt box first, and no Resume goes while it sits there unsent; once it is sent the Resume waits for its request (and goes if none starts)', { options: { ...SETUP.options, autoResume: true } }, async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  const fills: { at: number; text: string }[] = []
  on('prompt.fill', async (_: unknown, e: any) => (fills.push({ at: await clock.now(), text: e.text }), { isFilled: true }))
  answer(on, seen, 'Compact first, then send')
  on('classic.StopFailure', () => ({}))
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 4 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  let finish: () => void = () => {}
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finish = r }) : Promise.resolve()) // the person's compaction hangs; the Resume falls due 4 minutes in
  await $.prompt.submit({ text: 'stop, do X instead', origin: COMPOSER, wait: false } as never)
  let finished = false
  for (let i = 0; i < 25 * 6; i++) {
    await clock.advance(10000)
    if (!finished && fills.length) { finish(); finished = true } // it ends late, right after the message is back in the box
  }
  expect(fills.map((f) => f.text)).toEqual(['stop, do X instead'])
  expect(Math.round((fills[0].at - t0) / 60000)).toBe(15)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: [], compacts: 1 }) // 10 minutes after the box was filled, the Resume still waits for the message
  await $.prompt.submit({ text: 'stop, do X instead', origin: COMPOSER, wait: false } as never) // the person presses Enter
  await clock.advance(60000)
  expect(seen.submits).toEqual([]) // its request has not started: the Resume still waits on it
  await clock.advance(2 * 60000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: ['Resume'], compacts: 1 }) // none started: the Resume goes
})

test('a Resume due during the person\'s hung "Compact first" is not sent at all while the compaction stays out: nothing beside the filled-back message, no second /compact', { options: { ...SETUP.options, autoResume: true } }, async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  const fills: string[] = []
  on('prompt.fill', (_: unknown, e: any) => (fills.push(e.text), { isFilled: true }))
  answer(on, seen, 'Compact first, then send')
  on('classic.StopFailure', () => ({}))
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 4 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve())
  await $.prompt.submit({ text: 'stop, do X instead', origin: COMPOSER, wait: false } as never)
  for (let i = 0; i < 20; i++) await clock.advance(60000) // minute 16 is the one the Resume used to go at
  expect({ submits: seen.submits, compacts: seen.compacts, fills }).toEqual({ submits: [], compacts: 1, fills: ['stop, do X instead'] })
})

test('a person\'s "Compact first" that waits on a hung Resume compaction goes back in the prompt box when it is abandoned, with no second /compact, and the Resume is tried again', { options: { autoResume: true } }, async ($, on) => {
  const box = { asks: 0 }
  const fills: string[] = []
  const { clock, seen } = await resumeCompacting($, on, () => {
    answer(on, box, 'Compact first, then send')
    on('prompt.fill', (_: unknown, e: any) => (fills.push(e.text), { isFilled: true }))
  })
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve())
  await clock.advance(91 * 60000 + 1000) // the Resume compacts, and the compaction hangs
  await clock.advance(5 * 60000)
  await $.prompt.submit({ text: 'hello', origin: COMPOSER, wait: false } as never) // waits on it
  await clock.advance(10 * 60000 + 2000)
  expect({ submits: seen.submits, compacts: seen.compacts, fills, asks: box.asks }).toEqual({ submits: [], compacts: 1, fills: ['hello'], asks: 1 })
  expect(seen.toasts.filter((t) => /The earlier compaction is still running; your message is back in the prompt box/.test(t)).length).toBe(1)
  expect(seen.toasts.filter((t) => /Something else was sent or chosen meanwhile, so the automatic one waits until/.test(t)).length).toBe(1) // the Compact first answer cancelled the Resume (rule B), which is armed again
  await clock.advance(20 * 60000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: ['Resume'], compacts: 2 }) // the put-back hold and the abandoned mark both end 15 minutes on: the Resume compacts afresh and goes
})

test('a compaction abandoned after 15 minutes that finishes late marks the chat compacted: the Resume tried again goes without compacting', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeCompacting($, on)
  let finish: () => void = () => {}
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finish = r }) : Promise.resolve())
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(15 * 60000 + 1000) // abandoned; the Resume is armed again
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: [], compacts: 1 })
  finish()
  await clock.advance(1000)
  await clock.advance(200000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: ['Resume'], compacts: 1 })
})

test('a compaction abandoned after 15 minutes that fails late frees the next send to compact', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeCompacting($, on)
  let fail: (e: Error) => void = () => {}
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((_, rej) => { fail = rej }) : Promise.resolve())
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(15 * 60000 + 1000)
  fail(new Error('late boom'))
  await clock.advance(1000)
  await clock.advance(200000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: ['Resume'], compacts: 2 })
})

test('a message sent after the abandonment is put back behind the earlier batch, still unsent in the box: a fill never removes it', SETUP, async ($, on) => {
  const { clock, seen, fills } = await twoCompactFirst($, on, (n) => (n === 1 ? new Promise(() => {}) : Promise.resolve()))
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['one\n\ntwo'])
  await $.prompt.submit({ text: 'three', origin: COMPOSER, wait: false } as never) // no second compaction: it goes straight back
  await clock.advance(1000)
  expect({ compacts: seen.compacts, submits: seen.submits, fills }).toEqual({ compacts: 1, submits: [], fills: ['one\n\ntwo', 'one\n\ntwo\n\nthree'] })
})

test('a /clear after the abandonment starts afresh: the next chat\'s Resume compacts', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeCompacting($, on, () => on('classic.SessionStart', () => ({})))
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve())
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(15 * 60000 + 1000) // abandoned
  await ($ as any).classic.SessionStart({ source: 'clear' })
  const t = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t + 5 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(7 * 60000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: ['Resume'], compacts: 2 })
})

// The Resume's compaction runs while a cold-send dialog opens for a message of the person's, and fails: once the test says so (endCompact), or at once, with the dialog still open (failsAtOnce)
async function resumeDialogDuringCompaction($: any, on: any, text: string, command?: { name: string; args: string }, failsAtOnce = false) {
  const release = gatedAsk(on)
  const { clock, seen } = await resumeCompacting($, on)
  seen.failCompact = true
  let endCompact: () => void = () => {}
  const compactGate = new Promise<void>((r) => { endCompact = r })
  let sent: Promise<unknown> | null = null
  let n = 0
  seen.duringCompact = () => { if (++n === 1) { sent = $.prompt.submit({ text, ...(command ? { command } : {}), origin: COMPOSER, wait: false } as never); return failsAtOnce ? Promise.resolve() : compactGate } return Promise.resolve() }
  await clock.advance(91 * 60000 + 1000) // the Resume falls due and starts compacting; the dialog opens
  await clock.advance(5000)
  return { clock, seen, release, sent: () => sent, endCompact }
}

test('Cancel answered before the Resume\'s compaction fails: the Resume is not sent uncompacted, and is armed again', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen, release, sent, endCompact } = await resumeDialogDuringCompaction($, on, 'hold on')
  release('Cancel')
  await sent()
  await clock.advance(2000) // the dialog is closed; the compaction is still running
  expect(seen.submits).toEqual([])
  endCompact() // and now it fails
  await clock.advance(2000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: [], compacts: 1 })
  expect(seen.toasts.filter((t) => /Could not compact \(.*\), so the Resume waits until/.test(t)).length).toBe(1)
  expect(seen.toasts.filter((t) => /so the message goes as typed/.test(t))).toEqual([])
  expect(await bandResume($)).toMatch(/Resumes/)
})

test('"/btw question" answered Send anyway while the Resume\'s compaction fails: the Resume goes as typed, with no "waits until" toast', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen, release, sent } = await resumeDialogDuringCompaction($, on, '/btw what is x', { name: 'btw', args: 'what is x' }, true)
  await clock.advance(1000)
  expect(seen.submits).toEqual([]) // the compaction failed, the dialog is still open
  release('Send anyway')
  await sent()
  await clock.advance(5000)
  expect(seen.submits).toEqual(['Resume'])
  expect(seen.toasts.filter((t) => /so the Resume waits until/.test(t))).toEqual([])
  expect(seen.toasts.filter((t) => /Could not compact \(.*\), so the message goes as typed/.test(t)).length).toBe(1)
})

test('a Resume armed again after a Cancel whose compaction fails again is not sent uncompacted: it says so and leaves it to the person', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen, release, sent, endCompact } = await resumeDialogDuringCompaction($, on, 'hold on')
  release('Cancel')
  await sent()
  endCompact()
  await clock.advance(2000)
  expect(seen.toasts.filter((t) => /so the Resume waits until/.test(t)).length).toBe(1)
  await clock.advance(200000) // 2 minutes on: it compacts again, and that fails too (failCompact stays set)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: [], compacts: 2 })
  expect(seen.toasts.filter((t) => /Could not compact \(.*\)\. Send Resume yourself when ready\./.test(t)).length).toBe(1)
  await clock.advance(10 * 60000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: [], compacts: 2 }) // and not armed a third time
})

test('a new arm clears the mark of a Resume armed again after a Cancel: its Resume whose compaction fails goes as typed', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen, release, sent, endCompact } = await resumeDialogDuringCompaction($, on, 'hold on')
  release('Cancel')
  await sent()
  endCompact()
  await clock.advance(2000) // armed again, marked
  const t = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t + 5 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" }) // armed afresh, the mark cleared
  await clock.advance(7 * 60000) // due, its compaction fails, no dialog open
  expect(seen.submits).toEqual(['Resume'])
  expect(seen.toasts.filter((t) => /Send Resume yourself when ready/.test(t))).toEqual([])
})

test('/btw with a question typed while a turn is running gets no cold-send dialog', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, 'Send anyway')
  on('turn.start', () => ({ turnId: 't' }))
  on('turn.complete', () => ({ text: '' }))
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await ($ as any).turn.start({ turnId: 't', messages: [] })
  await $.prompt.submit({ text: '/btw what is x', command: { name: 'btw', args: 'what is x' }, origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(0)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'end_turn' } as never)
  await $.prompt.submit({ text: '/btw what is x', command: { name: 'btw', args: 'what is x' }, origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1) // idle again: asked
})

test('the cold-send guard asks for /btw with a question, which goes to the model, but not for /usage or a bare /btw', SETUP, async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  answer(on, seen, 'Send anyway')
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: '/usage', command: { name: 'usage', args: '' }, origin: COMPOSER, wait: false } as never)
  await $.prompt.submit({ text: '/btw', command: { name: 'btw', args: '  ' }, origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(0)
  await $.prompt.submit({ text: '/btw what is x', command: { name: 'btw', args: 'what is x' }, origin: COMPOSER, wait: false } as never)
  expect(seen.asks).toBe(1)
})

// ===== the abandoned compaction, round 2 =====
// Answers each cold-send dialog with `prefer` when it is offered, else with its first option, and keeps what was asked
function askLog(on: any) {
  const asked: { question: string; labels: string[] }[] = []
  let prefer = 'Compact first, then send'
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    const q = e.questions?.[0]
    const labels = (q?.options ?? []).map((o: any) => (typeof o === 'string' ? o : o.label))
    asked.push({ question: q?.question ?? '', labels })
    return { result: { questions: e.questions, answers: { [q?.question ?? '']: labels.includes(prefer) ? prefer : labels[0] } } }
  })
  return { asked, prefer: (label: string) => { prefer = label } }
}

// A cold big chat where the person's "Compact first" hangs (n === 1), an optional second send waits on it. `hooks` go in beneath the plugins; `fill` answers each prompt.fill (the text is recorded in fills first)
async function coldChat($: any, on: any, hooks: (kept: Map<string, unknown>) => void = () => {}, fill: (e: any, fills: string[]) => unknown = () => ({ isFilled: true })) {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  const fills: string[] = []
  on('prompt.fill', (_: unknown, e: any) => (fills.push(e.text), fill(e, fills)))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } })
  hooks(kept)
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  return { clock, seen, fills, kept }
}
const send = ($: any, text: string, command?: { name: string; args: string }) => $.prompt.submit({ text, ...(command ? { command } : {}), origin: COMPOSER, wait: false } as never)
// A typed /branch: the person submits the command, which runs locally and sends nothing to the chat, and the fork's SessionStart follows
const typeBranch = async ($: any) => {
  await send($, '/branch', { name: 'branch', args: '' })
  await ($ as any).classic.SessionStart({ source: 'fork', transcript_path: '/h/fork.jsonl' })
}

test('after the put-back the person presses Enter and the cold-send dialog comes again: it offers no "Compact first" and says why, and nothing is put back a second time', SETUP, async ($, on) => {
  const log = askLog(on)
  const { clock, seen, fills } = await coldChat($, on)
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve())
  await send($, 'one')
  await clock.advance(100)
  await send($, 'two')
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['one\n\ntwo'])
  log.prefer('Compact first, then send') // if it were offered
  await send($, 'one\n\ntwo') // Enter on the box
  await clock.advance(1000)
  expect(log.asked.length).toBe(3)
  expect(log.asked[2].labels).toEqual(['Send anyway', 'Cancel'])
  expect(log.asked[2].question).toContain('An earlier compaction is still running, so compacting first is not offered.')
  expect(log.asked[0].labels).toContain('Compact first, then send') // before the abandonment it is offered
  expect({ fills, compacts: seen.compacts }).toEqual({ fills: ['one\n\ntwo'], compacts: 1 })
})

test('a later abandonment does not bring back text that was delivered in between', SETUP, async ($, on) => {
  const log = askLog(on)
  const { clock, seen, fills } = await coldChat($, on)
  let fail: (e: Error) => void = () => {}
  let n = 0
  seen.duringCompact = () => { n++; return n === 1 ? new Promise((_, rej) => { fail = rej }) : n === 2 ? Promise.resolve() : new Promise(() => {}) }
  await send($, 'one')
  await clock.advance(100)
  await send($, 'two')
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['one\n\ntwo'])
  fail(new Error('late')) // frees the next compaction
  await clock.advance(1000)
  await send($, 'one\n\ntwo') // Enter on the box: Compact first compacts again (n === 2) and sends it
  await clock.advance(1000)
  expect(seen.submits).toEqual(['one\n\ntwo'])
  await mainStep($) // its request runs
  await clock.advance(3 * 60 * 60000) // cold again
  await send($, 'three') // this compaction (n === 3) hangs
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['one\n\ntwo', 'three'])
  expect(log.asked.length).toBe(4)
})

test('a slash command is never joined with other text: the plain texts are filled, the command is quoted in a toast', SETUP, async ($, on) => {
  askLog(on)
  const { clock, seen, fills } = await coldChat($, on)
  seen.duringCompact = () => new Promise(() => {})
  await send($, '/merge-pr 1', { name: 'merge-pr', args: '1' })
  await clock.advance(100)
  await send($, 'hello')
  await clock.advance(100)
  await send($, 'world')
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['hello\n\nworld'])
  expect(seen.toasts.filter((t) => /Also not sent: \/merge-pr 1 — send it again when ready\./.test(t)).length).toBe(1)
  expect(seen.toasts.filter((t) => /Compaction has not finished after 15 minutes\./.test(t)).length).toBe(1) // the command's own toast does not claim it is in the box
  expect(seen.toasts.filter((t) => /your message is back in the prompt box/.test(t)).length).toBe(2) // hello's and world's: the command owns the compaction, they waited on it
})

test('a batch that is only one slash command fills it alone', SETUP, async ($, on) => {
  askLog(on)
  const { clock, seen, fills } = await coldChat($, on)
  seen.duringCompact = () => new Promise(() => {})
  await send($, '/merge-pr 1', { name: 'merge-pr', args: '1' })
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['/merge-pr 1'])
  expect(seen.toasts.filter((t) => /Also not sent/.test(t))).toEqual([])
})

test('the person\'s own successful /compact clears the abandoned mark: the next "Compact first" compacts normally', SETUP, async ($, on) => {
  const log = askLog(on)
  const { clock, seen } = await coldChat($, on, () => on('classic.PostCompact', () => ({})))
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve())
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000) // abandoned
  await ($ as any).classic.PostCompact({}) // the person ran /compact and it worked
  await mainStep($)
  await clock.advance(3 * 60 * 60000) // cold again
  await send($, 'later')
  await clock.advance(1000)
  expect(log.asked[log.asked.length - 1].labels).toContain('Compact first, then send')
  expect({ compacts: seen.compacts, submits: seen.submits }).toEqual({ compacts: 2, submits: ['later'] })
})

test('an abandoned compaction that never settles is waited for only a second 15 minutes: after that a send may compact again', SETUP, async ($, on) => {
  const log = askLog(on)
  const { clock, seen, fills } = await coldChat($, on)
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve())
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000) // abandoned
  await clock.advance(13 * 60000) // 29 minutes after it started
  await send($, 'two')
  await clock.advance(1000)
  expect(log.asked[log.asked.length - 1].labels).toEqual(['Send anyway', 'Cancel'])
  expect({ compacts: seen.compacts, fills }).toEqual({ compacts: 1, fills: ['one'] })
  await clock.advance(2 * 60000) // 31 minutes
  await send($, 'three')
  await clock.advance(1000)
  expect(log.asked[log.asked.length - 1].labels).toContain('Compact first, then send')
  expect({ compacts: seen.compacts, submits: seen.submits }).toEqual({ compacts: 2, submits: ['three'] })
})

// The Resume's compaction hangs; the person clears the chat while it is out
async function clearedDuringResumeCompaction($: any, on: any) {
  const log = askLog(on)
  const fills: string[] = []
  const { clock, seen } = await resumeCompacting($, on, () => {
    on('prompt.fill', (_: unknown, e: any) => (fills.push(e.text), { isFilled: true }))
    on('classic.SessionStart', () => ({}))
  })
  let finish: () => void = () => {}
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finish = r }) : Promise.resolve())
  await clock.advance(91 * 60000 + 1000) // the Resume compacts, and it hangs
  await clock.advance(5 * 60000)
  await ($ as any).classic.SessionStart({ source: 'clear' })
  await mainStep($) // the new chat's first request (300k in this fixture)
  return { clock, seen, fills, log, finish: () => finish() }
}

test('a compaction abandoned after a /clear is not the new chat\'s: its first cold send compacts, and is not put back', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen, fills } = await clearedDuringResumeCompaction($, on)
  await clock.advance(11 * 60000) // the old chat's compaction is abandoned now
  await clock.advance(80 * 60000) // the new chat goes cold
  await send($, 'new chat msg')
  await clock.advance(1000)
  expect({ compacts: seen.compacts, submits: seen.submits, fills }).toEqual({ compacts: 2, submits: ['new chat msg'], fills: [] })
})

test('a compaction of the old chat that succeeds late does not mute the new chat\'s cold-send guard', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen, log, finish } = await clearedDuringResumeCompaction($, on)
  await clock.advance(11 * 60000) // abandoned
  await clock.advance(80 * 60000) // the new chat goes cold
  finish() // the old chat's compaction succeeds, late
  await clock.advance(1000)
  await send($, 'new chat msg')
  await clock.advance(1000)
  expect(log.asked.length).toBe(1) // asked
})

test('a compaction of the old chat that succeeds in time, after the /clear, does not mute the new chat\'s cold-send guard either', { options: { autoResume: true } }, async ($, on) => {
  const { clock, log, finish } = await clearedDuringResumeCompaction($, on)
  finish() // 5 minutes after the clear, well inside the 15: the Resume's own compaction ends
  await clock.advance(1000)
  await clock.advance(80 * 60000) // the new chat goes cold
  await send($, 'new chat msg')
  await clock.advance(1000)
  expect(log.asked.length).toBe(1)
})

test('"Compact first" on a /btw question while the Resume compacts leaves the Resume alone: it goes after the compaction, and the question goes back in the prompt box', { options: { autoResume: true } }, async ($, on) => {
  const log = askLog(on)
  const fills: string[] = []
  const { clock, seen } = await resumeCompacting($, on, () => on('prompt.fill', (_: unknown, e: any) => (fills.push(e.text), { isFilled: true })))
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) await send($, '/btw what is X?', { name: 'btw', args: 'what is X?' }) }
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(1000)
  expect(log.asked.length).toBe(1)
  expect({ submits: seen.submits, fills, compacts: seen.compacts }).toEqual({ submits: ['Resume'], fills: ['/btw what is X?'], compacts: 1 })
  expect(seen.toasts.filter((t) => /automatic one/.test(t))).toEqual([])
})

test('a message put back while the chat is then cleared does not hold the next chat\'s Resume', { options: { ...SETUP.options, autoResume: true } }, async ($, on) => {
  askLog(on)
  const { clock, seen, fills } = await coldChat($, on, () => (on('classic.SessionStart', () => ({})), on('classic.StopFailure', () => ({}))))
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve())
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['one']) // the box holds it
  await ($ as any).classic.SessionStart({ source: 'clear' }) // no request has started since: only the clear can lower the hold
  const t = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t + 5 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(7 * 60000)
  expect(seen.submits).toEqual(['Resume'])
})

test('the give-up toast names the cause of the latest failed try: two tries stopped by the compaction, then two refused sends, say the send was refused', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeCompacting($, on)
  let finish: () => void = () => {}
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finish = r }) : Promise.resolve())
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(15 * 60000 + 1000) // abandoned: try 1
  await clock.advance(200000) // try 2 finds it still out
  expect(seen.toasts.filter((t) => /Compaction has not finished|still running/.test(t)).length).toBe(2)
  finish() // late: the chat is compacted
  seen.failSubmit = true // from here the Resume is refused both ways
  await clock.advance(10 * 60000)
  expect(seen.toasts.filter((t) => /Could not send Resume after four tries/.test(t)).length).toBe(1)
  expect(seen.toasts.filter((t) => /Compaction did not finish, so the Resume was not sent after four tries/.test(t))).toEqual([])
})

// ===== review round 26: the put-back, a replaced chat and the compaction marks =====
const WAKE_TEXT = 'Usage reset: the 5h limit capped, so the CLI account was rotated to C. Go on.'
// Cold-send dialogs the test answers by hand: the first `auto` answer "Compact first" at once, the later ones wait for release(label)
function heldAsk(on: any, auto = 1) {
  const waiting: ((label: string) => void)[] = []
  let n = 0
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    const q = e.questions?.[0]
    const reply = (label: string) => ({ result: { questions: e.questions, answers: { [q?.question ?? '']: label } } })
    if (++n <= auto) return reply('Compact first, then send')
    return new Promise((resolve) => waiting.push((label) => resolve(reply(label))))
  })
  return { release: (label: string) => waiting.shift()!(label) }
}
const hang = (seen: any) => { let n = 0; seen.duringCompact = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve()) }

test('a wake-up arriving after the put-back keeps the text still in the box: the fill is the unsent text and then the wake-up\'s', SETUP, async ($, on) => {
  askLog(on)
  const { clock, seen, fills } = await coldChat($, on)
  hang(seen)
  await send($, 'one')
  await clock.advance(100)
  await send($, 'two')
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['one\n\ntwo'])
  await clock.advance(60000)
  await send($, WAKE_TEXT)
  await clock.advance(1000)
  expect(fills).toEqual(['one\n\ntwo', 'one\n\ntwo\n\n' + WAKE_TEXT])
  expect(seen.compacts).toBe(1)
})

test('a wake-up released by a cold-send dialog after the batch was filled is put back behind the batch, not over it', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const { clock, seen, fills } = await coldChat($, on)
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  await send($, WAKE_TEXT) // waits on the compaction
  await clock.advance(1000)
  void send($, 'x') // a dialog opens and stays open
  await clock.advance(15 * 60000) // abandoned: 'one' goes back; the wake-up waits for the dialog
  expect(fills).toEqual(['one'])
  dialogs.release('Cancel')
  await clock.advance(1000)
  expect(fills).toEqual(['one', 'one\n\n' + WAKE_TEXT])
})

test('a "Compact first" answered after the abandonment is put back behind the text still in the box', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const { clock, seen, fills } = await coldChat($, on)
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  void send($, 'three') // its dialog stays open
  await clock.advance(15 * 60000)
  expect(fills).toEqual(['one'])
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect({ fills, compacts: seen.compacts, submits: seen.submits }).toEqual({ fills: ['one', 'one\n\nthree'], compacts: 1, submits: [] })
})

test('a slash command put back while text is still in the box is quoted in a toast, and the box keeps its text', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const { clock, seen, fills } = await coldChat($, on)
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  void send($, '/merge-pr 1', { name: 'merge-pr', args: '1' }) // its dialog stays open
  await clock.advance(15 * 60000)
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect(fills).toEqual(['one'])
  expect(seen.toasts.filter((t) => /Also not sent: \/merge-pr 1/.test(t)).length).toBe(1)
})

test('a "Compact first" message from before a /clear is not sent into the new chat: a toast quotes it', SETUP, async ($, on) => {
  askLog(on)
  let finish: () => void = () => {}
  const { clock, seen, fills } = await coldChat($, on, () => on('classic.SessionStart', () => ({})))
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finish = r }) : Promise.resolve())
  await send($, 'old chat message')
  await clock.advance(60000)
  await ($ as any).classic.SessionStart({ source: 'clear' })
  await clock.advance(60000)
  finish()
  await clock.advance(1000)
  expect({ submits: seen.submits, fills }).toEqual({ submits: [], fills: [] })
  expect(seen.toasts.filter((t) => t.includes('Not sent, because the chat was cleared: old chat message')).length).toBe(1)
})

test('a message from before a /clear whose compaction runs out after it is not put back in the new chat\'s box either', SETUP, async ($, on) => {
  askLog(on)
  const { clock, seen, fills } = await coldChat($, on, () => on('classic.SessionStart', () => ({})))
  hang(seen)
  await send($, 'x'.repeat(100))
  await clock.advance(60000)
  await ($ as any).classic.SessionStart({ source: 'clear' })
  await clock.advance(15 * 60000 + 1000)
  expect({ submits: seen.submits, fills }).toEqual({ submits: [], fills: [] })
  const stale = seen.toasts.filter((t) => t.includes('Not sent, because the chat was cleared: '))
  expect(stale.length).toBe(1)
  expect(stale[0]).toContain('x'.repeat(100)) // quoted in full: the person has to type it again
})

test('a wake-up in the new chat does not wait on the old chat\'s hung compaction', SETUP, async ($, on) => {
  askLog(on)
  const { clock, seen } = await coldChat($, on, () => on('classic.SessionStart', () => ({})))
  hang(seen)
  await send($, 'old chat message')
  await clock.advance(60000)
  await ($ as any).classic.SessionStart({ source: 'clear' })
  await mainStep($) // the new chat's first request
  const t0 = await clock.now()
  await send($, WAKE_TEXT)
  let at = -1
  for (let i = 0; i < 20 && at < 0; i++) { await clock.advance(60000); if (seen.submits.length) at = (await clock.now()) - t0 }
  expect(seen.submits).toEqual([WAKE_TEXT])
  expect(at).toBeLessThan(5 * 60000)
  expect(seen.compacts).toBe(2) // its own compaction in the new chat
})

test('a /btw question put back is no hold: the Resume is not kept waiting for a message that never reaches the chat', { options: { autoResume: true } }, async ($, on) => {
  askLog(on)
  const fills: string[] = []
  const { clock, seen } = await resumeCompacting($, on, () => on('prompt.fill', (_: unknown, e: any) => (fills.push(e.text), { isFilled: true })))
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) { await send($, '/btw what is X?', { name: 'btw', args: 'what is X?' }); await new Promise(() => {}) } }
  await clock.advance(91 * 60000 + 1000) // the Resume compacts; the /btw "Compact first" waits on it
  await clock.advance(15 * 60000 + 1000) // abandoned
  expect(fills).toEqual(['/btw what is X?'])
  await send($, '/btw what is X?', { name: 'btw', args: 'what is X?' }) // Enter on the box: it runs locally and never reaches the chat
  await clock.advance(1000)
  expect(await bandText($, /⏸ Resume waits/)).toBeNull()
  await clock.advance(5 * 60000)
  expect(seen.toasts.filter((t) => /Resume was not sent/.test(t)).length).toBeGreaterThan(1) // tried again, not held
})

test('a put-back whose fill failed holds nothing: the Resume is tried and the band shows no wait', { options: { autoResume: true } }, async ($, on) => {
  askLog(on)
  const { clock, seen } = await resumeCompacting($, on, () => on('prompt.fill', () => ({ isFilled: false })))
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) { await send($, 'hold on'); await new Promise(() => {}) } }
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(15 * 60000 + 1000) // abandoned; the message could not be put back
  expect(seen.toasts.filter((t) => /could not be put back: hold on/.test(t)).length).toBe(1)
  await clock.advance(5 * 60000)
  expect(await bandText($, /⏸ Resume waits/)).toBeNull()
  expect(seen.toasts.filter((t) => /Resume was not sent/.test(t)).length).toBeGreaterThan(1) // tried again, not held
})

test('while a put-back message is unsent and the Resume is due the band says it waits for the message, not a time that has passed; once the hold lapses the band is clear', { options: { autoResume: true } }, async ($, on) => {
  const box = { asks: 0 }
  const { clock, seen } = await resumeCompacting($, on, () => {
    answer(on, box, 'Compact first, then send')
    on('prompt.fill', () => ({ isFilled: true }))
  })
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve())
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(5 * 60000)
  await $.prompt.submit({ text: 'hello', origin: COMPOSER, wait: false } as never)
  await clock.advance(10 * 60000 + 2000) // abandoned: 'hello' is back in the box and the cancelled Resume is armed 2 minutes on
  expect(await bandText($, /⏸ Resumes? /)).toMatch(/Resumes /) // not due yet: a time
  await clock.advance(3 * 60000)
  expect(await bandText($, /⏸ Resumes? /)).toBe('⏸ Resume waits for your message')
  await clock.advance(13 * 60000) // 15 minutes after the put-back
  expect(seen.submits).toEqual(['Resume'])
  expect(await bandText($, /⏸ Resumes? /)).toBeNull()
})

test('while a compaction of an earlier chat is still out, the engine\'s compaction marks do not mark the new chat compacted', SETUP, async ($, on) => {
  const log = askLog(on)
  const { clock, seen } = await coldChat($, on, () => (on('classic.SessionStart', () => ({})), on('classic.PostCompact', () => ({}))))
  hang(seen)
  await send($, 'old chat message') // Compact first: hangs
  await clock.advance(60000)
  await ($ as any).classic.SessionStart({ source: 'clear' })
  await mainStep($) // the new chat's first request
  await clock.advance(10 * 60000)
  await ($ as any).classic.PostCompact({}) // the old compaction's late end, as the engine reports it
  await ($ as any).classic.SessionStart({ source: 'compact' })
  await clock.advance(70 * 60000) // the new chat goes cold
  await send($, 'new chat message')
  await clock.advance(1000)
  expect(log.asked.length).toBe(2) // the guard still asks
})

test('an earlier chat\'s compaction out longer than two compaction limits no longer mutes the engine\'s compaction marks', SETUP, async ($, on) => {
  const log = askLog(on)
  const { clock, seen } = await coldChat($, on, () => (on('classic.SessionStart', () => ({})), on('classic.PostCompact', () => ({}))))
  hang(seen)
  await send($, 'old chat message') // Compact first: hangs, never settles
  await clock.advance(60000)
  await ($ as any).classic.SessionStart({ source: 'clear' })
  await mainStep($)
  await clock.advance(31 * 60000) // the old run has been out past two limits
  await ($ as any).classic.PostCompact({}) // the person's own /compact in the new chat
  await ($ as any).classic.SessionStart({ source: 'compact' })
  await clock.advance(60 * 60000)
  await send($, 'new chat message')
  await clock.advance(1000)
  expect(log.asked.length).toBe(1) // marked compacted: the guard does not ask
})

test('an older compaction that succeeds late does not forget a newer abandoned one: the next send that needs a compaction starts none beside it', SETUP, async ($, on) => {
  const log = askLog(on)
  const { clock, seen } = await coldChat($, on)
  let finishA: () => void = () => {}
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finishA = r }) : n === 2 ? new Promise(() => {}) : Promise.resolve())
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000) // A abandoned
  await clock.advance(16 * 60000) // and forgotten, 15 minutes on
  await send($, 'two') // compacts again: B
  await clock.advance(15 * 60000 + 1000) // B abandoned
  expect(seen.compacts).toBe(2)
  finishA() // A succeeds, late
  await clock.advance(1000)
  await mainStep($) // a request: the chat is not just-compacted any more
  await send($, WAKE_TEXT) // the rotation makes the chat cold again
  await send($, 'three') // the dialog: B is still out
  await clock.advance(1000)
  expect(log.asked[log.asked.length - 1].labels).toEqual(['Send anyway', 'Cancel'])
  expect(seen.compacts).toBe(2)
})

test('a message waiting on a shared compaction when the chat is cleared is not sent into the new chat, nor does it start a compaction there', SETUP, async ($, on) => {
  askLog(on)
  const { clock, seen, fills } = await coldChat($, on, () => on('classic.SessionStart', () => ({})))
  hang(seen)
  await send($, 'first') // its compaction hangs
  await clock.advance(1000)
  await send($, 'second') // waits on it
  await clock.advance(1000)
  await ($ as any).classic.SessionStart({ source: 'clear' })
  await clock.advance(15 * 60000 + 1000) // the old compaction is abandoned: both wait no longer
  expect({ compacts: seen.compacts, submits: seen.submits, fills }).toEqual({ compacts: 1, submits: [], fills: [] })
  expect(seen.toasts.filter((t) => /Not sent, because the chat was cleared: (first|second)/.test(t)).length).toBe(2)
})

test('a /clear between the abandonment and the put-back fill leaves the new chat\'s box alone', SETUP, async ($, on) => {
  askLog(on)
  const { clock, seen, fills } = await coldChat($, on, () => on('classic.SessionStart', () => ({})))
  hang(seen)
  await send($, 'one') // its compaction starts 50 ms on and is abandoned 15 minutes after that; the fill follows 50 ms later
  await clock.advance(50 + 15 * 60000 + 20)
  expect(seen.toasts.filter((t) => /Compaction has not finished/.test(t))).toEqual([]) // not put back yet
  await ($ as any).classic.SessionStart({ source: 'clear' })
  await clock.advance(1000)
  expect(fills).toEqual([])
  expect(seen.toasts.filter((t) => t.includes('Not sent, because the chat was cleared: one')).length).toBe(1)
})

test('a message put back while an unsent slash command is in the box is filled, and the command is quoted in full in a toast: nothing is lost, nothing is joined', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const { clock, seen, fills } = await coldChat($, on)
  hang(seen)
  const slash = '/merge-pr 1 --with-a-long-flag-list ' + 'x'.repeat(90)
  await send($, slash, { name: 'merge-pr', args: '1' }) // its compaction hangs, then it is put back alone
  await clock.advance(1000)
  const long = 'Please refactor the parser so it handles nested quotes, then add tests for the three edge cases we discussed yesterday.'
  void send($, long) // its dialog stays open
  await clock.advance(15 * 60000)
  expect(fills).toEqual([slash])
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect(fills).toEqual([slash, long])
  expect(seen.toasts.filter((t) => t.includes(`Also not sent: ${slash} — send it again when ready.`)).length).toBe(1)
  expect(seen.toasts.filter((t) => /Also not sent: Please/.test(t))).toEqual([])
})

// The band's segment matching re as drawn, or null when it shows none
async function bandText($: any, re: RegExp) {
  const ui = await $.ui.mount({ plugin: 'test', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 200, rows: 30 }, props: {} } as never)
  const seg: any = await ui.find({ type: 'Text', text: re })
  return seg ? String(seg.text).trim() : null
}

// ===== review round 27: engine marks, the box text, a replaced chat =====
test('the engine\'s compaction mark for an older run\'s late end, more than two COMPACT_LIMITs after that run started, is taken for a compaction of the chat: it clears a newer abandonment, and the next cold send offers "Compact first" again', SETUP, async ($, on) => {
  const log = askLog(on)
  const { clock, seen } = await coldChat($, on, () => (on('classic.SessionStart', () => ({})), on('classic.PostCompact', () => ({}))))
  let finishA: () => void = () => {}
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finishA = r }) : n === 2 ? new Promise(() => {}) : Promise.resolve())
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000) // A abandoned
  await clock.advance(16 * 60000) // and forgotten, 15 minutes on
  await send($, 'two') // compacts again: B
  await clock.advance(15 * 60000 + 1000) // B abandoned
  expect(seen.compacts).toBe(2)
  finishA()
  await ($ as any).classic.PostCompact({}) // the engine reports A's end
  await ($ as any).classic.SessionStart({ source: 'compact' })
  await clock.advance(1000)
  await mainStep($) // a request: the chat is not just-compacted any more
  await send($, WAKE_TEXT) // the rotation makes the chat cold again
  await send($, 'three') // the dialog
  await clock.advance(1000)
  expect(log.asked[log.asked.length - 1].labels).toContain('Compact first, then send') // B no longer blocks: A has been out for 46 minutes
  expect(seen.compacts).toBe(3)
})

test('a message waiting on a compaction when the chat is cleared is dropped as soon as that compaction ends, not when the new chat\'s own compaction does', SETUP, async ($, on) => {
  askLog(on)
  const { clock, seen } = await coldChat($, on, () => on('classic.SessionStart', () => ({})))
  let finishA: () => void = () => {}
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finishA = r }) : new Promise(() => {}))
  await send($, 'first')
  await clock.advance(1000)
  await send($, 'second') // waits on the first compaction
  await clock.advance(1000)
  await ($ as any).classic.SessionStart({ source: 'clear' })
  await mainStep($)
  await send($, WAKE_TEXT) // the new chat's own compaction: it hangs
  await clock.advance(60000)
  finishA()
  await clock.advance(1000)
  expect(seen.compacts).toBe(2)
  expect(seen.toasts.filter((t) => t.includes('cleared: second')).length).toBe(1) // not 15 minutes on
  expect(seen.submits).toEqual([])
})

test('a slash command filled after a compaction that finished late does not overwrite unsent put-back text: the command is quoted in a toast', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const { clock, seen, fills } = await coldChat($, on)
  let finishA: () => void = () => {}
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finishA = r }) : Promise.resolve())
  await send($, 'one')
  await clock.advance(1000)
  void send($, '/merge-pr 1', { name: 'merge-pr', args: '1' }) // its dialog stays open
  await clock.advance(15 * 60000) // A abandoned: 'one' is back in the box
  expect(fills).toEqual(['one'])
  finishA() // A succeeds late: the chat counts as compacted
  await clock.advance(1000)
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect(fills).toEqual(['one'])
  expect(seen.compacts).toBe(1)
  expect(seen.toasts.filter((t) => t.includes('Also not sent: /merge-pr 1 — send it again when ready.')).length).toBe(1)
})

test('a /btw question put back is tracked in the box: a wake-up put back after it is filled, and the question is quoted in full in a toast', { options: { ...SETUP.options, autoResume: true } }, async ($, on) => {
  askLog(on)
  const fills: string[] = []
  const { clock, seen } = await resumeCompacting($, on, () => on('prompt.fill', (_: unknown, e: any) => (fills.push(e.text), { isFilled: true })))
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) { await send($, '/btw what is X?', { name: 'btw', args: 'what is X?' }); await new Promise(() => {}) } }
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(15 * 60000 + 1000) // abandoned: the question is back in the box
  expect(fills).toEqual(['/btw what is X?'])
  await send($, WAKE_TEXT)
  await clock.advance(1000)
  expect(fills).toEqual(['/btw what is X?', WAKE_TEXT])
  expect(seen.toasts.filter((t) => t.includes('Also not sent: /btw what is X? — send it again when ready.')).length).toBe(1)
})

test('a message put back after the Resume hold has lapsed still goes behind the unsent text in the box', SETUP, async ($, on) => {
  askLog(on)
  const { clock, seen, fills } = await coldChat($, on)
  let n = 0
  seen.duringCompact = () => (++n <= 2 ? new Promise(() => {}) : Promise.resolve())
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000) // abandoned: 'one' is back in the box
  expect(fills).toEqual(['one'])
  await clock.advance(16 * 60000) // the abandonment and the Resume hold have both run out
  await send($, 'two') // compacts again (hangs)
  await clock.advance(15 * 60000 + 1000)
  expect(seen.compacts).toBe(2)
  expect(fills).toEqual(['one', 'one\n\ntwo'])
})

test('what the box holds is read from it: the person\'s edit of the put-back text is left untouched, and a later put-back is quoted in full instead of filled', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const box: { edit: string | null; filled: string[] } = { edit: null, filled: [] } // what the person typed over the last fill, if anything
  const { clock, seen, fills } = await coldChat($, on, () => on('prompt.read', () => { const text = box.edit ?? box.filled[box.filled.length - 1] ?? ''; return { value: { text, cursor: text.length } } }))
  box.filled = fills
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  void send($, 'three') // its dialog stays open
  await clock.advance(15 * 60000)
  expect(fills).toEqual(['one'])
  box.edit = 'one, but edited' // the person edits the box
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect(fills).toEqual(['one']) // the edit stands: nothing was filled over it
  expect(seen.toasts.filter((t) => t.includes('Also not sent: three — send it again when ready.')).length).toBe(1)
})

test('what the box holds is read from it: text the person deleted does not come back with a later fill', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const box: { edit: string | null; filled: string[] } = { edit: null, filled: [] } // what the person typed over the last fill, if anything
  const { clock, seen, fills } = await coldChat($, on, () => on('prompt.read', () => { const text = box.edit ?? box.filled[box.filled.length - 1] ?? ''; return { value: { text, cursor: text.length } } }))
  box.filled = fills
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  void send($, 'three')
  await clock.advance(15 * 60000)
  expect(fills).toEqual(['one'])
  box.edit = '' // the person deletes it
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect(fills).toEqual(['one', 'three'])
})

test('put-back text is no longer in the box once a request has started: a later put-back is filled alone', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const { clock, seen, fills } = await coldChat($, on)
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  void send($, 'three') // its dialog stays open
  await clock.advance(15 * 60000)
  expect(fills).toEqual(['one'])
  await mainStep($) // the person sent it and its request started
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect(fills).toEqual(['one', 'three'])
})

test('a "Compact first" message in flight when the chat is branched is still sent: a fork carries the conversation on', SETUP, async ($, on) => {
  askLog(on)
  let finish: () => void = () => {}
  const { clock, seen, fills } = await coldChat($, on, () => on('classic.SessionStart', () => ({})))
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finish = r }) : Promise.resolve())
  await send($, 'carry on here')
  await clock.advance(60000)
  await typeBranch($)
  await clock.advance(60000)
  finish()
  await clock.advance(1000)
  expect({ submits: seen.submits, fills }).toEqual({ submits: ['carry on here'], fills: [] })
  expect(seen.toasts.filter((t) => /Not sent/.test(t))).toEqual([])
})

test('a "Compact first" message from before the chat was replaced by a resumed one is not sent into it, and the toast says so, quoting it in full', SETUP, async ($, on) => {
  askLog(on)
  let finish: () => void = () => {}
  const { clock, seen, fills } = await coldChat($, on, () => on('classic.SessionStart', () => ({})))
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finish = r }) : Promise.resolve())
  const long = 'resume the work on the parser, ' + 'and then run the whole test suite twice. '.repeat(3)
  await send($, long)
  await clock.advance(60000)
  await ($ as any).classic.SessionStart({ source: 'resume' })
  await clock.advance(60000)
  finish()
  await clock.advance(1000)
  expect({ submits: seen.submits, fills }).toEqual({ submits: [], fills: [] })
  expect(seen.toasts.filter((t) => t.includes(`Not sent, because the chat was replaced by a resumed chat: ${long}`)).length).toBe(1)
  expect(seen.toasts.filter((t) => /was cleared/.test(t))).toEqual([])
})

test('a put-back that arrives while the abandoned batch is still gathering its members goes after the batch, not before it', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const { clock, seen, fills } = await coldChat($, on)
  hang(seen)
  await send($, 'one') // its compaction starts 50 ms on and is abandoned 15 minutes after that
  await clock.advance(1000)
  void send($, 'two') // its dialog stays open
  await clock.advance(50 + 15 * 60000 - 1000 - 20) // 20 ms before the abandonment
  dialogs.release('Compact first, then send') // 'two' starts 50 ms on, 30 ms after the abandonment and 20 ms before the batch's fill
  await clock.advance(200)
  expect(seen.compacts).toBe(1)
  expect(fills).toEqual(['one', 'one\n\ntwo'])
})

// ===== review round 28: wake-ups, forks, the person's own text in the box =====
test('a wake-up cancelled by the person\'s message arms no Resume: with autoResume off none is ever sent, and the band shows none', SETUP, async ($, on) => {
  const log = askLog(on)
  log.prefer('Send anyway')
  let finish: () => void = () => {}
  const { clock, seen } = await coldChat($, on, () => on('ui.render', engineDraws))
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finish = r }) : Promise.resolve())
  await send($, WAKE_TEXT) // the wake-up compacts first, no dialog
  await clock.advance(1000)
  await send($, 'my own message') // Send anyway: handed on while the wake-up compacts
  await clock.advance(1000)
  finish()
  await clock.advance(1000)
  expect(seen.toasts.filter((t) => /the automatic one was not sent/.test(t)).length).toBe(1)
  expect(await bandText($, /⏸ Resumes? /)).toBeNull()
  await clock.advance(3 * 60000) // past the 2 minutes a re-armed Resume would wait; the person's request has not started
  expect(seen.submits).toEqual([])
  expect(seen.compacts).toBe(1)
})

test('a branch while a message waits on a compaction that succeeds: the fork is the same conversation, so the waiter uses it and no second /compact starts', SETUP, async ($, on) => {
  askLog(on)
  let finish: () => void = () => {}
  const { clock, seen, fills } = await coldChat($, on, () => on('classic.SessionStart', () => ({})))
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finish = r }) : Promise.resolve())
  await send($, 'first')
  await clock.advance(1000)
  await send($, 'second') // waits on the first compaction
  await clock.advance(1000)
  await typeBranch($)
  await clock.advance(60000)
  finish()
  await clock.advance(1000)
  expect({ compacts: seen.compacts, submits: seen.submits, fills }).toEqual({ compacts: 1, submits: ['first', 'second'], fills: [] })
})

test('a branch while a message waits on a compaction that hangs: it is still abandoned for the fork, and both messages are put back together in order', SETUP, async ($, on) => {
  askLog(on)
  const { clock, seen, fills } = await coldChat($, on, () => on('classic.SessionStart', () => ({})))
  hang(seen)
  await send($, 'first')
  await clock.advance(1000)
  await send($, 'second')
  await clock.advance(1000)
  await typeBranch($)
  await clock.advance(15 * 60000 + 1000)
  await clock.advance(1000)
  expect({ compacts: seen.compacts, submits: seen.submits, fills }).toEqual({ compacts: 1, submits: [], fills: ['first\n\nsecond'] })
})

test('a compaction of ours still out when the chat is branched does not mute the engine\'s compaction marks in the fork: the person\'s own /compact there counts', SETUP, async ($, on) => {
  const log = askLog(on)
  const { clock, seen } = await coldChat($, on, () => (on('classic.SessionStart', () => ({})), on('classic.PostCompact', () => ({}))))
  hang(seen)
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000) // abandoned, still out
  await typeBranch($)
  await ($ as any).classic.PostCompact({}) // the person's own /compact in the fork succeeds
  await ($ as any).classic.SessionStart({ source: 'compact' })
  await clock.advance(1000)
  await send($, 'two')
  await clock.advance(1000)
  expect({ compacts: seen.compacts, asked: log.asked.length }).toEqual({ compacts: 1, asked: 1 }) // 'two' goes as typed: the chat is compacted, no cold-send dialog
})

test('an older run of ours that never settles stops muting the engine\'s compaction marks after two COMPACT_LIMITs: the person\'s own /compact then clears a newer abandonment', SETUP, async ($, on) => {
  const log = askLog(on)
  const { clock, seen } = await coldChat($, on, () => (on('classic.SessionStart', () => ({})), on('classic.PostCompact', () => ({}))))
  let n = 0
  seen.duringCompact = () => (++n <= 2 ? new Promise(() => {}) : Promise.resolve())
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000) // A abandoned
  await clock.advance(16 * 60000) // forgotten
  await send($, 'two') // B
  await clock.advance(15 * 60000 + 1000) // B abandoned, A still out, 46 minutes on
  await ($ as any).classic.PostCompact({}) // the person's own /compact succeeds
  await ($ as any).classic.SessionStart({ source: 'compact' })
  await clock.advance(1000)
  await mainStep($)
  await send($, WAKE_TEXT)
  await send($, 'three')
  await clock.advance(1000)
  expect(log.asked[log.asked.length - 1].labels).toContain('Compact first, then send')
})

// What the box holds, as the engine's prompt.read answers it: the text the person has typed since the last fill, else the last fill
function readsBox(on: any, box: { edit: string | null; filled: string[] }) {
  on('prompt.read', () => { const text = box.edit ?? box.filled[box.filled.length - 1] ?? ''; return { value: { text, cursor: text.length } } })
}

test('a draft the person is typing, starting with "/", stays in the box when a put-back arrives: the put-back is quoted in full instead', SETUP, async ($, on) => {
  askLog(on)
  const box: { edit: string | null; filled: string[] } = { edit: null, filled: [] }
  const { clock, seen, fills } = await coldChat($, on, () => readsBox(on, box))
  box.filled = fills
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  box.edit = '/Users/me/project/src/parser.ts throws on nested quotes, can you look' // the person is typing their next message
  await clock.advance(15 * 60000)
  expect(fills).toEqual([]) // the draft is not replaced, and not moved to a toast
  expect(seen.toasts.filter((t) => t.includes('Also not sent: one — send it again when ready.')).length).toBe(1)
  expect(seen.toasts.filter((t) => t.includes('/Users/me/project'))).toEqual([])
})

test('a draft typed after the message stays as it is when a put-back arrives: nothing is put in front of it or reordered, the put-back is quoted', SETUP, async ($, on) => {
  askLog(on)
  const box: { edit: string | null; filled: string[] } = { edit: null, filled: [] }
  const { clock, seen, fills } = await coldChat($, on, () => readsBox(on, box))
  box.filled = fills
  hang(seen)
  await send($, 'step one: rename the module')
  await clock.advance(1000)
  box.edit = 'step two: then update the imports'
  await clock.advance(15 * 60000)
  expect(fills).toEqual([])
  expect(seen.toasts.filter((t) => t.includes('Also not sent: step one: rename the module — send it again when ready.')).length).toBe(1)
})

test('a put-back with several items and a box that holds the person\'s draft quotes each item in full, one toast each', SETUP, async ($, on) => {
  askLog(on)
  const box: { edit: string | null; filled: string[] } = { edit: null, filled: [] }
  const { clock, seen, fills } = await coldChat($, on, () => readsBox(on, box))
  box.filled = fills
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  await send($, 'two')
  box.edit = 'my own draft'
  await clock.advance(15 * 60000)
  expect(fills).toEqual([])
  expect(seen.toasts.filter((t) => t.includes('Also not sent: one — send it again when ready.')).length).toBe(1)
  expect(seen.toasts.filter((t) => t.includes('Also not sent: two — send it again when ready.')).length).toBe(1)
})

test('a /clear while the put-back is being filled leaves nothing tracked for the new chat: a put-back there is filled alone, with no text of the old chat', SETUP, async ($, on) => {
  askLog(on)
  let clearDuringFill = false
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  const fills: string[] = []
  on('prompt.fill', async (_: unknown, e: any) => {
    fills.push(e.text)
    if (clearDuringFill) { clearDuringFill = false; await ($ as any).classic.SessionStart({ source: 'clear' }) }
    return { isFilled: true }
  })
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: { input_tokens: 10, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 } } })
  on('classic.SessionStart', () => ({}))
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  let n = 0
  seen.duringCompact = () => (++n === 1 || n === 2 ? new Promise(() => {}) : Promise.resolve())
  clearDuringFill = true
  await send($, 'old chat secret plan')
  await clock.advance(15 * 60000 + 1000)
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [], changed: [] })
  await clock.advance(80 * 60000)
  await send($, WAKE_TEXT)
  await clock.advance(1000)
  await send($, 'new chat message')
  await clock.advance(31 * 60000)
  expect(fills).toEqual(['old chat secret plan', 'new chat message'])
  expect(seen.toasts.filter((t) => t.includes('The chat was cleared while your message was being put back: old chat secret plan')).length).toBe(1)
  expect(seen.toasts.filter((t) => t.includes('Not sent, because the chat was cleared: old chat secret plan'))).toEqual([]) // it does not say the text is gone: it may be in the box
})

// A prompt.read the engine has not answered: it answers once `open()` is called (with a draft the mod must no longer be waiting for)
function slowRead(on: any) {
  let open: () => void = () => {}
  const gate = new Promise<void>((resolve) => { open = resolve })
  on('prompt.read', async () => { await gate; return { value: { text: 'a draft typed meanwhile', cursor: 23 } } })
  return { open }
}
const realMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('a prompt.read the engine has not answered is not waited for: after 2 seconds the box is left alone and the message is quoted in a toast', SETUP, async ($, on) => {
  askLog(on)
  const read = slowRead(on)
  const { clock, seen, fills } = await coldChat($, on)
  hang(seen)
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual([]) // the read is out
  expect(seen.toasts.filter((t) => t.includes('Also not sent: one'))).toEqual([])
  await clock.advance(2000)
  expect(fills).toEqual([]) // not answered in time: nothing is known about the box, so nothing is written over it
  expect(seen.toasts.filter((t) => t.includes('Also not sent: one — send it again when ready.')).length).toBe(1)
  read.open() // the late answer is ignored
  await clock.advance(1000)
  await realMs(50)
  expect(fills).toEqual([])
})

test('a prompt.read the engine has not answered does not hold a due Resume for good: the message is quoted without it, and the Resume goes once the hold has lapsed', { options: { autoResume: true } }, async ($, on) => {
  const box = { asks: 0 }
  const fills: string[] = []
  let read = { open: () => {} }
  const { clock, seen } = await resumeCompacting($, on, () => {
    answer(on, box, 'Compact first, then send')
    on('prompt.fill', (_: unknown, e: any) => (fills.push(e.text), { isFilled: true }))
    read = slowRead(on)
  })
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve())
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(5 * 60000)
  await $.prompt.submit({ text: 'hello', origin: COMPOSER, wait: false } as never)
  await clock.advance(10 * 60000 + 2000 + 2000) // abandoned, then the 2 second read limit
  expect(fills).toEqual([])
  expect(seen.toasts.filter((t) => t.includes('Also not sent: hello — send it again when ready.')).length).toBe(1)
  read.open()
  await realMs(50)
  await clock.advance(16 * 60000)
  await realMs(50)
  await clock.advance(1000)
  expect(seen.submits).toEqual(['Resume'])
})

test('a message sent after a branch, while the compaction started before it is still running, waits for that compaction instead of starting a second /compact beside it', SETUP, async ($, on) => {
  askLog(on)
  let finish: () => void = () => {}
  const { clock, seen, fills } = await coldChat($, on, () => on('classic.SessionStart', () => ({})))
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finish = r }) : Promise.resolve())
  await send($, 'first')
  await clock.advance(1000)
  await typeBranch($)
  await clock.advance(1000)
  await send($, 'second') // the fork's own message: the same conversation, so it waits
  await clock.advance(60000)
  expect(seen.compacts).toBe(1)
  finish()
  await clock.advance(1000)
  expect({ compacts: seen.compacts, submits: seen.submits, fills }).toEqual({ compacts: 1, submits: ['first', 'second'], fills: [] })
})

// ===== review round 28: the box read and fill, the quoted put-back and a branch =====
test('a message quoted because the box holds the person\'s own draft holds a due Resume until it is sent or 15 minutes pass', { options: { ...SETUP.options, autoResume: true } }, async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  const fills: string[] = []
  on('prompt.fill', (_: unknown, e: any) => (fills.push(e.text), { isFilled: true }))
  let draft = ''
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  answer(on, seen, 'Compact first, then send')
  on('classic.StopFailure', () => ({}))
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 4 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  let finish: () => void = () => {}
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finish = r }) : Promise.resolve())
  await $.prompt.submit({ text: 'stop, do X instead', origin: COMPOSER, wait: false } as never)
  await clock.advance(60000)
  draft = 'and also look at Y' // the person types a draft while the compaction runs
  let quotedAt = 0
  for (let i = 0; i < 20 && !quotedAt; i++) {
    await clock.advance(60000)
    if (seen.toasts.some((t) => t.includes('Also not sent: stop, do X instead'))) quotedAt = await clock.now()
  }
  expect(quotedAt).toBeGreaterThan(0)
  expect(fills).toEqual([]) // the draft is left as it is
  finish() // the abandoned compaction ends late, successfully: nothing else keeps the Resume back
  await clock.advance(10 * 60000)
  expect(seen.submits).toEqual([]) // the Resume does not go ahead of the message still to be sent
  await clock.advance(6 * 60000) // 15 minutes since the message was quoted
  expect(seen.submits).toEqual(['Resume'])
})

test('a message sent during a prompt.read that does not answer is not put back from the text tracked before the read', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const ref: { fills: string[] } = { fills: [] }
  let mode: 'answer' | 'hang' = 'answer'
  const { clock, seen, fills } = await coldChat($, on, () => {
    on('prompt.read', () => (mode === 'hang' ? new Promise(() => {}) : { value: { text: ref.fills[ref.fills.length - 1] ?? '', cursor: 0 } }))
  })
  ref.fills = fills
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  void send($, 'three') // its dialog stays open
  await clock.advance(15 * 60000)
  expect(fills).toEqual(['one'])
  mode = 'hang'
  dialogs.release('Compact first, then send') // 'three' is put back: the read does not answer
  await clock.advance(500)
  void send($, 'one') // the person presses Enter on the box during the read
  await clock.advance(10)
  dialogs.release('Send anyway')
  await clock.advance(10)
  await mainStep($) // its request starts
  await clock.advance(3000)
  expect(fills).toEqual(['one']) // 'one' was sent: it does not come back in front of 'three'
  expect(seen.toasts.filter((t) => t.includes('Also not sent: three — send it again when ready.')).length).toBe(1)
})

test('a prompt.read that fails after the put-back text was sent does not bring the sent text back', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  let mode: 'answer' | 'fail' = 'answer'
  let fail: () => void = () => {}
  const failing = new Promise<never>((_, reject) => { fail = () => reject(new Error('no read')) })
  failing.catch(() => {})
  const ref: { fills: string[] } = { fills: [] }
  const { clock, seen, fills } = await coldChat($, on, () => {
    on('prompt.read', async () => {
      if (mode === 'fail') await failing
      return { value: { text: ref.fills[ref.fills.length - 1] ?? '', cursor: 0 } }
    })
  })
  ref.fills = fills
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  void send($, 'three')
  await clock.advance(15 * 60000)
  expect(fills).toEqual(['one'])
  mode = 'fail'
  dialogs.release('Compact first, then send') // 'three' is put back: the read is out
  await clock.advance(300)
  void send($, 'one') // the person presses Enter on the box during the read
  await clock.advance(10)
  dialogs.release('Send anyway')
  await clock.advance(10)
  await mainStep($)
  fail() // the read fails, inside its 2 seconds
  await clock.advance(500)
  expect(fills).toEqual(['one', 'three']) // not 'one\n\nthree'
})

test('a prompt.read that does not answer leaves the person\'s draft alone, and the tracked text is dropped once a read shows the box is not ours', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const box: { edit: string | null; hang: boolean } = { edit: null, hang: false }
  const ref: { fills: string[] } = { fills: [] }
  const { clock, seen, fills } = await coldChat($, on, () => on('prompt.read', () => {
    if (box.hang) return new Promise(() => {})
    const text = box.edit ?? ref.fills[ref.fills.length - 1] ?? ''
    return { value: { text, cursor: text.length } }
  }))
  ref.fills = fills
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  void send($, 'three')
  await clock.advance(15 * 60000)
  expect(fills).toEqual(['one'])
  box.edit = 'my own draft'
  dialogs.release('Compact first, then send') // a read shows the draft: 'three' is quoted and 'one' is no longer tracked
  await clock.advance(1000)
  expect(seen.toasts.filter((t) => t.includes('Also not sent: three'))).toHaveLength(1)
  expect(fills).toEqual(['one'])
  box.hang = true // the engine stops answering reads
  let m = 0
  seen.duringCompact = () => (++m === 1 ? new Promise(() => {}) : Promise.resolve())
  await clock.advance(16 * 60000)
  void send($, 'four') // its dialog: compacts again (hangs), and is put back after 15 minutes
  await clock.advance(10)
  dialogs.release('Compact first, then send')
  await clock.advance(15 * 60000 + 5000)
  expect(fills).toEqual(['one']) // not 'one\n\nfour': the old text is not the box's
  expect(seen.toasts.filter((t) => t.includes('Also not sent: four'))).toHaveLength(1)
})

test('a read that showed the person\'s draft ends the tracking of the put-back text: a later read that fails does not bring it back', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const box: { edit: string | null; hang: boolean; broken: boolean } = { edit: null, hang: false, broken: false }
  const ref: { fills: string[] } = { fills: [] }
  const { clock, seen, fills } = await coldChat($, on, () => on('prompt.read', () => {
    if (box.hang) return new Promise(() => {})
    if (box.broken) throw new Error('no read')
    const text = box.edit ?? ref.fills[ref.fills.length - 1] ?? ''
    return { value: { text, cursor: text.length } }
  }))
  ref.fills = fills
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  void send($, 'three')
  await clock.advance(15 * 60000)
  expect(fills).toEqual(['one'])
  box.edit = 'my own draft'
  dialogs.release('Compact first, then send') // a read shows the draft: 'three' is quoted and 'one' is no longer tracked
  await clock.advance(1000)
  expect(seen.toasts.filter((t) => t.includes('Also not sent: three'))).toHaveLength(1)
  expect(fills).toEqual(['one'])
  box.broken = true // the engine can no longer read the box
  let m = 0
  seen.duringCompact = () => (++m === 1 ? new Promise(() => {}) : Promise.resolve())
  await clock.advance(16 * 60000)
  void send($, 'four') // its dialog: compacts again (hangs), and is put back after 15 minutes
  await clock.advance(10)
  dialogs.release('Compact first, then send')
  await clock.advance(15 * 60000 + 5000)
  expect(fills).toEqual(['one', 'four']) // not 'one\n\nfour': the old text is not the box's
})

test('a prompt.read that answers with the put-back text after it was sent does not merge the sent text again', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const ref: { fills: string[] } = { fills: [] }
  let slow = false
  let open: () => void = () => {}
  const gate = new Promise<void>((resolve) => { open = resolve })
  const { clock, seen, fills } = await coldChat($, on, () => {
    on('prompt.read', async () => {
      const text = ref.fills[ref.fills.length - 1] ?? '' // what the box held when the read began
      if (slow) await gate
      return { value: { text, cursor: text.length } }
    })
  })
  ref.fills = fills
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  void send($, 'three')
  await clock.advance(15 * 60000)
  expect(fills).toEqual(['one'])
  slow = true
  dialogs.release('Compact first, then send') // 'three' is put back: the read is out
  await clock.advance(300)
  void send($, 'one') // the person presses Enter on the box during the read
  await clock.advance(10)
  dialogs.release('Send anyway')
  await clock.advance(10)
  await mainStep($)
  open() // the read answers, inside its 2 seconds, with the text that has been sent
  await clock.advance(500)
  expect(fills).toEqual(['one']) // not 'one\n\nthree'
  expect(seen.toasts.filter((t) => t.includes('Also not sent: three — send it again when ready.')).length).toBe(1)
})

test('a prompt.read that is missing in the engine leaves the tracked put-back text standing: a later put-back goes behind it', SETUP, async ($, on) => {
  askLog(on)
  const { clock, seen, fills } = await coldChat($, on) // no prompt.read hook: the call throws
  let n = 0
  seen.duringCompact = () => (++n <= 2 ? new Promise(() => {}) : Promise.resolve())
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['one'])
  await clock.advance(16 * 60000)
  await send($, 'two')
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['one', 'one\n\ntwo'])
})

// A read the engine has but that fails ({ deny } is how the test engine rejects a call; a hook that throws is skipped, as if the engine had no read)
test('a prompt.read the engine rejects once does not make the tracked text the box: the person\'s edit of the put-back is left alone and the message quoted', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const box: { edit: string | null; broken: boolean } = { edit: null, broken: false }
  const ref: { fills: string[] } = { fills: [] }
  const { clock, seen, fills } = await coldChat($, on, () => on('prompt.read', () => {
    if (box.broken) return { deny: 'the box could not be read' }
    const text = box.edit ?? ref.fills[ref.fills.length - 1] ?? ''
    return { value: { text, cursor: text.length } }
  }))
  ref.fills = fills
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  void send($, 'three')
  await clock.advance(15 * 60000)
  expect(fills).toEqual(['one'])
  box.edit = 'one, edited by me' // the person edits the put-back
  box.broken = true // and this read fails
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect(fills).toEqual(['one']) // nothing written over the edit
  expect(seen.toasts.filter((t) => t.includes('Also not sent: three — send it again when ready.'))).toHaveLength(1)
})

test('text the person deleted does not come back when the engine later has no way to read the box: a read that showed the box empty ended the tracking', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const box: { edit: string | null; gone: boolean } = { edit: null, gone: false }
  const ref: { fills: string[] } = { fills: [] }
  const { clock, seen, fills } = await coldChat($, on, () => on('prompt.read', () => {
    if (box.gone) throw new Error('no read') // the hook is skipped: the engine has no implementation
    const text = box.edit ?? ref.fills[ref.fills.length - 1] ?? ''
    return { value: { text, cursor: text.length } }
  }), (e) => ({ isFilled: e.text !== 'three' })) // the fill of 'three' fails: nothing is tracked for it
  ref.fills = fills
  hang(seen)
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['one'])
  box.edit = '' // the person deletes the put-back
  void send($, 'three')
  await clock.advance(100)
  dialogs.release('Compact first, then send') // the read shows the box empty
  await clock.advance(1000)
  expect(fills).toEqual(['one', 'three'])
  box.gone = true
  void send($, 'five')
  await clock.advance(100)
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect(fills).toEqual(['one', 'three', 'five']) // not 'one\n\nfive'
})

// A fill the engine answers after the 2 s bound may still have landed: the box is unknown
test('a fill that did not answer in time may still land: the toast says the message may not have been put back, nothing is tracked, and the next put-back leaves the box alone', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const box = { text: '' }
  const { clock, seen, fills } = await coldChat($, on, () => on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } })), (e) => {
    if (e.text.includes('one')) return new Promise(() => {}) // never answers (and never lands, here)
    box.text = e.text
    return { isFilled: true }
  })
  hang(seen)
  await send($, 'zero')
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['zero'])
  void send($, 'one')
  await clock.advance(100)
  dialogs.release('Compact first, then send') // 'zero' is in the box: the fill of 'zero\n\none' does not answer
  await clock.advance(1000)
  expect(seen.toasts.filter((t) => /may not have been put back/.test(t))).toEqual([]) // not within 2 seconds
  await clock.advance(1500)
  expect(fills).toEqual(['zero', 'zero\n\none'])
  expect(seen.toasts.filter((t) => t.includes('the message may not have been put back: one'))).toHaveLength(1)
  expect(seen.toasts.filter((t) => t.includes('could not be put back'))).toEqual([])
  void send($, 'two')
  await clock.advance(100)
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect(fills).toEqual(['zero', 'zero\n\none']) // 'zero' is no longer trusted as what the box holds: nothing is filled over it
  expect(seen.toasts.filter((t) => t.includes('Also not sent: two — send it again when ready.'))).toHaveLength(1)
})

// The box is empty when the fill of the first put-back times out: a read while that fill is still out shows an empty box, which must not be taken as free to write
function lateFill(on: any, box: { text: string }) {
  const ctl: { land: (isFilled?: boolean) => void } = { land: () => {} }
  const fill = (e: any) => new Promise((resolve) => { ctl.land = (isFilled = true) => { if (isFilled) box.text = e.text; resolve({ isFilled }) } })
  return { ctl, fill }
}

test('a put-back while an earlier fill that did not answer in time is still out quotes its message and leaves the box alone, even though a read shows the box empty', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const box = { text: '' }
  const { ctl, fill } = lateFill(on, box)
  const { clock, seen, fills } = await coldChat($, on, () => on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } })), fill)
  hang(seen)
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000)
  await clock.advance(2500)
  expect(fills).toEqual(['one'])
  expect(seen.toasts.filter((t) => t.includes('the message may not have been put back: one'))).toHaveLength(1)
  void send($, 'two')
  await clock.advance(100)
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect(fills).toEqual(['one']) // not filled over the late fill
  expect(seen.toasts.filter((t) => t.includes('Also not sent: two — send it again when ready.'))).toHaveLength(1)
  ctl.land() // it lands now: the box holds 'one', which 'two' did not overwrite
  await realMs(50)
  expect(box.text).toBe('one')
})

test('once the fill that did not answer in time has settled without landing, the next put-back reads the box and fills it again', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const box = { text: '' }
  const { ctl, fill } = lateFill(on, box)
  let first = true
  const { clock, seen, fills } = await coldChat($, on, () => on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } })), (e: any) => {
    if (first) { first = false; return fill(e) }
    box.text = e.text
    return { isFilled: true }
  })
  hang(seen)
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000)
  await clock.advance(2500)
  ctl.land(false) // the engine answers late: it did not fill
  await realMs(50)
  await clock.advance(1000)
  void send($, 'two')
  await clock.advance(100)
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect(fills).toEqual(['one', 'two'])
  expect(seen.toasts.filter((t) => t.includes('Also not sent: two'))).toEqual([])
})

test('a /clear while a fill that did not answer in time is still out lets the next chat\'s put-back read the box', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const box = { text: '' }
  const { fill } = lateFill(on, box)
  let first = true
  const { clock, seen, fills } = await coldChat($, on, () => { on('classic.SessionStart', () => ({})); on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } })) }, (e: any) => {
    if (first) { first = false; return fill(e) } // never settles
    box.text = e.text
    return { isFilled: true }
  })
  let n = 0
  seen.duringCompact = () => (++n <= 2 ? new Promise(() => {}) : Promise.resolve()) // both compactions hang: both messages are put back
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000)
  await clock.advance(2500)
  await ($ as any).classic.SessionStart({ source: 'clear', transcript_path: '/h/other.jsonl' })
  await mainStep($) // the new chat has a big request (300k cached)
  await clock.advance(77 * 60000) // and its cache is cold
  void send($, 'two')
  await clock.advance(100)
  dialogs.release('Compact first, then send')
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['one', 'two'])
})

test('a fill that answers only after the 2 s bound and lands: the box then holds it, and a later put-back quotes its message instead of writing over the box', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const box = { text: '' }
  let land: () => void = () => {}
  const { clock, seen, fills } = await coldChat($, on, () => on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } })), (e) => {
    if (!e.text.includes('one')) { box.text = e.text; return { isFilled: true } }
    return new Promise((resolve) => { land = () => { box.text = e.text; resolve({ isFilled: true }) } })
  })
  hang(seen)
  await send($, 'zero')
  await clock.advance(15 * 60000 + 1000)
  void send($, 'one')
  await clock.advance(100)
  dialogs.release('Compact first, then send')
  await clock.advance(2500)
  expect(seen.toasts.filter((t) => t.includes('the message may not have been put back: one'))).toHaveLength(1)
  land() // the engine answers late, after the bound, and the text is in the box
  await realMs(50)
  await clock.advance(1000)
  expect(box.text).toBe('zero\n\none')
  void send($, 'two')
  await clock.advance(100)
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect(fills).toEqual(['zero', 'zero\n\none'])
  expect(seen.toasts.filter((t) => t.includes('Also not sent: two — send it again when ready.'))).toHaveLength(1)
})

test('a box the host gives back with a trailing newline or CRLF is still the put-back text: a later put-back merges with it', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const ending = { text: '\n' }
  const { clock, seen, fills } = await coldChat($, on, () => on('prompt.read', () => { const text = (fills[fills.length - 1] ?? '') + (fills.length ? ending.text : ''); return { value: { text, cursor: text.length } } }))
  hang(seen)
  await send($, 'one')
  await clock.advance(1000)
  void send($, 'three')
  await clock.advance(15 * 60000)
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect(fills).toEqual(['one', 'one\n\nthree'])
  expect(seen.toasts.filter((t) => t.includes('Also not sent'))).toEqual([])
})

test('a box with CRLF line ends is compared as the put-back text', SETUP, async ($, on) => {
  const dialogs = heldAsk(on)
  const { clock, seen, fills } = await coldChat($, on, () => on('prompt.read', () => { const text = (fills[fills.length - 1] ?? '').replace(/\n/g, '\r\n'); return { value: { text, cursor: text.length } } }))
  hang(seen)
  await send($, 'one\ntwo')
  await clock.advance(1000)
  void send($, 'three')
  await clock.advance(15 * 60000)
  dialogs.release('Compact first, then send')
  await clock.advance(1000)
  expect(fills).toEqual(['one\ntwo', 'one\ntwo\n\nthree'])
})

test('a prompt.fill that never answers is not waited for: the message is reported as possibly not put back, and the next put-back is quoted while that fill is still out', SETUP, async ($, on) => {
  askLog(on)
  let asked = 0
  const { clock, seen } = await coldChat($, on, () => {}, () => (asked++, new Promise(() => {})))
  let n = 0
  seen.duringCompact = () => (++n <= 2 ? new Promise(() => {}) : Promise.resolve())
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000)
  expect(asked).toBe(1)
  await clock.advance(2000)
  expect(seen.toasts.filter((t) => t.includes('the message may not have been put back: one')).length).toBe(1)
  await clock.advance(16 * 60000)
  await send($, 'two') // compacts again (hangs) and is put back after 15 minutes
  await clock.advance(15 * 60000 + 1000)
  expect(asked).toBe(1) // the first fill is still out and may land: the box is not written to again
  await clock.advance(3000)
  expect(asked).toBe(1)
  expect(seen.toasts.filter((t) => t.includes('Also not sent: two — send it again when ready.')).length).toBe(1)
  expect(seen.toasts.filter((t) => t.includes('may not have been put back: two')).length).toBe(0)
})

test('a prompt.fill that never answers holds a due Resume as a put-back does (the message may be in the box), for 15 minutes and not for good', { options: { ...SETUP.options, autoResume: true } }, async ($, on) => {
  const kept = new Map<string, unknown>()
  const { clock, seen } = engine($, on, { label: 'A' }, kept)
  let asked = 0
  on('prompt.fill', () => (asked++, new Promise(() => {})))
  answer(on, seen, 'Compact first, then send')
  on('classic.StopFailure', () => ({}))
  await clock.advance(60000)
  kept.set('last:sid-test', { ctx: 300000, at: await clock.now(), model: 'claude-opus-5-5' })
  await clock.advance(77 * 60000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 300000, window: 1000000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 4 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  let finish: () => void = () => {}
  let n = 0
  seen.duringCompact = () => (++n === 1 ? new Promise<void>((r) => { finish = r }) : Promise.resolve())
  await $.prompt.submit({ text: 'stop, do X instead', origin: COMPOSER, wait: false } as never)
  await clock.advance(16 * 60000) // the compaction is abandoned and the put-back fill never answers
  expect(asked).toBe(1)
  finish() // the compaction ends late, successfully
  await clock.advance(10 * 60000)
  expect(seen.submits).toEqual([]) // the message may be in the box and unsent: the Resume waits for it
  await clock.advance(6 * 60000) // 15 minutes after the put-back
  expect(seen.submits).toEqual(['Resume'])
})

test('a /clear while the put-back is being filled still quotes what the fill left out, and does not tell it again', SETUP, async ($, on) => {
  askLog(on)
  let clearDuringFill = false
  const { clock, seen, fills } = await coldChat($, on, () => on('classic.SessionStart', () => ({})), async () => {
    if (clearDuringFill) { clearDuringFill = false; await ($ as any).classic.SessionStart({ source: 'clear' }) }
    return { isFilled: true }
  })
  hang(seen)
  clearDuringFill = true
  await send($, 'one')
  await clock.advance(1000)
  await send($, '/merge-pr 1', { name: 'merge-pr', args: '1' }) // waits on the compaction: in the same batch, quoted because a slash command is never joined
  await clock.advance(15 * 60000 + 1000)
  expect(fills.length).toBeGreaterThan(0)
  expect(seen.toasts.filter((t) => t.includes('Also not sent: /merge-pr 1 — send it again when ready.'))).toHaveLength(1)
  expect(seen.toasts.filter((t) => t.includes('The chat was cleared while your message was being put back: one'))).toHaveLength(1)
  expect(seen.toasts.filter((t) => t.includes('while your message was being put back: /merge-pr 1'))).toEqual([]) // quoted already
})

// ----- a branch carries the conversation on: the Resume with it -----
async function resumeBranching($: any, on: any, before?: () => void) {
  return resumeCompacting($, on, () => { on('classic.SessionStart', () => ({})); before?.() })
}

test('a pending Resume survives a /branch and goes', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeBranching($, on)
  await clock.advance(30 * 60000)
  await typeBranch($)
  expect(await bandResume($)).not.toBe(null) // still pending in the fork
  await clock.advance(62 * 60000)
  expect(seen.submits).toEqual(['Resume'])
})

test('a Resume compacting when the chat is branched still goes into the fork', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeBranching($, on)
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) await typeBranch($) }
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(10000)
  expect(seen.submits).toEqual(['Resume'])
  expect(seen.toasts.filter((t) => /the automatic one/.test(t))).toEqual([])
})

// A typed /branch is a local command: it sends nothing to the chat, so it counts as no send
test('a typed /branch while the Resume compacts is no message sent meanwhile: the Resume goes and says nothing about being cancelled', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeBranching($, on)
  let n = 0
  seen.duringCompact = async () => { if (++n === 1) await typeBranch($) }
  await clock.advance(91 * 60000 + 1000)
  await clock.advance(10000)
  expect({ submits: seen.submits, compacts: seen.compacts }).toEqual({ submits: ['Resume'], compacts: 1 })
  expect(seen.toasts.filter((t) => /sent meanwhile|the automatic one|Not sent/.test(t))).toEqual([])
})

// The typed /branch replaced the text in the box, so the message put back is gone from it: a due Resume has nothing to wait for. A fork that did not come from a typed command (nothing was submitted) keeps the hold
async function resumeHeldByPutBack($: any, on: any) {
  const r = await resumeBranching($, on, () => {
    askLog(on) // "Compact first" for 'hello'; the first answer offered otherwise (Send anyway) for the cold-send dialog a typed command would get if it counted as a send
    on('prompt.fill', () => ({ isFilled: true }))
  })
  let n = 0
  r.seen.duringCompact = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve())
  await r.clock.advance(91 * 60000 + 1000)
  await r.clock.advance(5 * 60000)
  await $.prompt.submit({ text: 'hello', origin: COMPOSER, wait: false } as never)
  await r.clock.advance(10 * 60000 + 2000) // abandoned: 'hello' is back in the box
  await r.clock.advance(3 * 60000)
  expect(await bandText($, /⏸ Resumes? /)).toBe('⏸ Resume waits for your message')
  return r
}

test('a typed /branch ends the Resume hold of a put-back message: the typed command replaced the box text, so the Resume no longer waits for it and goes', { options: { autoResume: true } }, async ($, on) => {
  const { clock } = await resumeHeldByPutBack($, on)
  await typeBranch($)
  await clock.advance(10000)
  // the Resume is attempted again on its own schedule (it shows a time), not held for a message that is no longer in the box. (It cannot go within this scenario: the abandoned compaction of 'hello' is still out, so it is armed again, as in the held case until the hold lapses)
  expect(await bandText($, /⏸ Resumes? /)).toMatch(/^⏸ Resumes? \d/)
})

test('a fork that came from no typed command keeps the Resume hold of a put-back message: the Resume still waits for it, and goes 15 minutes after the put-back', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = await resumeHeldByPutBack($, on)
  await ($ as any).classic.SessionStart({ source: 'fork', transcript_path: '/h/fork.jsonl' }) // nothing typed: the box text is still there
  await clock.advance(5 * 60000)
  expect(seen.submits).toEqual([])
  expect(await bandText($, /⏸ Resumes? /)).toBe('⏸ Resume waits for your message')
  await clock.advance(8 * 60000) // 16 minutes after the put-back
  expect(seen.submits).toEqual(['Resume'])
})

test('a typed /branch leaves no send pending: a due Resume is not delayed by it', { options: { autoResume: true } }, async ($, on) => {
  const { clock, seen } = engine($, on)
  on('classic.StopFailure', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('turn.step', async function* () { return { answer: '', toolUses: [], usage: null } })
  await start($, 50000, clock)
  const t0 = await clock.now()
  await $.session.measure({ context: { tokens: 50000, window: 1000000, percent: 5 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(t0 + 90 * 60000).toISOString() }], changed: [] } as never)
  await ($ as any).classic.StopFailure({ error: 'rate_limit', error_details: "You've hit your usage limit" })
  await clock.advance(91 * 60000 - 20000) // the Resume is due 20 s from now
  await typeBranch($)
  await clock.advance(40000) // it fell due 20 s ago
  expect(seen.submits).toEqual(['Resume']) // a send handed on, its request not started, would hold it for 2 minutes
})

test('a typed /branch ends the tracking of the text a put-back left in the box: the box text was replaced, so a later put-back on an engine that cannot read the box fills only its own text', SETUP, async ($, on) => {
  askLog(on)
  const { clock, seen, fills } = await coldChat($, on, () => on('classic.SessionStart', () => ({}))) // no prompt.read: the tracked text would stand in for a read
  hang(seen)
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['one'])
  await typeBranch($)
  await clock.advance(60000)
  await send($, WAKE_TEXT)
  await clock.advance(1000)
  expect(fills).toEqual(['one', WAKE_TEXT]) // not 'one\n\n' + WAKE_TEXT: the text the person replaced does not come back
})

test('a fork that came from no typed command keeps the tracking of the text a put-back left in the box: a later put-back goes in behind it', SETUP, async ($, on) => {
  askLog(on)
  const { clock, seen, fills } = await coldChat($, on, () => on('classic.SessionStart', () => ({})))
  hang(seen)
  await send($, 'one')
  await clock.advance(15 * 60000 + 1000)
  expect(fills).toEqual(['one'])
  await ($ as any).classic.SessionStart({ source: 'fork', transcript_path: '/h/fork.jsonl' })
  await clock.advance(60000)
  await send($, WAKE_TEXT)
  await clock.advance(1000)
  expect(fills).toEqual(['one', 'one\n\n' + WAKE_TEXT])
})

test('a typed /branch on a cold big chat opens no cold-send dialog and compacts nothing', SETUP, async ($, on) => {
  const log = askLog(on)
  const { clock, seen } = await coldChat($, on, () => on('classic.SessionStart', () => ({})))
  await typeBranch($)
  await clock.advance(1000)
  expect({ asked: log.asked.length, compacts: seen.compacts }).toEqual({ asked: 0, compacts: 0 })
})

for (const source of ['clear', 'resume']) {
  test(`a ${source === 'clear' ? '/clear' : 'resume of another chat'} still cancels a pending Resume`, { options: { autoResume: true } }, async ($, on) => {
    const { clock, seen } = await resumeBranching($, on)
    await clock.advance(30 * 60000)
    await ($ as any).classic.SessionStart({ source, transcript_path: '/h/other.jsonl' })
    expect(await bandResume($)).toBe(null)
    await clock.advance(62 * 60000)
    expect(seen.submits).toEqual([])
  })
}
