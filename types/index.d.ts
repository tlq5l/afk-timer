export type AfkView =
  | { kind: 'away'; minutes: number }
  | { kind: 'back'; minutes: number; at: number }
  | null

declare module 'claude-code' {
  interface PluginState {
    'afk-timer': { lastTouchAt: number | null; view: AfkView }
  }
}
