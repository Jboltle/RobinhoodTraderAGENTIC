-- Multi-tenant schema: shared callouts, per-user trades/settings/broker tokens,
-- and the signup allowlist. Column names match the queries in
-- server/src/trader/db.ts, which is the only module that reads them.
--
-- ACCESS MODEL — read this before adding a policy.
-- Every application query goes through Fastify using the service_role key,
-- which has BYPASSRLS. The browser only ever holds the anon key, and only for
-- Supabase Auth (login/signup/session) — never for data. So every table here
-- is default-deny: RLS on, zero policies, and the anon/authenticated grants
-- revoked so PostgREST answers "permission denied" instead of an empty array.
--
-- The anon key ships inside the client JS bundle and PostgREST is publicly
-- reachable, so a permissive policy added "so the client can read" would turn
-- GET /rest/v1/trades?select=* into a data leak. Do not add one.

-- =============================================================================
-- callouts — shared Discord snapshot + cached LLM parse. No user_id.
--
-- One parse serves every user, which is the cost saving that matters as users
-- are added. Also the idempotency ledger for catch-up-on-wake: the pipeline
-- skips any Discord message that already has a row here.
-- =============================================================================

create table public.callouts (
  -- Discord message id, which is what makes this table the idempotency ledger.
  message_id text primary key,
  channel_id text not null,
  -- Null for DMs and any channel the bot cannot name.
  channel_name text,
  author_name text not null,
  content text not null,
  -- The Discord message timestamp, NOT when we inserted the row. Catch-up
  -- compares it against the staleness window before replaying a callout.
  "timestamp" timestamptz not null,
  -- Raw Discord embed JSON, stored as-is; the bot flattens it for the LLM.
  embeds jsonb not null default '[]'::jsonb,
  -- Shape of Callout in server/src/shared/types.ts; null unless fully parsed.
  parse jsonb,
  -- CalloutParseStatus in server/src/trader/db.ts. 'skipped' is the default
  -- because a row can exist as a pure idempotency marker, never sent to the LLM.
  parse_status text not null default 'skipped'
    check (parse_status in ('parsed', 'not_callout', 'failed', 'skipped')),
  constraint callouts_parse_matches_status
    check ((parse_status = 'parsed') = (parse is not null))
);

-- The dashboard feed reads newest-first.
create index callouts_timestamp_idx on public.callouts ("timestamp" desc);

-- =============================================================================
-- trades — per-user decision record, one row per callout per user.
--
-- Deliberately denormalized (ticker, action) so a row reads standalone without
-- joining callouts, and deliberately without a foreign key to callouts: this is
-- an audit log that must outlive the callout it came from.
-- =============================================================================

create table public.trades (
  -- A uuid rather than an identity column purely to avoid needing a sequence
  -- grant for service_role. Nothing reads this id; rows are keyed by message_id.
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  message_id text not null,
  -- DecisionKind in server/src/shared/types.ts.
  kind text not null check (
    kind in (
      'not_callout',
      'parser_error',
      'risk_rejected',
      'pending_approval',
      'submitted',
      'execution_failed',
      'missed'
    )
  ),
  -- RejectionCode; null for successful/informational kinds. Left unconstrained
  -- because the code list churns with risk rules and the kind check already
  -- pins the state machine.
  code text,
  reason text not null,
  ticker text,
  action text check (action in ('buy', 'sell')),
  -- Shape of SubmittedOrder; null unless we attempted a submit.
  order_payload jsonb,
  "timestamp" timestamptz not null default now()
);

-- Risk state is derived from this table rather than stored, so these two
-- indexes are load-bearing: daily submitted-trade count, then per-ticker
-- cooldown. Both queries also filter on kind, but user_id is the selective
-- column and a third key would not earn its write cost.
create index trades_user_id_timestamp_idx on public.trades (user_id, "timestamp" desc);
create index trades_user_id_ticker_timestamp_idx
  on public.trades (user_id, ticker, "timestamp" desc);

-- =============================================================================
-- settings — per-user resolved settings, one row per user.
--
-- Authoritative: there is no env or file layer behind it.
-- =============================================================================

create table public.settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Fully-resolved TradeSettings, every field populated.
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

-- =============================================================================
-- allowed_emails — invite-only signup gate, managed by hand.
-- =============================================================================

create table public.allowed_emails (
  -- Lowercase enforced so the signup check is a plain equality lookup.
  email text primary key check (email = lower(email)),
  added_at timestamptz not null default now()
);

-- =============================================================================
-- broker_connections — per-user Robinhood connection.
--
-- Ciphertext only: the app encrypts with encryptTokens() under
-- RH_TOKENS_VAULT_KEY before insert, so the database never sees a usable token.
-- =============================================================================

create table public.broker_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Base64 of the AES-256-GCM blob (iv || authTag || ciphertext). Text rather
  -- than bytea so it round-trips through PostgREST JSON without hex decoding.
  encrypted_tokens text not null,
  updated_at timestamptz not null default now()
);

-- =============================================================================
-- Default-deny. RLS with no policies denies anon and authenticated; revoking
-- the grants on top makes PostgREST fail loudly rather than return [], which is
-- what makes the denial testable — an empty array is indistinguishable from an
-- empty table. The revokes are redundant on a project where new tables are not
-- auto-exposed, but they are what keeps this correct on one where they are.
-- =============================================================================

alter table public.callouts enable row level security;
alter table public.trades enable row level security;
alter table public.settings enable row level security;
alter table public.allowed_emails enable row level security;
alter table public.broker_connections enable row level security;

revoke all on table public.callouts from anon, authenticated;
revoke all on table public.trades from anon, authenticated;
revoke all on table public.settings from anon, authenticated;
revoke all on table public.allowed_emails from anon, authenticated;
revoke all on table public.broker_connections from anon, authenticated;

-- service_role is how the Fastify server reaches every table, and it needs the
-- grant spelled out: Supabase no longer auto-exposes new public tables to the
-- Data API roles, so without this the server gets "permission denied" too.
-- RLS still does not apply to it (BYPASSRLS), which is the whole access model.
grant select, insert, update, delete on public.callouts to service_role;
grant select, insert, update, delete on public.trades to service_role;
grant select, insert, update, delete on public.settings to service_role;
grant select, insert, update, delete on public.allowed_emails to service_role;
grant select, insert, update, delete on public.broker_connections to service_role;
