# Discord-driven Robinhood Auto-Trader

A two-process TypeScript system:

- **`bot/`** — a Discord Gateway client (`discord.js`) that listens to `MESSAGE_CREATE` events on configured channels, filters by author allowlist, and forwards each candidate as an HMAC-signed JSON POST to the trader.
- **`trader/`** — a Fastify HTTP service that verifies the HMAC signature, uses an LLM to extract a structured trade callout, applies deterministic risk filters, and executes equity or single-leg option orders via the [Robinhood Trading MCP](https://agent.robinhood.com/mcp/trading) (Streamable HTTP + OAuth).

## Why a Gateway bot, not Discord webhook events

Discord's outgoing webhook-events transport only delivers `APPLICATION_*`, `ENTITLEMENT_*`, `LOBBY_MESSAGE_*`, and `GAME_DIRECT_MESSAGE_*`. Regular guild text-channel messages are **not** in that list, so a Gateway bot is the only supported way to read them. The bot synthesizes the "incoming webhook" shape internally by POSTing each match to the trader.

## Architecture

```
Discord Gateway ──▶ bot (discord.js) ──HMAC POST──▶ trader (Fastify)
                                                         │
                                                         ├─▶ LLM (Anthropic) – parse callout
                                                         ├─▶ Risk filter – deterministic guards
                                                         └─▶ Robinhood MCP – place equity order
                                                         │
                              ◀── "Bought 3 AAPL …" ──── posts receipt back to channel
```

## Setup

```bash
# 1. Install deps
npm install

# 2. Configure
cp .env.example .env
# Fill in:
#   DISCORD_BOT_TOKEN              -- from https://discord.com/developers/applications
#   DISCORD_ALLOWED_CHANNEL_IDS    -- channel(s) to monitor
#   DISCORD_ALLOWED_AUTHOR_IDS     -- whitelisted callout authors
#   ANTHROPIC_API_KEY              -- LLM key
#   BOT_TRADER_SECRET              -- `openssl rand -hex 32`
```

The Discord bot needs the **Message Content** privileged intent enabled in the developer portal (Bot → Privileged Gateway Intents).

## Run

Run the trader **first** (it owns the OAuth flow with Robinhood):

```bash
# Terminal 1 — trader
npm run trader
# On first run, prints a Robinhood OAuth URL.
# Open it in your browser, authorize the agentic account,
# and the trader stores refresh tokens at state/rh-tokens.json.

# Terminal 2 — bot
npm run bot
```

Both processes read the same `.env`. The bot will only forward messages whose `channelId` and `authorId` are in your allowlists.

## Risk controls

All configured via `.env` (see `.env.example`):

| Var | Purpose |
| --- | --- |
| `MAX_NOTIONAL_USD_PER_TRADE` | Hard cap per order |
| `MAX_TRADES_PER_DAY` | Total daily trades across all tickers |
| `COOLDOWN_SECONDS_PER_TICKER` | Minimum gap between two trades on the same ticker |
| `ALLOWED_TICKERS` / `BLOCKED_TICKERS` | Symbol allow/block lists |
| `REGULAR_HOURS_ONLY` | Reject orders outside US/Eastern 09:30–16:00 weekdays |
| `DAILY_LOSS_CIRCUIT_BREAKER_USD` | Halt trading once daily realized P/L is below this |
| `MIN_CONFIDENCE` | Drop callouts the LLM rates below this confidence |

State files live under `state/` and are git-ignored:

- `state/audit.jsonl` — append-only record of every callout, decision, and MCP response
- `state/risk.json` — daily counters, per-ticker last-trade timestamps
- `state/rh-tokens.json` — Robinhood OAuth tokens (chmod 0600)

## Project layout

```
src/
├── shared/        config (Zod), types, HMAC signing
├── bot/           discord.js Gateway client
└── trader/
    ├── routes/    POST /webhook/discord
    ├── pipeline/  parseCallout, riskFilter, executeTrade
    ├── rh/        MCP client + OAuth + typed tool wrappers
    └── audit/     JSONL writer
```

## Out of scope (v1)

- Multi-leg options, crypto, and advanced order management beyond simple equity and single-leg option buy/sell
- Persistent DB (state is JSON files)
- Web UI
- Replaying historical callouts
