-- What a Supabase stack already has and a bare Postgres does not, so that
-- supabase/migrations/*.sql apply to a throwaway local database. Used only by
-- the opt-in test accountOwnership.sql.test.ts; never applied anywhere real.

create schema if not exists auth;
create schema if not exists extensions;

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role; end if;
end
$$;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);
