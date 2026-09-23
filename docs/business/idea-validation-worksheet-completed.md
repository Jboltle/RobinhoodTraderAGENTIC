# Idea Validation Worksheet — Completed

**Venture:** [CalloutPilot] (working name) · **Founder:** [Your name], Michigan State University · **Date:** September 2026
*Burgess Institute Discovery Program, Step 1 · Answered with Claude (Anthropic), as the worksheet instructs*

---

## 1. The Idea, In One Line

**My idea:** Software that turns trade alerts posted in paid Discord trading communities into sized, risk-checked orders in each member's own brokerage account within seconds, following rules the member sets in advance, and sold through the community owners themselves.

---

## 2. Problem Validation

**What problem is this actually solving? Is it real and painful enough that people would pay to fix it?**
Members of trade-alert communities pay a monthly fee for alerts ("BTO SPY 755C 0DTE $0.71"), but acting on one means seeing the notification, opening a brokerage app, typing the order and sizing it. On short-dated options that delay can wipe out the edge the member is paying for. The second pain is discipline: people break their own sizing and daily-limit rules in the moment. The pain is real, and these people already pay for alerts, so willingness to pay is demonstrated. The open question is whether they'll pay *extra* on top of the alert subscription. That is the thing to test.

**Who exactly has this problem? Describe one specific, real person.**
[Replace with a real person you interviewed.] Example profile: a 21-year-old MSU student who pays about $50/month for an options alert Discord. Most alerts land while he's in class. When he does catch one, he enters 30–60 seconds late at a worse price, and he admits to oversizing "when a call feels hot." He has a written rule of 2% per trade and breaks it about once a week.

**What are people doing today to solve this without my product? Why might that already be good enough?**
- Phone notifications and fast manual entry. This is free, and some people say being in the loop is part of the fun.
- Resting limit orders at the caller's price, after the fact.
- Webhook automation tools (TradersPost, SignalStack). These need the caller to publish structured signals, which most human callers don't.
- Skipping alerts they miss.

*Why that might be good enough:* for swing trades (entries held for days), a 60-second delay barely matters. The pain concentrates in fast, short-dated options alerts. That's a narrower but more intense segment.

---

## 3. Market Reality Check

