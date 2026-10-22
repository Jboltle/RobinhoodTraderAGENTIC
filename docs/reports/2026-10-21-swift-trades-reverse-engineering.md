# Swift Trades (swiftoptions.pro): how it works, and how we compare

Prepared Oct 21, 2026. Read-only review of a competitor's product and of our own production data; the only state changed was a Railway TCP proxy on our Postgres (section 6).

**Evidence base.**
- The site's 780 Vite chunks (`https://swiftoptions.pro/assets/*`), downloaded and grepped. Their own help text and guides are quoted where they explain behaviour.
- The signed-in app, observed over CDP: screenshots, accessibility tree, and same-origin `fetch` from the page so the member session token never left the browser. Member tier (`vip`); owner-only routes answered 403 and were not pursued.
- Our production Postgres on Railway: 9,619 messages since Jul 28, 2,207 callouts, 3,098 decision rows since Sep 22. Read-only (`default_transaction_read_only=on`).
- Comparison script `compare.ts` (kept outside the repo in `/tmp/swift/`) joining Swift's recorded entries to our `messages` rows on contract and time.

**Ground rules.** All times UTC unless marked ET. Path shorthand: `trader/` means `server/src/trader/`. Numbers are from Oct 21; Swift's book changes daily.

---

## 1. Bottom line

1. **Same input, different model.** Swift ingests the same Optionality Discord channels our Listener captures; its Harvey alerts carry `relaySource: "harvey"`, and Swift's own alert cards are posted into `#swift-alerts` by their bot. There is no faster source. What differs is what happens after capture: every callout becomes a *tracked position* priced against live quotes, with a peak, a simulated trim ladder, a settlement at expiry and a Win/Loss result, whether or not anyone traded it. Our model records a per-user execution decision and nothing else.
2. **Transport is a wash.** Both systems are Discord gateway → server → SSE. Our capture is 0.12 s median; Swift's own cards appear on Discord ~6 s after their internal `addedAt`, so for Swift's trades their members see it first, for Harvey's we do.
3. **We lose on parser recall, not speed.** Sep 22 – Oct 21: Swift recorded 373 entries. We parsed Swift's bot cards 181/184 (98%) and Harvey's free-form posts **13/123 (11%)**; the other 110 are in our archive as `not_callout`. Root cause is three grammar gaps in `trader/pipeline/parseCallout.ts` (section 5.2).
4. **We lose most of all on broker-session health.** Same window: 65 submitted, 1,598 `execution_failed`, 1,406 `risk_rejected`. The failures are one string: "Robinhood authorization required". Every one of the 65 submits still read `status: unconfirmed` because nothing read the fill back (fixed on `feat/desk-tracking`, section 7).
5. **Where we are structurally ahead.** Swift's Robinhood connection is read-only ("cannot place, modify or cancel orders"). We execute in each member's own Robinhood account from one shared parse, with per-user risk and approval. That is the product; the rest of this report is about catching up on tracking and publishing.

---

## 2. Backend topology

One origin behind Cloudflare. CSP: `connect-src 'self' https://api.stripe.com https://58qr5yci46.execute-api.us-east-1.amazonaws.com`.

| Surface | Path prefix | What it is |
| --- | --- | --- |
| Desk API | `/api/*` | The trading engine: auth, Discord alert ingest, tracked positions, brokers (IBKR, Alpaca, Robinhood read-only, SnapTrade), SSE. |
| Edge API | `/api/edge/*` | The market-data product (options flow, gamma, news, AI). Vendor named in the client: Unusual Whales. Only `/recaps/book` and `/dashboard/positions` matter to us. |
| Lab | `/lab/*`, `/journal/*`, `/bt-*` | A journaling/backtesting product; 404 on this origin. |
| AWS API Gateway | CSP only | Never referenced in the bundle; likely the mobile shell or push relay. |

Stack: Vite + React 19 + Tailwind + Lucide + framer-motion + lightweight-charts; hash router (`#edge/dashboard`). Same family as `client/`.

## 3. Auth and transport

