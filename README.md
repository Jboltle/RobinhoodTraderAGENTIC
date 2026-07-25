# Discord-driven Robinhood Auto-Trader

An invite-only, multi-tenant TypeScript system. One Discord channel fans out to each signed-up user's own Robinhood account, settings and risk limits.

- **`server/src/bot/`** — a Discord Gateway client (`discord.js`) that listens to `MESSAGE_CREATE` events on configured channels, filters by author allowlist, and forwards each candidate as an HMAC-signed JSON POST to the trader.
- **`server/src/trader/`** — a Fastify HTTP service that verifies the HMAC signature, uses an LLM to extract a structured trade callout **once**, then runs it per connected user: their settings, their risk state, their [Robinhood Trading MCP](https://agent.robinhood.com/mcp/trading) session (Streamable HTTP + OAuth).
- **`client/`** — a TanStack Start dashboard. Users sign in with Supabase Auth, connect their own Robinhood account, edit their own limits, and watch their own feed.

All state lives in Supabase (Postgres). Users, per-user trades, per-user settings and encrypted per-user broker tokens are rows, not files.

## Why a Gateway bot, not Discord webhook events

Discord's outgoing webhook-events transport only delivers `APPLICATION_*`, `ENTITLEMENT_*`, `LOBBY_MESSAGE_*`, and `GAME_DIRECT_MESSAGE_*`. Regular guild text-channel messages are **not** in that list, so a Gateway bot is the only supported way to read them. The bot synthesizes the "incoming webhook" shape internally by POSTing each match to the trader.

## Architecture

```
Discord Gateway ──▶ bot (discord.js) ──HMAC POST──▶ trader (Fastify)
                                                         │
                                              LLM parse ONCE, cached in `callouts`
                                                         │
                                          ┌──────────────┴──────────────┐
                                       user A                        user B
                                   their settings                their settings
                                   derived risk state            derived risk state
                                   their Robinhood MCP           their Robinhood MCP
                                          └──────────────┬──────────────┘
                                                         │
      ◀── "BUY QQQ 710P — 1 submitted, 1 risk_rejected across 2 accounts." ─┘

browser (client/) ──Supabase JWT──▶ /api/* ──service_role──▶ Supabase Postgres
```

One parse serves everyone, which is the cost saving that matters as users are added. Users then run concurrently — separate Robinhood sessions — while each user's own messages stay serialized so no account ever has two orders in flight. The Discord receipt counts outcomes rather than naming who traded what, because the source channel is shared.

### Access model

- Every route is behind a Fastify `preHandler` that verifies the Supabase JWT. The only public ones are `/health`, `/webhook/discord` (HMAC over the raw body) and `/api/auth/signup`.
- Signup is gated server-side against the `allowed_emails` table, so the browser cannot skip the invite check.
- [`server/src/trader/db.ts`](server/src/trader/db.ts) is the only module that constructs a Supabase client. It uses the service-role key, and every per-user method takes `userId` as its first argument so a caller cannot forget to scope a query.
- RLS is on with **default-deny** (no policies, grants revoked) for all five tables. This is mandatory, not defense in depth: the anon key ships in the JS bundle and PostgREST is publicly reachable, so without it `GET /rest/v1/trades?select=*` is a full data leak. The browser's anon key is used **only** for auth, never for data. [`supabaseRls.test.ts`](server/src/shared/__tests__/supabaseRls.test.ts) is the guard on that.

### Schema (`supabase/migrations/`)

| Table | Scope | Holds |
| --- | --- | --- |
| `callouts` | shared | Discord snapshot + the cached LLM parse. Also the idempotency ledger for catch-up. |
| `trades` | per-user | One decision row per callout per user. Denormalized so it reads standalone. |
| `settings` | per-user | One `jsonb` payload — the full resolved settings. Authoritative; no env or file layer behind it. |
| `allowed_emails` | shared | The signup gate. |
| `broker_connections` | per-user | Robinhood tokens, AES-256-GCM encrypted under `RH_TOKENS_VAULT_KEY`. The database only ever holds ciphertext. |

Daily trade counts and per-ticker cooldowns are **derived** from `trades` with two count queries rather than stored, so a restart no longer resets the daily cap.

On startup the trader replays Discord messages it slept through, skipping any that already have a `callouts` row. Anything older than the **2-minute** staleness window is recorded as *missed* rather than executed at a price that has since moved.

## Setup

Backend code lives in `server/`, the dashboard in `client/`; run bun commands from the matching folder. The server's `.env` stays at the repo root; the client has its own `client/.env`.

### 1. Install deps

```bash
cd server && bun install
cd ../client && bun install
```

### 2. Start local Supabase

From the **repo root**. The CLI is not installed globally on purpose — `npx` fetches it:

```bash
npx supabase start
```

First run pulls the Docker images and applies everything in `supabase/migrations/`, which takes a few minutes. Ports are shifted off the CLI defaults in `supabase/config.toml` so this stack can run beside another local Supabase: API `54331`, DB `54332`, Studio `54333`, Mailpit `54334`.

`npx supabase status` prints the keys you need. Re-run it any time — if `SUPABASE_ANON_KEY` in `.env` ever drifts from what it reports, PostgREST rejects the key before it reaches a table and the RLS test fails with `PGRST301` instead of the `42501` it asserts.

### 3. Configure

```bash
# from the repo root
cp .env.example .env
```

Fill in:

| Var | Value |
| --- | --- |
| `DISCORD_BOT_TOKEN` | from https://discord.com/developers/applications |
| `DISCORD_ALLOWED_CHANNEL_IDS` | channel(s) to monitor |
| `DISCORD_ALLOWED_AUTHOR_IDS` | whitelisted callout authors |
| `LLM_PROVIDER` + `LLM_MODEL` | `ollama` \| `openai` \| `anthropic` (startup fails if unset) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | only for the matching cloud provider |
| `BOT_TRADER_SECRET` | `openssl rand -hex 32` |
| `SUPABASE_URL` | `API_URL` from `npx supabase status` |
| `SUPABASE_ANON_KEY` | `ANON_KEY` from the same output |
| `SUPABASE_SERVICE_ROLE_KEY` | `SERVICE_ROLE_KEY` — bypasses RLS, server-side only, never in the client bundle |
| `RH_TOKENS_VAULT_KEY` | `openssl rand -hex 32`. Encrypts Robinhood tokens at rest; losing it means everyone reconnects. |

The trader refuses to boot without the four Supabase/vault values.

Then the dashboard's own build-time config:

```bash
cp client/.env.example client/.env
```

`API_URL` points at the trader (`http://localhost:3000` by default); `SUPABASE_URL` and `SUPABASE_ANON_KEY` are the same two values as above. Never put the service-role key here — this file is baked into a public bundle.

### 4. Invite yourself

**Signup is allowlist-gated, and the allowlist starts empty — until you add a row, nobody can create an account and the sign-up form just returns "this email is not invited".**

Open Studio at http://127.0.0.1:54333, go to the SQL editor, and run:

```sql
insert into public.allowed_emails (email) values ('you@example.com');
```

The email must be lowercase (there is a check constraint) and the address only has to be one you can type — local Supabase does not send or confirm mail, and any confirmation it did send would land in Mailpit at http://127.0.0.1:54334 rather than a real inbox.

To have the allowlist survive a `npx supabase db reset`, put the same statement in `supabase/seed.sql`; `[db.seed]` in `config.toml` is already enabled and pointed at that path.

The Discord bot needs the **Message Content** privileged intent enabled in the developer portal (Bot → Privileged Gateway Intents).

## Run

Local Supabase needs to be up first (`npx supabase start`). Then the backend, from `server/`:

```bash
cd server
bun run dev
```

`dev` starts the trader first, waits for `GET /health`, then starts the Discord bot. Both processes read the same root `.env`. The bot only forwards messages whose `channelId` is in `DISCORD_ALLOWED_CHANNEL_IDS`; `DISCORD_ALLOWED_AUTHOR_IDS` remains an optional author allowlist.

And the dashboard, from `client/`:

```bash
cd client
bun run dev      # http://localhost:3001
```

Sign up with the address you added to `allowed_emails`, then connect Robinhood from the dashboard — there is no boot-time OAuth prompt any more, because tokens are per user. The connect dialog warns about two things worth knowing up front: the "can't reach this page" error after consent is expected (Robinhood only allows loopback redirects, so the redirect dead-ends on your own machine and you paste the URL back), and connecting burns that Robinhood account's Claude Code slot.

On restart the trader reconnects every user who already had stored tokens, so their MCP session is warm before the first callout rather than during it.

`GET /health` is public and returns `{ ok, executionMode }` — it is a liveness signal, not an auth report. Per-user Robinhood state is at `GET /api/broker/status`.

You can still run components separately when debugging:

```bash
bun run trader
bun run bot
```

## Ollama in WSL (local LLM)

Never install Linux GPU drivers inside WSL — the Windows NVIDIA driver is passed through. Verify with:

```bash
nvidia-smi   # should show your GPU from inside WSL
```

Then install Ollama and pull the parser model:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:8b
```

With `LLM_PROVIDER=ollama` and `LLM_MODEL=qwen3:8b` in `.env`, the trader uses it at `OLLAMA_BASE_URL` (default `http://localhost:11434`).

## Tests and typecheck

```bash
cd server
bun run test        # unit tests
bun run typecheck   # tsc -p . --noEmit
```

Most of the suite is hermetic. [`supabaseRls.test.ts`](server/src/shared/__tests__/supabaseRls.test.ts) is the exception: it talks to the live local stack and proves every table is unreadable both by the anon key and by a real logged-in user's JWT, while `service_role` still works. It skips itself when the `SUPABASE_*` vars are unset, and fails with an explicit message if the anon key is stale — a denial caused by an unusable key would prove nothing about RLS.

The dashboard has its own suite:

```bash
cd client
bun run test
bun run typecheck
```



## Robinhood OAuth On WSL

If Robinhood shows ChatGPT/agent access as connected but the trader does not continue, the Robinhood website authorized successfully but the local callback did not reach the WSL process. The app needs to receive a redirect like:

```text
http://127.0.0.1:8788/oauth/callback?code=...
```

Recommended WSL settings (the redirect URI is derived from the host + port, so
you usually only set the host):

```env
ROBINHOOD_OAUTH_REDIRECT_HOST=127.0.0.1
ROBINHOOD_OAUTH_CALLBACK_PORT=8788
ROBINHOOD_OAUTH_CALLBACK_HOST=0.0.0.0
```

While the trader is waiting for OAuth, open this in the same Windows browser:

```text
http://127.0.0.1:8788/oauth/callback
```

If the callback listener is reachable, you should see a "Waiting for Robinhood..." page and the trader logs should show an OAuth callback request. If it does not load, use the WSL IP instead:

```bash
hostname -I
```

Then set:

```env
ROBINHOOD_OAUTH_REDIRECT_HOST=YOUR_WSL_IP
ROBINHOOD_OAUTH_CALLBACK_HOST=0.0.0.0
```

Restart `bun run dev` after changing the redirect URI and use the newly printed Robinhood auth URL.

If Robinhood says the agent is already connected but this app never continues, that user's `broker_connections` row may hold only partial OAuth state and no usable tokens. Drop it and start again:

```bash
bun run auth:reset you@example.com   # email or user id
bun run dev
```

This does not disconnect anything inside Robinhood; it only removes the stored OAuth client/verifier/tokens for that one user so a new authorization flow can produce usable ones. `bun run connect <email or user id>` runs the same flow from the CLI instead of the dashboard, and additionally checks our canonical tool names against what the MCP server actually advertises.

## Test With Your Discord Channel

For safe end-to-end Discord testing, run in approval mode first:

```env
DISCORD_ALLOWED_CHANNEL_IDS=your_test_channel_id
DISCORD_ALLOWED_AUTHOR_IDS=your_discord_user_id
TRADE_EXECUTION_MODE=approval
```

`TRADE_EXECUTION_MODE` is the global kill-switch and it wins: in `approval` it holds every user, whatever their own `executionMode` says. Turn off `regularHoursOnly` on the Settings page if you want to test outside market hours.

Then start everything:

```bash
bun run dev
```

In your allowed Discord channel, send test callouts like:

```text
BTO $QQQ 710p 06/08 0.97
RISKY SIZE APPROPRIATE
```

```text
Buy To Open
SPY 755C 0DTE $0.71
```

```text
Close or Trim & Set SL to BE
TRIM
QQQ 707C 2026-06-11
1.5900 -> 1.75 P/L: +10.06% ($16.00)
```

In `approval` mode every user gets an approval-required outcome and no order is submitted. Switch to `TRADE_EXECUTION_MODE=immediate` only when you want passed callouts to submit live orders.

One thing that surprises people: the pipeline fans out to users who have a `broker_connections` row, so if nobody has connected Robinhood yet, a callout is parsed and stored but produces no per-user outcomes and no receipt. Connect at least one account before wondering where the feed went.

## Deployment

Owned separately — see `render.yaml` and `server/docker-compose.yml`. In outline: the trader and bot run as one process tree so the single `/health` keep-alive ping also keeps the Discord Gateway socket alive, the dashboard deploys as a static site, and Supabase moves from the local CLI stack to a hosted project with `npx supabase db push`. Nothing in `supabase/migrations/` is local-only.

## Risk controls

Per user, not per environment. Each user owns one row in `settings`, edited from the dashboard's Settings page; the defaults below live in `TradeSettingsSchema` ([`server/src/shared/types.ts`](server/src/shared/types.ts)) and are the only source. There is no env or file layer behind them.

| Setting | Default | Purpose |
| --- | --- | --- |
| `maxNotionalPct` | 5 | Max equity notional per order, as % of buying power |
| `maxOptionsNotionalPct` | 2 | Max options premium per order, as % of buying power |
| `maxSingleContractPct` | 5 | Skip options trades where even 1 contract exceeds this % of buying power |
| `positionSmallPct` / `positionMediumPct` | 25 / 50 | % of the per-trade cap used for the small/medium size keywords |
| `maxTradesPerDay` | 10 | Total daily submitted trades across all tickers |
| `cooldownSeconds` | 300 | Minimum gap between two trades on the same ticker |
| `allowedTickers` / `blockedTickers` | `[]` / `[]` | Symbol allow/block lists; empty allowlist means allow everything |
| `minConfidence` | 0.7 | Drop callouts the LLM rates below this confidence |
| `regularHoursOnly` | `true` | Reject orders outside US/Eastern 09:30–16:00 weekdays |
| `executionMode` | `immediate` | This user's own switch: `immediate` submits after risk checks, `approval` records without submitting |

`maxTradesPerDay` and `cooldownSeconds` are enforced against the `trades` table rather than an in-process counter, so they hold across restarts.

The one remaining env-level control is `TRADE_EXECUTION_MODE`, a global kill-switch. It can only tighten: a trader booted in `approval` mode holds every user regardless of their own `executionMode`, because the MCP sessions it would need to submit with are never wired up.

## Project layout

```
server/
├── src/
│   ├── index.ts       supervises trader + bot as one process tree
│   ├── shared/        config + validation, types, HMAC signing, logger, LLM providers
│   ├── bot/           discord.js Gateway client (filter, assemble, forward)
│   ├── scripts/       one-shot operator CLIs (connect, auth:reset)
│   └── trader/
│       ├── index.ts   process entrypoint (wires deps, starts the server, catch-up)
│       ├── server.ts  Fastify routes: POST /webhook/discord, GET /health, /api/*
│       ├── auth.ts    Supabase JWT preHandler; the public-route list lives here
│       ├── db.ts      the only Supabase client; every per-user method takes userId first
│       ├── catchup.ts replays messages missed while asleep, with the staleness window
│       ├── pipeline/  parse-once + per-user fan-out, riskFilter, execute, summarize
│       └── rh/        per-user MCP registry, MCP client, OAuth, token crypto, tool wrappers
supabase/
├── config.toml        local stack config (ports shifted off the CLI defaults)
└── migrations/        the schema; portable to a hosted project with `db push`
client/                web dashboard (TanStack Start)
```

## Out of scope (v1)

- Multi-leg options, crypto, and advanced order management beyond simple equity and single-leg option buy/sell
- Self-service signup — the allowlist is managed by hand, and connecting burns a Robinhood account's Claude Code slot, which is the hard blocker on opening this up
- Replaying historical callouts beyond catch-up-on-wake
