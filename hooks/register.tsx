import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { AfkView } from '../types/index'

export const AWAY_AFTER_MS = 5 * 60_000
export const BACK_SHOWN_MS = 10_000
export const TICK_MS = 15_000
export const TOUCH_THROTTLE_MS = 5_000

export const formatGap = (minutes: number): string => {
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

const lastTouchAt = atom({ plugin: 'afk-timer', key: 'lastTouchAt' } as const, null)
const view = atom({ plugin: 'afk-timer', key: 'view' } as const, null)

const PERSON_ORIGINS = ['composer', 'bridge', 'sdk', 'slack-ping']

let recentTouchAt = 0
let timer: { cancel: () => void } | null = null

const clearBack = async ($: EngineInterface, at: number) => {
  const current = await read($, view)
  if (current?.kind === 'back' && current.at === at) await update($, view, (): AfkView => null)
}

const touch = async ($: EngineInterface) => {
  const now = await $.clock.now()
  if (now - recentTouchAt < TOUCH_THROTTLE_MS) return
  recentTouchAt = now
  const last = await read($, lastTouchAt)
  await update($, lastTouchAt, () => now)
  if (typeof last === 'number' && now - last >= AWAY_AFTER_MS) {
    const minutes = Math.floor((now - last) / 60_000)
    await update($, view, (): AfkView => ({ kind: 'back', minutes, at: now }))
    // Clear on time: the next tick can come up to TICK_MS late.
    $.clock.after(BACK_SHOWN_MS, () => {
      void clearBack($, now).catch(() => {})
    })
  }
}

const startTicking = ($: EngineInterface) => {
  if (timer) return
  timer = $.clock.every(TICK_MS, () => {
    void tick($).catch(() => {})
  })
}

const tick = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const last = await read($, lastTouchAt)
  if (typeof last !== 'number') {
    await update($, lastTouchAt, () => now)
    return
  }
  const gap = now - last
  const current = await read($, view)
  if (gap >= AWAY_AFTER_MS) {
    const minutes = Math.floor(gap / 60_000)
    if (!(current?.kind === 'away' && current.minutes === minutes)) {
      await update($, view, (): AfkView => ({ kind: 'away', minutes }))
    }
    return
  }
  // An away line under the threshold is stale: a touch landed while this tick ran.
  const isOver = current?.kind === 'away' || (current?.kind === 'back' && now - current.at >= BACK_SHOWN_MS)
  if (isOver) await update($, view, (): AfkView => null)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    const last = await read($, lastTouchAt)
    if (typeof last !== 'number') await update($, lastTouchAt, () => now)
    timer?.cancel()
    timer = null
    if (e.isInteractive || (await $.session.surfaces()).length > 0) startTicking($)
    return next(e)
  })

  on('session.attach', ($, e, next) => {
    startTicking($)
    return next(e)
  })

  on('prompt.edit', ($, e, next) => {
    void touch($).catch(() => {})
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (PERSON_ORIGINS.includes(e.origin.kind)) await touch($).catch(() => {})
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (PERSON_ORIGINS.includes(e.origin.kind)) await touch($).catch(() => {})
    return next(e)
  })

  on('ui.press', async ($, e, next) => {
    await touch($).catch(() => {})
    return next(e)
  })

  on('ui.input', async ($, e, next) => {
    await touch($).catch(() => {})
    return next(e)
  })

  on('ui.select', async ($, e, next) => {
    await touch($).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A screen is drawing the band, so someone can see it: covers a desktop app that attached before this module loaded.
    startTicking($)
    const current = await read($, view)
    if (e.props.hasSurvey || current == null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    if (current.kind === 'away') {
      return <Box><Text key="afk">{`AFK for ${formatGap(current.minutes)}`}</Text></Box>
    }
    return <Box><Text key="afk" dimColor>{`You were AFK for ${formatGap(current.minutes)}`}</Text></Box>
  })
}