- Sign-in: Discord OAuth (`/auth/discord/login`), Apple, Google or email. Opaque bearer in `localStorage.swift_trades_session`; `Authorization: Bearer` on every call. `GET /api/me` → `{id (Discord snowflake), username, tier, guilds:[{guildId, roleId, label, roleLabel}], billing:{desk, desk_copy, provision, server_alerts}, linkedProviders}`. Gating answers `403 {"error":"insufficient access tier"}` or `{"reason":"owner-only"}`.
- SSE: `GET /api/trade-events` accepts the Bearer header directly (verified 200 `text/event-stream`). For native `EventSource`, `POST /api/sse-ticket` mints a 32-char single-use ticket appended as `?ticket=`; their stated reason is that the browser API cannot set headers and their web-server log format drops query strings. We already solve the same problem with `fetch` streaming (`client/src/lib/stream.ts`).
- Reconnect: exponential 1 s → 30 s; a full `snapshot` on every connect, so no catch-up logic. Same as ours.
- Edge client wrapper: `cache: 'no-store'`, 750 ms de-dupe per URL, polling with visibility pause and backoff to 5 min, `X-Act-As` so the owner can view as a member.
- Dashboard section order is server-driven: `GET /api/dashboard-layout` → `{"order":["position-stats","trade-alerts","open-positions","closed-today"]}`.

### 3.1 SSE contract (`/api/trade-events`; `marks` on `/quote-events`)

| Event | Payload | Purpose |
| --- | --- | --- |
| `connected` | `{}` | handshake |
| `snapshot` | `{positions:[Position], closedNow:{[occ]:{nowPrice,nowPct}}, summary, updated, gatewayAuthenticated, accountKey, accountMode, broker}` | full state; `gatewayAuthenticated:false` = IBKR gateway needs its daily login |
| `trade` | `{side:"B"\|"BUY"\|"S"\|"SELL", size, symbol, price\|avgPrice, realized_pnl, kind?:"trim"}` | the owner's broker fills; rendered as "🟢 Bought 5 SPY … @ $1.25 · P&L +$62.40" and a browser Notification |
| `order-event` | `{kind:"placed"\|"filled"\|"trimmed"\|"stopped"\|"rejected", display\|occ, qty, price, note}` | toasts |
| `position-quote` | `{conid, last, bid, ask}` | per-contract quote; client recomputes `mv`, `upnl`, `dpnl`, batched with rAF |
| `underlying-quote` | `{symbol, price}` | |
| `watchlist-quote` | `{conid, quote:{last,bid,ask,marked,isClose,change,changePct,prevClose,src,quoteAsOfMs,quoteAgeMs}}` | |
| `marks` | `{marks:{[OCC]:…}, exits:{[OCC]:…}, unrealisedPnl, account, winnersUsd, winnersCount, losersUsd, losersCount, dailyPnl, openCount, closedTodayCount, realisedAllTime, asOfMs}` | the KPI strip |
| `alert-milestone`, `book-changed` | | badge bump; debounced (120 ms) refetch |

### 3.2 REST surface that matters (verified live, member tier)

- `GET /api/positions` → `{positions:[Position], trackedCount, closedNow, updated, accountId, accountKey, accountMode:"live", broker:"IBKR"}`.
- `GET /api/trade-history` → `{history:[{date, trades:[HistoryTrade]}], updated, simulatedCount, …}` (57 days, 384 of the trades simulated).
- `GET /api/alerts` → `{alerts:[Alert]}` — every tracked callout (29 open).
- `GET /api/analysts` → `{analysts:[{id, name, owner, active, avatar}], lockedAnalysts:[…]}` — Discord author IDs; avatars from `cdn.discordapp.com`.
- `GET /api/traders` → leaderboard `{id, handle, discordId, kind:"desk"|"analyst", totalTrades, totalPnl, winners, losers, winRate, avgGain, following}`.
- `GET /api/edge/recaps/book` (924 KB) → `{manual:{history}, recaps:[RecapRow], alerts:[Alert], analysts, lockedAnalysts, todayKey, rth, cutoff:"2026-07-18", asOf, stale, sources:{manual|positions|recaps|alerts|analysts:{ok, reason, ageMs}}}`. `?slice=today` polled every 10 s during RTH; `?fresh=1` busts the cache. `sources.*.ageMs` of 23–74 ms says this is assembled per request from in-memory caches, not one table.
- `GET /api/exit-watch` → `{enabled, armPct:75, trailPct:50, watching:[{conid, symbol, peakPct, armed, triggerPct}]}` (trailing stop on peak).
- `GET /api/robinhood/status` → `{configured, connected, ordersEnabled:false, policy:"read-only — Swift Trades cannot place, modify or cancel orders in your account", redirectUri}`; `GET /api/robinhood/quote-option?symbol&strike&right&expiry` (403 on member tier).
- Owner-only (403): `/api/member/dashboard`, `/api/member/channel-rules`, `/api/member/auto-place`, `/api/edge/dashboard/trim-settings`, `/api/edge/copy/*`, `/api/edge/feedhealth/*`, `/api/edge/mcp/*`.
- Webhooks: every desk alert is POSTed as signed JSON, `X-SwiftTrades-Signature: t=…,v1=…` = HMAC-SHA256 of `t + "." + body`.

