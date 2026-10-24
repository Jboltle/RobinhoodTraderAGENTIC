-- Lotto trades: entries the Caller labels a lotto are skipped (risk code
-- lotto_blocked) until the user opts in from the Settings page, and once
-- taken they deploy their own slice of buying power rather than Small.
-- Mirrors allowLottoTrades / optionsLottoPct in TradeSettingsSchema
-- (server/src/shared/types.ts).
alter table public.users
  add column allow_lotto_trades boolean not null default false,
  add column options_lotto_pct numeric not null default 0.25;
