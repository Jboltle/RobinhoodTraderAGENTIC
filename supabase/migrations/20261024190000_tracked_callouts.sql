-- Tracked callouts: every Caller entry priced against live marks with a
-- simulated trim ladder, whether or not any user traded it. One row per
-- opening Buy, keyed by its Discord message id; the book monitor
-- (server/src/trader/book/monitor.ts) writes marks and ladder fills, the
-- pipeline writes Caller exits, and GET /api/book reads it. Shape mirrors
-- TrackedPosition in server/src/trader/book/ladder.ts.
--
-- Shared data, no user scope (like callers / recaps). ACCESS MODEL: default-
-- deny like every other table — RLS on, zero policies, anon and authenticated
-- grants revoked. The server reaches it over the direct SUPABASE_DB_URL
-- connection.

create table public.tracked_callouts (
  message_id text primary key,
  author_id text not null,
  ticker text not null,
  option_type text not null check (option_type in ('call', 'put')),
  strike numeric not null,
  expiration date not null,
  -- The Caller's stated premium, or the first mark seen when none was stated.
  entry_price numeric,
  -- Contracts the entry is tracked as ($5k nominal rule); 0 until priced.
  nominal_qty integer not null default 0,
  opened_at timestamptz not null,
  closed_at timestamptz,
  closed_by text check (closed_by in ('caller_exit', 'ladder', 'expiry')),
  exit_price numeric,
  last_mark numeric,
  last_mark_at timestamptz,
  highest_pct numeric,
  highest_price numeric,
  -- LadderLevel[] and TrackedFill[] (book/ladder.ts).
  ladder jsonb not null default '[]'::jsonb,
  fills jsonb not null default '[]'::jsonb,
  result text check (result in ('win', 'loss', 'be')),
  constraint tracked_callouts_closed_consistent check (
    (closed_at is null and closed_by is null and result is null)
    or (closed_at is not null and closed_by is not null and result is not null)
  )
);

-- The monitor's work list: open rows.
create index tracked_callouts_open_idx on public.tracked_callouts (opened_at)
  where closed_at is null;
-- Closed-today / sessions read newest-closed first.
create index tracked_callouts_closed_at_idx on public.tracked_callouts (closed_at desc)
  where closed_at is not null;
-- A Caller's exit looks up their open entry in the ticker.
create index tracked_callouts_caller_open_idx on public.tracked_callouts (author_id, ticker)
  where closed_at is null;

alter table public.tracked_callouts enable row level security;
revoke all on table public.tracked_callouts from anon, authenticated;
grant select, insert, update, delete on public.tracked_callouts to service_role;
