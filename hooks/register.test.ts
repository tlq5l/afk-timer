import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import { AWAY_AFTER_MS, BACK_SHOWN_MS, TICK_MS, formatGap, formatTokens } from './register'

const MIN = 60_000
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const composer: PromptOrigin = { kind: 'composer' }
const submit = (text: string, origin: PromptOrigin = composer) => ({ text, origin, wait: false })

const HOUR = 60 * MIN
const PLAN_LIMITS = [{ kind: 'five_hour', percentUsed: 12 }]

// The engine beneath the plugin: takes every prompt as given, draws an empty band, and answers the events the mod does not.
// `rateLimits` stands for the account: plan limits on a subscription, none on an API key.
const fakeEngine = (on: On, rateLimits = PLAN_LIMITS) => {
  const clock = mock.clock(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 182_400, window: 200_000 }, rateLimits } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('prompt.edit', (_$, e) => ({ text: e.text, cursor: e.cursor }))
  on('ui.render', () => ({ type: 'Box' as const }))
  on('session.surfaces', () => ({ value: [] }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  return clock
}

// Starts a session at time 0, so the mod records its first touch at 0 and its tick timer runs.
const begin = async ($: Engine, on: On, rateLimits = PLAN_LIMITS) => {
  const clock = fakeEngine(on, rateLimits)
  await $.session.start({ cwd: '/work/afk', surface: null, isInteractive: true })
  return clock
}

const mountBand = ($: Engine, surface: Surface) =>
  $.ui.mount({
    plugin: 'afk-timer',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })

// Mounts the AbovePrompt band on one surface. Returns the afk text drawn, if any, and whether anything matching /AFK/ is drawn.
const bandOn = async ($: Engine, surface: Surface) => {
  const ui = await mountBand($, surface)
  const found = await ui.find({ type: 'Text', text: /AFK/ })
  await ui.unmount()
  return { text: found?.text, afkDrawn: found !== undefined }
}

// Mounts the band on one surface and returns the text of its AFK line and its cache line.
const linesOn = async ($: Engine, surface: Surface) => {
  const ui = await mountBand($, surface)
  const afk = (await ui.find({ type: 'Text', text: /AFK/ }))?.text
  const cache = (await ui.find({ type: 'Text', text: /^Cache/ }))?.text
  await ui.unmount()
  return { afk, cache }
}

// One main-conversation turn: the prompt, then Claude's reply.
const turn = async ($: Engine, turnId: string, agentId?: string) => {
  if (agentId === undefined) await $.turn.start({ text: 'go', turnId })
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId, reason: 'answer', ...(agentId ? { agentId } : {}) })
}

const EXPIRED_1H = 'Cache likely expired (last reply 1 h 0 min ago): your next message re-reads ~182k tokens at full price. Same task? Carry on. New task? /clear first, it costs under half as much.'

