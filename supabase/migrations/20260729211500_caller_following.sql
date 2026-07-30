-- Caller Following (docs/specs/0001-caller-following.md): the Caller roster
-- and the author id the per-user Following gate filters on.
--
-- Same access model as 20260725012642_multi_tenant_schema.sql: default-deny.
-- RLS on, zero policies, anon/authenticated grants revoked, service_role
-- granted explicitly. The roster is served to clients only through the
-- authenticated GET /api/callers route in server/src/trader/server.ts.

-- =============================================================================
-- callers — one row per Caller (Discord author). Upserted on every ingested
-- callout from envelope data; seeded once via server/src/scripts/seedCallers.ts
-- so the picker is not empty before the first ingested message.
-- =============================================================================

create table public.callers (
  -- Discord author id (user or bot), the unit of per-user Following.
  author_id text primary key,
  display_name text not null,
  -- Plain public CDN URL (custom avatar or Discord's default-avatar fallback).
  avatar_url text,
  -- Timestamp of the Caller's most recently ingested message.
  last_seen_at timestamptz not null
);

-- The author a callout came from, so the Following gate and the client-side
-- feed filter can match callouts to Callers. Nullable: rows written before
-- this feature carry no author id.
alter table public.callouts add column author_id text;

alter table public.callers enable row level security;
revoke all on table public.callers from anon, authenticated;
grant select, insert, update, delete on public.callers to service_role;