## 4. Data model

### 4.1 Shapes (field lists complete, from live payloads)

**Position** (open tracked callout or owner fill): `sym "BAC Nov20 '26 50 Put", und, undPrice, earnings, qty, avg, mkt, mv, upnl, dpnl, dayBasis, dpnlIsTotal, realizedPnl, realizedRoi, assetClass:"OPT", multiplier:100, closed, isAuto, openedAt, closedAt, note, thesis, strategy, conid, expiry "YYYYMMDD", theta, extHours, highestPct, tapeQty, tapeDisagrees, tracked, trackedOriginalQty, trackedNotes, trackedRisk, analystId, trackedAdds, trackedTrimLevels[], trackedTrimLevelsSource:"auto", trimHistory[], historyIncomplete, simulated, sim, simFillBasis:"bid"`. `conid` is a numeric IBKR id for the owner's fills and an OCC string (`BAC261120P00050000`) for tracked callouts.

**trimHistory[]**: `{time, qty, price, entryPriceAtTime, basisAvg, pctGain, realizedPnl}`.

**trackedTrimLevels[] / sim.ladder[]**: `{pct, qty, price, label:"+25%", isRunner|runner, collapsed, filled, at, fillBasis:"bid"}`. 25/50/75/100 split the body; runners at 150/200/500/1000/2500/5000/10000 get one contract each and are carved out first.

**sim** (simulation engine state): `{armedAt, openingWindow, lateRunIndex, conid, symbol, occ, qty, originalQty, avgPrice, entryAvg, ladder[], trimHistory[], peakGainPct, beArmed, stopAt, stopKind, trailAt, worstFillBasis, channelId, ladderStale, suspended, closedAt, entryAnnounced, slToBePct, ruleSource:"auto"}`.

**Alert** (a Discord callout as ingested): `{conid (OCC), symbol, displaySym, strike, right:"C"|"P", expiry, entryPrice, addedAt, triggeredThresholds:[10,25,50,75,100,125], qty, originalQty, contracts, adds[], notes, underlyingConid, isTest, realOrder, entryFromFill, multiLeg, channelId, analystId, sim, simulate, relayUsd, relaySource, alertId, highestPct, tracked, costBasis, trimLevels, trimLevelsSource, trimLevelsAsOfMs}`.

**HistoryTrade**: `{sym, avg, pnl, roi, costBasis, strategy, highestPct, blunder, conid, nowPrice, nowPct, isAuto, trimHistory[], simulated, analystId, simFillBasis, openedAt}`.

**RecapRow**: `{conid, symbol, displaySym, strike, right, expiry, entryPrice, highestPrice, highestPct, result:"Win"|"Loss", addedAt, closedAt, notes, isTest, settlement:{price, pct, underlyingClose, source:"secondary", at}}`.

**extHours**: `{estimated, underlyingRoot, proxyRoot, underlyingLast, underlyingClose, underlyingChange(Pct), delta, gamma, theta, model:"reprice", impliedVol, sessionsLeft, thetaApplied, decayDays, decayValue, closeMark, estMark, estPnl, estPnlPct, estPnlDeltaVsClose, confidence, source:"calc"}` — the option repriced off the underlying's extended-hours move with delta/gamma/IV plus theta decay, labelled "est" in the UI.

### 4.2 Rules the client reveals

- Nominal sizing when a callout names no quantity: `qty = max(1, round(5000 / (entry × 100)))` (`recapsCore`, constant `5e3`).
- Ladder fills are simulated at the **bid** (`fillBasis:"bid"`), never mid or last.
- Result is graded on the peak ("Auto grades this on the Peak % — positive is a win"); for Swift's own calls only gains above 25% count as green.
- Untouched contracts expiring OTM settle at price 0, −100%, `source:"settlement-*"`.
- Tracking began 2026-07-18 (`cutoff`).

### 4.3 Where quotes come from

