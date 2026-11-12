-- Accounts, step 1 of 2: EXPAND.
--
-- Settings, trades and broker connections move from one-per-user to
-- one-per-connected-account, so a user can hold a Robinhood account and
-- SnapTrade accounts side by side, each trading under its own settings and
-- against its own lots. This file only adds; nothing the previous trader code
-- reads or writes is removed or changed, so it is safe to apply while that
-- code is still running:
--
--   * users keeps its settings columns and broker_connections stays. Triggers
--     below copy every write the old code makes to them (a settings save, a
--     Robinhood token refresh, a disconnect, a first sign-in) onto the user's
--     account row, so nothing written between this file and the deploy is lost.
--   * trades.account_id is filled by a trigger when an insert omits it, and
--     trades_user_message_uidx stays, so the old code's
--     ON CONFLICT (user_id, message_id) still has its index.
--
-- The new code reads and writes accounts only and runs correctly on a database
-- that has had this file and not the contract step. Step 2
-- (20261111210000_accounts_contract.sql) removes the old columns, the old table
-- and these triggers; it must wait until the new code is the only code running.
--
-- Apply by hand in one transaction:
--   psql "<database URL>" -X -1 -v ON_ERROR_STOP=1 -f <this file>
-- Safe to run again: a second run adds nothing and never overwrites an account.
-- Takes ACCESS EXCLUSIVE on trades and users for the length of the transaction
-- (well under a second at ten thousand trades); lock_timeout makes it give up
-- rather than queue behind a long query and stall the trader.

set lock_timeout = '5s';

do $$
begin
  if to_regclass('public.accounts') is not null and to_regclass('public.broker_connections') is null then
    raise exception 'the accounts contract step has already run here; the expand step must not run after it';
  end if;
end
$$;

-- =============================================================================
-- accounts: one row per real brokerage account, the same columns for every
-- broker. Mirrored by `accounts` in server/src/trader/db/schema.ts.
-- =============================================================================

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,

  -- How we reach the account: BrokerId in server/src/trader/broker/types.ts.
  adapter text not null check (adapter in ('robinhood', 'snaptrade')),
  -- Which broker holds it ('robinhood', 'alpaca-paper', ...). A Robinhood
  -- account reached directly is robinhood/robinhood; one seen through SnapTrade
  -- would be snaptrade/robinhood, so the two are never confused.
  institution text not null,
  -- The broker's own account id. Null on a direct Robinhood account: the
  -- OAuth grant names the account and no id is needed to reach it.
  external_account_id text,
  label text not null,
  is_paper boolean not null default false,
  needs_reconnect boolean not null default false,
  -- When the connection was removed; the row, its settings and its trades stay.
  disconnected_at timestamptz,

  -- Ciphertext only (AES-256-GCM under RH_TOKENS_VAULT_KEY), null when the
  -- adapter keeps none or the account is not connected. Robinhood: the OAuth
  -- client, tokens and PKCE verifier that broker_connections held.
  credentials text,
  -- Shape depends on adapter (AccountRow in broker/types.ts), validated on
  -- read. robinhood: {}. snaptrade: { connectionId, institutionSlug,
  -- maskedAccountNumber }. A new adapter adds a variant, not a migration.
  adapter_data jsonb not null default '{}'::jsonb,

  -- Trade settings: the columns users carried, same types, defaults and checks.
  -- Defaults mirror TradeSettingsSchema in server/src/shared/types.ts.
  execution_mode text not null default 'approval'
    check (execution_mode in ('immediate', 'approval')),
  equity_small_pct numeric not null default 1.25,
  equity_medium_pct numeric not null default 2.5,
  equity_full_pct numeric not null default 5,
  options_small_pct numeric not null default 0.5,
  options_medium_pct numeric not null default 1,
  options_full_pct numeric not null default 2,
  options_lotto_pct numeric not null default 0.25,
  max_single_contract_pct numeric not null default 5,
  max_trades_per_day integer not null default 10,
  cooldown_seconds numeric not null default 300,
  allowed_tickers text[] not null default '{}',
  blocked_tickers text[] not null default '{}',
  min_confidence numeric not null default 0.7,
  regular_hours_only boolean not null default true,
  allow_lotto_trades boolean not null default false,
  -- '{}' = follow no one (default); NULL = legacy follow-everyone.
  followed_caller_ids text[] default '{}',
  max_loss_pct numeric,
  max_loss_usd numeric,
  exit_mode text not null default 'caller'
    check (exit_mode in ('caller', 'ladder')),
  trim_levels jsonb not null default
    '[{"gainPct":25,"portionPct":25},{"gainPct":50,"portionPct":25},{"gainPct":75,"portionPct":25},{"gainPct":100,"portionPct":25}]',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One direct Robinhood account per user: what broker_connections' primary key
