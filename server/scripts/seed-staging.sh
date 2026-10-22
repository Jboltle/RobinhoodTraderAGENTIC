#!/usr/bin/env bash
# Build a staging database from production: clone production's schema into
# TARGET, then copy the shared archive and the per-user history across,
# never the broker tokens or sessions.
#
#   SOURCE_DB_URL=postgresql://... TARGET_DB_URL=postgresql://... server/scripts/seed-staging.sh
#
# The schema is taken from SOURCE with pg_dump rather than by replaying
# supabase/migrations: the early files assume Supabase's auth schema, which
# production never had, so a dump is the only thing guaranteed to match.
# pg_dump must be at least the server's major version (brew install libpq).
#
# SOURCE is read with a read-only transaction. TARGET's public schema is
# dropped and recreated, so the script is safe to re-run. broker_connections
# is excluded on purpose: a second process refreshing the same Robinhood
# grant invalidates production's refresh token, and the one agent slot per
# account cannot be shared. sessions are excluded so a production browser
# token never works against staging.
set -euo pipefail

: "${SOURCE_DB_URL:?SOURCE_DB_URL is required (production, read-only)}"
: "${TARGET_DB_URL:?TARGET_DB_URL is required (staging)}"

if [[ "$TARGET_DB_URL" == *"railway.internal"* || "$TARGET_DB_URL" == "$SOURCE_DB_URL" ]]; then
  echo "refusing: TARGET_DB_URL looks like production" >&2
  exit 1
fi

# Shared archive first (no foreign keys), then users, then the rows that
# reference users. allowed_emails + users let the same people sign in to
# staging; trades give the dashboard its history.
TABLES=(messages callers recaps recap_insights allowed_emails users trades)

echo "== cloning production schema"
psql "$TARGET_DB_URL" -X -q -v ON_ERROR_STOP=1 -c "
  drop schema if exists public cascade;
  drop schema if exists extensions cascade;
  create schema extensions;
  create extension if not exists moddatetime with schema extensions;"
# A newer pg_dump emits SET lines an older target server rejects
# (transaction_timeout arrived in 17); they are session defaults, so drop them.
PGOPTIONS='-c default_transaction_read_only=on' pg_dump "$SOURCE_DB_URL" \
  --schema-only --no-owner --no-privileges --schema=public --schema=extensions \
  | grep -v -e '^CREATE SCHEMA extensions;$' -e '^SET transaction_timeout' \
  | psql "$TARGET_DB_URL" -X -q -v ON_ERROR_STOP=1

echo "== copying data (source read-only)"
dump_args=()
for table in "${TABLES[@]}"; do dump_args+=(--table "public.$table"); done
PGOPTIONS='-c default_transaction_read_only=on' pg_dump "$SOURCE_DB_URL" \
  --data-only --no-owner --no-privileges --disable-triggers "${dump_args[@]}" \
  | grep -v '^SET transaction_timeout' \
  | psql "$TARGET_DB_URL" -X -q -v ON_ERROR_STOP=1

echo "== target row counts"
psql "$TARGET_DB_URL" -X -q -v ON_ERROR_STOP=1 -c "
  select 'messages' t, count(*) from messages
  union all select 'callers', count(*) from callers
  union all select 'recaps', count(*) from recaps
  union all select 'allowed_emails', count(*) from allowed_emails
  union all select 'users', count(*) from users
  union all select 'trades', count(*) from trades
  union all select 'broker_connections (must be 0)', count(*) from broker_connections
  union all select 'sessions (must be 0)', count(*) from sessions"
