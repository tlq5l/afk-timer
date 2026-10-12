export type AfkView =
  | { kind: 'away'; minutes: number }
  | { kind: 'back'; minutes: number; at: number }
  | null

// When the main conversation's prompt cache was last refreshed. Null before the first reply, while a turn runs, and after /clear or /compact.
export type CacheClock = { lastReplyAt: number; tokens: number | null; ttlMs: number } | null

export type CacheView =
  | { kind: 'warm'; minutesLeft: number }
  | { kind: 'expired'; minutesSince: number; tokens: number | null }
  | null

declare module 'claude-code' {
  interface PluginState {
    'afk-timer': { lastTouchAt: number | null; view: AfkView; cache: CacheClock; cacheView: CacheView }
  }
}
