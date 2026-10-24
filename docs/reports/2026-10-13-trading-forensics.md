# Trading forensics: the agentic account, Oct 1–13, 2026

Prepared Oct 13, 2026, and updated the same evening with production data. Read-only review: no code, database or broker state was changed.

**Evidence base.**
- Six Robinhood trade confirmations for the account ending 4000: 75 fills on Oct 1, 5, 6, 7, 9 and 12.
- Read-only extracts from production, taken Oct 13 at 20:02 ET:
  - your settings row;
  - your 363 decision rows (`trades`) since Sep 25;
  - 4,857 captured messages since Sep 25;
  - recaps and callers.

  Other users appear only as anonymous counts.
- The code at HEAD `23dc3a8` (Oct 6, 20:43 ET; clean working tree).
- The sources cited in the appendix.

**Ground rules.**
- Every position on the confirmations was opened by the system. A sell is labelled **system** when a matching system sell order exists. Otherwise it is **manual (inferred)**: placed by you, or possibly by Robinhood's own expiration-day close-out. Max Loss is ruled out (section 3.2). The app's "Submitted by" label is the final word.
- Production runs on Railway in immediate mode, on Supabase's free tier. The Supabase project is restricted for egress (HTTP 402), so dashboard sign-in and approvals fail. The SQL editor still works.
- All times are ET. Path shorthand: `trader/` means `server/src/trader/`, `shared/` means `server/src/shared/`, and `listener/` means `server/listener/src/listener/`. Line numbers are at `23dc3a8`.

---

## 1. Bottom line

The period lost **−$104.47 realized** on 18 closed round trips. **5 × ACI Oct 16 12.5C** ($175.20) are probably still open. Production data now ties every round trip to its callout and to your decision rows. The ranking below is by observed harm.

1. **Orders recorded as failed can still execute. This is still happening as of today.**
   - All 15 of your orders on Oct 12 were recorded `execution_failed` with "API error 409: Reference ID must be unique". **12 of them filled**: 9 buys and 3 sells.
   - On Oct 13, 2 of 3 orders failed the same way: a QQQ buy at 09:36 and an SNXX buy at 10:12. The third, 7 × SPY 778C at 14:27, was recorded `submitted` with its status unconfirmed.
   - It started on Oct 12. All 17 of these 409s fall on Oct 12–13, and the first was at 09:33 on Oct 12. Your 11 earlier `execution_failed` rows (Sep 9–30) were genuine failures: no matching contract, other API errors, or a lapsed Robinhood authorization. The first 409 came before the account switched to margin (09:42–10:01), so look for what else changed that morning: a deploy, or a change on Robinhood's side.
   - Cause: `place_option_order` builds its `ref_id` once, and `withRetry` resends the same arguments (`trader/rh/tools.ts:240-258,736-761`).
     - A 409 on a retry therefore proves the first attempt reached Robinhood.
     - It also settles an open question: Robinhood does de-duplicate by `ref_id`.
     - The first attempt's error isn't stored; only the Railway logs have it.
   - Because the records show no position, nothing that depends on them can manage these positions:
     - Max Loss takes its entry basis from submitted buys, so it skips them;
     - the cap and cooldown undercount;
     - nothing reconciles with the broker.

     You closed most of the Oct 12 positions yourself.
2. **Oversizing: −$354 on three trades.**
   - Your settings size options at **30% / 50% / 70%** of buying power for small, medium and full. The defaults are 0.5 / 1 / 2.
   - Every Swift BUY post contains "Trim Targets:". The size classifier tests the medium pattern (`\btrim\b`) before the small one (`lotto|risky`) (`trader/pipeline/parseCallout.ts:303-310`). So "Super Lotto — Size Very Less" entries were sized at **50%**.
   - Nothing caps the contract count or sets a premium floor (`trader/pipeline/execute.ts:150-219`). That produced SPY 779C ×21 at $0.24, MSFT 530P ×28 at $0.09 and MU 1050C ×41 at $0.05.
   - Sized as small (30%), they would have been 12, 17 and 24 lots and lost about **$146 less**. At the defaults, each would have been 1 lot.
3. **Late fills are invisible to the system.**
   - Entries are good-for-day limits that nothing watches. A working order isn't a position, so caller exits that arrive before the fill find "no open position".
   - This happened on SPY 779C, QQQ 751C, MU 1000C and SPY 781C. On 779C and 751C you ended **$231 worse** than the caller's own exits. MU 1000C gave up the caller's +66% ($203).
4. **Milestone "Close or Trim" alerts are executed as exits.**
   - 114 such alerts reached your pipeline.
   - **9 of the 14 system sell orders** came from them, all on Namrood trades. They filled 7–13% below the alert price: about **$99** of slippage on 12 contracts.
   - Another 15 were rejected because half of 1 lot rounds to 0.
   - The Oct 1 QQQ 742C sale is now **confirmed as the system's**. It sold on the second milestone alert (10:35:16) at $1.09. The caller ran to $2.62, so up to $153 was forgone (an upper bound).
5. **Silent per-user drops on Oct 1–2.**
   - 9 Namrood callouts left no row for you, while other users got rows for the same messages.
   - They include the QQQ 743C, PLTR 195C and AMZN 255C entries that ran +33% to +86%. Those were never submitted, so they weren't "unfilled".
   - The cause is unknown without Railway logs. There have been none since Oct 5.
6. **Exits that follow your Following list instead of your positions.**
   - On Oct 13 at 09:51, the ACI caller posted "exit at $.55" from his own account, which you don't follow. The Swift bot never reposted it.
   - The 5 ACI calls had no system exit: up to +$100 if still held and sold at that price.
   - Exits for held positions should follow the position, not the follow list.
7. **System vs manual exits.**
   - System sells closed 30 contracts for **+$114** before fees.
   - Manual (inferred) sells closed 108 contracts for **−$207**: +$210 on Namrood trades and −$417 on Swift trades.
   - The manual sells were mostly on positions the system had lost track of (409 or late fill). The three oversized lots alone account for −$347 of the manual figure.
   - Max Loss (80% / $700) explains no sell: the worst sell was −67% and $168.
8. **Other confirmed problems.**
   - SPX is untradeable: 48 SPX decisions were rejected as `ticker_invalid`. No SPX was ever bought, so there was no harm here.
   - The production `trades_kind_check` constraint omits `max_loss_exit`, so a Max Loss sell can never be recorded. Max Loss never fired in this window.
   - `gpt-4.1-nano`, the rollback parser's model, shuts down Oct 23.
   - Supabase is restricted, so the dashboard and approvals are down.

**Latent risks, not observed Oct 1–13.** These stay on the fix list at lower priority:
- exits dropped as stale: 0, with p99 processing lag of 5.5 s;
- exits blocked by the daily cap, market hours, the confidence floor or the ticker lists: 0. On Oct 12 the rejections were 47 `insufficient_capital` and 10 `ticker_invalid`, not the cap;
- exits parked for approval: 0. Two re-entries were parked, and you rejected them;
- market orders after a quote failure: 0;
- duplicate orders: 0;
- processing stalls: 0;
- capture gaps: none, with the longest market-hours silence 43 minutes across 14 channels;
- Jev timeouts: 1, with no trade impact.

**Following history.** There is no settings history, so this is inferred from your decision rows:
- Oct 1–8: Namrood only.
- Oct 9 before 11:02: nobody.
- From Oct 9 11:02 (your last settings update): Swift Alerts, SwiftX and shyamal.
- The account switched from cash to margin between 09:42 and 10:01 on Oct 12. Buys before then are type C and 1 lot; buys after are type M and 6–41 lots.

---

## 2. Do before the next market open, and this week

### Recommendation: pause execution before Wednesday's 09:30 open

Keep execution paused until fixes 1–3 below are deployed and tested.

**Why.**
- Fix 1 is the most important. Orders still execute while being recorded as failed, so neither you nor the system knows what is held.
- The sizing path behind −$354 is unchanged, and the account now uses margin.
- Nothing can be watched or approved from the dashboard while Supabase is restricted.

**Trade-off.**
- You will miss the caller's good days. Oct 6 alone was 84% of gross gains.
- Pausing also stops the system's caller-driven exits. Manage open positions yourself in the Robinhood app.
- Max Loss ignores the execution mode, so it keeps running (80% / $700). It can't see positions recorded as failed, and any sell it makes can't be recorded.

