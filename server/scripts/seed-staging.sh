#!/usr/bin/env bash
# Build a staging database from production: clone production's schema into
# TARGET, then copy the shared archive and the per-user history across,
# never the broker logins or sessions.
#
#   SOURCE_DB_URL=postgresql://... TARGET_DB_URL=postgresql://... server/scripts/seed-staging.sh
#
# The schema is taken from SOURCE with pg_dump rather than by replaying
# supabase/migrations: the early files assume Supabase's auth schema, which
# production never had, so a dump is the only thing guaranteed to match.
# pg_dump must be at least the server's major version (brew install libpq).
#
# The clone has production's schema, so when staging runs code ahead of
# production the migrations production has not had yet must be applied on top:
#
#   POST_CLONE_MIGRATIONS="supabase/migrations/<a>.sql supabase/migrations/<b>.sql"
#
# lists them (space separated, in order); each is applied in one transaction
# after the copy.
#
# SOURCE is read with a read-only transaction. TARGET's public schema is
# dropped and recreated, so the script is safe to re-run. Broker logins are
# never copied: a second process refreshing the same Robinhood grant
# invalidates production's refresh token, and the one agent slot per account
# cannot be shared. They live in accounts.credentials, and before the accounts
# migration in broker_connections: accounts is copied without that column and
# broker_connections is not copied at all. sessions are excluded so a
# production browser token never works against staging. Should either reach
# TARGET all the same, the closing check removes it there and the script fails.
set -euo pipefail

: "${SOURCE_DB_URL:?SOURCE_DB_URL is required (production, read-only)}"
: "${TARGET_DB_URL:?TARGET_DB_URL is required (staging)}"

if [[ "$TARGET_DB_URL" == *"railway.internal"* || "$TARGET_DB_URL" == "$SOURCE_DB_URL" ]]; then
  echo "refusing: TARGET_DB_URL looks like production" >&2
  exit 1
fi

source_sql() {
  PGOPTIONS='-c default_transaction_read_only=on' psql "$SOURCE_DB_URL" -X -q -At -v ON_ERROR_STOP=1 -c "$1"
}
target_sql() {
  psql "$TARGET_DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"
}

# Fails when TARGET holds a stored broker login, in either place one can live.
# Nested ifs: a table may not exist, and the inner query must not be planned
# then.
assert_target_has_no_broker_logins() {
  target_sql -c "
    do \$\$ begin
      if to_regclass('public.broker_connections') is not null then
        if exists (select 1 from public.broker_connections) then
          raise exception '$1: TARGET_DB_URL holds broker_connections rows';
        end if;
      end if;
      if to_regclass('public.accounts') is not null then
        if exists (select 1 from public.accounts where credentials is not null) then
          raise exception '$1: TARGET_DB_URL holds accounts with stored credentials';
        end if;
      end if;
    end \$\$;"
}

# Production holds stored broker logins and staging never does, so a TARGET
# with any is production under swapped addresses. A failed check stops the
# script before anything is dropped.
assert_target_has_no_broker_logins "refusing, this is production"

# Shared archive first (no foreign keys), then users, then the rows that
# reference users. allowed_emails + users let the same people sign in to
# staging; trades give the dashboard its history and tracked_callouts is the
# caller book. Every production table is listed except accounts (copied below
# without its credentials), broker_connections and sessions; a new table has to
# be added here, and is left out until someone has looked.
TABLES=(messages callers tracked_callouts recaps recap_insights allowed_emails users trades)

echo "== cloning production schema"
target_sql -c "
  drop schema if exists public cascade;
  drop schema if exists extensions cascade;
  create schema extensions;
  create extension if not exists moddatetime with schema extensions;"
# A newer pg_dump emits SET lines an older target server rejects
# (transaction_timeout arrived in 17); they are session defaults, so drop them.
PGOPTIONS='-c default_transaction_read_only=on' pg_dump "$SOURCE_DB_URL" \
  --schema-only --no-owner --no-privileges --schema=public --schema=extensions \
  | grep -v -e '^CREATE SCHEMA extensions;$' -e '^SET transaction_timeout' \
  | target_sql

echo "== copying data (source read-only)"
dump_args=()
for table in "${TABLES[@]}"; do dump_args+=(--table "public.$table"); done
# --disable-triggers also holds back the foreign-key checks, so users and
# trades may name accounts that only arrive in the next step.
PGOPTIONS='-c default_transaction_read_only=on' pg_dump "$SOURCE_DB_URL" \
  --data-only --no-owner --no-privileges --disable-triggers "${dump_args[@]}" \
  | grep -v '^SET transaction_timeout' \
  | target_sql

# accounts exists once production has had the accounts migration. Every column
# but credentials is read, so the ciphertext never leaves production.
account_columns=$(source_sql "
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    from information_schema.columns
   where table_schema = 'public' and table_name = 'accounts' and column_name <> 'credentials'")
if [[ -n "$account_columns" ]]; then
  echo "== copying accounts without credentials"
  source_sql "copy (select $account_columns from public.accounts) to stdout" \
    | target_sql -c "copy public.accounts ($account_columns) from stdin"
fi

# The closing check. A broker login or a session on TARGET here means the copy
# went wrong. It is removed before the script fails, in a statement that
# commits (a raise would undo the removal), so a production ciphertext or
# browser token never stays on staging. Nested ifs as above.
leaked=$(target_sql -At -c "
  create temp table leaked (what text);
  do \$\$ begin
    if to_regclass('public.broker_connections') is not null then
      with removed as (delete from public.broker_connections returning 1)
      insert into leaked select 'broker_connections rows' from removed;
    end if;
    if to_regclass('public.accounts') is not null then
      with removed as (update public.accounts set credentials = null
                        where credentials is not null returning 1)
      insert into leaked select 'accounts with stored credentials' from removed;
    end if;
    if to_regclass('public.sessions') is not null then
      with removed as (delete from public.sessions returning 1)
      insert into leaked select 'sessions' from removed;
    end if;
  end \$\$;
  select string_agg(n || ' ' || what, ', ' order by what)
    from (select count(*) n, what from leaked group by what) found;")
if [[ -n "$leaked" ]]; then
  echo "copy failed: removed from TARGET_DB_URL: $leaked" >&2
  exit 1
fi

for migration in ${POST_CLONE_MIGRATIONS:-}; do
  echo "== applying $migration"
  target_sql -1 -f "$migration"
done

echo "== target row counts (sessions must be 0; no broker login was copied)"
target_sql -c "$(target_sql -At -c "
  select string_agg(format('select %L t, count(*) from public.%I', relname, relname), ' union all ' order by relname)
    from pg_class
   where relnamespace = 'public'::regnamespace and relkind = 'r'")"
