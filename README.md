# Discord-driven Robinhood Auto-Trader

A two-process TypeScript system:

- **`server/src/bot/`** — a Discord Gateway client (`discord.js`) that listens to `MESSAGE_CREATE` events on configured channels, filters by author allowlist, and forwards each candidate as an HMAC-signed JSON POST to the trader.
- **`server/src/trader/`** — a Fastify HTTP service that verifies the HMAC signature, uses an LLM to extract a structured trade callout, applies deterministic risk filters, and executes equity or single-leg option orders via the [Robinhood Trading MCP](https://agent.robinhood.com/mcp/trading) (Streamable HTTP + OAuth).

## Why a Gateway bot, not Discord webhook events

Discord's outgoing webhook-events transport only delivers `APPLICATION_*`, `ENTITLEMENT_*`, `LOBBY_MESSAGE_*`, and `GAME_DIRECT_MESSAGE_*`. Regular guild text-channel messages are **not** in that list, so a Gateway bot is the only supported way to read them. The bot synthesizes the "incoming webhook" shape internally by POSTing each match to the trader.

## Architecture

```
Discord Gateway ──▶ bot (discord.js) ──HMAC POST──▶ trader (Fastify)
                                                         │
                                                         ├─▶ LLM (Ollama, OpenAI, or Anthropic) – parse callout
                                                         ├─▶ Risk filter – deterministic guards
                                                         └─▶ Robinhood MCP – place equity order
                                                         │
                              ◀── "Bought 3 AAPL …" ──── posts receipt back to channel
```

## Setup

All backend code lives in `server/`; run bun/docker commands from there. `.env` stays at the repo root.

```bash
# 1. Install deps
cd server
bun install

# 2. Configure (from the repo root)
cp .env.example .env
# Fill in:
#   DISCORD_BOT_TOKEN              -- from https://discord.com/developers/applications
#   DISCORD_ALLOWED_CHANNEL_IDS    -- channel(s) to monitor
#   DISCORD_ALLOWED_AUTHOR_IDS     -- whitelisted callout authors
#   LLM_PROVIDER + LLM_MODEL       -- ollama | openai | anthropic (startup fails if unset)
#   OPENAI_API_KEY / ANTHROPIC_API_KEY -- only for the matching cloud provider
#   BOT_TRADER_SECRET              -- `openssl rand -hex 32`
```

The Discord bot needs the **Message Content** privileged intent enabled in the developer portal (Bot → Privileged Gateway Intents).

## Run

Start the full stack with one command (from `server/`):

```bash
cd server
bun run dev
```

`dev` starts the trader first, waits for `GET /health` (up to 10 minutes, to leave room for first-time OAuth), then starts the Discord bot.

On startup in immediate mode the trader detects its Robinhood auth state automatically:

1. It inspects `state/rh-tokens.json` (decoding the access token's expiry) and logs whether the saved tokens are valid, refreshable, or missing.
2. If the tokens can't carry the session, it prints a Robinhood OAuth URL — open it in your browser to authorize; tokens are then stored at `state/rh-tokens.json` and refreshed automatically, so no re-auth is needed.

`GET /health` reports `rhConnected`, `rhTokenState`, and `rhTokenExpiresInSec` so you can observe the auth state. `bun run dev` also logs an auth preflight summary before the trader starts.

Both processes read the same `.env`. The bot will only forward messages whose `channelId` is in `DISCORD_ALLOWED_CHANNEL_IDS`; `DISCORD_ALLOWED_AUTHOR_IDS` remains a global optional author allowlist.

You can still run components separately when debugging:

```bash
bun run trader
bun run bot
```

## Run with Docker Compose

See [Deployment (Docker)](#deployment-docker) below.

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
bunx vitest run     # unit tests
bunx tsc --noEmit   # typecheck
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

If Robinhood says the agent is already connected but this app never continues, your local `state/rh-tokens.json` may contain only partial OAuth state and no tokens. Reset local OAuth state and start again:

```bash
bun run auth:reset
bun run dev
```

This does not disconnect anything inside Robinhood; it only removes the local cached OAuth client/verifier/token file so a new authorization flow can produce usable local tokens.

## Test With Your Discord Channel

For safe end-to-end Discord testing, run in approval mode first:

```env
DISCORD_ALLOWED_CHANNEL_IDS=your_test_channel_id
DISCORD_ALLOWED_AUTHOR_IDS=your_discord_user_id
TRADE_EXECUTION_MODE=approval
REGULAR_HOURS_ONLY=false
```

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

In `approval` mode the bot should post an approval-required receipt back to the same Discord channel, and no Robinhood MCP connection or order submission is attempted. Switch to `TRADE_EXECUTION_MODE=immediate` only when you want passed callouts to submit live orders.

## Deployment (Docker)

Each user runs their own stack — the containers hold your Discord token and your Robinhood login, so this is self-hosted per person, not a shared service.

```bash
cp .env.example .env   # at the repo root; fill in tokens/secrets — read at runtime, never baked into images
cd server
docker compose up -d --build
```

Topology: `bot` and `trader` containers (one per service, built from `Dockerfile.bot` / `Dockerfile.trader`), a shared named volume mounted at `/app/state` in both, and `depends_on` so the bot starts only after the trader reports healthy. The bot needs outbound network only; the trader publishes `TRADER_PORT` (default 3000) and the OAuth callback port (default 8788).

### Why the images run from source (not `dist/` bundles)

`bun build` does not produce standalone bundles for this dependency tree: discord.js and fastify use lazy CommonJS `require()` calls that survive bundling as-is (`ws`, `undici`, `ajv`, ...). `ws` and `undici` happen to be Bun built-ins, and Bun's auto-install can silently fetch the rest at runtime — which masks the gap locally but is exactly the kind of network-dependent surprise you don't want in a container. So the images copy `src/` and install production dependencies with `bun install --frozen-lockfile --production`, and run `bun src/<service>/index.ts` directly (same as `bun run start:bot` / `start:trader`). `bun run build` still emits `dist/` bundles, but they are not the deployable artifact.

### First-run Robinhood OAuth inside Docker

In `immediate` mode the trader must complete Robinhood OAuth before it starts listening:

1. `docker compose up` and watch the trader logs (`docker compose logs -f trader`) — it prints a Robinhood auth URL.
2. Open the URL in your host browser and authorize.
3. Robinhood redirects to `http://127.0.0.1:8788/oauth/callback`. That port is published by compose on host loopback, so the redirect reaches the container's callback listener. Keep `ROBINHOOD_OAUTH_REDIRECT_HOST` unset (or `127.0.0.1`) when running under compose — the WSL-IP value from "Robinhood OAuth On WSL" applies only to the non-Docker WSL flow, since compose publishes 8788 on `127.0.0.1` only.
4. Tokens are saved to the `state` volume (`state/rh-tokens.json`) and refreshed automatically — later restarts skip this flow.

The trader's healthcheck allows ~10 minutes for this before compose marks it unhealthy; the bot waits for a healthy trader.

### State persistence

`state/` (decision log, risk counters, OAuth tokens, settings) lives in the named `state` volume shared by both containers. `docker compose down` keeps it; `docker compose down -v` deletes it, which erases your Robinhood tokens and trade history.

### Ollama in compose

The `ollama` service is profile-gated (opt-in):

```bash
docker compose --profile ollama up -d
docker compose exec ollama ollama pull qwen3:8b   # once
```

Inside the compose network the trader reaches it at `http://ollama:11434` (the compose default for `OLLAMA_BASE_URL`) — **not** the host default `http://localhost:11434` from `.env.example`, because `localhost` inside a container is the container itself. To use an Ollama already running on your host instead, skip the profile and set `OLLAMA_BASE_URL=http://host.docker.internal:11434` in `.env`. For NVIDIA GPU acceleration, install [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) and uncomment the `deploy.resources` block in `docker-compose.yml`.

## Risk controls

All configured via `.env` (see `.env.example`):

| Var | Purpose |
| --- | --- |
| `MAX_NOTIONAL_PCT_PER_TRADE` | Max equity notional per order, as % of buying power |
| `MAX_OPTIONS_NOTIONAL_PCT` | Max options premium per order, as % of buying power |
| `MAX_SINGLE_CONTRACT_PCT` | Skip options trades where even 1 contract exceeds this % of buying power |
| `POSITION_SMALL_PCT` / `POSITION_MEDIUM_PCT` | Fraction of the per-trade cap used for small/medium size keywords |
| `MAX_TRADES_PER_DAY` | Total daily trades across all tickers |
| `COOLDOWN_SECONDS_PER_TICKER` | Minimum gap between two trades on the same ticker |
| `ALLOWED_TICKERS` / `BLOCKED_TICKERS` | Symbol allow/block lists |
| `REGULAR_HOURS_ONLY` | Reject orders outside US/Eastern 09:30–16:00 weekdays |
| `MIN_CONFIDENCE` | Drop callouts the LLM rates below this confidence |
| `TRADE_EXECUTION_MODE` | `immediate` submits after risk checks; `approval` logs/notifies without submitting |

State files live under `state/` and are git-ignored:

- `state/decisions.jsonl` — append-only record of every callout decision and its outcome
- `state/risk.json` — daily counters, per-ticker last-trade timestamps
- `state/rh-tokens.json` — Robinhood OAuth tokens (chmod 0600)

## Project layout

```
server/
├── src/
│   ├── shared/        config + validation, types, HMAC signing, logger, LLM providers
│   ├── bot/           discord.js Gateway client (filter, assemble, forward)
│   └── trader/
│       ├── index.ts   process entrypoint (wires deps, starts the server)
│       ├── server.ts  Fastify routes: POST /webhook/discord, GET /health, /api/*
│       ├── pipeline/  runPipeline orchestrator, parseCallout, riskFilter, execute, summarize
│       ├── rh/        MCP client + OAuth + token bootstrap + typed tool wrappers
│       └── decisionLog.ts  append-only JSONL writer
├── state/             runtime state files (git-ignored)
└── docker-compose.yml
client/                web dashboard (TanStack Start)
```

## Out of scope (v1)

- Multi-leg options, crypto, and advanced order management beyond simple equity and single-leg option buy/sell
- Persistent DB (state is JSON files)
- Replaying historical callouts