-- on user_id enforced.
create unique index if not exists accounts_one_direct_robinhood_uidx
  on public.accounts (user_id) where adapter = 'robinhood';
-- The same brokerage account is never imported twice for a user.
create unique index if not exists accounts_user_adapter_external_uidx
  on public.accounts (user_id, adapter, external_account_id);

-- Default-deny like every other table; the trader connects as the owner.
alter table public.accounts enable row level security;

create or replace trigger accounts_updated_at
  before update on public.accounts
  for each row
  execute function extensions.moddatetime(updated_at);

-- =============================================================================
-- Backfill: one direct Robinhood account per user, carrying that user's
-- settings and, where they have connected, their encrypted tokens. A user who
-- already has the row (a second run) is skipped, never overwritten.
-- =============================================================================

insert into public.accounts (
  user_id, adapter, institution, label, credentials, disconnected_at,
  execution_mode, equity_small_pct, equity_medium_pct, equity_full_pct,
  options_small_pct, options_medium_pct, options_full_pct, options_lotto_pct,
  max_single_contract_pct, max_trades_per_day, cooldown_seconds,
  allowed_tickers, blocked_tickers, min_confidence, regular_hours_only,
  allow_lotto_trades, followed_caller_ids, max_loss_pct, max_loss_usd,
  exit_mode, trim_levels, updated_at
)
select
  u.id, 'robinhood', 'robinhood', 'Robinhood', b.encrypted_tokens, null,
  u.execution_mode, u.equity_small_pct, u.equity_medium_pct, u.equity_full_pct,
  u.options_small_pct, u.options_medium_pct, u.options_full_pct, u.options_lotto_pct,
  u.max_single_contract_pct, u.max_trades_per_day, u.cooldown_seconds,
  u.allowed_tickers, u.blocked_tickers, u.min_confidence, u.regular_hours_only,
  u.allow_lotto_trades, u.followed_caller_ids, u.max_loss_pct, u.max_loss_usd,
  u.exit_mode, u.trim_levels, u.updated_at
from public.users u
left join public.broker_connections b on b.user_id = u.id
on conflict (user_id) where adapter = 'robinhood' do nothing;

-- =============================================================================
-- users.selected_account_id: the account the dashboard and Settings show.
-- Switching it never changes which accounts trade.
-- =============================================================================

alter table public.users
  add column if not exists selected_account_id uuid
    references public.accounts (id) on delete set null;

update public.users u
   set selected_account_id = a.id
  from public.accounts a
 where a.user_id = u.id and a.adapter = 'robinhood' and u.selected_account_id is null;

-- =============================================================================
-- trades.account_id: every decision belongs to one account. user_id stays.
-- No ON DELETE action on purpose: deleting an account that still has trades is
-- refused, because its filled buys are the lots a later sell is sized from. A
-- user delete still cascades to both.
-- =============================================================================

alter table public.trades
  add column if not exists account_id uuid references public.accounts (id);

-- Old-code inserts name no account. Created before the backfill so no row can
-- land between the two without one.
create or replace function public.trades_fill_account_id()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  select a.id into new.account_id
    from public.accounts a
   where a.user_id = new.user_id and a.adapter = 'robinhood';
  return new;
end;
$$;

