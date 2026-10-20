-- Sign-in moves off Supabase Auth into the trader (server/src/trader/auth.ts):
-- typing the email of an account, or of an invited address, starts a session.
-- Production also moves to a plain Postgres with no auth schema. So:
--
--   users.id   minted here (gen_random_uuid) instead of copied from auth.users,
--              so its foreign key and the sync trigger go; an invited email
--              (allowed_emails) gets its row at its first sign-in
--   sessions   one row per signed-in browser, keyed by the SHA-256 of its
--              bearer token so a database read cannot be replayed as a login
--
-- Guarded so the same file applies to the local Supabase stack (which has an
-- auth schema) and to a plain Postgres (which does not).

alter table public.users drop constraint if exists users_id_fkey;
alter table public.users alter column id set default gen_random_uuid();

do $$
begin
  if to_regclass('auth.users') is not null then
    drop trigger if exists sync_user_from_auth on auth.users;
  end if;
end
$$;
drop function if exists public.sync_user_from_auth();

create table public.sessions (
  token_hash text primary key,
  user_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index sessions_user_id_idx on public.sessions (user_id);

-- Default-deny like every other table; the trader connects as the owner.
alter table public.sessions enable row level security;
