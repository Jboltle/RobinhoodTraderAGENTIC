-- Accounts ROLLBACK: the reverse copy. NOT a migration; nothing applies this
-- folder automatically, and it is never part of a normal deploy.
--
-- Run it only to put the previous trader code (the code that reads settings
-- from users and tokens from broker_connections) back on a database that has
-- had 20261111200000_accounts_expand.sql and NOT the contract step. The accounts
-- code writes accounts only, so from its first deploy the old columns and
-- broker_connections go stale: old settings, a refresh token Robinhood has
-- since retired, a connection the user has removed. This copies what the
-- accounts hold now back onto them, so the old code starts from current data.
--
-- Order: stop the trader (the accounts code), run this, then deploy the old
-- code. Anything the accounts code writes after the copy is lost to the old.
--
--   psql "<database URL>" -X -1 -v ON_ERROR_STOP=1 -f <this file>
--
-- Safe to run again. There is no rollback after the contract step: the
-- columns and the table this writes to are gone, and this refuses to run.
--
-- ONE statement, the DO block below, so it copies everything or nothing
-- however psql is invoked.

do $rollback$
begin
  set local lock_timeout = '5s';

  if to_regclass('public.accounts') is null then
    raise exception 'public.accounts does not exist: the accounts expand step never ran here, so there is nothing to copy back';
  end if;
  if to_regclass('public.broker_connections') is null then
    raise exception 'the accounts contract step has run here: the old code cannot be put back, there is no rollback';
  end if;

  -- broker_connections and accounts before users, as in the expand step.
  lock table public.broker_connections, public.accounts, public.users in access exclusive mode;

  -- The expand step's triggers copy the old code's writes onto accounts. They
  -- stay installed for the old code; they are off for this copy only, so it
  -- leaves every account exactly as it is.
  alter table public.users disable trigger users_sync_account;
  alter table public.broker_connections disable trigger broker_connections_sync_account;

  update public.users u
     set (
       execution_mode, equity_small_pct, equity_medium_pct, equity_full_pct,
       options_small_pct, options_medium_pct, options_full_pct, options_lotto_pct,
       max_single_contract_pct, max_trades_per_day, cooldown_seconds,
       allowed_tickers, blocked_tickers, min_confidence, regular_hours_only,
       allow_lotto_trades, followed_caller_ids, max_loss_pct, max_loss_usd,
       exit_mode, trim_levels
     ) = (
       a.execution_mode, a.equity_small_pct, a.equity_medium_pct, a.equity_full_pct,
       a.options_small_pct, a.options_medium_pct, a.options_full_pct, a.options_lotto_pct,
       a.max_single_contract_pct, a.max_trades_per_day, a.cooldown_seconds,
       a.allowed_tickers, a.blocked_tickers, a.min_confidence, a.regular_hours_only,
       a.allow_lotto_trades, a.followed_caller_ids, a.max_loss_pct, a.max_loss_usd,
       a.exit_mode, a.trim_levels
     )
    from public.accounts a
   where a.user_id = u.id and a.adapter = 'robinhood';

  insert into public.broker_connections (user_id, encrypted_tokens)
  select a.user_id, a.credentials
    from public.accounts a
   where a.adapter = 'robinhood' and a.credentials is not null
  on conflict (user_id) do update
     set encrypted_tokens = excluded.encrypted_tokens, updated_at = now();

  -- Disconnected under the accounts code: the old code must not fan out to it.
  delete from public.broker_connections b
   using public.accounts a
   where a.user_id = b.user_id and a.adapter = 'robinhood' and a.credentials is null;

  alter table public.users enable trigger users_sync_account;
  alter table public.broker_connections enable trigger broker_connections_sync_account;
end
$rollback$;
