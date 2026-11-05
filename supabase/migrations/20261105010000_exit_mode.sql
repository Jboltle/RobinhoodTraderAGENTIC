-- How a user exits, and the levels their own ladder sells at.
-- exit_mode 'caller' copies the Caller's trims. 'ladder' ignores those trims
-- and sells the levels in trim_levels. A Caller's full close still closes
-- what remains in either mode. Mirrors exitMode / trimLevels in
-- TradeSettingsSchema (server/src/shared/types.ts).
alter table public.users
  add column exit_mode text not null default 'caller',
  add column trim_levels jsonb not null default
    '[{"gainPct":25,"portionPct":25},{"gainPct":50,"portionPct":25},{"gainPct":75,"portionPct":25},{"gainPct":100,"portionPct":25}]';

alter table public.users
  add constraint users_exit_mode_check check (exit_mode in ('caller', 'ladder'));