**How: approval mode.** Run this in the Supabase SQL editor:

```sql
update users set execution_mode = 'approval'
where id = 'a8da12d5-1a60-4359-98f8-e2fdd4f60bae';
```

- Every callout that passes the risk checks becomes a `pending_approval` row with its sized order, and nothing executes (`trader/pipeline/index.ts:519-529`).
- Nothing can be approved while Supabase Auth is restricted.
- This keeps a decision log from Oct 14 on, for back-testing the fixes.
- Settings are read fresh for each callout (`trader/pipeline/index.ts:349,568`), so no restart is needed.
- There is no "shadow" mode. The only execution modes are `immediate` and `approval` (`shared/types.ts:29`).

**Never approve old pending rows.** Approvals don't expire, and an approval submits the original price unchecked. Clear the backlog first, then revert:

```sql
update trades set kind = 'rejected'
where kind = 'pending_approval' and user_id = 'a8da12d5-1a60-4359-98f8-e2fdd4f60bae';

update users set execution_mode = 'immediate'
where id = 'a8da12d5-1a60-4359-98f8-e2fdd4f60bae';
```

**If you already unfollowed everyone, restore the list.** An empty list `'{}'` follows no one, which leaves no decision log. `NULL` follows everyone (`trader/pipeline/index.ts:353`).

```sql
update users
set followed_caller_ids = '{1001881177529008178,747978338420785184,1525002430503452784}'
where id = 'a8da12d5-1a60-4359-98f8-e2fdd4f60bae';
```

**Fallbacks.**
- Stop the Railway service if you want nothing running. This also stops capture and Max Loss.
- Don't use `TRADE_EXECUTION_MODE`. The README calls it a kill switch (`README.md:262,324`), but no code reads it.
- Disconnecting the agent in the Robinhood app is the emergency stop. Reconnecting needs the dashboard's OAuth flow, which can't sign in while Supabase is restricted.

### Tonight, no code

1. **Check positions and working orders in the Robinhood app.**
   - 5 × ACI Oct 16 12.5C are probably still held. The caller exited at $0.55 on Oct 13 from an account you don't follow. Decide your exit.
   - Today's "failed" QQQ (09:36) and SNXX (10:12) buys may have filled. Check the 7 × SPY 778C (14:27) as well.
   - Verify: every position in the app has an exit plan, and no working order is left that you didn't intend.
2. **Close every dashboard tab on every device.**
   - The stream is authenticated only at connect (`trader/auth.ts:39-57`), polls every 5 s, and reconnects every 3 s (`client/src/lib/stream.ts:25,47-64`). Any open tab restarts the egress the moment Auth works again.
   - Verify: Railway's HTTP logs show no new `GET /api/stream`.
3. **Pull the Railway logs for Oct 12–13 and Oct 1–2.**
   - Search for `will retry` around each 409, to find the first attempt's error.
   - Search Oct 1–2 for the 9 dropped callouts, to find why your pipeline wrote no row.
4. **Record the production configuration:** `LLM_MODEL`, `DECISION_ENGINE`, `JEV_MODEL`, the replica count and the deployed commit.
   - Verify: the values are written into section 9.

### Code changes before switching back to immediate mode

1. **Treat 409 "Reference ID must be unique" as "already placed".**
   - Keep the `ref_id` outside the call. On a 409, look the order up with `get_option_orders` (`trader/rh/tools.ts:38,174`), then record it as `submitted` with its order id and quantity.
   - Match by `ref_id` if the response includes it; otherwise match by option id, side, quantity and creation time. Which fields come back is unverified.
   - Fix the cause too, once the logs show the first attempt's error.
   - Verify: a test where the first call throws and the retry gets a 409 records `submitted` with the broker's order id, not `execution_failed`.
2. **Treat working orders as pending positions.**
   - Exits should look at working orders as well as positions. When the caller exits before the entry fills, cancel the working buy; when it is partly filled, cancel the rest and sell what filled.
   - This needs `cancel_option_order` wired (`trader/rh/tools.ts:29-42`).
   - Verify: with a resting buy and no position, a caller exit cancels the buy and records it.
3. **Fix entry sizing.**
   - Test the small pattern before medium in `classifyPositionSize`, or stop matching "trim" as a size word (`trader/pipeline/parseCallout.ts:303-310`).
   - Add a maximum contracts per order (start at 10) and a minimum premium ($0.10) after `trader/pipeline/execute.ts:219`. Use constants with a `ponytail:` note now and make them settings later.
   - Whether 30% / 50% / 70% suits this account is your call. Those settings drive every size.
   - Verify:
     - a Swift "Super Lotto … Trim Targets:" post classifies as small;
     - a $250 budget at $0.05 sizes 10 contracts, not 50;
     - a $0.05 premium is rejected as `risk_rejected`.
4. **Exits follow the position, not the Following list.** Apply exits from any caller in a watched channel to contracts you hold (`trader/pipeline/index.ts:351-360`).
   - Verify: an exit from an unfollowed author for a held contract places a sell; an entry from the same author is skipped.
5. **Milestone policy.** Treat "Close or Trim & Set SL to BE" as at most one trim per position, and later milestones as information (`trader/pipeline/decide.ts:105-113`). The thresholds are your call.
6. **Fix the Max Loss constraint.** Add a migration that re-creates `trades_kind_check` with `'max_loss_exit'` (last defined in `supabase/migrations/20260906201000_trade_approval.sql:14-25`).
   - Verify: an insert of a `max_loss_exit` row succeeds against a real Postgres.
7. **Lower priority (latent, not observed Oct 1–13):**
   - exits never go stale (`trader/pipeline/index.ts:169-172`);
   - exits bypass entry gates and review parking (`trader/pipeline/riskFilter.ts:147-173`, `trader/pipeline/index.ts:519`);
   - no quote, no trade (`trader/pipeline/execute.ts:200-206`).

   Flip the tests that assert the old behaviour (`server/src/trader/__tests__/poller.test.ts:84-92`, `server/src/trader/pipeline/__tests__/pipeline.test.ts:823-836`).

### Egress (in progress on a separate branch, not merged)

Redis isn't needed. The egress comes from polling unchanged data. The fix is push-on-change with in-memory caching and narrow selects, and Postgres LISTEN/NOTIFY is already in use. These decisions are taken:
- the dashboard stream refreshes every 10 s instead of 5 s (a UI-only change, since you rarely use the dashboard);
- Max Loss keeps its 15 s cadence, but caches entry bases and reloads only on a new decision or a cache miss.

This replaces the two `listDecisions(userId, 500)` full-row reads (`trader/server.ts:644`, `trader/maxLoss.ts:141`). Max Loss is already enabled for your account, so its read runs every 15 s during market hours today. Success check: with one tab open for a full trading day, the Supabase Usage page shows under 100 MB of egress.

### This week, dated

- **Replace `gpt-4.1-nano` before Thursday, Oct 23.**
  - OpenAI's [deprecations page][oai-dep] lists it and its fine-tunes for shutdown on Oct 23, with `gpt-5.6-luna` as the substitute.
  - On the Jev engine, the model powers only recap insights and the `DECISION_ENGINE=parser` rollback. On the parser engine, every LLM-routed message would fail (`trader/pipeline/parseCallout.ts:1474-1491`).
  - Run `bun run eval:parse corpus.jsonl` (`server/src/scripts/parseEval.ts`) once with each model, and switch `LLM_MODEL` in Railway only if the new model adds no violations.
- **While Supabase is restricted (staying on the free tier).**
  - The restriction lifts when the quota refills at the next billing cycle ([Supabase][sb-faq]). Note your reset date on the billing page.
  - Until then, make settings changes only through the SQL editor.
  - A second overage restricts without a new grace period, so the egress fix should land before the reset.

---

## 3. What happened on these trades

### 3.1 Ledger summary

Realized P&L was **−$104.47** on 18 closed contract-day round trips, net of $11.47 in fees ($11.67 across all 75 fills, including the open ACI buy). There were 9 winners for +$388.41 and 9 losers for −$492.88. If the ACI calls expire worthless, the total is **−$279.67**.

