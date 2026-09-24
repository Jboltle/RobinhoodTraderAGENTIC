-- Exactly-once fan-out across trader processes.
--
-- Two trader processes polling the same database (a local run next to the
-- deployed one, or overlapping containers during a redeploy) each read the
-- same unprocessed row and each fanned it out: two trades rows per user per
-- message, and potentially two orders. The poller now claims a row before
-- handling it, and trades gets the one-row-per-user-per-message rule the
-- pipeline always assumed.

-- ---------------------------------------------------------------------------
-- Row claim: UPDATE ... WHERE claimed_at IS NULL is atomic under Postgres row
-- locking, so exactly one poller wins. Works through the Supabase pooler,
-- unlike session advisory locks. claimed_at is cleared when the row is marked
-- processed (so a recap edit that re-opens the row can be claimed again);
-- claimed_by is kept as a record of which instance handled it.
-- ---------------------------------------------------------------------------

alter table public.messages
  add column claimed_at timestamptz,
  add column claimed_by text;

-- ---------------------------------------------------------------------------
-- One decision per user per message. Collapse existing duplicates first,
-- keeping the most advanced outcome (an order that reached the broker beats a
-- parked one beats a skip), then the earliest.
-- ---------------------------------------------------------------------------

delete from public.trades t
using (
  select id,
    row_number() over (
      partition by user_id, message_id
      order by
        case kind
          when 'submitted' then 0
          when 'pending_approval' then 1
          else 2
        end,
        "timestamp" asc,
        id
    ) as rn
  from public.trades
) ranked
where t.id = ranked.id
  and ranked.rn > 1;

create unique index trades_user_message_uidx on public.trades (user_id, message_id);
