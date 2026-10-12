import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { AfkView, CacheClock, CacheView } from '../types/index'

export const AWAY_AFTER_MS = 5 * 60_000
export const BACK_SHOWN_MS = 10_000
export const TICK_MS = 15_000
export const TOUCH_THROTTLE_MS = 5_000
// How long Claude Code's main conversation stays cached after Claude's last reply: 1 h on a subscription within plan usage, 5 min otherwise.
export const CACHE_TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const

export const formatGap = (minutes: number): string => {
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export const formatTokens = (tokens: number): string => (tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`)

export const afkLine = (afk: NonNullable<AfkView>, cache: CacheView): string => {
  if (afk.kind === 'back') return `You were AFK for ${formatGap(afk.minutes)}`
  const warm = cache?.kind === 'warm' ? ` · cache expires in ${formatGap(cache.minutesLeft)}` : ''
  return `AFK for ${formatGap(afk.minutes)}${warm}`
}

export const cacheLine = (cache: Extract<CacheView, { kind: 'expired' }>): string => {
  const size = cache.tokens == null ? 'the whole conversation' : `~${formatTokens(cache.tokens)} tokens`
  return `Cache likely expired (last reply ${formatGap(cache.minutesSince)} ago): your next message re-reads ${size} at full price. New task? /clear first.`
}

const lastTouchAt = atom({ plugin: 'afk-timer', key: 'lastTouchAt' } as const, null)
const view = atom({ plugin: 'afk-timer', key: 'view' } as const, null)
const cache = atom({ plugin: 'afk-timer', key: 'cache' } as const, null)
const cacheView = atom({ plugin: 'afk-timer', key: 'cacheView' } as const, null)

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

const cacheViewAt = (clock: CacheClock, now: number): CacheView => {
  if (clock == null) return null
  const sinceReply = now - clock.lastReplyAt
  if (sinceReply < clock.ttlMs) return { kind: 'warm', minutesLeft: Math.ceil((clock.ttlMs - sinceReply) / 60_000) }
  return { kind: 'expired', minutesSince: Math.floor(sinceReply / 60_000), tokens: clock.tokens }
}

const refreshCacheView = async ($: EngineInterface, now: number) => {
  const next = cacheViewAt(await read($, cache), now)
  if (JSON.stringify(await read($, cacheView)) !== JSON.stringify(next)) await update($, cacheView, (): CacheView => next)
}

const setCache = async ($: EngineInterface, clock: CacheClock) => {
  await update($, cache, (): CacheClock => clock)
  await refreshCacheView($, await $.clock.now())
}

// `auto` reads a subscription from the plan rate limits the last response reported (none before the first response).
const guessTtlMs = (choice: unknown, rateLimits: readonly unknown[]) => {
  if (choice === '1h' || choice === '5m') return CACHE_TTL_MS[choice]
  return rateLimits.length > 0 ? CACHE_TTL_MS['1h'] : CACHE_TTL_MS['5m']
}

const markReply = async ($: EngineInterface, choice: unknown) => {
  const { context, rateLimits } = await $.session.usage()
  await setCache($, { lastReplyAt: await $.clock.now(), tokens: context.tokens ?? null, ttlMs: guessTtlMs(choice, rateLimits) })
}

const markResumed = async ($: EngineInterface, choice: unknown, ago: number, tokens: number | null, isExpired: boolean | undefined) => {
  const guess = guessTtlMs(choice, (await $.session.usage()).rateLimits)
  // The engine knows the real lifetime: a cache it calls warm past 5 min is the 1 h one, and one it calls expired has lapsed by now.
  const ttlMs = isExpired ? Math.min(guess, ago) : ago >= CACHE_TTL_MS['5m'] ? CACHE_TTL_MS['1h'] : guess
  await setCache($, { lastReplyAt: (await $.clock.now()) - ago, tokens, ttlMs })
}

const startTicking = ($: EngineInterface) => {
  if (timer) return
  timer = $.clock.every(TICK_MS, () => {
    void tick($).catch(() => {})
  })
}

const tick = async ($: EngineInterface) => {
  const now = await $.clock.now()
  await refreshCacheView($, now)
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

export const register: Register = (on, options) => {
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

  // A running turn's requests keep the cache warm, so the cache clock restarts when the turn completes.
  on('turn.start', async ($, e, next) => {
    await setCache($, null).catch(() => {})
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's turn warms its own cache, not the main conversation's.
    if (e.agentId === undefined) await markReply($, options.cacheTtl).catch(() => {})
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    // /clear and /compact leave nothing big to re-read.
    if (e.source === 'clear' || e.source === 'compact') await setCache($, null).catch(() => {})
    // A resumed or forked session starts from a transcript whose cache may already have lapsed.
    if ((e.source === 'resume' || e.source === 'fork') && e.seconds_since_last_response !== undefined) {
      const ago = e.seconds_since_last_response * 1000
      await markResumed($, options.cacheTtl, ago, e.context_tokens ?? null, e.prompt_cache_likely_expired).catch(() => {})
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A screen is drawing the band, so someone can see it: covers a desktop app that attached before this module loaded.
    startTicking($)
    const afk = await read($, view)
    const cached = await read($, cacheView)
    const expired = cached?.kind === 'expired' ? cached : null
    if (e.props.hasSurvey || (afk == null && expired == null)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {afk && <Text key="afk" dimColor={afk.kind === 'back'}>{afkLine(afk, cached)}</Text>}
        {expired && <Text key="cache" color="warning">{cacheLine(expired)}</Text>}
      </Box>
    )
  })
}
