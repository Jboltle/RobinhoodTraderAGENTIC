# rh-discord-trader

Invite-only multi-tenant Discord→Robinhood copy-trader. One Discord ingest fans out to each user's own Robinhood account and settings. (This file is the domain glossary; session notes live in `context.md`.)

## Language

**Message**:
A raw Discord message captured by the Listener into the `messages` table, exactly as it arrived. Not every Message is a Callout — the Disposition records what became of it.
_Avoid_: alert, capture, envelope

**Listener**:
The service that reads watched channels as a Discord member (user token) and writes Messages. Capture only: it never parses, trades, or posts anything anywhere.
_Avoid_: resender, bot, ingester

**Disposition**:
The pipeline's verdict on a Message: `callout`, `not_callout`, `failed`, `missed`, or `recap`. Unset until judged. A Message carries a parse exactly when its Disposition is `callout`.
_Avoid_: parse status, state

**Callout**:
A Message the LLM parsed into a trade instruction — Disposition `callout`, parse attached. One verdict is recorded once and serves every user, regardless of who acts on it.
_Avoid_: signal, alert, message

**Caller**:
A Discord author (user or bot ID) whose messages are ingested as callouts. Identified by Discord author ID, not by channel.
_Avoid_: callout group, channel, analyst

**Following**:
A user's per-account choice of which Callers they copy-trade. Following is a user setting; ingestion is global and unaffected by it.
_Avoid_: subscription, allowlist

**User**:
Someone invited to the dashboard. Identified by email; their user id is the key on trades, settings, and the broker connection.
_Avoid_: account, profile, auth user

**Max Loss**:
A per-user setting that closes one open position when its unrealized loss exceeds a percent of entry and/or a dollar amount.
_Avoid_: stop loss, circuit breaker, flatten
