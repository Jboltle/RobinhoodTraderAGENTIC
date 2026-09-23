# Business Plan — [Working name: "CalloutPilot"]

*Burgess Institute Discovery Program submission · Draft v1 · September 2026*
*Founder: [Your name], [Major / class year], Michigan State University*

> **How to use this draft.** Anything in `[brackets]` is something only you can fill in (your name, customer interview results, pricing tests). Figures marked *assumption* are planning estimates, not measured data. Replace them with real numbers from your Idea Validation worksheet (Discovery Step 1) before you upload.
>
> The Discovery Program has you build the plan in **Venture Planner** (Step 3). Venture Planner generates the plan from a questionnaire, so use this document as your answer key. It covers what that questionnaire asks for: market segmentation, customer personas, SWOT, competitors, SMART objectives, and pricing, distribution, promotion, people and exit strategy. Where Venture Planner's generated text is generic, paste the matching section from here. Upload the Venture Planner draft and the completed Idea Validation worksheet together in Step 4.

---

## 1. Executive Summary

**The problem.** Millions of retail traders pay for or follow trade-alert communities on Discord. When a trusted analyst posts "BTO SPY 755C 0DTE $0.71", the member has to see the notification, read it, open their brokerage app, key in the order and size it. For short-dated options that takes 30–90 seconds, and prices move in seconds. So members routinely get worse fills than the caller, miss alerts while at work or in class, oversize trades in the moment, and have no record of which callers actually make them money.

**The solution.** CalloutPilot turns a trade alert into a sized, risk-checked order in the member's own brokerage account within seconds, under rules the member sets in advance. An AI parser reads each alert once. The platform then applies every member's own settings: which callers they follow, position size as a % of buying power, a daily trade cap, per-ticker cooldowns, ticker allow/block lists, a max-loss exit and market-hours limits. It either places the order or parks it for one-tap approval. Members keep custody of their money. We never hold funds and never decide what to trade.

**Traction.** A working multi-user product has been built and tested (≈3 months, 55 commits, 320+ automated tests): an AI alert parser, per-user risk engine, encrypted broker connections, approval mode and a live web dashboard. [Add: number of test users, number of alerts processed, interview count.]

**The business.** Our go-to-market is **business-to-community**. Alert-community owners license CalloutPilot as a premium perk for their members, which gives us a distribution channel with built-in trust. Pricing: members pay [$19–29/month] (*assumption*), with a revenue share to the community owner.

**The ask.** Admission to Burgess **Launch** and funding of **[$X]** for (1) a legal/regulatory review and restructuring onto officially sanctioned integrations, (2) a paid pilot with 2–3 partner communities, and (3) hosting and AI costs for the pilot.

---

## 2. Opportunity

### 2.1 Problem worth solving

| Pain | Who feels it | Today's workaround |
| --- | --- | --- |
| Alerts are time-sensitive; manual entry is slow | Members of options/day-trading alert groups | Phone notifications, trying to click fast |
| People trade in the moment and blow past their own risk rules | Newer retail traders | Willpower, spreadsheets |
| Can't trade while in class/at work | Students, full-time employees | Miss the trade |
| No honest record of which caller is actually profitable | Everyone in paid groups | Screenshots, the caller's own (selective) recaps |
| Community owners lose members who don't see results | Alert-group operators | Discounts, more hype |

