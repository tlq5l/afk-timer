import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

import { AWAY_AFTER_MS, BACK_SHOWN_MS, TICK_MS, formatGap } from './register'

const MIN = 60_000
const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
const composer: PromptOrigin = { kind: 'composer' }
const submit = (text: string, origin: PromptOrigin = composer) => ({ text, origin, wait: false })

// The engine beneath the plugin: takes every prompt as given, draws an empty band, and answers the events the mod does not.
const fakeEngine = (on: On) => {
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('prompt.edit', (_$, e) => ({ text: e.text, cursor: e.cursor }))
  on('ui.render', () => ({ type: 'Box' as const }))
  on('session.surfaces', () => ({ value: [] }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  return clock
}

// Starts a session at time 0, so the mod records its first touch at 0 and its tick timer runs.
const begin = async ($: Engine, on: On) => {
  const clock = fakeEngine(on)
  await $.session.start({ cwd: '/work/afk', surface: null, isInteractive: true })
  return clock
}

// Mounts the AbovePrompt band on one surface. Returns the afk text drawn, if any, and whether anything matching /AFK/ is drawn.
const bandOn = async ($: Engine, surface: Surface) => {
  const ui = await $.ui.mount({
    plugin: 'afk-timer',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  })
  const found = await ui.find({ text: /AFK/ })
  await ui.unmount()
  return { text: found?.text, afkDrawn: found !== undefined }
}

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

  test('formatGap spells the gap in minutes, then hours and minutes', () => {
    expect(formatGap(23)).toBe('23 min')
    expect(formatGap(65)).toBe('1 h 5 min')
    expect(formatGap(120)).toBe('2 h 0 min')
  })
})
