# Spec: Caller Following

Status: ready-for-agent
Produced by: grilling session, 2026-07-29 (see `CONTEXT.md` for glossary — Caller, Callout, Following)

## Problem Statement

Every user of the copy-trader currently trades on every Callout from every allowlisted Discord author. Users have no way to choose *whose* callouts they act on — the only filter is a global, operator-owned env allowlist that requires a redeploy to change and applies to everyone at once. Users also have no visual way to recognize who a Caller is: the system stores a bare display name and nothing else.

## Solution

Introduce **Following**: a per-user selection of which Callers to copy-trade, edited in the settings page as a row of clickable circular Discord profile pictures. Ingestion stays global and operator-gated; every callout is parsed once and stored once, exactly as today. At per-user fan-out, the trader only places trades for Callers the user follows. The dashboard feed receives all callouts and filters what is *displayed* to the user's Following list. By default a user follows everyone — including Callers added later — until they deselect someone.

## User Stories

1. As a user, I want to see every Caller as a circular Discord profile picture with their name in my settings, so that I can recognize who I'm choosing at a glance.
2. As a user, I want to click a Caller's circle to toggle whether I follow them, so that opting in and out takes one click.
3. As a user, I want followed and unfollowed Callers to look unmistakably different (full color + ring vs grayscale + dimmed), so that I can audit my selection at a glance.
4. As a user, I want to follow everyone by default, so that my trading behavior doesn't change when this feature ships.
5. As a new user, I want all Callers pre-selected on first visit, so that I start receiving trades without configuration.
6. As a user, I want trades to never be placed from a Caller I've deselected, so that my money only follows people I've chosen.
7. As a user, I want my Following choice enforced on the server, so that it applies even when my dashboard is closed and I'm asleep.
8. As a user, I want a "Clear all" action, so that I can stop all copy-trading in one click without disconnecting my broker.
9. As a user, I want a "Select all" action, so that I can return to following everyone — including future Callers — in one click.
10. As a user, I want a status line telling me whether I follow everyone (including future Callers) or an explicit subset ("Following 4 of 7"), so that I understand what happens when a new Caller is added.
11. As a user, I want my Following list saved with the same Save button as my other trade settings, so that settings behave consistently.
12. As a user, I want my feed to show callouts filtered to my followed Callers, so that my feed reflects my selection.
13. As a user, I want a Caller's name and picture to stay current when they change their Discord profile, so that the picker never shows stale identities.
14. As a user, I want Callers without a custom Discord avatar to still show a picture (Discord's default avatar), so that every circle renders an image.
15. As a user with an explicit Following list, I want newly allowlisted Callers to start unfollowed for me, so that my curated selection is never silently expanded.
16. As a user still on defaults, I want newly allowlisted Callers followed automatically, so that I keep receiving everything the operator admits.
17. As the operator, I want ingestion to stay gated by the env allowlists, so that widening or narrowing the global set remains a deliberate deployment decision.
18. As the operator, I want a new Caller to appear in every user's picker automatically after their first ingested message, so that no manual roster maintenance is needed.
19. As the operator, I want the current allowlisted author IDs seeded into the roster with names and avatars before launch, so that the picker is not empty on day one.

## Implementation Decisions

- **Unit of filtering is the Discord author ID (a Caller).** Channels are not part of per-user filtering; the channel env allowlist keeps its existing ingestion-gate role.
- **Ingestion is unchanged and global**: one parse, one stored callout, gated by the existing env allowlists (`DISCORD_ALLOWED_AUTHOR_IDS` / `DISCORD_ALLOWED_CHANNEL_IDS`). The operator widens the gate deliberately; no client-editable or admin-editable ingest configuration is built.
- **Settings field**: `followedCallerIds: string[] | null` added to the trade settings schema, riding the existing per-user settings jsonb payload and the existing settings API. Semantics: `null` (default) = follow every Caller including future ones; `[]` = follow no one; a non-empty list = follow exactly those IDs. The first deselect materializes `null` into an explicit list client-side.
- **Trade gate is server-side** in the per-user pipeline run: if the callout's author ID is not followed, the run returns early — before risk checks — writing no per-user record (silent skip). Display filtering is never a substitute for this gate.
- **Feed is not filtered server-side.** All callouts (and SSE events) are delivered to every authenticated client; the dashboard filters what's displayed using the Following list it already has from the settings query.
- **New `callers` table**: one row per Caller — author ID (PK), display name, avatar URL, last-seen timestamp. Upserted on every ingested callout from envelope data; seeded once via a one-time script calling Discord REST (`GET /users/{id}`, bot token) for the currently allowlisted author IDs.
- **Envelope and callout gain author identity**: the bot's envelope adds the author's avatar (hash or resolved CDN URL); the stored callout keeps the author ID instead of dropping it. Avatars are plain public CDN URLs (`cdn.discordapp.com/avatars/{id}/{hash}.png`), rendered directly in `<img>` tags; users without a custom avatar fall back to Discord's default-avatar CDN URL derived from the ID. Webhook/bot posters with per-message identities are handled naturally by upsert-at-ingest (roster reflects their most recent post).
- **Roster API**: a new authenticated read endpoint serving the `callers` table to the client.
- **UI**: a "Callers" section at the top of the existing settings form (above Execution), using the existing form-section components and Tailwind token classes. Wrapped row of ~56px circular avatar tiles, name beneath; click anywhere on the tile toggles. Followed = full color, brand ring, check badge; unfollowed = grayscale, reduced opacity, muted name. Header status line + "Select all" (→ `null`) and "Clear all" (→ `[]`) text buttons.

## Testing Decisions

- Tests assert external behavior only: envelopes in, trades/DB writes out — never internal call order.
- **Primary seam (existing): the message processor** driven with fake deps, as in the existing pipeline tests and fake DB harness. Cases: `null` Following → trade path proceeds; explicit list excluding the author → no trade and no per-user record; `[]` → no trades for any Caller; ingest upserts the `callers` row (insert on first sight, update of name/avatar/last-seen on later sight).
- **Route seam (existing): the trader HTTP tests** for the new roster endpoint — authenticated read returns seeded/upserted rows; unauthenticated is rejected like every other private route.
- **Schema seam**: settings schema parse tests for the three Following shapes (`absent → null`, `[]`, non-empty list) alongside the existing defaults tests.
- Client picker logic (null-materialization on first deselect) is covered by keeping it a pure function if client tests are added; no client test framework exists today, so it is not a gate.

## Out of Scope

- Inverse/fade trading (per-Caller copy/ignore/fade stances). Explicitly discussed and deferred; the boolean model was chosen deliberately.
- Admin or client-editable ingestion gate (moving the env allowlists into the DB with an `ingest_enabled` flag). Possible later; nothing in this feature depends on it.
- Per-channel per-user filtering.
- Per-user audit records for skipped unfollowed callouts (`skipped_unfollowed` outcome rows).
- Server-side feed filtering, "show hidden Callers" feed toggle, and any feed UI changes beyond client-side display filtering.

## Further Notes

- **Known interaction, accepted**: widening the env author allowlist auto-follows the new Caller for every user still on `null` defaults. The operator's discipline is to only allowlist authors they'd vouch for a defaults user auto-copying. Users with explicit lists are unaffected.
- Existing `DISCORD_ALLOWED_AUTHOR_IDS` behavior (empty = allow everyone) is unchanged and remains the global gate; Following filters within what the gate admits.
- Pending approvals created before an unfollow are left untouched; the gate applies from the next callout onward, consistent with how all settings changes apply.