**Validation evidence:** [Paste your Idea Validation / proof-of-concept worksheet findings here: how many traders you interviewed, what % said speed or discipline was their top pain, what they pay today, what they'd pay for automation. Reviewers weigh this section most heavily.]

### 2.2 Solution

1. **Capture.** The platform reads alerts from the partner community's channels. The target design uses an official Discord bot the community owner installs (see §4.3).
2. **Understand, once.** An LLM converts free-text alerts ("TRIM QQQ 707C 1.59 → 1.75") into structured instructions with a confidence score, and classifies each message as a callout, recap or noise. One parse serves every member, so AI cost does not grow with the number of users.
3. **Apply each member's rules.** Followed callers only; sizing as % of buying power with a hard per-trade ceiling; daily trade cap; per-ticker cooldown; minimum confidence; regular-hours-only; max-loss auto-close.
4. **Execute or ask.** In *immediate* mode the order goes to the member's own brokerage. In *approval* mode (the default) the member gets a sized ticket to approve or reject.
5. **Audit.** Every decision (placed, skipped and why, missed because stale) is logged per member. This is the basis for honest caller performance stats.

**Built-in safety.** Alerts older than 2 minutes are never executed at a stale price. A global kill switch can halt all trading. New accounts follow nobody until the member opts in.

### 2.3 Target market

- **Primary customer (payer):** owners of paid trade-alert communities on Discord, typically charging members $30–$150/month (*verify with interviews*). They want member retention and a premium tier.
- **End user:** retail options and equity traders aged 18–40 who already follow alert groups and use a commission-free broker.
- **Beachhead:** [2–3 specific communities you have access to or relationships with], then small and mid-sized alert groups (500–5,000 members).
- **Market sizing (to complete with sources):**
  - TAM: US retail traders active in options (industry data from OCC/Cboe on retail options volume, [cite]).
  - SAM: members of paid Discord/Whop trade-alert communities ([estimate from Whop/Discord marketplace research]).
  - SOM (3-year): [e.g. 40 partner communities × 100 paying members = 4,000 subscribers, matching the Year 3 forecast in §5.2].

### 2.4 Customer personas

- **"Busy Brandon," member, 22, student or early-career.** Pays $50/month for an options alert group. Misses most alerts during class or work, and when he does catch one he chases the price. Wants: "take the trades I'd take, at the size I chose, while I'm busy." Worry: losing control. Approval mode and hard size ceilings answer that worry.
- **"Disciplined-in-theory Dana," member, 30s.** Has written rules (max 2% per trade, no more than 5 trades a day) but breaks them when a call feels hot. Wants her rules enforced, not suggested. Values the audit log showing which callers make her money.
- **"Operator Omar," community owner.** Runs a 2,000-member paid Discord. Members churn when they can't get the results he posts. Wants a premium tier and retention without building software himself. Worry: members blaming him for losses. Member-set rules, disclosures and approval mode answer that worry.

[Refine these with real quotes from your interviews.]

### 2.5 Competition

| Competitor | What it does | Our difference |
| --- | --- | --- |
| Manual trading (status quo) | Member reads the alert and types the order | Seconds, not minutes; rules enforced automatically |
| TradersPost, SignalStack | Webhook → broker automation for TradingView/strategy signals | Built for *human* callouts in chat; AI parses free text, no webhook setup |
| Collective2, eToro CopyTrader | Copy-trading marketplaces tied to their own platform/broker | Works with the communities people already belong to |
| Community-built bots | One-off scripts owned by a single group | Multi-tenant, per-member risk controls, audited, maintained |

**Competitive advantage:** a parse-once, fan-out architecture (low marginal cost per user), per-member risk controls as a first-class feature, and a distribution model where community owners sell the product for us.

### 2.6 SWOT

| **Strengths** | **Weaknesses** |
| --- | --- |
| Working, tested multi-user product already built · parse-once AI keeps cost per user low · strong risk controls and security design · founder can ship fast | Solo founder · no paying customers yet · prototype depends on unsanctioned Discord and broker access (§4.3) · single broker today |
| **Opportunities** | **Threats** |
| Rapid growth of retail options trading and paid alert communities · brokers opening AI-agent and trading APIs · community owners looking for retention tools · a white-label B2B tier | Securities regulation · platform policy changes (Discord, brokers) · a broker or incumbent (e.g. TradersPost) adding chat-alert parsing · reputational risk from member losses in a downturn |

---

## 3. Execution

### 3.1 Marketing & sales

- **Channel partners first.** Offer 2–3 community owners a free 60-day pilot for their members in exchange for feedback and a testimonial. Convert them to a revenue share (*assumption:* 20–30% of member subscriptions to the owner).
- **Proof through data.** Publish anonymized "time-to-fill" and "rule-adherence" stats from the pilot. Speed and discipline are measurable benefits.
- **MSU network.** Student investment clubs and Burgess events as a source of early testers (paper-trading or approval mode only).
- **Pricing (*to test*):** Member plan [$19–29/mo]; Pro plan with multiple brokers and advanced exits [$49/mo]; community white-label [$X/mo platform fee].

### 3.2 Operations

- **Tech stack (already built):** TypeScript/Fastify trading service, Python capture service, Supabase Postgres with row-level security, TanStack web dashboard, AI parsing with a choice of models (a local model or a cloud model).
- **Security:** broker tokens encrypted at rest (AES-256-GCM); default-deny database access with automated tests proving it; invite-only accounts with passwordless sign-in.
- **Hosting:** a single containerized service plus managed Postgres. Estimated [$50–150/month] at pilot scale (*assumption*).
- **Support:** Discord support channel within each partner community; founder-run during the pilot.

### 3.3 Milestones

| # | Milestone | Target date | Status |
| --- | --- | --- | --- |
| 1 | Working MVP: parser, risk engine, dashboard, approval mode | Aug 2026 | ✅ Done |
| 2 | Discovery business plan reviewed by Burgess | [Oct 2026] | In progress |
| 3 | Legal review: regulatory status + platform terms (Burgess Legal Intern) | [Oct 2026] | Planned |
| 4 | Move to sanctioned integrations: official Discord bot, broker API partnership or public-API broker | [Dec 2026] | Planned |
| 5 | Pilot with 2–3 partner communities (approval mode) | [Jan–Feb 2027] | Planned |
| 6 | First paying subscribers; apply to Burgess Launch | [Mar 2027] | Planned |
| 7 | 10 partner communities / 500 subscribers | [Dec 2027] | Target |

### 3.4 SMART objectives

1. **Compliance:** complete the legal review and have a written regulatory position before charging any customer, **by [Dec 31, 2026]**.
2. **Integrations:** replace the prototype's user-token capture with an official Discord bot, and connect at least one broker through sanctioned API access, **by [Jan 31, 2027]**.
3. **Pilot:** sign 3 partner communities and onboard 100 members in approval mode, **by [Feb 28, 2027]**.
4. **Quality:** reach ≥98% correct parses on the regression set of real alerts, with median alert-to-order time under 10 seconds, **during the pilot**.
5. **Revenue:** 150 paying members and at least 60% of pilot users converting to paid, **by [Jun 30, 2027]**.

### 3.5 Key metrics

Alert-to-order latency · parse accuracy (% callouts parsed correctly) · members per partner community · paid conversion from pilot · monthly churn · % of trades blocked by a member's own risk rules (a proxy for the discipline value).

---

## 4. Company

### 4.1 Overview

[CalloutPilot, to be organized as an LLC in Michigan. Timing and entity type to be decided with the Burgess Legal Intern.] Founded by [name] in 2026 at Michigan State University.

### 4.2 Team

- **[Your name] — Founder / engineer.** Designed and built the full platform (backend, AI parsing, risk engine, security model, dashboard). [Relevant background: major, trading experience, prior projects.]
- **Gaps to fill:** a compliance/legal advisor (securities), and a growth or partnerships lead with ties to trading communities. [A Burgess Entrepreneur-in-Residence mentor in fintech would be ideal.]

### 4.3 Key risks and how we'll address them

A funder will ask about these, so the plan addresses them directly.

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| **Securities regulation.** Automatically executing third-party trade signals in customer accounts may raise investment-adviser or broker questions. | Could require registration or restrict the model | Legal review first (Milestone 3). Design the product as member-configured software: the member chooses callers, sizing and mode, and we give no recommendations. Keep approval mode as the default. Document the regulatory position before charging anyone. |
| **Platform terms, Discord.** The prototype reads channels through a personal user account, which Discord's Terms of Service prohibit. | Account bans; no path to scale | Move to an official Discord bot that the community owner installs with consent. The business-to-community model makes this natural. |
| **Platform terms, broker.** The prototype connects to Robinhood's AI-agent (MCP) interface using another app's client identity, and each connection uses up the member's single agent slot. | Could be cut off at any time; not acceptable for a commercial product | Apply for sanctioned third-party access with Robinhood. In parallel, add brokers with public trading APIs (e.g. Alpaca, Tradier, Schwab) so the business never depends on one broker. |
| **Community content rights.** Alerts are the community owner's paid content. | Owners could object | Only operate in communities whose owner has signed a partner agreement. |
| **Trading losses / user harm.** Members may lose money copying callers. | Reputational and legal exposure | Clear risk disclosures, conservative defaults (approval mode, small sizing, follow-nobody), hard per-trade ceiling, max-loss exits, staleness guard, kill switch. |
| **AI mis-parse.** A wrong ticker or strike would be a costly error. | Direct financial harm | Confidence threshold, a regression test suite of real alert formats, approval mode during the pilot. |

---

## 5. Financial Plan

*All figures are planning assumptions to be refined with pilot data.*

### 5.1 Revenue assumptions

- Member subscription [$25/month]; 25% revenue share to the community owner, so **net ≈ $18.75/member/month**.
- Pilot communities average 1,000 members, with 5–10% adopting (*assumption, to validate*).

### 5.2 Three-year forecast (illustrative)

| | Year 1 | Year 2 | Year 3 |
| --- | --- | --- | --- |
| Partner communities (end of year) | 5 | 20 | 40 |
| Paying members (average) | 150 | 1,200 | 4,000 |
| Net revenue | $34k | $270k | $900k |
| AI parsing + hosting | $4k | $15k | $40k |
| Legal / compliance | $10k | $25k | $40k |
| Payment processing (~3%) | $1k | $11k | $36k |
| Marketing / partner incentives | $5k | $40k | $120k |
| Team (founder stipend, contractors) | $15k | $120k | $350k |
| **Operating result** | **≈ -$1k** | **≈ +$59k** | **≈ +$314k** |

Net revenue = average paying members × $18.75 × 12. The biggest cost advantage is that one AI parse serves every member, so gross margin stays high as users grow.

### 5.3 Use of funds (Burgess Launch request: [$X])

| Use | Share | Purpose |
| --- | --- | --- |
| Legal & regulatory review, entity formation, terms and disclosures | 35% | Unblocks everything else (Milestones 3–4) |
| Sanctioned integrations (Discord bot app review, broker API access, security review) | 25% | Replace the prototype's workarounds |
| Pilot costs (hosting, AI, partner incentives) | 25% | Milestone 5 |
| Customer research & marketing materials | 15% | Validation data, pitch deck, landing page |

### 5.4 Funding path

Burgess Launch funding → first revenue from pilot partners → a pre-seed round or fintech accelerator (after the regulatory position is documented) once there are 10+ partner communities.

### 5.5 Exit strategy

Likely acquirers are companies that gain directly from more automated retail order flow or from owning the alert-community channel: trading-automation platforms (e.g. TradersPost-type tools), brokers building agent/API ecosystems, and community-commerce platforms that host paid trading groups (e.g. Whop). An alternative is to keep growing as a profitable, cash-flowing B2B2C SaaS.

---

## Appendix

- **A. Product screenshots:** [dashboard feed, settings / risk controls, approval queue]
- **B. Architecture:** alert capture → database → parse once → per-member risk check → member's broker. The database is the only interface between capture and trading, so catch-up after downtime needs no special code.
- **C. Idea Validation worksheet:** [attach from Discovery Step 1]
- **D. Sample parsed alerts:** `BTO $QQQ 710p 06/08 0.97` → buy-to-open QQQ $710 put, exp 06/08, limit $0.97, size "risky/small".