| Source | Marker in payloads | Used for |
| --- | --- | --- |
| IBKR Client Portal gateway | `broker:"IBKR"`, numeric `conid`, `gatewayAuthenticated` | owner positions, fills, primary intraday marks (`markSource:"desk"`). Needs a manual browser login roughly every 24 h. |
| Alpaca market data (owner key slots) | help text | real-time OPRA option quotes, "require Alpaca's Algo Trader Plus plan ($99/mo). Without it the options feed is 15-minute delayed indicative data". "No Alpaca market data is shown to members." |
| "calc" | `source:"calc"`, `liveFrom:"calc"` | their own quote/calculation service: `/api/edge/levels/quote`, after-hours `reprice`, tape status. `"calc+ref"` adds a reference prev-close source. |
| Robinhood read-only OAuth | `/api/robinhood/*` | "Marks come from Robinhood's own book" for members who connect it. |
| "secondary" | `settlement.source` | settling expired contracts |

### 4.4 How they parse (their words)

> Real posts are not clean. They arrive as forwards whose visible body is empty and whose original sits in an attached snapshot; as embeds with a title, a description, a footer and a row of fields; as relay lines prefixed with a name and a glyph. All of that is unwrapped before a single character is read as a ticker, and markdown links, bare URLs, role pings, custom emoji and code fences are removed with it.

> Each line of the post is judged on its own: the ticker, the strike, call or put, the expiry, and any word that names a size.

Deterministic, per line, no LLM. Decisions ("Read as an exit post", "outside market hours") are logged beside buys; only an unresolvable contract, or a symbol that is the channel's own name, is an error. After a Buy: milestone alerts at +10/25/50/75/100/125%, ladder trims at the bid, a `SOLD ALL` card on close ("Tracking only — no order is placed"), settlement at expiry, written to recaps. Average-downs (`kind:"avg-down"`) rebuild the ladder off the blended average, capped in rounds.

### 4.5 Recap format

"Copy recap" produces the Optionality DAILY RECAP text our `trader/recaps/parser.ts` already parses: `🟩 $SPY - 10/21 771C @ 0.68 --> 3.47 | +414.81%` under `SWIFT CALLS:`, with a `📊 STATS:` footer (Total Trades / Winners / Losers / Total Options Gain / Average Gain per Options Call). Two deltas for our parser: a `⬜` neutral marker (gain under 25%) and the header variant `SWIFT DAILY RECAP - 21 October 2026`.

## 5. Head to head on production data

### 5.1 Ingest and latency

Production holds the 16 Optionality alert channels, all live through Oct 21 (`#swift-alerts` 1,494 msgs/30 d, `#harvey-alerts` 728, `#mitro-alerts` 359, `#namrood-alerts` 343, …). 30-day percentiles over every judged message: capture (`captured_at − sent_at`) p50 0.12 s, p90 0.27 s, p99 0.88 s; fully processed including the Jev call p50 0.83 s, p90 3.86 s, p99 8.2 s.

Paired with Swift: Harvey posted `$VST $150P at $.04 Lotto` at 18:03:35; Swift `addedAt` 18:03:43 (8 s). His `$VST $150P exit` at 18:35:33; Swift `closedAt` 18:35:49 (16 s). For Swift's own alerts the Discord card lands ~6 s after `addedAt` (p10 4.4 s, p50 6.2 s, p90 8.1 s).

### 5.2 Parsing

Sep 22 – Oct 21, Swift's 373 recorded entries against our `messages`:

| Author | Swift entries | We parsed as buy | In our archive, judged `not_callout` |
| --- | --- | --- | --- |
| Swift Alerts (bot cards) | 184 | 181 (98%) | 3 |
| Harvey (free-form) | 123 | 13 (11%) | 110 |
| Swift's site-only alerts (no Discord card) | 66 | — | not captured |

Of the 66 not in our archive, Sep 22 (capture began 14:35) and Sep 28 (9 messages after 19:49) are Listener outages; the rest (`SKHY`, `SNDK`, `SNXX`, `HOOD`, `AAPL 357.5C`, `MSFT 540C`, `analystId: null`) exist only on their site.

Why Harvey fails, reproduced with `readPatterns()` on his lines: the option grammar is `TICKER \s+ STRIKE CP` with `STRIKE = \d+(\.\d+)?`, so `$274P` (dollar before the strike) never matches; `PREMIUM` needs a leading digit, so `$.25` is not a price; with no date token `soleExpiration()` is null, so even `$TSLA 357.50P entry at 0.18` yields `option: null`. Jev correctly says `BUY`; `decideCallout` discards it ("the patterns read no complete options contract"). Multi-contract posts (`$IWM $280C at $.55 $279P at $.40`, `$META … $875C Oct 26 … $590P Oct 23`) are refused outright because `readCandidateContract` returns null when a post names more than one contract; Swift records each leg. One wrong hit: `$VST $150P exit` resolved its expiration to **2027-10-02**.

