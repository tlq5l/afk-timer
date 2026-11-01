# How the cache timer works

afk-timer's "cache expires in" line is an estimate. It doesn't read Anthropic's cache. It works out a likely time from the rules below, and this page explains where that estimate can differ from the real cache.

## Anthropic's rules

These come from Anthropic's [prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [Claude Code's prompt caching docs](https://code.claude.com/docs/en/prompt-caching).

- The default cache lifetime is 5 minutes.
- Each use of the cached content refreshes the lifetime, at no additional cost.
- A 1-hour lifetime is available as an option. It costs extra.
- The lifetime is measured from the start of the request that reads or writes the cache entry, not from the end of the response. Time spent generating a response counts against the lifetime.
- In Claude Code, a Claude subscription within plan usage gets the 1-hour lifetime for the main conversation. API keys and cloud providers get 5 minutes. Once a subscription draws on usage credits, the main conversation drops to 5 minutes.
- Subagents keep a cache of their own, separate from the main conversation's.

## How afk-timer estimates it

- **Start point.** afk-timer starts its countdown when Claude's last reply finishes, not when the request started. Its expiry time is therefore later than Anthropic's by however long that reply took to generate. "Cache expires in" can show more time left than the real cache has.
- **Lifetime.** The `cacheTtl` setting picks 5 minutes or 1 hour. `auto`, the default, uses 1 hour when the account reports plan usage limits and 5 minutes otherwise. If that guess is wrong, the line is wrong too.
- **Resumed sessions.** When you resume a session, afk-timer uses Claude Code's own verdict on whether the cache has likely expired, if Claude Code provides one.
- **Subagents.** Only the main conversation is tracked. A subagent's turn doesn't restart the clock, and afk-timer doesn't track subagent caches at all.
- **Token count.** The size shown is the conversation size at Claude's last reply, rounded.

## What to do with it

Treat "cache expires in" as a rough guide, not a deadline. It can run late by the length of Claude's last reply, and it's wrong if the lifetime was guessed wrong. For the rules themselves, use Anthropic's docs linked above.