**Is this market growing, shrinking, or flat? What evidence tells me that?**
It's growing, but confirm with MSU databases (Step 2). Points to verify and cite:
- Retail options activity has grown sharply since 2020, and zero-days-to-expiration (0DTE) options have become a large share of S&P 500 index options volume, according to Cboe's public reporting.
- Commission-free brokers (Robinhood, Webull, etc.) grew their funded accounts through the early 2020s.
- Paid trading communities are a visible category on Discord and on creator-commerce platforms such as Whop.
- Brokers are opening agent and trading APIs (Robinhood's AI-agent trading interface, Alpaca, Tradier, Schwab), which makes this product buildable at all.

*Caveat:* retail trading activity is cyclical. It spikes in bull markets and fades in downturns, so demand will swing with the market.

**Who are the existing players — direct and indirect? Why hasn't one of them solved this already?**
- *Direct / adjacent:* TradersPost and SignalStack (signal-to-broker automation), Collective2 (strategy copy-trading), eToro CopyTrader (copy-trading inside eToro's own broker).
- *Indirect:* the brokers' own alert and notification features; bots that individual communities build for themselves.

*Why the gap exists:* (1) the alerts are free text from humans, not structured signals, and reliable parsing only became cheap with modern LLMs. (2) Discord communities are closed spaces; the operator has to opt in. (3) Regulation and liability make established players cautious about automatically executing third-party alerts in customers' accounts.

**What would have to be true about this market for my idea to become a real business?**
1. Community owners want this as a paid perk and will promote it to their members.
2. At least 5–10% of a community's members will pay about $20–30/month on top of their alert subscription.
3. Automated execution of member-configured alerts can operate legally without investment-adviser registration, or with a manageable compliance path.
4. At least one broker gives sanctioned API access for this use.

---

## 4. Stress-Test the Idea (blunt)

**What are the three most likely reasons this idea fails?**
1. **Regulatory or platform shutdown.** Automatically executing third-party trade signals in customer accounts may draw securities-regulation scrutiny. The current prototype also relies on access that platform terms don't permit: it reads Discord through a personal user account (against Discord's Terms of Service) and connects to Robinhood under another app's identity. If this isn't fixed first, the business can be switched off overnight.
2. **Members lose money and blame the product.** Most short-dated options traders lose money. Automation makes them faster, not profitable, and a bad month creates churn, refund demands and reputational damage for both us and the partner community.
3. **Willingness to pay is lower than it looks.** Members already pay for alerts. Some owners may see automation as a threat ("members will just copy and leave") rather than a perk.

**If a skeptical investor heard this idea for 30 seconds, what's their first objection?**
"Isn't this unregistered investment advice or a broker activity? And what happens to you when Discord or Robinhood cuts off your access?" A close second: "You're making it easier for retail traders to lose money faster."

**What's the riskiest assumption this depends on?**
That there is a **legal and sanctioned path** to automatically execute community alerts in members' own accounts. That covers securities law *and* official Discord and broker access. If the answer is no, the product shrinks to "approval-mode order tickets," which is a much weaker value proposition.

---

## 5. Business Model

**What are 2–3 plausible ways this idea could make money? What are the tradeoffs of each?**

| Model | How it works | Pros | Cons |
| --- | --- | --- | --- |
| **B2B2C revenue share** (preferred) | Members pay about $25/month; the community owner gets 20–30% | Owner does distribution; trust built in; consent solves platform-access issues | Depends on owner partnerships; revenue share cuts margin |
| **Direct-to-consumer subscription** | Traders sign up themselves and connect communities they belong to | Higher margin; no partner needed | Expensive customer acquisition; can't read a community without the owner's consent |
| **White-label platform fee** | Community owner pays a flat monthly fee and sells it under their own brand | Predictable revenue; fewer end-user support issues | Smaller market; owner carries customer relationship |

**Does this need to be a standalone business, or could it be a feature of something that already exists?**
Honestly, it *could* be a feature. A broker, a signal-automation tool like TradersPost, or a community platform like Whop could add it. The case for building it standalone is to get there first, prove parsing accuracy and per-member risk controls, and own the community-owner relationships. A realistic outcome is being acquired by one of those companies (see the business plan's exit strategy).

---

## 6. Cheapest Way to Test It

**What's the fastest, cheapest way to find out if anyone actually wants this — before writing a full plan?**
1. **Ten to fifteen interviews** with alert-community members and three to five community owners (MSU trading and investment clubs, the Discords you already belong to).
2. **Concierge / approval-mode pilot.** The working prototype already runs in approval mode, where every trade needs one tap to confirm. Run it with 5–10 volunteers on *paper or small accounts* in a community whose owner has agreed. Measure time-to-order and whether they keep using it after two weeks.
3. **Landing page with a pre-order or waitlist** at $25/month, shared by one partner owner. Measure sign-ups per 100 members who see it.

**What should I ask potential customers, and what answers would tell me to stop or keep going?**

*Members:* How many alerts did you miss last week? What did the last late entry cost you? Have you broken your own sizing rules? Would you let software place trades you pre-approved, and what would make you trust it? Would you pay $25/month on top of your alerts?

*Owners:* What's your monthly churn? Why do members leave? Would you offer this as a perk, and would a revenue share interest you? What would worry you?

- **Keep going if:** at least 60% of members name speed or discipline as a top-3 pain, at least 30% say they'd pay, and at least 2 owners agree to a pilot.
- **Stop or pivot if:** members mainly trade swings (speed doesn't matter), no owner will partner, or a legal review finds no workable path for automatic execution.

---

## 7. Go / No-Go

**Honest one-paragraph gut-check:**
The problem is real and concentrated: fast options-alert communities where speed and discipline directly cost people money. There's a working, well-tested prototype, which is further than most Discovery ideas get. But it is **not ready to be a business in its current form.** The prototype depends on platform access that Discord's and the broker's terms don't permit, and the regulatory position on automatically executing third-party alerts is unknown. Either issue alone could end the company. The idea is worth a full business plan **only** if the plan is built around the version that can operate legitimately: a community-owner-installed Discord bot, sanctioned broker APIs, member-configured rules, approval mode by default, and a legal review before any revenue.

**My decision:** **GO, with changes.** [Founder to confirm.]

**What needs to change (if anything):**
1. Legal review of the regulatory status of automatic execution (Burgess Legal Intern, Step 5) before charging anyone.
2. Replace the personal-account Discord capture with an official bot installed by partner community owners.
3. Get sanctioned broker access: apply to Robinhood for partner access, and add brokers with public APIs.
4. Validate willingness to pay with 10–15 member interviews, 3–5 owner interviews and an approval-mode pilot, and put the results into the business plan.
