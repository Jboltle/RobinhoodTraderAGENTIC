# Session Context — rh-discord-trader multi-tenant refactor (resume file)

Rewritten 2026-07-24 ~7:30 PM, after the multi-tenant Supabase refactor landed. Caveman-compressed. Read with the plan file: `.cursor/plans/multi-tenant_supabase_auth_5493be1b.plan.md`.

## Project

Discord→Robinhood auto-trader, now **invite-only multi-tenant**. One Discord channel fans out to each user's own Robinhood account, settings and limits.

Three parts: `server/src/bot/` (Discord gateway, forwards HMAC-signed envelopes) + `server/src/trader/` (Fastify webhook → LLM parse ONCE → per-user fan-out → each user's Robinhood MCP) + `client/` (TanStack Start dashboard, Supabase Auth). Shared code `server/src/shared/`. All state in Supabase Postgres; `state/` files are gone. `server/src/index.ts` supervises trader+bot as one process tree.

## Locked decisions (user Q&A)

- Bot + trader stay logically separate but run as one process tree (bot binds no port; one `/health` ping keeps the Gateway socket alive). Keep HMAC webhookAuth as the bot→trader trust boundary.
- Invite-only multi-tenant, NOT self-hosted-per-person any more. Supabase Auth email/password; signup gated server-side against `allowed_emails`.
- Runtime = Bun everywhere. vitest for tests, `tsc -p . --noEmit` typecheck.
- LLM: ONE factory in `server/src/shared/llm.ts` via TanStack AI adapters. Default provider ollama. `LLM_PROVIDER`/`TRADE_EXECUTION_MODE` fail-fast `z.enum`, plus `requiredString('LLM_MODEL')`.
- MCP client: hand-rolled wrapper, one instance **per user** in `rh/mcpRegistry.ts` (`Map`, ponytail-marked unbounded, LRU is the upgrade path).
- Data access: `server/src/trader/db.ts` is the ONLY module that constructs a Supabase client. Service-role key (bypasses RLS). Every per-user method takes `userId` first so scoping can't be forgotten.
- RLS on, default-deny (no policies + grants revoked) on all five tables. Mandatory, not defense in depth: anon key ships in the client bundle and PostgREST is public. Browser's anon key is auth-only.
- Settings: one `jsonb` row per user in `settings`. Defaults live in `TradeSettingsSchema` `.default()` values — no env layer, no file layer, no `resolveSettings`.
- Risk state DERIVED from `trades` (two count queries), not stored. Fixes `maxTradesPerDay` resetting on every restart.
- Broker tokens per user in `broker_connections`, AES-256-GCM under `RH_TOKENS_VAULT_KEY`. DB holds ciphertext only.
- Catch-up-on-wake staleness window = **2 minutes**. Older than that → recorded `missed`, never executed at a moved price.
- Supabase local via `npx supabase@latest start` (CLI deliberately NOT installed globally). Schema versioned in `supabase/migrations/`, portable to hosted with `db push`.
- Known accepted ceiling: users consent to an app calling itself "Claude Code" (borrowed blessed client id — the only way to get loopback allowlisted), and connecting burns that Robinhood account's Claude Code slot. Connect dialog warns about both. Hard blocker on ever opening this up.

## Environment facts

- Bun 1.3.14, Node 22.22, Docker 29.5.2. **Windows / PowerShell**, repo at `C:\Users\Sheri\Sandbox\RobinhoodTraderAGENTIC` (no longer the WSL layout the old notes assumed).
- `bunx` is NOT on PATH here; use `bun run vitest ...` / `bun x`.
- Local Supabase ports shifted off CLI defaults (other Postgres already on 5432x): API **54331**, DB **54332**, Studio **54333**, Mailpit **54334**. Set in `supabase/config.toml`.
- Local Supabase still uses the CLI's legacy `supabase-demo` JWT keys. `status` also prints newer `sb_publishable_` / `sb_secret_` keys; PostgREST accepts either and maps both to the `anon` role. `.env` holds the legacy JWT pair.
- Ollama reachable at `localhost:11434`, but only `gemma3:4b` + `nomic-embed-text` are pulled — **`qwen3:8b` (the `.env.example` default) is not present**. Pull it or set `LLM_MODEL` to something local.
- `.env` currently defines ONLY the four Supabase/vault vars. Discord, LLM and `TRADE_EXECUTION_MODE` are unset, so the trader will fail `assertConfigValid` on boot. Tests are unaffected — `server/vitest.config.ts` loads `.env` and then fills dummies for whatever is still missing.

## Workstream status

The refactor is landed and the suite is green: **322 pass / 3 skipped across 20 files + 1 skipped**, typecheck clean. (Count drifts upward while the deploy agent is working — it gained a file mid-session.)

1. **Schema + RLS: DONE.** `supabase/migrations/20260725012642_multi_tenant_schema.sql` — five tables, RLS on, zero policies, anon/authenticated grants revoked, service_role granted explicitly.
2. **Auth gate: DONE.** `trader/auth.ts` `preHandler` verifies the Supabase JWT on every route. Public set = `/health`, `/webhook/discord`, `/api/auth/signup` only.
3. **Data access: DONE.** `trader/db.ts` as above.
4. **Broker tokens, per-user MCP, settings-in-DB, callouts/trades, risk-derive, pipeline fan-out, catch-up: DONE.** `tokenVault.ts`, `settings.ts`, `decisionLog.ts` and all `state/` files deleted.
5. **Dashboard: DONE.** `AuthScreen` gates the app in `__root.tsx` (one component, sign-in/sign-up modes — not separate routes). SSE reads with `fetch`, not `EventSource`, so it carries a normal `Authorization` header instead of a token in the URL. "Backfill" concept gone; the feed reads the DB.
6. **RLS test reconciled: DONE.** See below.
7. **Docs: DONE.** `README.md` + this file.
8. **Deploy: OWNED BY ANOTHER AGENT — HANDS OFF** `render.yaml`, `server/docker-compose.yml`, the Dockerfiles. Moving under us mid-session: `scripts/dev.ts` deleted, `Dockerfile.bot`/`Dockerfile.trader` replaced by `Dockerfile.server`, `src/__tests__/stack.test.ts` added.

## RLS test — root cause, settled

`server/src/shared/__tests__/supabaseRls.test.ts` was reported red with 6 assertions getting `PGRST301` where it expects `42501`. Root cause was a **stale/unverifiable anon JWT in `.env`**, not the key *format* and not RLS.

Two error classes, and only one of them proves anything:

- `42501` = key decoded, role resolved to `anon`, Postgres denied on grants/RLS. **Genuine denial.** This is what the test must assert.
- `PGRST301` = PostgREST could not decode the bearer JWT (wrong signature, expired, malformed, empty). Denied at the auth layer, before any table. **Proves nothing.**

The 6-vs-passing split is the fingerprint: PostgREST only verifies the **bearer** token, and the 6 failing cases were the ones that send the anon key as the bearer. The `authenticated` cases send a freshly minted user JWT and the `service_role` cases send the service key, so both got as far as the grant check and passed. GoTrue does not verify the `apikey` header at all, so the `beforeAll` seeding succeeded either way.

Guard added so this can never be mistaken again: `assertAnonKeyReachesTheGrantCheck` hits `GET /rest/v1/` (needs a decodable key, no table privilege) before any expectation runs, and fails with "re-copy ANON_KEY from `npx supabase status`" if the key is rejected. Works for legacy JWT and `sb_publishable_` alike.

The "newer non-JWT publishable key format" hypothesis is **falsified**: a publishable key returns `42501` too, so it could never have produced `PGRST301`.

## Other notes

- Vacuity of the RLS test verified by hand: `grant select on public.trades to anon` → only `the anon key cannot read trades` fails; grant + permissive policy on `settings` to `authenticated` → only `a logged-in user cannot read settings` fails. Both reverted; grants/policies confirmed back to migration state.
- Fan-out set = users with a `broker_connections` row (`listBrokerUserIds`). Nobody connected ⇒ callout is parsed and stored but produces no trades and no Discord receipt. Bites you when testing.
- `server/src/scripts/dev.ts` is gone; the deploy agent folded it into `server/src/index.ts`, and `dev` and `start` are now the same command deliberately — a production path that differs from the one you develop against is a path nobody has tested.
- `/health` body is now `{ ok, executionMode }` only. Per-user Robinhood state moved to `GET /api/broker/status`. `/api/auth/status` and `/api/auth/callback` were renamed to `/api/broker/*` because `/api/auth/*` now means user auth.
- `allowed_emails` starts EMPTY, so nobody can sign up until a row is inserted. `[db.seed]` in `config.toml` is enabled and points at `supabase/seed.sql`, which does not exist yet — create it if you want the allowlist to survive `db reset`.
- `.ua/knowledge-graph.json` from the old session is gone; the pre-refactor snapshot no longer applies.
- User works in the repo concurrently — ALWAYS `git status` + re-read touched files before dispatching a workstream.
