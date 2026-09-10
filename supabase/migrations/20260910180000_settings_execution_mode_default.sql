-- executionMode lives on settings.payload, not in process env.
-- New rows default to approval; existing rows missing the key get the same.

alter table public.settings
  alter column payload set default '{"executionMode":"approval"}'::jsonb;

update public.settings
set payload = jsonb_set(payload, '{executionMode}', '"approval"', true)
where coalesce(payload ->> 'executionMode', '') = '';
