# afk-timer

A small Claude Code mod that tells you, above the prompt, how long you have been away and whether the session's prompt cache has likely expired. When it has, starting fresh with `/clear` is usually cheaper than carrying on in the same session.

```
AFK for 23 min · cache expires in 37 min
```

```
Cache likely expired (last reply 1 h 0 min ago): your next message re-reads ~182k tokens at full price. New task? /clear first.
```

## Why it exists

Every message you send makes Claude Code send the whole conversation again. The prompt cache lets the model reuse what it already read, so you mostly pay for what's new. A cache only lasts a fixed time after Claude's last reply:

- **1 hour** on a Claude subscription (Pro, Max), while you are within your plan's included usage.
- **5 minutes** on an API key, on a cloud provider, or once a subscription draws on usage credits.

After that, your next message re-reads the whole conversation at the full, uncached price. On a subscription that uses up more of your plan limits. On a 200k-token session that's a big hit for one message.

So when the warning is up:

- **Starting something new?** Run `/clear` first. The old conversation isn't sent again.
- **Need the old context?** Just carry on. You pay the full price once, then it's cached again.
- `/compact` doesn't help here. It re-reads the whole conversation to summarize it, so it costs the same.

The details are in Claude Code's [prompt caching docs](https://code.claude.com/docs/en/prompt-caching).

## Install

In Claude Code running in a terminal, type:

```
/plugin install afk-timer --marketplace tlq5l/afk-timer
```

Press `y` to add the marketplace, then Enter to install for your user. It starts working right away. The desktop app's Code tab doesn't accept that command, but once you install it from a terminal the line shows there too.

It needs a Claude Code version with function-hook mods (early access; built and tested on 2.1.296).

## What it shows

- **`AFK for 23 min · cache expires in 37 min`**: you haven't typed, sent or clicked anything for 5 minutes. The two numbers count from different moments: AFK from your last action, the cache from Claude's last reply.
- **`You were AFK for 23 min`** (dim): shown for 10 seconds when you come back.
- **`Cache likely expired …`**: shown once the cache has likely lapsed, including right after you resume an old session. It stays while you type and goes away when you send your next message, `/clear` or `/compact`.

## Settings

One setting, under `/config`: **Prompt cache lifetime** (`cacheTtl`).

- `auto` (default): 1 hour if your account reports plan usage limits (a subscription), otherwise 5 minutes.
- `1h` or `5m`: pin it. Use `1h` if you set `promptCacheTtl` to `1h` on an API key. Use `5m` while your subscription is on usage credits.

## Turn it off or remove it

```
claude plugin disable afk-timer@afk-timer
```

```
claude plugin uninstall afk-timer@afk-timer
```

## Limits

- It estimates. A mod can't read the cache's real lifetime, so `auto` guesses from your account type. When you resume a session it uses Claude Code's own verdict instead.
- Only the main conversation counts. Subagents keep caches of their own.
- The token count is the size of the conversation at Claude's last reply, rounded.
- Watching a long reply without touching anything counts as AFK.

## Develop

```
claude plugin test .
```

```
claude plugin validate .
```

```
claude --plugin-dir .
```

Claude Code writes the API types into `.claude-plugin/types/` the first time it loads the mod from a folder, which is what `tsconfig.json` extends.

## License

MIT