create or replace trigger trades_fill_account_id
  before insert on public.trades
  for each row
  when (new.account_id is null)
  execute function public.trades_fill_account_id();

update public.trades t
   set account_id = a.id
  from public.accounts a
 where a.user_id = t.user_id and a.adapter = 'robinhood' and t.account_id is null;

alter table public.trades alter column account_id set not null;

-- One decision per account per message: the backstop behind the poller's
-- claim, as trades_user_message_uidx was per user. That index stays until the
-- contract step; with one account per user the two reject the same rows.
create unique index if not exists trades_account_message_uidx
  on public.trades (account_id, message_id);
create index if not exists trades_account_id_timestamp_idx
  on public.trades (account_id, "timestamp" desc);
create index if not exists trades_account_id_ticker_timestamp_idx
  on public.trades (account_id, ticker, "timestamp" desc);

-- =============================================================================
-- Forward sync for the old code, dropped by the contract step. The new code
-- never writes these users columns or broker_connections, so under it the
-- triggers below only ever fire for a first sign-in.
-- =============================================================================

-- A first sign-in gets its Robinhood account; a settings save reaches it.
create or replace function public.users_sync_account()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.accounts (user_id, adapter, institution, label)
    values (new.id, 'robinhood', 'robinhood', 'Robinhood')
    on conflict (user_id) where adapter = 'robinhood' do nothing;

    update public.users u
       set selected_account_id = a.id
      from public.accounts a
     where u.id = new.id and u.selected_account_id is null
       and a.user_id = new.id and a.adapter = 'robinhood';
  end if;

  update public.accounts
     set (
       execution_mode, equity_small_pct, equity_medium_pct, equity_full_pct,
       options_small_pct, options_medium_pct, options_full_pct, options_lotto_pct,
       max_single_contract_pct, max_trades_per_day, cooldown_seconds,
       allowed_tickers, blocked_tickers, min_confidence, regular_hours_only,
       allow_lotto_trades, followed_caller_ids, max_loss_pct, max_loss_usd,
       exit_mode, trim_levels
     ) = (
       new.execution_mode, new.equity_small_pct, new.equity_medium_pct, new.equity_full_pct,
       new.options_small_pct, new.options_medium_pct, new.options_full_pct, new.options_lotto_pct,
       new.max_single_contract_pct, new.max_trades_per_day, new.cooldown_seconds,
       new.allowed_tickers, new.blocked_tickers, new.min_confidence, new.regular_hours_only,
       new.allow_lotto_trades, new.followed_caller_ids, new.max_loss_pct, new.max_loss_usd,
       new.exit_mode, new.trim_levels
     )
   where user_id = new.id and adapter = 'robinhood';
  return null;
end;
$$;

create or replace trigger users_sync_account
  after insert or update of
    execution_mode, equity_small_pct, equity_medium_pct, equity_full_pct,
    options_small_pct, options_medium_pct, options_full_pct, options_lotto_pct,
    max_single_contract_pct, max_trades_per_day, cooldown_seconds,
    allowed_tickers, blocked_tickers, min_confidence, regular_hours_only,
    allow_lotto_trades, followed_caller_ids, max_loss_pct, max_loss_usd,
    exit_mode, trim_levels
  on public.users
  for each row
  execute function public.users_sync_account();

-- A Robinhood token write (connect, refresh, invalidate) or a disconnect
-- reaches the account. Robinhood rotates the refresh token on every refresh,
-- so one that landed only in broker_connections would leave the account
-- holding a dead grant.
create or replace function public.broker_connections_sync_account()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    update public.accounts
       set credentials = null, disconnected_at = now()
     where user_id = old.user_id and adapter = 'robinhood';
  else
    update public.accounts
       set credentials = new.encrypted_tokens, disconnected_at = null
     where user_id = new.user_id and adapter = 'robinhood';
  end if;
  return null;
end;
$$;

create or replace trigger broker_connections_sync_account
  after insert or update or delete on public.broker_connections
  for each row
  execute function public.broker_connections_sync_account();
