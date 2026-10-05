# Jev decides the Action; parser patterns supply the evidence, contract and size

The trade path used to hand each Message to an LLM (`LlmCalloutParser`) that
had to decide whether it was a trade, which way, and which contract, all in
one structured call. It cost money and seconds per message, dropped
past-tense exits ("Out of NBIS" lost a real position), and fired on watchlist
posts. We replaced the decision with hosted Jev, TypeSafe's System One
classifier (`api.typesafe.ai`, pinned to `jev-1.13.0`), behind
`DECISION_ENGINE=jev`.

Jev answers two narrow questions per message: which Action it announces
(Buy, Average, Trim, Sell, Info, None) and whether the caller is telling
followers to trade now. The parser's deterministic templates never decide; they
pass what they saw as a `pattern_match` hint (read, template, contract, flags,
no confidence) and Jev treats it as evidence. Code then applies the rules:
Average, Info and None never trade; the act-now check gates free-form Buys
only, never a fixed entry template; probability 0.8 and up trades, 0.6 to 0.8
waits for approval in every execution mode, below 0.6 is ignored. The contract
and the exit size always come from the patterns and the caller's own words,
never from Jev; a Buy without a readable options contract is skipped, and an
exit without one takes the Caller's replied-to card, else their one live
entry (several go to approval, none is skipped quietly).

We chose this after read-only tests on Oct 4, 2026 against 226 hand-labeled
messages and 1,739 database messages (Sep 5 – Oct 4): no rewording of the
questions beat the original, and the adopted set (the original wording plus a
note that "Avg. 1.20" after a contract is an entry price, the hints, and the
template exemption from act-now) reached 85.4% labeled accuracy against 81.9%,
with 0 wrong entries, 61 of 70 exits, and 22 of 24 entries the earlier version
missed from followed callers. Those numbers are in-sample: the templates were
written while reading the same messages.

## Consequences

- Rollback is one setting: `DECISION_ENGINE=parser` restores the LLM parser.
  OpenAI stays configured for it and for recap insights.
- Jev is a network dependency with a 1.5 s budget per message. A failure or
  timeout records the message `failed` and every user sees `parse_failed`;
  there is no LLM fallback in the trade path.
- Jev is not fully repeatable: about 2% of messages change direction between
  identical runs, mostly below the 0.6 cutoff.
- Before each deploy, `bun src/scripts/actionDemo.ts decide` replays the
  production decider over the labeled set and a messages export and checks
  the ship bars (about 85% accuracy, at most 1 wrong entry, at least 60 of 70
  exits, at least 20 of the 24 followed missed entries, no averaging post
  traded, Bishop's exits back as Sell). `--since` lists every disagreement with
  the parser on messages the templates were never written against.
- Known gaps, accepted: Rowdy's "Added <contract> @ <price>" entries still
  come back Average; a plan post with a contract and price can pass the
  act-now check; a dateless contract ("RENENTERED NVDA 227.5C") never trades.
- New caller formats need a template, or Jev decides them from the words
  alone. Jev's answers may not be used to train another model (TypeSafe MCA).