Price: our parsed limit equals Swift's recorded entry exactly in 97 of 141 comparable cases, p50 difference 0%.

### 5.3 Execution

Same window, all users: 65 `submitted`, 1,598 `execution_failed`, 1,406 `risk_rejected`, 11 `pending_approval`.

- `execution_failed`: one string, "quote fetch for X failed: Robinhood authorization required — reconnect Robinhood in Settings" (SPY 585, SPX 184, QQQ 183, …). Per-user MCP tokens expire and nothing refreshes them until a callout arrives and fails.
- `risk_rejected`: `insufficient_capital` 830, mostly "no open X position to trim" — exits for entries we never got into; `ticker_invalid` 313, mostly "Robinhood MCP not connected yet".
- Every one of the 65 submits read `status: unconfirmed`: Robinhood's initial order state, stored at placement and never re-read.

When the session is alive we submit 0.4–1.4 s after the Discord post at the Caller's price. Most of the window the session was dead.

### 5.4 Fills and trims

| | Swift (owner, IBKR/Alpaca) | Ours (Robinhood MCP) |
| --- | --- | --- |
| Fill | read back from the broker's execution record | written once at placement; now read back (section 7) |
| Trims | a ladder of real resting sell limits at the broker, runners reserved first | only when the Caller posts a Trim/Sell (`exitPortion`) |
| Stop | resting stop; break-even stop "slightly above average" once up; trailing stop that only rises and ignores stale quotes | software Max Loss, 15 s sweep, market sell on breach |
| Average-down | validates, cancels resting sells, buys, re-rests the ladder | never copied (an Average trades nothing for anyone) |
| Members | Pro: alerts only; Auto: per-order approval with price drift shown, max $ per trade, kill switch | one shared parse fans out to each member's own account; immediate or approval; sized as % of buying power |

Robinhood MCP today: `place_option_order` with `time_in_force: gfd|gtc`, `get_option_orders` for fills. Not in our tool map: cancel, stop or trailing-stop order types. A GTC trim ladder can be rested after a confirmed fill; it cannot be re-rested on an average-down, and the stop side stays software.

## 6. Access notes

- Production is the Railway Postgres (`postgres.railway.internal/railway`). It has no public endpoint and `ssh.railway.com:22` is unreachable from this network, so a TCP proxy was created: `railway tcp-proxy create --port 5432 --service Postgres` → id `f4bcf63d-3798-4e9d-bfbd-87fd02903bb4`, `kodama.proxy.rlwy.net:49368`, password-protected. Delete with `railway tcp-proxy delete f4bcf63d-3798-4e9d-bfbd-87fd02903bb4 -s Postgres --yes` when no longer needed.
- The hosted Supabase database named in the local `.env.production` is **not** production. It received Harvey's posts through Oct 21 01:26, so a second Listener ran against it on the same Discord user token until then. No such process was running locally at 22:30 ET. That file is retired locally (`.env.production.retired`); production config lives only in Railway variables.

## 7. What changed on `feat/desk-tracking` as a result

- `TRADE_EXECUTION_MODE` is now enforced (`immediate | approval | read_only`) at `trader/pipeline/execute.ts#submitOrder` and the gates leading to it. Production has `approval` set on Railway; **set it to `immediate` before merging** or every callout parks.
- Fill read-back (`trader/fills.ts`): placed orders are polled by `orderId` against `get_option_orders` until terminal; `status`, `filledQuantity`, `averageFillPrice`, `filledAt` land on the row and the dashboard chip reads `filled @ $0.86` / `working` / `cancelled`. `bun run fills:backfill` covers the historical rows.
- Environment: the dashboard service keeps `API_URL` only (11 unread variables removed, including a stale `DISCORD_BOT_TOKEN` — revoke it in the Discord developer portal); the server lost two forwarder-era variables and gained `NODE_ENV=production`; `bun run env:audit` guards the read set.

Next, in order: parser recall (the three grammar gaps and multi-leg posts, target Harvey ≥ 95/123 with bot cards ≥ 181/184), tracked callouts with live marks and a simulated ladder, the auto-trim ladder and stops under the kill switch, then the Dashboard and Recaps in Swift's layout.
