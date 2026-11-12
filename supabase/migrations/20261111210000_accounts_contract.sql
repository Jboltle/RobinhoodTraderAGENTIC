-- Accounts, step 2 of 2: CONTRACT.
--
-- Removes what 20261111200000_accounts_expand.sql left in place for the old
-- trader code: the settings columns on users, broker_connections, the
-- per-user indexes on trades, the one-account-per-user index and the triggers
-- that kept the two shapes in step.
--
-- ONLY run this once the accounts code is the only trader code running against
-- the database and is not going to be rolled back. The old code cannot run
-- after it: its settings reads, its token reads and its trades inserts all
-- fail. Until then the expand step alone is a complete, working schema.
--
-- trades_user_message_uidx has to go before a user can hold a second account:
-- two accounts of one user taking the same callout are two rows with the same
-- (user_id, message_id). trades_account_message_uidx is the dedupe from here.
--
-- Apply by hand, with the trader stopped:
--   psql "<database URL>" -X -1 -v ON_ERROR_STOP=1 -f <this file>
-- Safe to run again.
--
-- The whole step is ONE statement, the DO block below, so the drops cannot
-- run when the guard fails, however psql is invoked. The flags above are still
-- the way to run it; ON_ERROR_STOP is what makes psql exit non-zero.

do $contract$
begin
  set local lock_timeout = '5s';

  if to_regclass('public.accounts') is null then
    raise exception 'public.accounts does not exist; run the accounts expand step first';
  end if;

  -- Every table this step alters, locked up front; each statement below is a
  -- catalog change, so they are held for milliseconds. trades first: an insert
  -- holds trades and then needs users and accounts for its foreign-key checks,
  -- so taking either of those first deadlocks with it and Postgres aborts the
  -- insert, which is an order with no row. accounts and users reference each
  -- other, so no order is safe against every statement on those two; that is
  -- one reason the trader is stopped for this step.
  lock table public.trades in access exclusive mode;
  -- Gone on a second run.
  if to_regclass('public.broker_connections') is not null then
    lock table public.broker_connections in access exclusive mode;
  end if;
  lock table public.accounts, public.users in access exclusive mode;

  if exists (
    select 1 from public.users u
     where not exists (select 1 from public.accounts a where a.user_id = u.id)
  ) then
    raise exception 'a user has no account; run the accounts expand step first';
  end if;

  drop trigger if exists users_sync_account on public.users;
  drop function if exists public.users_sync_account();

  drop trigger if exists trades_fill_account_id on public.trades;
  drop function if exists public.trades_fill_account_id();

  -- Its tokens were copied to accounts.credentials by the expand step and kept
  -- current by its trigger, which goes with the table.
  drop table if exists public.broker_connections;
  drop function if exists public.broker_connections_sync_account();

  drop index if exists public.trades_user_message_uidx;
  -- Every read is by account now; trades_account_id_* replace these.
  drop index if exists public.trades_user_id_timestamp_idx;
  drop index if exists public.trades_user_id_ticker_timestamp_idx;
  -- A user may hold several accounts from here.
  drop index if exists public.accounts_one_per_user_until_contract_uidx;

  -- users is identity only from here: id, email, selected_account_id, updated_at.
  alter table public.users
    drop column if exists execution_mode,
    drop column if exists equity_small_pct,
    drop column if exists equity_medium_pct,
    drop column if exists equity_full_pct,
    drop column if exists options_small_pct,
    drop column if exists options_medium_pct,
    drop column if exists options_full_pct,
    drop column if exists options_lotto_pct,
    drop column if exists max_single_contract_pct,
    drop column if exists max_trades_per_day,
    drop column if exists cooldown_seconds,
    drop column if exists allowed_tickers,
    drop column if exists blocked_tickers,
    drop column if exists min_confidence,
    drop column if exists regular_hours_only,
    drop column if exists allow_lotto_trades,
    drop column if exists followed_caller_ids,
    drop column if exists max_loss_pct,
    drop column if exists max_loss_usd,
    drop column if exists exit_mode,
    drop column if exists trim_levels;
end
$contract$;