| Day | Closed round trips | Realized P&L | Caller followed | Account type |
|---|---|---|---|---|
| Oct 1 | 1 | +$1.91 | Namrood | Cash |
| Oct 5 | 2 | +$17.47 | Namrood | Cash |
| Oct 6 | 1 | +$326.39 | Namrood | Cash |
| Oct 7 | 2 | −$43.80 | Namrood | Cash |
| Oct 9 | 4 | −$222.70 | Swift, from 11:02 | Cash |
| Oct 12 | 8, plus 1 open | −$183.74 | Swift | Margin from about 10:00 |
| **Total** | **18** | **−$104.47** | | |

**Concentration.**
- SPY 781C (Oct 6) was 84% of gross gains.
- The three oversized lots were 72% of gross losses.
- Namrood trades netted +$301.97 and Swift trades −$406.44.

**Processing was fast.** Discord-to-decision lag was 1.4–4.4 s on every entry except the ACI put (10.2 s). Across all messages, p50 was 0.8 s and p99 5.5 s.

### 3.2 Per-trade table

Prices are per share; one contract is 100 shares. Exit columns count contracts closed by a system sell order and manual (inferred) sells. "Gap" is what your quantity would have made at the caller's own exits, minus the actual result. "≤" marks an upper bound where the caller posted no exit.

| Date | Contract (qty) | Buy → avg sell | P&L net | Entry verdict | Exit: system / manual | Notes |
|---|---|---|---|---|---|---|
| Oct 1 | QQQ 742C (1) | 1.07 → 1.09 | +$1.91 | Correct | 1 / 0 | System sold on the 2nd milestone (+12%); caller ran to 2.62. Gap ≤ $153 |
| Oct 5 | SPY 772C (3) | 0.82 → 0.79 | −$10.26 | Correct | 3 / 0 | Followed "TRIM TRIM" and "ALL OUT"; market fills 7–10% under the alerts. Gap $23 |
| Oct 5 | SPY 774C (3) | 0.56 → 0.65 | +$27.73 | Correct | 2 / 1 | 2 sold early on milestones; the last 1 manual at 0.86. Gap ≤ $98 |
| Oct 6 | SPY 781C (7) | 0.56 → 1.03 | **+$326.39** | **Late fill** | 2 / 5 | 3 milestones found no position; system sold 2 on the +114% alert. Gap ≤ $121 |
| Oct 7 | SPY 778C (5) | 0.51 → 0.49 | −$10.44 | Correct | 2 / 3 | 2 sold on a +9% milestone; no caller exit |
| Oct 7 | SPY 773P (4) | 0.90 → 0.82 | −$33.36 | Correct | 3 / 1 | 3 sold on +10% milestones, below entry; manual 1 beat the caller's close. Gap $12 |
| Oct 9 | NVDA 230C (1) | 0.52 → 0.25 | −$27.09 | Correct | 0 / 1 | Trim of 1 lot = 0; caller averaged down and lost |
| Oct 9 | QQQ 751C (2) | 0.64 → 0.46 | −$36.17 | **Late fill** | 0 / 2 | 5 caller exits found no position. Gap $53 |
| Oct 9 | QQQ 752C (8) | 0.35 → 0.36 | +$10.32 | Correct | 8 / 0 | Followed the caller's trim and close. Gap $7 |
| Oct 9 | SPY 779C (21) | 0.24 → 0.16 | **−$169.76** | **Oversized**; late or invisible fill | 0 / 21 | 5 caller exits found no position. Gap $177 |
| Oct 12 | ACI 12.5C (5) | 0.35 → — | open ($175.20) | Limit rounded up 0.325 → 0.35; recorded failed (409) | — | **Missed exit**: caller out at 0.55 on Oct 13 on an unfollowed account |
| Oct 12 | ACI 12P (3) | 0.25 → 0.18 | −$21.25 | Rounded up 0.225 → 0.25; recorded failed | 0 / 3 | No caller exit |
| Oct 12 | IWM 279C (1) | 0.35 → 0.37 | +$1.91 | Correct (cash, 1 lot); recorded failed | 0 / 1 | Caller held to expiry |
| Oct 12 | IWM 278P (1) | 0.37 → 0.49 | +$11.91 | Correct (cash, 1 lot); recorded failed | 0 / 1 | Caller held to expiry |
| Oct 12 | MSFT 530P (28) | 0.09 → 0.03 | **−$170.25** | **Oversized** (margin); recorded failed | 0 / 28 | Caller held to expiry (peak 0.115) |
| Oct 12 | MU 1000C (2) | 1.54 → 1.55 | +$1.83 | **Late fill**; recorded failed | 2 / 0 | 10 caller trims found no position (1.54 → 5.18); the final close was sold, recorded failed. Gap $203 |
| Oct 12 | MU 1050C (41) | 0.05 → 0.047 | −$14.30 | **Oversized**; recorded failed | 0 / 41 | Caller held to expiry |
| Oct 12 | SPY 776P (1) | 0.18 → 0.19 | +$0.91 | Correct (cash, 1 lot); recorded failed | 1 / 0 | Followed the caller's close, recorded failed. Gap $2 |
| Oct 12 | SQQQ 34C (6) | 0.61 → 0.62 | +$5.50 | Correct; recorded failed | 6 / 0 | Followed the caller's close at his price, recorded failed |

Per-message detail: `/tmp/rh-forensics/db/contract_threads.txt`; data: `/tmp/rh-forensics/db/verdicts.csv`.

### 3.3 Exit attribution

| Exit actor | Contracts | Gross P&L | Trades |
|---|---|---|---|
| System, following the caller's close | 20 | +$10 | SPY 772C, QQQ 752C, SPY 776P, SQQQ 34C, MU 1000C (the last three recorded as failed) |
| System, early on a milestone alert | 10 | +$104 | QQQ 742C, SPY 774C ×2, SPY 781C ×2, SPY 778C ×2, SPY 773P ×3 |
| Manual (inferred), Namrood trades | 10 | +$210 | SPY 774C, 781C, 778C, 773P |
| Manual (inferred), Swift trades | 98 | −$417 | SPY 779C, MSFT 530P, MU 1050C, QQQ 751C, NVDA, ACI 12P, IWM ×2 |
| Not exited | 5 | open | ACI 12.5C |

- Swift's caller-close exits filled within $0.00–0.04 of the caller's price.
- Namrood's milestone exits are market orders. They filled 7–13% below the alert mark, and several +10% alerts sold below entry (SPY 773P at 0.86–0.89 against 0.90).
- **Max Loss is ruled out.** No manual sell reached 80% or $700 at its fill price; the worst was MSFT at −67% and $168. Max Loss checks the mark, which is at or above the bid, and it can't write a row in production anyway.

### 3.4 The Oct 1 QQQ 742C trade, confirmed

| Time | Caller (Namrood-BOT) | System and account |
|---|---|---|
| 10:15:18 | "Buy To Open 1/3 POSITION QQQ 742C 0DTE 1.07" | Bought 1 at 1.07 (2.2 s lag, zero slippage) |
| 10:33:40 | "Close or Trim & Set SL to BE … 0.98 → 1.04, +6.12%" | **No row for you** (one of the 9 silent drops) |
| 10:35:16 | Same alert at 1.10, +12.24% | **System market sell of 1, filled 1.09: +$1.91** |
| 10:37–10:40 | Milestones at 1.18, 1.24, 1.42 | "No open position" or no row |
| 13:48:16 | Milestone at 2.62 (+167%) | "No open position" |

- The code running on Oct 1 (`a62509f`) sized an exit with no size word at 1 contract, which was the whole position.
- Under [CONTEXT.md](../../CONTEXT.md), the alert is at most a Trim, and half of one contract rounds down to zero.
- On the Jev engine (since Oct 5), a 1-lot position is kept, which is the 15 "trim size 0 for 1" rejections. A multi-lot position sells half at every milestone (`trader/pipeline/decide.ts:105-113`).

### 3.5 Entries that never reached the broker, and entries that never filled

**Never submitted (silent drops, Oct 1–2).** 9 Namrood callouts produced no row for you, while other users got rows for the same messages. They include:

| Callout | Caller's next mark |
|---|---|
| Oct 1, 14:34:19: "Lotto … QQQ 743C 0DTE 0.87" | 1.36 at 14:35:18 (+56% in 59 s) |
| Oct 2, 09:33:56: "Lotto … PLTR 195C 0DTE 0.8" | 1.49 at 09:35:14 (+86% in 78 s) |
| Oct 2, 09:36:56: "Lotto … AMZN 255C 0DTE 0.45" | 0.60 at 09:38:02 (+33% in 66 s) |