describe('afk-timer', () => {
  test('under the threshold nothing of the mod is drawn', async ($, on) => {
    const clock = await begin($, on)
    await clock.advance(AWAY_AFTER_MS - 1)
    for (const surface of SURFACES) expect((await bandOn($, surface)).afkDrawn).toBe(false)
  })

  test('after the threshold with no touch the band counts the minutes away and keeps growing', async ($, on) => {
    const clock = await begin($, on)
    await clock.advance(AWAY_AFTER_MS)
    for (const surface of SURFACES) expect((await bandOn($, surface)).text).toBe('AFK for 5 min')
    await clock.advance(18 * MIN)
    for (const surface of SURFACES) expect((await bandOn($, surface)).text).toBe('AFK for 23 min')
  })

  test('a composer prompt after 23 minutes away says you were AFK, then the band clears', async ($, on) => {
    const clock = await begin($, on)
    await clock.advance(AWAY_AFTER_MS + 18 * MIN)
    for (const surface of SURFACES) expect((await bandOn($, surface)).text).toBe('AFK for 23 min')
    await $.prompt.submit(submit('back at last'))
    for (const surface of SURFACES) expect((await bandOn($, surface)).text).toBe('You were AFK for 23 min')
    await clock.advance(BACK_SHOWN_MS + TICK_MS)
    for (const surface of SURFACES) expect((await bandOn($, surface)).text).toBeUndefined()
  })

  test('the "You were AFK" line clears on time after the return, without waiting for a tick', async ($, on) => {
    const clock = await begin($, on)
    await clock.advance(AWAY_AFTER_MS + 18 * MIN)
    await $.prompt.submit(submit('back at last'))
    await clock.advance(BACK_SHOWN_MS - 1)
    for (const surface of SURFACES) expect((await bandOn($, surface)).text).toBe('You were AFK for 23 min')
    await clock.advance(1)
    for (const surface of SURFACES) expect((await bandOn($, surface)).text).toBeUndefined()
  })

  test('a desktop prompt with origin sdk counts as a touch the same way', async ($, on) => {
    const clock = await begin($, on)
    await clock.advance(AWAY_AFTER_MS + 18 * MIN)
    for (const surface of SURFACES) expect((await bandOn($, surface)).text).toBe('AFK for 23 min')
    await $.prompt.submit(submit('from the sdk', { kind: 'sdk' }))
    for (const surface of SURFACES) expect((await bandOn($, surface)).text).toBe('You were AFK for 23 min')
  })

  test('task-notification and plugin prompts do not count as a touch', async ($, on) => {
    const clock = await begin($, on)
    await clock.advance(AWAY_AFTER_MS + 18 * MIN)
    await $.prompt.submit(submit('build finished', { kind: 'task-notification' }))
    await $.prompt.submit(submit('plugin note', { kind: 'plugin', name: 'notes' }))
    for (const surface of SURFACES) expect((await bandOn($, surface)).text).toBe('AFK for 23 min')
    await clock.advance(MIN)
    for (const surface of SURFACES) expect((await bandOn($, surface)).text).toBe('AFK for 24 min')
  })

  test('typing in the prompt (prompt.edit) counts as a touch', async ($, on) => {
    const clock = await begin($, on)
    await clock.advance(AWAY_AFTER_MS + 18 * MIN)
    for (const surface of SURFACES) expect((await bandOn($, surface)).text).toBe('AFK for 23 min')
    // The typings leave prompt.edit off the test's $.prompt, though the engine raises it at runtime; the cast reaches it.
    const promptEdit = $.prompt as unknown as { edit: (e: { origin: PromptOrigin; text: string; cursor: number; start: number; end: number; inputText: string }) => Promise<unknown> }
    await promptEdit.edit({ origin: composer, text: 'h', cursor: 0, start: 0, end: 0, inputText: 'h' })
    await clock.settle()
    for (const surface of SURFACES) expect((await bandOn($, surface)).text).toBe('You were AFK for 23 min')
  })

  test('a touch after a gap the timer never ran reports the full gap', async ($, on) => {
    const clock = await begin($, on)
    await clock.set(40 * MIN)
    await $.prompt.submit(submit('finally back'))
    for (const surface of SURFACES) expect((await bandOn($, surface)).text).toBe('You were AFK for 40 min')
  })

  test('a desktop session starts counting once the app attaches', async ($, on) => {
    const clock = fakeEngine(on)
    await $.session.start({ cwd: '/work/afk', surface: null, isInteractive: false })
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    await clock.advance(AWAY_AFTER_MS + 18 * MIN)
    expect((await bandOn($, 'desktop')).text).toBe('AFK for 23 min')
  })

  test('a session whose app attached before the mod loaded starts counting once the band is drawn', async ($, on) => {
    const clock = fakeEngine(on)
    await $.session.start({ cwd: '/work/afk', surface: null, isInteractive: false })
    await bandOn($, 'desktop')
    await clock.advance(AWAY_AFTER_MS + 18 * MIN)
    expect((await bandOn($, 'desktop')).text).toBe('AFK for 23 min')
    await $.prompt.submit(submit('back', composer))
    await clock.advance(BACK_SHOWN_MS + TICK_MS)
    expect((await bandOn($, 'desktop')).text).toBeUndefined()
  })

  test('a headless session with no app attached never shows the band', async ($, on) => {
    const clock = fakeEngine(on)
    await $.session.start({ cwd: '/work/afk', surface: null, isInteractive: false })
    await clock.advance(AWAY_AFTER_MS + 18 * MIN)
    for (const surface of SURFACES) expect((await bandOn($, surface)).afkDrawn).toBe(false)
  })

  test('on a subscription the AFK line counts down the 1 h cache, then a warning says it likely expired', async ($, on) => {
    const clock = await begin($, on)
    await $.prompt.submit(submit('do the thing'))
    await turn($, 't1')
    await clock.advance(AWAY_AFTER_MS + 18 * MIN)
    for (const surface of SURFACES) expect(await linesOn($, surface)).toEqual({ afk: 'AFK for 23 min · cache expires in 37 min', cache: undefined })
    await clock.advance(37 * MIN)
    for (const surface of SURFACES) expect(await linesOn($, surface)).toEqual({ afk: 'AFK for 1 h 0 min', cache: EXPIRED_1H })
  })

  test('on an API key the cache lasts 5 min', async ($, on) => {
    const clock = await begin($, on, [])
    await turn($, 't1')
    await clock.advance(AWAY_AFTER_MS - 1)
    expect((await linesOn($, 'terminal')).cache).toBeUndefined()
    await clock.advance(TICK_MS)
    expect((await linesOn($, 'terminal')).cache).toMatch(/^Cache likely expired \(last reply 5 min ago\)/)
  })

  test('a pinned 5m lifetime wins over the subscription guess', { options: { cacheTtl: '5m' } }, async ($, on) => {
    const clock = await begin($, on)
    await turn($, 't1')
    await clock.advance(AWAY_AFTER_MS + TICK_MS)
    expect((await linesOn($, 'desktop')).cache).toMatch(/^Cache likely expired/)
  })

  test('the warning stays while you type and clears once your next turn starts', async ($, on) => {
    const clock = await begin($, on)
    await turn($, 't1')
    await clock.advance(HOUR)
    await $.prompt.submit(submit('back'))
    await clock.advance(BACK_SHOWN_MS + TICK_MS)
    for (const surface of SURFACES) expect(await linesOn($, surface)).toEqual({ afk: undefined, cache: EXPIRED_1H })
    await $.turn.start({ text: 'carry on', turnId: 't2' })
    for (const surface of SURFACES) expect((await linesOn($, surface)).cache).toBeUndefined()
  })

  test('/clear and /compact take the warning down', async ($, on) => {
    const clock = await begin($, on)
    for (const source of ['clear', 'compact'] as const) {
      await turn($, `t-${source}`)
      await clock.advance(HOUR)
      expect((await linesOn($, 'terminal')).cache).toBe(EXPIRED_1H)
      await $.classic.SessionStart({ source })
      for (const surface of SURFACES) expect((await linesOn($, surface)).cache).toBeUndefined()
    }
  })

  test('a subagent finishing does not restart the main cache clock', async ($, on) => {
    const clock = await begin($, on)
    await turn($, 't1')
    await clock.advance(50 * MIN)
    await turn($, 'sub-1', 'agent-7')
    await clock.advance(10 * MIN)
    expect((await linesOn($, 'terminal')).cache).toBe(EXPIRED_1H)
  })

  test('resuming or forking a session the engine says went cold shows the warning straight away', async ($, on) => {
    fakeEngine(on, [])
    await $.session.start({ cwd: '/work/afk', surface: 'terminal', isInteractive: true })
    for (const source of ['resume', 'fork'] as const) {
      await $.classic.SessionStart({ source: 'clear' })
      await $.classic.SessionStart({ source, seconds_since_last_response: 3 * 3600, context_tokens: 95_000, prompt_cache_likely_expired: true })
      for (const surface of SURFACES) {
        expect((await linesOn($, surface)).cache).toBe('Cache likely expired (last reply 3 h 0 min ago): your next message re-reads ~95k tokens at full price. Same task? Carry on. New task? /clear first, it costs under half as much.')
      }
    }
  })

  test('a small conversation that went cold gets a calm line instead of the /clear advice', async ($, on) => {
    fakeEngine(on, [])
    await $.session.start({ cwd: '/work/afk', surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 2 * 3600, context_tokens: 40_000, prompt_cache_likely_expired: true })
    expect((await linesOn($, 'terminal')).cache).toBe('Cache likely expired (last reply 2 h 0 min ago), but the conversation is small (~40k tokens): carrying on costs little.')
  })

  test('resuming a session the engine says is still warm after 20 min counts down the 1 h cache', async ($, on) => {
    const clock = fakeEngine(on, [])
    await $.session.start({ cwd: '/work/afk', surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 20 * 60, context_tokens: 95_000, prompt_cache_likely_expired: false })
    await clock.advance(AWAY_AFTER_MS)
    expect(await linesOn($, 'terminal')).toEqual({ afk: 'AFK for 5 min · cache expires in 35 min', cache: undefined })
  })

  test('formatTokens rounds to thousands', () => {
    expect(formatTokens(182_400)).toBe('182k')
    expect(formatTokens(640)).toBe('640')
  })

  test('formatGap spells the gap in minutes, then hours and minutes', () => {
    expect(formatGap(23)).toBe('23 min')
    expect(formatGap(65)).toBe('1 h 5 min')
    expect(formatGap(120)).toBe('2 h 0 min')
  })
})

// Stands in for a built-in mod beneath this one that draws its own AbovePrompt line, as "You should know" does.
const modBelow = {
  name: 'cc-plugin-you-should-know',
  tier: 'builtin' as const,
  register(on: On) {
    on('ui.render', { component: 'AbovePrompt' } as never, (() => ({ type: 'Text', children: ['From the mod below'] })) as never)
  },
}

describe('mods beneath the band', () => {
  test('still draw while the AFK line shows', { plugins: [modBelow] } as never, async ($: Engine, on: On) => {
    const clock = await begin($, on)
    await clock.advance(AWAY_AFTER_MS)
    for (const surface of SURFACES) {
      const ui = await mountBand($, surface)
      expect((await ui.find({ type: 'Text', text: /AFK/ }))?.text).toBe('AFK for 5 min')
      expect(await ui.find({ type: 'Text', text: 'From the mod below' })).toBeDefined()
      await ui.unmount()
    }
  })
})
