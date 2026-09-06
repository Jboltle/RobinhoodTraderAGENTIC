-- Position sizing: cap x fraction -> direct percentages.
--
-- The old model multiplied a per-trade cap by a size keyword's fraction of
-- that cap, so "medium" meant 50% of 5% = 2.5% of buying power and no field
-- on its own told you what a trade would cost. The new model stores the six
-- resolved percentages directly, and `full` doubles as the per-trade ceiling
-- that maxNotionalPct/maxOptionsNotionalPct used to be.
--
-- Settings rows hold a full resolved snapshot, so a user who customized
-- maxNotionalPct would silently drop to the new default if their old keys were
-- just ignored. This derives the new values arithmetically instead, which is
-- exactly behavior-preserving: the defaults below (5, 2, 25, 50) reproduce the
-- new schema defaults, and a customized value carries through unchanged.
--
-- Matches TradeSettingsSchema in server/src/shared/types.ts.

update public.settings
set payload =
  payload
    - 'maxNotionalPct'
    - 'maxOptionsNotionalPct'
    - 'positionSmallPct'
    - 'positionMediumPct'
  || jsonb_build_object(
       'equityFullPct',
         coalesce((payload ->> 'maxNotionalPct')::numeric, 5),
       'equityMediumPct',
         coalesce((payload ->> 'maxNotionalPct')::numeric, 5)
           * coalesce((payload ->> 'positionMediumPct')::numeric, 50) / 100,
       'equitySmallPct',
         coalesce((payload ->> 'maxNotionalPct')::numeric, 5)
           * coalesce((payload ->> 'positionSmallPct')::numeric, 25) / 100,
       'optionsFullPct',
         coalesce((payload ->> 'maxOptionsNotionalPct')::numeric, 2),
       'optionsMediumPct',
         coalesce((payload ->> 'maxOptionsNotionalPct')::numeric, 2)
           * coalesce((payload ->> 'positionMediumPct')::numeric, 50) / 100,
       'optionsSmallPct',
         coalesce((payload ->> 'maxOptionsNotionalPct')::numeric, 2)
           * coalesce((payload ->> 'positionSmallPct')::numeric, 25) / 100
     )
where payload ?| array[
  'maxNotionalPct',
  'maxOptionsNotionalPct',
  'positionSmallPct',
  'positionMediumPct'
];
