-- Messages consolidation: one raw archive table, verdicts recorded in place.
--
-- The Listener (server/listener — a Python gateway client reading as a member)
-- INSERTs every captured message here raw. The trader's poller reads rows
-- where processed_at is null, judges each one, and records the verdict on the
-- same row: disposition, parse (for real callouts), processed_at. This
-- replaces the webhook ingestion path end to end, and absorbs the callouts
-- table — a Callout is now a Message whose disposition says so, not a row in a
-- second table. See docs/adr/0001-database-as-integration-boundary.md.
--
-- ACCESS MODEL: default-deny like every other table (see
-- 20260725012642_multi_tenant_schema.sql) — RLS on, zero policies, anon and
-- authenticated grants revoked. The server reaches it over the direct
-- SUPABASE_DB_URL connection; the Listener writes over the same DSN.

create table public.messages (
  -- Discord message snowflake. The primary key is the idempotency guard: a
  -- gateway RESUME replays recent events, and the Listener inserts with
  -- ON CONFLICT DO NOTHING, so a replay is a no-op rather than a duplicate.
  id text primary key,
  channel_id text not null,
  -- Null for any channel the account cannot name.
  channel_name text,
  author_id text not null,
  author_name text not null,
  author_is_bot boolean not null default false,
  -- Raw message text with attachment URLs appended by the Listener. Embed text
  -- is NOT flattened in here: the trader flattens exactly once at read time
  -- (flattenEnvelope in server/src/shared/embedText.ts).
  content text not null default '',
  -- Raw Discord embed JSON — the usual payload for bot-posted alerts.
  embeds jsonb not null default '[]'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  -- Faithful snapshot of the message as the library exposed it, kept so a
  -- later schema change can be backfilled from stored data instead of waiting
  -- for the traffic to recur. '{}' on rows migrated from callouts history.
  raw jsonb not null default '{}'::jsonb,
  -- The Discord message timestamp, NOT insertion time. The poller compares it
  -- against the staleness window before trading.
  sent_at timestamptz not null,
  edited_at timestamptz,
  captured_at timestamptz not null default now(),
  -- Soft delete: a retracted alert is itself a signal, so the row is kept and
  -- the archive shows that it existed and was withdrawn.
  deleted_at timestamptz,
  -- The pipeline's verdict — MessageDisposition in server/src/trader/db.ts.
  -- Null until the poller has processed the row.
  disposition text
    check (disposition in ('callout', 'not_callout', 'failed', 'missed', 'recap')),
  -- Shape of Callout in server/src/shared/types.ts.
  parse jsonb,
  -- Set by the poller once the row has been fully handled (including fan-out).
  -- disposition without processed_at marks a crash mid fan-out; the poller
  -- then finishes the mark without re-trading.
  processed_at timestamptz,
  -- A Callout IS a message whose disposition says so: parse present exactly
  -- when disposition = 'callout'. IS DISTINCT FROM keeps this airtight for
  -- pending rows (disposition null), where a plain equality would pass NULL.
  constraint messages_parse_matches_disposition check (
    (disposition = 'callout' and parse is not null)
    or (disposition is distinct from 'callout' and parse is null)
  )
);

-- The poller's work queue: unprocessed rows only, oldest first.
create index messages_unprocessed_idx on public.messages (sent_at)
  where processed_at is null;
-- The dashboard feed reads newest-first.
create index messages_sent_at_idx on public.messages (sent_at desc);

-- ---------------------------------------------------------------------------
-- Fold callouts history in, then drop the table.
--
-- Old rows stored content post-flatten (embed text already inlined), so the
-- embeds are deliberately dropped to '[]': carrying them would double their
-- text when the feed re-flattens content + embeds. The text is preserved.
-- parse_status maps onto dispositions; old 'skipped' rows were exactly the
-- stale-on-wake markers, which is what 'missed' now names.
-- ---------------------------------------------------------------------------

insert into public.messages (
  id, channel_id, channel_name, author_id, author_name,
  content, embeds, sent_at, captured_at, disposition, parse, processed_at
)
select
  message_id,
  channel_id,
  channel_name,
  -- Rows written before Caller Following existed carry a null author.
  coalesce(author_id, ''),
  author_name,
  content,
  '[]'::jsonb,
  "timestamp",
  "timestamp",
  case parse_status
    when 'parsed' then 'callout'
    when 'not_callout' then 'not_callout'
    when 'failed' then 'failed'
    when 'skipped' then 'missed'
  end,
  case when parse_status = 'parsed' then parse end,
  now()
from public.callouts
on conflict (id) do nothing;

drop table public.callouts;

-- ---------------------------------------------------------------------------
-- Default-deny, same reasoning as the original schema migration.
-- ---------------------------------------------------------------------------

alter table public.messages enable row level security;
revoke all on table public.messages from anon, authenticated;
grant select, insert, update, delete on public.messages to service_role;