At one contract, these peaked up to $134 above entry. That is the best possible exit, not realizable profit. Earlier drafts called them "unfilled"; they were never sent.

**Submitted but never filled.**
- SPY 780P on Oct 6 ran +80% in 19 minutes, so up to $208 at 4 lots.
- MU 950P (+82%), UNH 450C (+40%) and INTC 110C also never filled. Whether these three were truly unfilled or failed needs the order history.

**What this means.** Limit entries at the caller's price miss when the option gaps up, and fill late when it comes back down. Both directions are confirmed: 23 entry orders, 19 filled, 4 of those only after the move.

### 3.6 Oversized cheap positions

`contracts = ⌊ buying power × size% ÷ 100 ÷ (premium × 100) ⌋`. The premium is the caller's limit, or else the live mark (`trader/pipeline/execute.ts:150-219`). Both guards are dollar limits: a single contract must cost under `max_single_contract_pct` (90% for you) of buying power, and total spend is capped at the full size% (70%). Nothing caps the count, so it grows as the premium falls.

No callout carried a contract count the system used. Buying power isn't stored; the ranges below are implied by the counts.

| Entry | Callout says | Limit | Contracts | Implied buying power | At small (30%) |
|---|---|---|---|---|---|
| SPY 779C, Oct 9, 11:05 | "Super Lotto — RISKY — Size Very Less" | 0.255 | 21 | $1,071–1,122 (cash) | 12 |
| MSFT 530P, Oct 12, 10:11 | "Lotto — RISKY — Size Less" | 0.085 | 28 | $476–493 (margin) | 17 |
| MU 1050C, Oct 12, 10:01 | "Lotto — RISKY — Size Less" | 0.05 | 41 | $410–420 (margin) | 24 |

- One cent was 4%, 11% and 20% of these premiums, and the contracts decay to zero within hours.
- The order is consistent: buying power fell as each order was placed (on Oct 9: QQQ 752C ×8, then QQQ 751C ×2, then NVDA ×1).
- Six other buys were rejected for exceeding the 90% single-contract limit when buying power was low.

### 3.7 Account-type change

Buys through 09:42 on Oct 12 are type C (cash) and 1 lot. From 10:01 they are type M (margin) and 6–41 lots.

- FINRA [Regulatory Notice 26-10][finra-2610] replaced the pattern-day-trader rule with intraday margin standards, effective June 4, 2026. Firms may phase in until Oct 20, 2027. Robinhood's adoption date is unverified.
- Sizing multiplies the broker's `buying_power` (`trader/rh/tools.ts:492-497`). If that figure includes margin, the same percentages size larger positions. Unverified: inspect one raw `get_portfolio` response.

---

## 4. Errors found

Every Critical and High finding was re-read in the code at `23dc3a8`; † marks details taken from the code audit without a re-read. Evidence labels:
- **Prod:** in the production decision or message rows.
- **Trades:** on the confirmations.
- **Prior:** an earlier internal report.
- **Live:** happening now.
- **Code:** code-only, not yet observed.

"Latent" means the production data shows no occurrence Oct 1–13. IDs are kept from the draft; X9 and X10 are new.

### 4.1 Exits

| ID | Sev | What fails, and what it costs | Where | Fix direction | Evidence |
|---|---|---|---|---|---|
| E7 | Critical | Every "Close or Trim & Set SL to BE" milestone is executed as a market-order exit. 114 reached your pipeline. 9 of 14 system sells came from them: up to $251 forgone (upper bounds) and about $99 of slippage at 7–13% below the alert. On Jev each alert sells half of what's left. "Set SL to BE" is ignored. | `trader/pipeline/parseCallout.ts:470-524,1173-1191`; `trader/pipeline/decide.ts:105-113` | One trim per position, later milestones as information, a breakeven stop. Your call. | Prod; Trades |
| E11 | High | Exits obey the Following list, so exits for held positions from an unfollowed author are dropped. | `trader/pipeline/index.ts:351-360` | Exits follow the position (code fix 4). | Prod: ACI 12.5C missed the caller's exit at 0.55 |
| E6 | High | Only a caller exit closes a position. Max Loss is on for you at 80% / $700 but runs 09:30–16:00 only, and skips positions it has no entry basis for, including every position recorded as failed. There's no time stop or 0DTE flatten. | `trader/maxLoss.ts:101,125,145-147` | Flatten 0DTE by 15:25; a tighter stop for 0DTE; reconcile with the broker. | Prod; Trades |
| E8 | High | Max Loss sells, then its `max_loss_exit` insert violates `trades_kind_check`. The sale goes unrecorded, the retry guard is deleted, and the next sweep may sell again. The fake DB skips CHECK constraints, so tests pass (†). | `trader/maxLoss.ts:281-312`; `supabase/migrations/20260906201000_trade_approval.sql:14-25` | Widen the constraint (code fix 6). | Prod: constraint confirmed; Max Loss never fired |
| E10 | High | Exits need an exact broker match on symbol, type, strike and expiry. A slip or alias (SPXW, unverified) means "no open position", never retried. | `trader/pipeline/execute.ts:243-250,308-324` | Match within the ticker, and alert. | Code. Whether SPY 779C's invisibility was this or a late fill needs the order history |
| E4 | High | A ticker-less exit that isn't a reply ("all out") becomes `not_callout` with no per-user row, as does one naming two tickers. | `trader/pipeline/index.ts:190-204,231`; `trader/pipeline/parseCallout.ts:1204-1220` | Match the caller's live entries; always record and alert. | Prior: the old parser dropped 14 of 27 labelled exits. Not re-measured on production rows |
| E1 | High | A message handled more than 120 s after posting is recorded `missed` unparsed, exits included. Tests assert this. | `trader/poller.ts:56,154-155`; `trader/pipeline/index.ts:169-172` | Run exits for held positions at any age. | Latent: 0 stale exits; p99 lag 5.5 s. Fired on Sep 10 (Prior) |
| E2 | High | Exits face entry gates: the daily cap (20 for you), the 09:30–16:00 gate, the ticker lists and the parser's confidence floor. | `trader/pipeline/riskFilter.ts:147-173` | Exempt position-reducing sells. | Latent: 0 exits blocked |
| E3 | High | Jev confidence of 0.6–0.8 parks an order for approval even in immediate mode. Approvals need Supabase Auth, pending rows never expire, and a late approval submits a stale price. | `trader/pipeline/index.ts:519-529`; `trader/pipeline/decide.ts:76-78`; `trader/server.ts:247-301` | Auto-execute exits for held positions; expire pending rows. | Latent for exits: 0. Two re-entries were parked and rejected (Prod) |
| E5 | Medium | A Jev timeout (1.5 s budget) or HTTP error makes the message `failed` for good, with no fallback. | `trader/pipeline/jev.ts:31,154`; `trader/pipeline/index.ts:175-180` | Retry exit-shaped messages with a longer budget. | Latent: 1 timeout (an Average), no impact |
| E9 | Medium | Every decision first needs an equity quote of the underlying. A broker tool error becomes `ticker_invalid`, never retried. | `trader/pipeline/index.ts:422-455`; `trader/rh/tools.ts:69-79` | Skip the quote gate for sells of held positions. | Prod: only SPX hit it (X10) |
| E12 | Medium | Ticker-only exits count entries the caller already closed; with several, the newest is picked and parked. | `trader/pipeline/index.ts:286-305` | Subtract the caller's Sells. | Code |
| E13 | Medium | Exits match by contract, not by caller. | `trader/pipeline/execute.ts:308-324` | Track units per caller. | Code |
| E14 | Medium | On the parser engine (the rollback), a plain Sell sells 1 contract and "close all" sells all but one. | `trader/pipeline/execute.ts:326-340` | Use the exit portion on both engines. | Trades: Oct 1 |
| E15 | Medium | Max Loss has no overlap guard, shares the per-user chain, and compares the mark while selling at the bid (†). | `trader/maxLoss.ts:83-107,249-253` | Overlap guard; a bid-based check. | Code |

### 4.2 Entries, execution and sizing

