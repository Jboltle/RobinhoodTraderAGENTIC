# rh-discord-trader

Invite-only multi-tenant Discord→Robinhood copy-trader. One Discord ingest fans out to each user's own Robinhood account and settings. (This file is the domain glossary; session notes live in `context.md`.)

## Language

**Callout**:
A Discord message parsed by the LLM into a trade instruction. Stored once in the `callouts` table, regardless of which users act on it.
_Avoid_: signal, alert, message

**Caller**:
A Discord author (user or bot ID) whose messages are ingested as callouts. Identified by Discord author ID, not by channel.
_Avoid_: callout group, channel, analyst

**Following**:
A user's per-account choice of which Callers they copy-trade. Following is a user setting; ingestion is global and unaffected by it.
_Avoid_: subscription, allowlist
