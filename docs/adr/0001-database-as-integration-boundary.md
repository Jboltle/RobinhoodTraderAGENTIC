# Database as the integration boundary for Discord ingestion

The Listener (a `discord.py-self` user-token client, absorbed from the
discord-message-resender project) writes every captured message to the
`messages` table and does nothing else; the trader discovers work by polling
for unprocessed rows (~1s). We chose this over the previous push model — an
HMAC-signed webhook POST from a producer into the trader — because the store
had to happen before any forward anyway, and making the store *the* interface
deleted the entire delivery apparatus: the per-route deliveries state machine,
the retry sweeper, HMAC signing/verification, the documented at-most-once
double-trade window, and Discord REST catch-up (which could not work in servers
where a bot cannot be invited — the reason a member-token Listener exists at
all).

## Consequences

- Ingestion latency grows by up to one poll interval — noise next to the LLM
  parse time and the 120s staleness gate.
- Catch-up after downtime is the same query as live operation, not a code path.
- Exactly one poller instance may run: no row locking. Upgrade paths, if ever
  needed: `FOR UPDATE SKIP LOCKED` for a second instance, LISTEN/NOTIFY for
  sub-second reaction.
- The system is Discord-read-only. Its entire Discord surface is the
  Listener's gateway socket; notifications (receipts, mirrors) were deleted
  and would be rebuilt as database readers, never as pipeline side effects.