| ID | Sev | What fails, and what it costs | Where | Fix direction | Evidence |
|---|---|---|---|---|---|
| X9 | Critical | **New.** The size classifier tests "trim" before "lotto/risky". Every Swift BUY contains "Trim Targets:", so every Swift entry was sized medium (50% for you). | `trader/pipeline/parseCallout.ts:303-310` | Test small first, or don't treat "trim" as a size word (code fix 3). | Prod: about $146 of the −$354 |
| X1 | Critical | Contracts are budget ÷ premium with dollar-only caps. With 30–70% budgets, cheap options produce 21–41-lot positions where one cent is 4–20% of the premium. There's no contract cap, premium floor or spread check. | `trader/pipeline/execute.ts:150-219` | A per-order contract cap and premium floor (code fix 3); spread and live-quote checks later. | Prod; Trades: −$354 on three trades |
| X2 | Critical | Entries are good-for-day limits that nothing polls or cancels; no cancel tool is wired. A working order isn't a position, so caller exits find "no open position" and a late fill is held with no exit. | `trader/rh/tools.ts:29-42,257`; `trader/pipeline/execute.ts:287-296,308-324` | Working orders as pending positions; cancel on caller exit or timeout (code fix 2). | Prod: 4 late fills; $231 vs the caller on two |
| X4 | High | Entries without a price, and every exit including Max Loss, are market orders. | `trader/pipeline/decide.ts:99,109`; `trader/maxLoss.ts:270-276` | Capped marketable limits. | Prod: milestone exits filled 7–13% below the alert |
| X5 | Medium | 1-lot positions can't be trimmed, because half of 1 rounds to 0. | `trader/pipeline/execute.ts:349-358` | Your call: sell 1 when the fraction is at least 0.5. | Prod: 15 "trim size 0 for 1" rejections |
| X10 | Medium | **New.** SPX isn't a tradable Robinhood symbol through `get_equity_quotes`, so every SPX decision is rejected. | `trader/pipeline/index.ts:422-455` | Map SPX/SPXW, or tell the caller list it's unsupported. | Prod: 48 `ticker_invalid` (no SPX held) |
| X3 | Medium | A failed option quote returns `null`, so a callout without a price sends a 1-contract market order with the caps skipped. | `trader/rh/tools.ts:101-110`; `trader/pipeline/execute.ts:200-206` | No quote, no trade. | Latent: all 26 October entries were limits |
| X6 | Medium | When Jev says BUY on a message the templates read as an exit, the system buys the contract the caller is exiting. | `trader/pipeline/decide.ts:70-102` | Require agreement on direction. | Code |
| X7 | Medium | Approvals bypass the per-user chain. | `trader/server.ts:277`; `trader/pipeline/index.ts:69-79` | Route approvals through `processor.enqueue`. | Code |
| X8 | Medium | With no active agentic account, orders fall back to the default account (†). | `trader/rh/tools.ts:466-480` | Fail loudly. | Code |

### 4.3 Parsing and decisioning

| ID | Sev | What fails, and what it costs | Where | Fix direction | Evidence |
|---|---|---|---|---|---|
| P1 | High | `gpt-4.1-nano` shuts down Oct 23. On the parser engine every LLM-routed message fails; on Jev, recap insights and the rollback break. | `shared/config.ts:85`; `trader/pipeline/parseCallout.ts:1474-1491` | Swap after `eval:parse`. | Live (dated) |
| P2 | High | Caller edits that add "SOLD 2.10" or fix a strike are archived but never judged again. | `listener/db.py:117-133`; `listener/listener.py:146-159` | Re-judge edits with exit language. | Code |
| P3 | Medium | "1DTE" and "2DTE" aren't in the expiry grammar; "0DTE" uses the UTC date. | `trader/pipeline/parseCallout.ts:128-135,644-651` | A calendar-aware expiry resolver. | Prior: two Oct 1 lottos dropped |
| P4 | Medium | Recaps and averaging posts stored as live callouts on the old parser. The hours gate blocked the Oct 2 16:37 recap-as-Buy. | Parser path | A golden eval set with hard negatives. | Prod; Prior |
| P5 | Medium | A `NULL` Following list means follow everyone, and an empty author allowlist lets any author trigger trades (†, listener side). | `trader/pipeline/index.ts:353`; `listener/config.py` | Drop `NULL`; require an allowlist. | Code |
| P6 | Low | Discord text reaches Jev and the LLM verbatim (prompt injection). | `trader/pipeline/decide.ts:133-139` | Adversarial tests. | Code |

### 4.4 Reliability, idempotency and reconciliation

| ID | Sev | What fails, and what it costs | Where | Fix direction | Evidence |
|---|---|---|---|---|---|
| R6 | Critical | `withRetry` resends `place_option_order` with the same `ref_id` after any error. When the first attempt reached Robinhood, the retry gets 409 "Reference ID must be unique", and the order is recorded `execution_failed` with no order id. The position then exists only at the broker. | `trader/rh/tools.ts:240-258,736-761` | Treat the 409 as "already placed": look it up with `get_option_orders` and record it (code fix 1). | Prod: 15 of 15 orders on Oct 12 (12 filled), 2 of 3 on Oct 13 |
| R4 | High | Nothing reconciles the records with the broker. A failed decision write after submit is only logged, and the cap and cooldown undercount. | `trader/pipeline/index.ts:547-561,572-584` | A reconciliation loop on positions and working orders. | Prod: Oct 12 shows zero positions for a day with 9 buys |
| R7 | High | Per-user failures can leave no row: a crash mid fan-out marks the message done for users who never ran, and per-user DB errors write nothing. | `trader/poller.ts:124-135`; `trader/pipeline/index.ts:130-139` | Per-user completion markers; alert on a missing row. | Prod: 9 silent drops Oct 1–2 (cause unconfirmed), none after Oct 5 |
| R5 | High | A non-401 transport error leaves the MCP client broken until restart (†). | `trader/rh/mcpClient.ts:125-126,337-345` | Reset on transport errors. | Code |
| R1 | Medium | The poller handles one message at a time and waits for every user's broker calls (up to about 3 minutes each). Max Loss shares the chain. | `trader/poller.ts:100-108,206-216`; `trader/rh/tools.ts:736-761` | Shorter call timeouts; decouple fan-out. | Latent: 0 stalls; recap processing took 39 and 20 minutes after hours |
| R2 | Medium | Approve calls the broker before its compare-and-set, with a fresh `ref_id`. | `trader/server.ts:259,277,300`; `trader/rh/tools.ts:258` | Compare-and-set first; persist the `ref_id`. | Latent: 0 duplicates |
| R3 | Medium | If the disposition and processed writes both fail, the next tick orders again. | `trader/pipeline/index.ts:308-321`; `trader/poller.ts:155-156` | An order-intent row before submitting. | Latent: 0 duplicates |
| R8 | Medium | The daily cap resets at server-local midnight (UTC, so 20:00 ET); no holiday calendar. | `trader/pipeline/riskFilter.ts:95-99,204-219` | America/New_York plus a market calendar. | Code |
| R9 | Low | Unbounded in-memory maps; Max Loss closures pile up when scans exceed 15 s. | `trader/pipeline/index.ts:68-70` | Bounded maps and an overlap guard. | Prior (memory chart, Oct 6) |

### 4.5 Infrastructure, egress and ingestion

| ID | Sev | What fails, and what it costs | Where | Fix direction | Evidence |
|---|---|---|---|---|---|
| I1 | High | Supabase is restricted, so every dashboard request gets 401: no approvals or reconnects. Postgres still works; the SQL editor and the trader are unaffected. | `trader/auth.ts:39-57`; `trader/db.ts:726-730` | Section 2 (egress); local JWT verification. | Live |
| I2 | High | Egress: the stream re-reads up to 500 full `trades` rows plus the token row every 5 s per open tab. Max Loss repeats that read every 15 s in market hours, and is enabled for you. | `trader/server.ts:48,51,489,644`; `trader/maxLoss.ts:27,141`; `trader/db.ts:330-338` | Push-on-change, caching, narrow selects (in progress, not merged). | Live (402); Code |
| I3 | Medium | No backfill after a reconnect or restart, and the listener restarts with the trader. | `listener/listener.py:80-144`; `server/src/index.ts:93-101` | Backfill from the last id; run as a separate service. | Latent in October: longest silence 43 min. Prior gaps Sep 11–22 |
| I4 | Medium | The listener automates a user account, which Discord forbids. | `listener/` | Section 5.7. | Code |
| I5 | Medium | `TRADE_EXECUTION_MODE` is documented as a kill switch, but no code reads it. | `README.md:259-262,324` | Implement it or delete it. | Code |
| I6 | Low | The OAuth callback binds 0.0.0.0:8788, and the image exposes it. | `shared/config.ts:111`; `server/Dockerfile.server:42` | Don't expose 8788. | Code |
| I7 | Low | Render keep-alive code and docs remain. | `server/src/index.ts:57-80` | Remove them. | Code |

