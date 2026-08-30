-- Recap Performance & Metrix: storage for daily trade-recap posts and the
-- cached AI narration derived from them.
--
-- Raw-first design: `content` is the source of truth; `parse` is a disposable
-- jsonb cache stamped with `parser_version`. When the recap format drifts, the
-- regex parser is updated, the version bumped, and every row re-parses from
-- stored raw content — no Discord re-fetch, no schema change.
--
-- Same access model as 20260725012642_multi_tenant_schema.sql: default-deny.
-- RLS on, zero policies, anon/authenticated grants revoked, service_role
-- granted explicitly. Served to clients only through the authenticated
-- GET /api/recaps/performance route in server/src/trader/server.ts.

-- =============================================================================
-- recaps — one row per message seen in a DISCORD_RECAP_CHANNEL_IDS channel.
-- Non-recap posts (morning updates, earnings previews) are stored with
-- parse_status 'not_recap' so the sweep never re-fetches them.
-- =============================================================================

create table public.recaps (
  -- Discord message id; the idempotency key for live ingest + sweep upserts.
  message_id text primary key,
  channel_id text not null,
  -- Discord message timestamp (when the recap was posted, usually evening ET).
  posted_at timestamptz not null,
  -- Trading day parsed from the recap header ("... DAILY RECAP | AUGUST 19, 2026"),
  -- not from posted_at: evening posts cross midnight UTC. Null when the header
  -- is absent or unparsable (non-recap posts).
  recap_date date,
  -- Raw flattened message content — the source of truth for (re)parsing.
  content text not null,
  -- SHA-256 of content; the sweep re-parses when an edited recap changes it.
  content_hash text not null,
  -- Cached RecapParse (trades, futures counts, claimed stats, checksum).
  parse jsonb,
  -- 'parsed' | 'parsed_partial' (unparsed lines or checksum mismatch)
  -- | 'not_recap' | 'failed'
  parse_status text not null,
  -- PARSER_VERSION that produced `parse`; rows below the current version are
  -- re-parsed from `content` at boot/sweep.
  parser_version integer not null default 0
);

-- The performance window filter is always "recap_date >= now() - N days".
create index recaps_recap_date_idx on public.recaps (recap_date);

-- =============================================================================
-- recap_insights — one row per window: the LLM-written narrative over the
-- computed stats, regenerated when recap rows change so page loads never
-- wait on a model call.
-- =============================================================================

create table public.recap_insights (
  window_days integer primary key,
  generated_at timestamptz not null,
  content text not null
);

alter table public.recaps enable row level security;
revoke all on table public.recaps from anon, authenticated;
grant select, insert, update, delete on public.recaps to service_role;

alter table public.recap_insights enable row level security;
revoke all on table public.recap_insights from anon, authenticated;
grant select, insert, update, delete on public.recap_insights to service_role;
