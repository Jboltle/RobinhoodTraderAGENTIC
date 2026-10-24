# Discord-driven Robinhood Auto-Trader

An invite-only, multi-tenant system. One Discord ingest fans out to each signed-up user's own Robinhood account, settings and risk limits.

- **`server/listener/`** — the **Listener**: a Python Discord gateway client (`discord.py-self`) that reads watched channels **as a member with your own user token** and writes every captured message raw into the `messages` table. Capture only — it never parses, trades, or posts.
- **`server/src/trader/`** — a Fastify HTTP service whose poller drains unprocessed `messages` rows, uses an LLM to extract a structured trade callout **once** per message, then runs it per connected user: their settings, their risk state, their [Robinhood Trading MCP](https://agent.robinhood.com/mcp/trading) session (Streamable HTTP + OAuth).
- **`client/`** — a TanStack Start dashboard. Users sign in with their invited email, connect their own Robinhood account, edit their own limits, and watch their own feed.

All state lives in Postgres (Railway in production). Users, per-user trades, per-user settings, encrypted per-user broker tokens — and now the raw Discord archive — are rows, not files. **The database is the entire interface between capture and trading** ([ADR-0001](docs/adr/0001-database-as-integration-boundary.md)): the Listener only writes, the trader only polls, and nothing forwards anything anywhere.

## Self-bot risk — read before setting DISCORD_USER_TOKEN

The Listener authenticates with a Discord **user token**, because the channels worth copying live in servers where you are a member and cannot invite a bot. Automating a user account is prohibited by Discord's Terms of Service and the enforcement outcome is **account termination**. The codebase keeps the account's behaviour close to a normal idle client: one gateway session (never run two Listeners on one token), the library's own backoff/RESUME handling (a hot reconnect loop is a strong automation signal), no member-list chunking, and `discord.py-self` pinned to a commit that tracks the current Discord client fingerprint (see `server/listener/pyproject.toml`). The token bypasses two-factor auth — treat it like a password, and note the Listener redacts it from its own logs. If a source channel is an *Announcement* channel, prefer Discord's native Follow feature: it needs no token and carries no ToS exposure.

## Architecture

```
Discord Gateway ──▶ Listener (Python, user token) ──INSERT──▶ messages (Postgres)
                                                                  │
                                            trader poller (~1s): unprocessed rows
                                                                  │
                                            LLM parse ONCE ──▶ disposition + parse
                                                                  │
                                          ┌───────────────────────┴─────┐
                                       user A                        user B
                                   their settings                their settings
                                   derived risk state            derived risk state
                                   their Robinhood MCP           their Robinhood MCP
                                          └───────────────────────┬─────┘
                                                                  ▼
                                                          decisions in `trades`

browser (client/) ──session token──▶ /api/* ──owner connection──▶ Postgres
```

One parse serves everyone, which is the cost saving that matters as users are added. Users then run concurrently — separate Robinhood sessions — while each user's own messages stay serialized so no account ever has two orders in flight. Every message gets a **disposition** (`callout`, `not_callout`, `failed`, `missed`, `recap`) recorded on its row; a Callout is simply a message whose disposition says so, with its parse attached. If the trader is down, messages pile up unprocessed and the poller's first drain on boot is the catch-up — anything older than the **2-minute** staleness window is recorded as *missed* rather than executed at a price that has since moved. The system is Discord-read-only: the dashboard is the only output surface.

### Access model

- Every route is behind a Fastify `preHandler` that resolves the bearer token to a live row in `sessions`. The only public ones are `/health` and `/api/auth/login`.
- Sign-in is the email alone, and nothing is ever emailed. `POST /api/auth/login` takes an email; if it belongs to an account, or is on the `allowed_emails` invite list (the account is created at that first sign-in), it returns a random session token that lasts 30 days, and only the token's SHA-256 is stored. Any other email gets a 403. **The email is the whole credential: anyone who knows a user's email can sign in as them, trades included**, so treat each user's email as the key to their account.
- [`server/src/trader/db.ts`](server/src/trader/db.ts) is the only module that talks to the database, and every per-user method takes `userId` as its first argument so a caller cannot forget to scope a query.
- RLS stays on with default-deny for every table, but nothing is exposed through a public data API: the browser only ever talks to the trader, which connects as the table owner.

### Schema (`supabase/migrations/`)

| Table | Scope | Holds |
| --- | --- | --- |
| `messages` | shared | The raw Discord archive (Listener-written) + the trader's verdict: `disposition`, `parse`, `processed_at`. The poller's work queue, the idempotency ledger, and the feed source, all in one table. |
| `trades` | per-user | One decision row per callout per user. Denormalized so it reads standalone. |
| `settings` | per-user | One `jsonb` payload — the full resolved settings. Authoritative; no env or file layer behind it. |
| `allowed_emails` | shared | The signup gate. |
| `broker_connections` | per-user | Robinhood tokens, AES-256-GCM encrypted under `RH_TOKENS_VAULT_KEY`. The database only ever holds ciphertext. |
| `user_emails` | view | `user_id` + `email` from `auth.users`. The join for identifying a User. |

Daily trade counts and per-ticker cooldowns are **derived** from `trades` with two count queries rather than stored, so a restart no longer resets the daily cap.

Deletes are soft (`deleted_at`): a retracted alert is itself a signal, so the archive shows that it existed and was withdrawn. Edits update the row; on recap channels they also reset the processing marks so corrected P/L numbers re-ingest, while callout-channel edits never re-trigger trades.

## Setup

Backend code lives in `server/`, the dashboard in `client/`; run `npm` (server) or `bun` (client) commands from the matching folder. The server's `.env` stays at the repo root; the client has its own `client/.env`.

### 1. Install deps

```bash
cd server && npm install
cd ../client && bun install
```

The Listener needs [uv](https://docs.astral.sh/uv/) on PATH (one-time):

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

That's the whole Python setup — `uv run` provisions CPython and syncs the Listener's locked dependencies automatically on first start.

### 2. Start local Supabase

From the **repo root**. The CLI is not installed globally on purpose — `npx` fetches it:

```bash
npx supabase start
```

First run pulls the Docker images and applies everything in `supabase/migrations/`, which takes a few minutes. Locally the stack is only a Postgres for the trader; its auth service is unused. Ports are shifted off the CLI defaults in `supabase/config.toml` so this stack can run beside another local Supabase: API `54331`, DB `54332`, Studio `54333`.

### 3. Configure

```bash
# from the repo root
cp .env.example .env
```

Fill in:

| Var | Value |
| --- | --- |
| `DISCORD_USER_TOKEN` | your own Discord **user** token — see "Self-bot risk" above before setting it |
| `DISCORD_ALLOWED_CHANNEL_IDS` | channel(s) the Listener captures |
| `DISCORD_ALLOWED_AUTHOR_IDS` | authors captured in callout channels (empty = everyone) |
| `LLM_MODEL` | Model id. Backend is inferred (`qwen3:8b` → Ollama, `gpt-4o` → OpenAI, `claude-*` → Anthropic). Optional `openai/` / `anthropic/` / `ollama/` prefix. Startup fails if unset. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | only for the matching cloud provider |
| `SUPABASE_DB_URL` | Postgres connection string; both the trader and the Listener write over it. Local stack: `postgresql://postgres:postgres@127.0.0.1:54332/postgres`. Railway: `${{Postgres.DATABASE_URL}}` |
| `RH_TOKENS_VAULT_KEY` | any long random string (e.g. from a password manager, or `openssl rand -hex 32`). Encrypts Robinhood tokens at rest; losing it means everyone reconnects. |

The trader refuses to boot without `SUPABASE_DB_URL` and `RH_TOKENS_VAULT_KEY`; the Listener refuses without the user token and `SUPABASE_DB_URL`.

Then the dashboard's own build-time config:

```bash
cp client/.env.example client/.env
```

`API_URL` points at the trader (`http://localhost:3000` by default). It is the dashboard's only setting: sign-in goes through the trader too.

### 4. Invite yourself

An email can sign in once it has an account or is on the `allowed_emails` invite list, and the list starts empty. Add yourself — locally in Studio's SQL editor at http://127.0.0.1:54333, in production with `psql` against the Railway Postgres service:

```sql
insert into public.allowed_emails (email) values ('you@example.com');
```

The email must be lowercase (there is a check constraint). The account is created the first time that email signs in. To have the invite survive a `npx supabase db reset`, put the same statement in `supabase/seed.sql`; `[db.seed]` in `config.toml` is already enabled and pointed at that path.

## Run

Local Supabase needs to be up first (`npx supabase start`). Then the backend, from `server/`:

```bash
cd server
npm run dev
```

`dev` starts the trader first, waits for `GET /health`, then starts the Listener (`uv run python -m listener` — first run installs its locked deps automatically). Both processes read the same root `.env`. The Listener only captures messages whose channel is in `DISCORD_ALLOWED_CHANNEL_IDS` / `DISCORD_RECAP_CHANNEL_IDS`; `DISCORD_ALLOWED_AUTHOR_IDS` remains an optional author allowlist on the callout channels.

And the dashboard, from `client/`:

```bash
cd client
bun run dev      # http://localhost:3001
```

On the sign-in screen, enter that email, then connect Robinhood from the dashboard — there is no boot-time OAuth prompt any more, because tokens are per user. The connect dialog warns about two things worth knowing up front: the "can't reach this page" error after consent is expected (Robinhood only allows loopback redirects, so the redirect dead-ends on your own machine and you paste the URL back), and connecting burns that Robinhood account's Claude Code slot.

On restart the trader reconnects every user who already had stored tokens, so their MCP session is warm before the first callout rather than during it.

`GET /health` is public and returns `{ ok }` — it is a liveness signal, not an auth report. Per-user Robinhood state is at `GET /api/broker/status`.

You can still run components separately when debugging:

```bash
npm run trader
npm run listener
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

With `LLM_MODEL=qwen3:8b` in `.env`, the trader uses it at `OLLAMA_BASE_URL` (default `http://localhost:11434`).

## Tests and typecheck

```bash
cd server
npm run test        # unit tests
npm run typecheck   # tsc -p . --noEmit
```

The suite is hermetic: routes run against an in-memory database, so no Postgres or Robinhood account is needed.

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

Restart `npm run dev` after changing the redirect URI and use the newly printed Robinhood auth URL.

If Robinhood says the agent is already connected but this app never continues, that user's `broker_connections` row may hold only partial OAuth state and no usable tokens. Drop it and start again:

```bash
npm run auth:reset you@example.com   # email or user id
npm run dev
```

This does not disconnect anything inside Robinhood; it only removes the stored OAuth client/verifier/tokens for that one user so a new authorization flow can produce usable ones. `npm run connect <email or user id>` runs the same flow from the CLI instead of the dashboard, and additionally checks our canonical tool names against what the MCP server actually advertises.

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
npm run dev
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

One thing that surprises people: the pipeline fans out to users who have a `broker_connections` row, so if nobody has connected Robinhood yet, a callout is parsed and stored but produces no per-user outcomes. Connect at least one account before wondering where the decisions went.

## Deployment

Owned separately — see `server/docker-compose.yml` and `server/Dockerfile.server` (the image carries Node, running the trader's TypeScript through tsx, and the uv binary for the Listener; uv provisions its own CPython). In outline: the trader and the Listener run as one process tree so the single `/health` keep-alive ping also keeps the Discord Gateway socket alive, the dashboard deploys as a separate service (a UI deploy must never restart the gateway session or warm broker sessions), and production data lives in the Railway project's Postgres service. The trader's `SUPABASE_DB_URL` there is `${{Postgres.DATABASE_URL}}`, the private-network URL, so database traffic is never billed as egress. A new file in `supabase/migrations/` is applied to Railway by hand with `psql "<public database URL>" -f <file>`; the files are guarded to run on both that database and the local stack. Run exactly one instance: one gateway session per token, and the poller assumes no sibling.

Production configuration lives only in Railway variables; no `.env` file ships in either image. The complete set each service reads (`npm run env:audit` in `server/` checks the code against `.env.example`):

| Service | Variables |
| --- | --- |
| trader + Listener | `SUPABASE_DB_URL`, `RH_TOKENS_VAULT_KEY`, `DISCORD_USER_TOKEN`, `DISCORD_ALLOWED_CHANNEL_IDS`, `DISCORD_ALLOWED_AUTHOR_IDS`, `DISCORD_RECAP_CHANNEL_IDS`, `JEV_API_KEY`, `LLM_MODEL`, `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`), `TRADE_EXECUTION_MODE`, `NODE_ENV=production`; optional `LOG_LEVEL`, `JEV_MODEL`, `DECISION_ENGINE`, `KEEP_ALIVE_URL` |
| dashboard | `API_URL` only. It is read at runtime by `client/server.ts`; nothing is baked into the bundle, and no secret belongs on this service. |

### Staging

A staging deployment runs the **trader only** (never a second Listener: one gateway session per Discord user token) with `TRADE_EXECUTION_MODE=read_only`, so nothing it does can reach a broker, against a database cloned from production without the broker tokens or sessions. Robinhood is never connected from staging: the agentic connection is one slot per account, and a second process refreshing the same grant invalidates production's refresh token.

Seed the staging database from production (schema and data; `pg_dump` must match the server's major version, `brew install libpq`):

```bash
SOURCE_DB_URL="<production public URL>" TARGET_DB_URL="<staging URL>" server/scripts/seed-staging.sh
```

Local staging, using the Homebrew Postgres already on the box:

```bash
initdb -D ~/.local/share/rh-staging-pg -U postgres --auth=trust
pg_ctl -D ~/.local/share/rh-staging-pg -o "-p 54342 -c listen_addresses=127.0.0.1" -l /tmp/pg-staging.log start
psql postgresql://postgres@127.0.0.1:54342/postgres -c "create database staging"
# seed as above with TARGET_DB_URL=postgresql://postgres@127.0.0.1:54342/staging, then:
cd server && SUPABASE_DB_URL=postgresql://postgres@127.0.0.1:54342/staging TRADE_EXECUTION_MODE=read_only \
  RH_TOKENS_VAULT_KEY=$(openssl rand -hex 16) TRADER_PORT=3100 NODE_ENV=production npm run trader
```

Railway staging, in the existing `Staging` environment (`railway environment link Staging`): `railway add --database postgres`, then `railway add --service TraderStaging --repo Jboltle/RobinhoodTraderAGENTIC --branch feat/desk-tracking` with `source.rootDirectory=server/`, `build.dockerfilePath=Dockerfile.server`, `deploy.startCommand="npm run trader"`, `deploy.healthcheckPath=/health`, and the trader variables from the table above minus `DISCORD_USER_TOKEN`, with `TRADE_EXECUTION_MODE=read_only` and `SUPABASE_DB_URL=${{Postgres.DATABASE_URL}}`. Enable the Postgres TCP proxy (`railway tcp-proxy create --port 5432 --service Postgres`) to run the seed script against it. Railway pauses new resources while the workspace is over its usage hard limit ("Paused temporarily").

## Risk controls

Per user, not per environment. Each user owns one row in `settings`, edited from the dashboard's Settings page; the defaults below live in `TradeSettingsSchema` ([`server/src/shared/types.ts`](server/src/shared/types.ts)) and are the only source. There is no env or file layer behind them.

| Setting | Default | Purpose |
| --- | --- | --- |
| `equitySmallPct` / `equityMediumPct` / `equityFullPct` | 1.25 / 2.5 / 5 | What a stock callout deploys, as % of buying power, per size keyword |
| `optionsSmallPct` / `optionsMediumPct` / `optionsFullPct` | 0.5 / 1 / 2 | Same, for options |
| `optionsLottoPct` | 0.25 | What a lotto entry deploys once `allowLottoTrades` is on; the lotto label outranks any size word in the message |
| `maxSingleContractPct` | 5 | Skip options trades where even 1 contract exceeds this % of buying power |
| `maxTradesPerDay` | 10 | Total daily submitted trades across all tickers |
| `cooldownSeconds` | 300 | Minimum gap between two trades on the same ticker |
| `allowedTickers` / `blockedTickers` | `[]` / `[]` | Symbol allow/block lists; empty allowlist means allow everything |
| `minConfidence` | 0.7 | Drop callouts the LLM rates below this confidence |
| `regularHoursOnly` | `true` | Reject orders outside US/Eastern 09:30–16:00 weekdays |
| `allowLottoTrades` | `false` | Take entries the Caller labels a lotto. Off skips them as `lotto_blocked`; exits of a lotto already held always go through |
| `followedCallerIds` | `[]` | Which Callers to copy. Empty means nobody, so a new account trades nothing until its owner picks some |
| `executionMode` | `approval` | This user's own switch: `approval` sizes and parks each trade for a per-row Approve/Reject in the dashboard, `immediate` submits as soon as risk checks pass |

**Sizing has one layer, not two.** Each percentage above is taken directly off buying power — a `medium size` stock callout deploys 2.5%, full stop, with nothing multiplied by anything else. A callout that names no size uses Medium for stock and Small for options. `full` is the per-trade ceiling and everything clamps to it: a callout asking for an explicit $5,000 or 300 shares is trimmed to it, and so is a Small or Medium that a user sets above it, so no callout can ever deploy more than Full.

`maxTradesPerDay` and `cooldownSeconds` are enforced against the `trades` table rather than an in-process counter, so they hold across restarts. They are checked when the callout arrives, which for an approval-mode trade is not when it is submitted — approving a backlog can therefore outrun the daily cap.

The one remaining env-level control is `TRADE_EXECUTION_MODE`, a global kill-switch enforced at the single broker write path (`submitOrder` in [`server/src/trader/pipeline/execute.ts`](server/src/trader/pipeline/execute.ts)) and at the gates that lead to it. It can only tighten: a trader booted in `approval` mode parks every callout-driven trade regardless of the user's own `executionMode` and rejects the dashboard's Approve button with a 409, so no callout ever submits; Max Loss, which the user opted into as protection, still flattens. `read_only` goes further and stops every broker write, Max Loss included — a breach is logged, not sold — which is what a staging deployment or a historical replay runs with. Unset means `immediate`: the per-user setting decides. The mode is logged once at boot (`execution policy`).

## Project layout

```
server/
├── listener/          the Listener: Python/uv gateway capture (user token) -> messages table
│   ├── src/listener/  config, models, db, gateway client, __main__
│   └── tests/         pytest suite (gates, models, config)
├── src/
│   ├── index.ts       supervises trader + Listener as one process tree
│   ├── shared/        config + validation, types, logger, LLM providers
│   ├── scripts/       one-shot operator CLIs (connect, auth:reset)
│   └── trader/
│       ├── index.ts   process entrypoint (wires deps, starts the server + poller)
│       ├── poller.ts  the consumer loop: unprocessed messages -> pipeline (catch-up included)
│       ├── server.ts  Fastify routes: GET /health, /api/*
│       ├── auth.ts    Supabase JWT preHandler; the public-route list lives here
│       ├── db.ts      the only database client; every per-user method takes userId first
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