### 4.6 Observability and tests

| ID | Sev | What fails, and what it costs | Where | Fix direction | Evidence |
|---|---|---|---|---|---|
| O1 | Medium | `/health` always returns ok, and nothing alerts on failed, rejected or missed orders. An alert on `execution_failed` would have flagged Oct 12 the same morning. | `trader/server.ts:101-103` | Push alerts (5.5). | Prod |
| O2 | Medium | Tests assert the risky behaviour (stale exits `missed`, a parser TRIM sells 1). Untested: retries against a 409, working orders, schema constraints (†). | `server/src/trader/__tests__/poller.test.ts:84-92`; `server/src/trader/pipeline/__tests__/pipeline.test.ts:202-219,823-836,943-957` | Flip those tests; add a few DB-backed ones. | Code |
| O3 | Low | Nothing measures fill rate, time to fill, slippage or missed-exit rate. | — | Section 5.5. | Code |

**Totals:** 50 findings: 5 Critical (R6, X9, X1, X2, E7), 16 High, 24 Medium and 5 Low.

---

## 5. Risk-mitigation design

Thresholds marked "start at" are starting points to tune on your own fills, not sourced numbers. External sources come from the research file and were not re-fetched for this report. The exceptions are the OpenAI deprecation and FINRA 26-10 facts, which were verified against their primary sources.

### 5.1 Execution

- **Limit orders only, capped against both the signal and the live market.**
  - Fetch bid, ask and quote time with `get_option_quotes`.
  - Set cap = min(signal × (1 + x%), signal + N ticks). Start at x = 5–8% for 0DTE and N ≥ 2.
  - Reject when the quote is older than 2 s, the bid is 0, the spread is over 15% of mid (ETFs) or 25% (single stocks), or the ask is above the cap.
  - Robinhood documents no price collar on option market orders ([market orders][rh-mkt]), and FINRA found its equity collar mis-disclosed ([AWC][finra-awc]). Retail spreads on 0DTE index options run about 5–6% of premium ([Beckmeyer et al.][beck]). Price bands are the standard erroneous-order control ([SEC 15c3-5][sec-15c3-5]; [FIA][fia]).
- **Spread and liquidity filters.** Require a bid above 0, displayed size at least the order size, and open interest and volume above floors ([OIC][oic-bidask]).
- **Fill timeout, reprice ladder, cancel.**
  1. Rest at mid (rounded up to the tick) for 1–2 s.
  2. Move to the ask, if within the cap, for 3–5 s.
  3. Cancel, keeping the total at 10–15 s or less for 0DTE.
  4. Confirm `cancelled` or `filled` before any replacement.
  5. Cancel working entries for a contract the moment the caller exits it. This closes the late-fill gap (X2).
  - The SEC's 0DTE study found a mid-price limit filled 50–62% of the time within 1 s ([DERA][dera]). `cancel_option_order` is in Robinhood's agent tool list ([trading with your agent][rh-tools]) but isn't wired.

### 5.2 Exits

