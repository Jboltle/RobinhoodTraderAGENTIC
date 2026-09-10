-- users consolidation: one row per account carrying identity (id + email,
-- synced from auth.users) and every trade setting as a typed column.
--
-- Replaces two things:
--   settings      the schemaless jsonb payload — two earlier migrations had to
--                 do jsonb surgery on it; typed columns make the next settings
--                 change a plain `alter table`.
--   user_emails   the auth.users view — the sync trigger below keeps email
--                 current in public, which is exactly what the view existed to
--                 avoid copying.
--
-- trades and broker_connections re-point their user_id foreign keys here so the
-- whole per-user graph lives in the public schema. Deletion semantics are
-- unchanged: users.id cascades from auth.users, so an auth-level delete still
-- ripples through.
--
-- Deliberately NOT touched:
--   callouts / callers / recaps / recap_insights  shared data, no user scope.
--   allowed_emails   invite gate, not an auth mechanism. Sign-in is a magic
--                    link today and may change; the gate stays independent.
--   broker_connections  user_id stays the primary key — the schema-level
--                    guarantee of exactly one Robinhood connection per user.
--                    Multi-platform later = add a provider column + widen the
--                    pk; nothing here blocks that.
--
-- Same access model as every other table (see 20260725012642): default-deny.
-- RLS on, zero policies, anon/authenticated revoked, service_role granted.

-- moddatetime keeps updated_at honest: the old settings.updated_at defaulted to
-- now() on insert but no write ever refreshed it, so it silently meant created_at.
create extension if not exists moddatetime with schema extensions;

-- =============================================================================
-- users — identity + resolved trade settings, one row per account.
--
-- Column defaults mirror TradeSettingsSchema in server/src/shared/types.ts,
-- which remains the API validation layer for PUT /api/settings. Keep the two
-- in sync when a setting is added.
-- =============================================================================

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  -- Synced from auth.users by sync_user_from_auth(); never written by the app.
  email text not null unique,

  -- ExecutionMode in server/src/shared/types.ts.
  execution_mode text not null default 'approval'
    check (execution_mode in ('immediate', 'approval')),

  -- Position sizing: plain percentages of buying power. `full` doubles as the
  -- per-trade ceiling for explicit dollar/share/contract callouts.
  equity_small_pct numeric not null default 1.25,
  equity_medium_pct numeric not null default 2.5,
  equity_full_pct numeric not null default 5,
  options_small_pct numeric not null default 0.5,
  options_medium_pct numeric not null default 1,
  options_full_pct numeric not null default 2,
  -- Skip options trades where even 1 contract exceeds this % of buying power.
  max_single_contract_pct numeric not null default 5,

  max_trades_per_day integer not null default 10,
  cooldown_seconds numeric not null default 300,

  -- Empty = allow every ticker.
  allowed_tickers text[] not null default '{}',
  blocked_tickers text[] not null default '{}',

  min_confidence numeric not null default 0.7,
  regular_hours_only boolean not null default true,

  -- Following: '{}' = follow no one (default), non-empty = exactly those
  -- Discord author ids. NULL means "follow everyone including future Callers" —
  -- the legacy meaning rows written before the default flipped rely on; the UI
  -- no longer produces it.
  followed_caller_ids text[] default '{}',

  -- Max Loss: flatten a position when unrealized loss hits either threshold.
  -- null / 0 = that side off. Both off (the default) = feature off.
  max_loss_pct numeric,
  max_loss_usd numeric,

  updated_at timestamptz not null default now()
);

alter table public.users enable row level security;
revoke all on table public.users from anon, authenticated;
grant select, insert, update, delete on public.users to service_role;

create trigger users_updated_at
  before update on public.users
  for each row
  execute function extensions.moddatetime(updated_at);

-- =============================================================================
-- auth.users -> public.users sync.
--
-- Insert-or-email-update keeps every auth user mirrored here with a current
-- email, regardless of how they signed in (magic link today, whatever later).
-- ensureUser() in db.ts therefore needs no follow-up write after
-- auth.admin.createUser — this trigger creates the profile row.
--
-- Security definer: the trigger fires as the auth admin flow's role, which has
-- no grant on public.users; definer (postgres) does.
-- =============================================================================

create function public.sync_user_from_auth()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger sync_user_from_auth
  after insert or update of email on auth.users
  for each row
  when (new.email is not null)
  execute function public.sync_user_from_auth();

-- =============================================================================
-- Backfill: one row per existing auth user, hydrating settings from the old
-- jsonb payload where a row exists. coalesce() falls back to the schema
-- defaults, so a user with no settings row lands exactly where a fresh parse
-- of {} would have put them.
-- =============================================================================

insert into public.users (
  id, email, execution_mode,
  equity_small_pct, equity_medium_pct, equity_full_pct,
  options_small_pct, options_medium_pct, options_full_pct,
  max_single_contract_pct, max_trades_per_day, cooldown_seconds,
  allowed_tickers, blocked_tickers, min_confidence, regular_hours_only,
  followed_caller_ids, max_loss_pct, max_loss_usd, updated_at
)
select
  u.id,
  u.email,
  coalesce(s.payload ->> 'executionMode', 'approval'),
  coalesce((s.payload ->> 'equitySmallPct')::numeric, 1.25),
  coalesce((s.payload ->> 'equityMediumPct')::numeric, 2.5),
  coalesce((s.payload ->> 'equityFullPct')::numeric, 5),
  coalesce((s.payload ->> 'optionsSmallPct')::numeric, 0.5),
  coalesce((s.payload ->> 'optionsMediumPct')::numeric, 1),
  coalesce((s.payload ->> 'optionsFullPct')::numeric, 2),
  coalesce((s.payload ->> 'maxSingleContractPct')::numeric, 5),
  coalesce((s.payload ->> 'maxTradesPerDay')::integer, 10),
  coalesce((s.payload ->> 'cooldownSeconds')::numeric, 300),
  array(select jsonb_array_elements_text(s.payload -> 'allowedTickers')),
  array(select jsonb_array_elements_text(s.payload -> 'blockedTickers')),
  coalesce((s.payload ->> 'minConfidence')::numeric, 0.7),
  coalesce((s.payload ->> 'regularHoursOnly')::boolean, true),
  -- Three-way: key absent -> '{}' (follow no one, the modern default);
  -- explicit json null -> NULL (legacy follow-everyone); array -> the array.
  case
    when s.payload is null or not s.payload ? 'followedCallerIds' then '{}'::text[]
    when s.payload -> 'followedCallerIds' = 'null'::jsonb then null
    else array(select jsonb_array_elements_text(s.payload -> 'followedCallerIds'))
  end,
  (s.payload ->> 'maxLossPct')::numeric,
  (s.payload ->> 'maxLossUsd')::numeric,
  coalesce(s.updated_at, now())
from auth.users u
left join public.settings s on s.user_id = u.id
where u.email is not null;

-- =============================================================================
-- Re-point per-user foreign keys from auth.users to public.users. Runs after
-- the backfill so every referenced id already has a row. No data changes.
-- =============================================================================

alter table public.trades
  drop constraint trades_user_id_fkey,
  add constraint trades_user_id_fkey
    foreign key (user_id) references public.users (id) on delete cascade;

alter table public.broker_connections
  drop constraint broker_connections_user_id_fkey,
  add constraint broker_connections_user_id_fkey
    foreign key (user_id) references public.users (id) on delete cascade;

-- =============================================================================
-- Retire the replaced objects. settings data was copied above; user_emails is
-- a pure view over auth.users, nothing stored.
-- =============================================================================

drop view public.user_emails;
drop table public.settings;
