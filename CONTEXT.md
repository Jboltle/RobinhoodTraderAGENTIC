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
A Message judged to be a trade instruction — Disposition `callout`, parse attached. One verdict is recorded once and serves every user, regardless of who acts on it. Callouts are options only: a trade with no options contract is not a Callout.
_Avoid_: signal, alert, message

**Action**:
What a Caller's Message announces: Buy, Average, Trim, or Sell. Read from the Caller's words alone, never from any User's holdings. A Message with no Action, or whose Action is Average, is not a Callout.
_Avoid_: signal, intent

**Buy**:
An Action that opens a new position.
_Avoid_: entry, open

**Average**:
An Action that buys more of a position the Caller already holds. Followers never copy it: an Average trades nothing for anyone.
_Avoid_: add, addition, averaging down

**Trim**:
An Action that sells part of a position and keeps the rest. Each User sells the Caller's stated fraction of their own position ("Sold 4 of 20" is a fifth), rounded down; "runners only" keeps one contract, and no stated fraction means half. A Message headed "TRIM" that sells the whole position is a Sell.
_Avoid_: partial exit, scale out

**Sell**:
An Action that closes the whole position. When the Caller sells without saying how much, it's a Sell.
_Avoid_: close, full exit

**Ticker-only Exit**:
A Sell that names only the ticker ("out of NBIS"). It closes the Caller's own open position in that ticker, never a position another Caller called.
_Avoid_: blind exit, generic exit

**Info**:
A Message where the Caller shares news or plans about a position they still hold, without an Action. Info is not a Callout.
_Avoid_: status update, holding update, position update

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