- **Exits follow positions.** An exit for a held contract runs regardless of who posted it, message age, daily cap, hours, ticker lists, confidence and approval mode. This mirrors the kill-switch asymmetry in [FIA's guidance][fia]: block risk-increasing orders, allow risk-reducing ones.
- **Mirror the caller, plus independent exits.**
  - A disaster stop: start at −50% of premium for 0DTE.
  - An alert at 15 minutes with no caller exit, then a per-caller time stop.
  - A **0DTE flatten by 15:25 ET**. Robinhood starts closing at-risk expiring positions at 15:30, or 15:45 for late-close products such as SPY ([options hours][rh-hours]; [expiration][rh-exp]). OCC auto-exercises anything $0.01 or more in the money ([OIC][oic-ex]).
  - Evaluate exits on the **bid** with a quote-age check, not the mark.
- **Broker-side protective orders, if supported.**
  - The app supports options stop-limit orders, and sell-to-close stop-market orders that can't be entered 09:30–09:45 ([order types][rh-types]; [stop market][rh-stopmkt]; [stop limit][rh-stoplmt]). There are no trailing stops for options ([trailing stop][rh-trail]).
  - **Unverified:** whether `place_option_order` accepts stop types. Dump the live tool schemas first with `server/scripts/dump-option-schemas.ts`.

### 5.3 Pre-trade risk checks

Put these in one gate in code, before every `place_*` call (models: [SEC 15c3-5][sec-15c3-5], [FINRA 15-09][finra-1509], [FIA][fia]).

| Check | Start at |
|---|---|
| Max contracts per order (block when unset) | 10 |
| Min premium | $0.10 |
| Max contracts per day | 50 |
| Max notional per order, per day, per caller | 10%, 50% and 25% of buying power |
| Max open positions, counting working orders | 3–5 |
| Duplicate check: same contract and side within 60 s, or the same message | reject |
| Daily loss limit: realized plus unrealized | −5% to −10% of start-of-day value turns entries off, exits stay on |
| Stale or aberrant quote | block |

**Kill switch.**
- It blocks entries, cancels working entries, still allows exits, and resets manually.
- It trips automatically on the daily loss limit, a reject streak, reconciliation drift or stale quotes.
- Control it from something that needs neither Supabase Auth nor Discord: a Railway env var plus an admin endpoint guarded by a long random token. Until then, approval mode via the SQL editor is the switch.
- Robinhood's "disconnect the agent" is the manual backstop ([Robinhood agents][rh-agents]).

### 5.4 Parsing safety

- **Strict structured outputs** ([OpenAI][oai-so]).
- **Option-chain validation before sizing.** The contract must exist via `get_option_instruments`. Abstain when the signal price differs from the mid by more than 25%.
- **Agreement or abstain** for anything not matched by a template. Self-reported LLM confidence is overconfident ([Xiong et al.][xiong]).
- **A golden eval set before any model swap:** 300–1,000 labelled messages with hard negatives (recaps, watchlists, P/L lines, edits, multi-contract posts, NDTE, and size words such as "Trim Targets"). Gate on zero harmful errors ([FINRA 15-09][finra-1509]). `server/src/scripts/parseEval.ts` is the starting point.
- **Prompt-injection hygiene** ([OWASP LLM01][owasp]): treat Discord text as untrusted and enforce all limits in code.

### 5.5 Reliability

- **Idempotent client order IDs.** Derive `ref_id` = UUIDv5(user, message, leg, intent version), persist it before sending, and **query before retrying** ([AWS][aws-idem]). Production now shows that Robinhood rejects a reused `ref_id` with 409, which is safe only if the client treats it as "already placed".
- **Outbox.** Write the order intent in the same transaction as the decision, and have one sender drain it ([transactional outbox][outbox]).
- **Broker reconciliation loop.** Every 30–60 s in market hours, and after every ambiguous submit, compare positions and working orders with `get_option_positions` and `get_option_orders`. Alert on orphans and phantoms ([FIA][fia] §4.1). This would have caught every Oct 12 position.
- **Heartbeats and alerting that depend on neither Supabase nor Discord.** Use a free push service (for example ntfy or Pushover). Page on `execution_failed`, a rejected or missed exit, reconciliation drift, a capture gap, and a Robinhood token refresh failure.

### 5.6 The data layer within the Supabase free tier

- **Fix egress at the source** ([Supabase's guidance][sb-egress]): push-on-change over the existing LISTEN/NOTIFY, in-memory caching, explicit column lists, no `raw` in lists. Redis isn't needed.
- **Keep Supabase off the trading hot path.** Hold open positions and working orders in the trader process, with the broker as the source of truth via reconciliation. Write `trades` asynchronously as an audit log. Keep LISTEN/NOTIFY on the session pooler ([connecting][sb-connect]); don't move orders to Realtime ([Supabase blog][sb-rt-blog]).
- **Verify JWTs locally** rather than calling Auth on every request (`trader/db.ts:726-730`).
- **Other free-tier limits.** Past 500 MB the database goes read-only ([database size][sb-dbsize]). About 7 days of low activity pauses the project ([pausing][sb-pause]).

### 5.7 Discord ingestion

- **Self-bot risk.** Discord says automating a user account "is forbidden, and can result in an account termination" ([self-bots][dc-selfbot]; [guidelines][dc-guide]). Prefer an Announcement channel followed into your own server and read by an official bot ([announcement channels][dc-announce]).
- **Gap detection and backfill.** Persist the last message id per channel and page `GET /channels/{id}/messages?after=<last>` on resume ([messages API][dc-msg]; [gateway][dc-gw]). Backfilled exits go through the exits-follow-positions rule.

---

## 6. Improvement plan

### Phase 0: before Wednesday, Oct 14, 09:30 ET

| Change | Where | Success check |
|---|---|---|
| Pause: approval mode for your user id (SQL in section 2). Restore the Following list if you unfollowed | SQL editor | New callouts create `pending_approval` rows; the app shows no new agent orders |
| Check positions and working orders: ACI 12.5C, today's QQQ and SNXX, SPY 778C | Robinhood app | Every position has an exit plan |
| Close all dashboard tabs | Every device | No `GET /api/stream` in Railway HTTP logs |
| Pull Railway logs: first-attempt errors behind the 409s; the Oct 1–2 drops | Railway | Errors recorded in section 9 |
| Record production env, replicas and deployed commit | Railway | Section 9 filled in |

### Phase 1: this week (the model swap before Oct 23)

| Change | Where | Success check |
|---|---|---|
| 1. 409 "Reference ID must be unique" → look up with `get_option_orders` and record as placed | `trader/rh/tools.ts:240-258,736-761`; `trader/pipeline/index.ts:531-561` | A first-call-throws, retry-409 test records `submitted` with the broker order id |
| 2. Working orders as pending positions; caller exits cancel or replace them | `trader/rh/tools.ts` (wire `cancel_option_order`); `trader/pipeline/execute.ts:308-324` | With a resting buy and no position, an exit cancels it |
| 3. Size classifier order, contract cap, premium floor | `trader/pipeline/parseCallout.ts:303-310`; `trader/pipeline/execute.ts:183-219` | Swift lotto → small; $250 at $0.05 → 10; $0.05 rejected |
| Exits follow the position, not the Following list | `trader/pipeline/index.ts:351-360` | An unfollowed author's exit sells a held contract |
| Milestone policy: one trim per position | `trader/pipeline/decide.ts:105-113` | Six milestones on an 8-lot position give one trim |
| `max_loss_exit` constraint | New migration | A DB-backed insert succeeds |
| Egress: dashboard 10 s, Max Loss cached (**in progress on a separate branch, not merged**) | `trader/server.ts:51,489,644`; `trader/maxLoss.ts:141` | Under 100 MB a day with one tab open |
| Push alert on `execution_failed` and on rejected exits | `finalize`, `trader/pipeline/index.ts:572-592` | A forced failure pages your phone within 10 s |
| `LLM_MODEL=gpt-5.6-luna` | Railway env, after `eval:parse` | No new violations versus nano |
| Back-test fixes 1–3 on the approval-mode rows | `trades` where kind is `pending_approval` | Sizes and exits match what you would accept |

### Phase 2: the next 2–3 weeks

| Change | Where | Success check |
|---|---|---|
| Reconciliation loop and a position ledger | New module using `getOptionPositions` and `getOptionOrders` | An injected mismatch alerts within 60 s |
| Order lifecycle: poll, timeout, marketable-limit ladder | `trader/rh/tools.ts`; `trader/pipeline/execute.ts` | No entry order alive past its timeout |
| Idempotency: intent row and deterministic `ref_id` | `trader/pipeline/index.ts:531`; `trader/server.ts:255-301` | A replayed message places one order |
| Per-user completion markers (the Oct 1–2 drops) | `trader/poller.ts:124-135`; `trader/pipeline/index.ts:130-139` | A per-user failure writes a row and alerts |
| Time stop and 0DTE flatten by 15:25 | Generalize `trader/maxLoss.ts` | A simulated-clock test closes a 0DTE position by 15:25 |
| Latent exit gaps: never stale, no gates or review parking for exits, no quote no trade | `trader/pipeline/index.ts:169-172,519`; `trader/pipeline/riskFilter.ts:147-173`; `trader/pipeline/execute.ts:200-206` | Flipped tests pass |
| SPX support or explicit rejection | `trader/pipeline/index.ts:422-455` | An SPX callout is traded or rejected with a clear reason |
| Listener backfill, separate service; golden eval set | `listener/`; `server/src/trader/pipeline/__tests__/fixtures/` | A 5-minute outage loses no messages; zero harmful errors |

### Phase 3: later

| Change | Where | Success check |
|---|---|---|
| Broker-side disaster stops, after the schema check | `server/scripts/dump-option-schemas.ts`, then `trader/rh/tools.ts` | Every fill has a resting stop |
| Trading hot path off Supabase | Trader process state plus an async audit write | A drill with Supabase blocked still exits positions |
| Sanctioned ingestion relay | Listener | At least 99% of messages de-duplicate across both paths |
| Per-caller analytics | New report on `trades` | Follow decisions use realized slippage and P&L per caller (Namrood +$302, Swift −$406 here) |

---

## 7. Features to add, and to remove or simplify

**Add, highest value first.**
1. Broker truth: 409-as-placed, working orders as pending positions, and a reconciliation loop.
2. Pre-trade limits: contract cap, premium floor, notional and open-position limits, a daily loss limit, and a kill switch that allows exits.
3. An exit-first policy: exits follow positions (not the Following list), are never stale or gated, are retried until flat, and alert on failure.
4. An order lifecycle: status polling, timeout and cancel, marketable limits with a slippage cap.
5. Independent exits: a 0DTE flatten, a time stop, and a breakeven stop when the caller says "SL to BE".
6. Listener resilience: backfill, a heartbeat, a separate service.
7. Observability: real `/health`, push alerts, fill-rate and slippage metrics.

**Remove or simplify.**
- "Trim" as a size word.
- Market-order exits on milestone alerts.
- The 120 s staleness drop for exits.
- The "premium unknown → 1 contract" fallback.
- `listDecisions(500)` in the stream and Max Loss, and `select *` on `messages`.
- `TRADE_EXECUTION_MODE` docs, unless it is implemented.
- Render keep-alive code and the exposed OAuth port.

---

## 8. Other latent issues (not yet observed)

- **Market-order exits at the open.** Robinhood accepts option market orders only from 09:35 to 16:00 ET ([market orders][rh-mkt]). A milestone exit at 09:30–09:35 would likely be rejected and never retried. MCP behaviour is unverified.
- **Margin sizing.** Sizing multiplies `buying_power` (`trader/rh/tools.ts:492-497`), which may include margin.
- **Same-day entries late in the day.** Robinhood stops new same-day option opens at 15:30 when expiration-date trading is on ([options hours][rh-hours]).
- **Approvals Robinhood holds.** Robinhood may require approval for some agent trades ([trading with your agent][rh-tools]). The system would record those orders as `submitted`.
- **Half days and holidays** break the hours gate and the daily cap (R8).
- **OAuth client name.** The broker OAuth uses the "Claude Code" client name (`shared/config.ts:105-108`). If Robinhood tightens that client, reconnects fail.
- **The approval race (R2).** It becomes live once the dashboard works and approvals are used.
- **Stale approvals.** Rows parked during the pause must be rejected before switching back (section 2).

---

## 9. Missing context and data gaps

| Unknown | Why it matters | How to supply it |
|---|---|---|
| Robinhood order history, Oct 1–13: created and filled times, status, cancels, "Submitted by" | Fill times of the four late fills; why SPY 779C was invisible at 11:17–11:25; whether MU 950P, UNH 450C and INTC 110C were unfilled or failed; confirming the manual-exit inference | App → History → each order's details |
| Current holdings | Whether ACI 12.5C is still held; whether today's QQQ and SNXX buys filled | App → positions and working orders |
| Railway logs, Oct 12–13 | The first-attempt error behind every 409 | Railway → Logs, around each failure (`will retry`) |
| Railway logs, Oct 1–2 | Why your pipeline wrote no row for 9 callouts | Railway → Logs, filtered to those message times |
| Confirmations for Sep 25–30 and Oct 13 | 19 submitted orders unchecked; Oct 13's SPY 778C ×7, QQQ and SNXX | Robinhood → Documents → Trade confirmations |
| Settings history | The Following list from Oct 9 00:00 to 11:02, and earlier Max Loss and sizing values | Not stored; from memory, or add an audit table |
| Railway `LLM_MODEL`, `DECISION_ENGINE`, `JEV_MODEL`, replica count, deployed commit per day | Which code made each decision; Oct 23 impact | Railway → Variables, Settings, Deployments |
| Billing-cycle reset date | When the restriction lifts and the egress risk restarts | Supabase → Billing |
| Raw `get_portfolio` response | Whether `buying_power` includes margin | One logged response |

---

## Appendix

### A. Verification notes

The production findings were checked against the extracts in `/tmp/rh-forensics/db/` and the code at `23dc3a8`:
- the `ref_id` built once in `trader/rh/tools.ts:258`;
- the classifier order in `trader/pipeline/parseCallout.ts:303-310`;
- settings read per callout (`trader/pipeline/index.ts:349,568`);
- `NULL` versus `'{}'` Following (`:353`);
- the two execution modes (`shared/types.ts:29`);
- approval parking (`trader/pipeline/index.ts:519-529`);
- the Oct 12–13 decision codes in `owner_trades.csv`.

**Superseded or corrected by production data.**
- **Oct 1 exit:** "most likely the system's; unconfirmed" → confirmed system, on the second milestone (10:35:16), not the first. The first got no row.
- **Oct 1–2 missed entries:** "three entries never filled" → never submitted (silent per-user drops).
- **Oct 12 daily-cap hypothesis:** dropped. Your cap is 20; Oct 12 rejections were 47 `insufficient_capital` and 10 `ticker_invalid`.
- **Exit gaps (stale, gates, approval parking), quote-failure orders, duplicates, stalls, capture gaps:** Critical or High → latent, 0 observed Oct 1–13.
- **"Robinhood de-duplication by `ref_id` is unverified":** confirmed. Reuse is rejected with 409, and the system mishandles that (R6, now Critical).
- **"Shadow mode":** there is no such mode. The pause is `execution_mode = 'approval'` for your user id.
- **"Max Loss is off by default":** it is on for you (80% / $700). It explains no sell, and its constraint gap is confirmed in production.
- **Sizing:** the default 0.5/1/2% figures don't apply; your settings are 30/50/70%. The classifier bug (X9) is new.
- **Deep single-sell losses:** "unknown exiter" → manual (inferred), with Max Loss ruled out.
- **Severity:** X9 and R6 are new or raised to Critical; E7 raised to Critical; E11 raised on the ACI evidence; E1, E2, E3, E5, R1, R2, R3, X3 and I3 lowered as latent.

**Kept from the first pass.**
- The research's claim of an existing contract-count cap is false; the only caps are dollar caps.
- An expired session doesn't stop the stream; it is authenticated only at connect.
- PDT is replaced by FINRA 26-10; Robinhood's adoption date is unverified.
- Upgrading to Pro is not the fix; egress is fixed at the source.
- Fees: $11.47 on closed trades, $11.67 across all fills.

### B. Evidence files

These are local to the analysis machine and not in the repo:
- `/tmp/rh-forensics/forensics.md`, `code-audit.md` and `research.md`: the three input analyses.
- `/tmp/rh-forensics/ledger.csv` (75 fills) and `roundtrips.csv`.
- `/tmp/rh-forensics/db/`:
  - `owner_user.csv`;
  - `owner_trades.csv`;
  - `messages.csv`;
  - `owner_oct_timeline.txt`;
  - `contract_threads.txt`;
  - `verdicts.py` and `verdicts.csv`;
  - `users_anon.csv` (anonymized).

### C. Sources

[oai-dep]: https://developers.openai.com/api/docs/deprecations
[finra-2610]: https://www.finra.org/rules-guidance/notices/26-10
[sb-faq]: https://supabase.com/docs/guides/platform/billing-faq
[sb-egress]: https://supabase.com/docs/guides/platform/manage-your-usage/egress
[sb-connect]: https://supabase.com/docs/guides/database/connecting-to-postgres
[sb-rt-blog]: https://supabase.com/blog/realtime-or-pipelines-how-to-choose-the-right-tool
[sb-dbsize]: https://supabase.com/docs/guides/platform/database-size
[sb-pause]: https://supabase.com/docs/guides/platform/free-project-pausing
[rh-tools]: https://robinhood.com/us/en/support/articles/trading-with-your-agent/
[rh-agents]: https://robinhood.com/us/en/newsroom/robinhood-is-now-open-to-agents/
[rh-mkt]: https://robinhood.com/us/en/support/articles/market-order-options/
[rh-types]: https://robinhood.com/us/en/support/articles/order-types/
[rh-stopmkt]: https://robinhood.com/us/en/support/articles/stop-market-order-options/
[rh-stoplmt]: https://robinhood.com/us/en/support/articles/stop-limit-order-options/
[rh-trail]: https://robinhood.com/us/en/support/articles/trailing-stop-order/
[rh-hours]: https://robinhood.com/us/en/support/articles/options-trading-hours/
[rh-exp]: https://robinhood.com/us/en/support/articles/expiration-exercise-and-assignment/
[finra-awc]: https://www.finra.org/sites/default/files/2025-03/robinhood-AWC-030725.pdf
[sec-15c3-5]: https://www.law.cornell.edu/cfr/text/17/240.15c3-5
[finra-1509]: https://www.finra.org/rules-guidance/notices/15-09
[fia]: https://www.fia.org/sites/default/files/2024-07/FIA_WP_AUTOMATED%20TRADING%20RISK%20CONTROLS_FINAL_0.pdf
[dera]: https://www.sec.gov/files/dera-hope-reasonable-prc-2503.pdf
[beck]: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4404704
[oic-bidask]: https://www.optionseducation.org/news/understanding-the-bid-and-ask-prices-for-options
[oic-ex]: https://www.optionseducation.org/referencelibrary/faq/options-exercise
[oai-so]: https://platform.openai.com/docs/guides/structured-outputs
[owasp]: https://genai.owasp.org/llmrisk/llm01-prompt-injection/
[xiong]: https://arxiv.org/abs/2306.13063
[aws-idem]: https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/
[outbox]: https://microservices.io/patterns/data/transactional-outbox.html
[dc-selfbot]: https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots
[dc-guide]: https://discord.com/guidelines
[dc-announce]: https://support.discord.com/hc/en-us/articles/360032008192-Announcement-Channels-FAQ
[dc-msg]: https://docs.discord.com/developers/resources/message
[dc-gw]: https://docs.discord.com/developers/events/gateway

- [OpenAI model deprecations][oai-dep]: `gpt-4.1-nano` shuts down Oct 23, 2026; substitute `gpt-5.6-luna` (verified against the primary source).
- [FINRA Regulatory Notice 26-10][finra-2610]: effective June 4, 2026, with phase-in to Oct 20, 2027 (verified against the primary source).
- Supabase: [billing FAQ][sb-faq], [egress][sb-egress], [connecting][sb-connect], [Realtime vs pipelines][sb-rt-blog], [database size][sb-dbsize], [project pausing][sb-pause]
- Robinhood: [trading with your agent][rh-tools], [agents announcement][rh-agents], [market orders][rh-mkt], [order types][rh-types], [stop market][rh-stopmkt], [stop limit][rh-stoplmt], [trailing stop][rh-trail], [options hours][rh-hours], [expiration and exercise][rh-exp], [FINRA AWC][finra-awc]
- Controls and market structure: [SEC 15c3-5][sec-15c3-5], [FINRA 15-09][finra-1509], [FIA automated trading controls][fia], [SEC DERA 0DTE study][dera], [Beckmeyer et al.][beck], [OIC bid/ask][oic-bidask], [OIC exercise][oic-ex]
- LLM: [OpenAI structured outputs][oai-so], [OWASP LLM01][owasp], [Xiong et al.][xiong]
- Reliability: [AWS idempotent APIs][aws-idem], [transactional outbox][outbox]
- Discord: [self-bots][dc-selfbot], [guidelines][dc-guide], [announcement channels][dc-announce], [messages API][dc-msg], [gateway][dc-gw]
