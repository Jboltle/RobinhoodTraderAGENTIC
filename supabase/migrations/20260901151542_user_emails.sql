-- user_emails — email ↔ auth user id in the public schema.
--
-- trades / settings / broker_connections key on user_id; allowed_emails keys
-- on email; auth.users holds both but is not queryable from the Data API.
-- This view is the join. findUserByEmail reads it; operators can join it
-- onto any per-user table in Studio.
--
-- A view, not a table: auth.users is the source of truth. Copying email into
-- public would need a trigger to stay current.
--
-- Same access model as the tables: default-deny. Views cannot ENABLE ROW
-- LEVEL SECURITY, so the revoke is the whole lock. The view is owned by the
-- migration role and therefore reads auth.users as definer — required,
-- because service_role has no SELECT on auth.users. Do not add
-- security_invoker. Do not grant to anon or authenticated.

create view public.user_emails as
  select id as user_id, email
  from auth.users
  where email is not null;

revoke all on public.user_emails from anon, authenticated;
grant select on public.user_emails to service_role;
