import { flattenEnvelope } from '../../shared/embedText.js';
import { createLogger } from '../../shared/logger.js';
import {
  optionLabel,
  type Callout,
  type CalloutParser,
  type Decision,
  type DiscordEnvelope,
  type OptionContract,
  type ResolvedTradeSettings,
  type SubmittedOrder,
} from '../../shared/types.js';
import type { MessageDisposition, TraderDb } from '../db.js';
import type { TraderEvents } from '../events.js';
import { BrokerUnavailableError } from '../rh/mcpClient.js';
import type { McpRegistry } from '../rh/mcpRegistry.js';
import { SymbolNotFoundError } from '../rh/tools.js';
import {
  CapitalConstraintError,
  ParseInconsistencyError,
  sizeEquityOrder,
  sizeOptionsOrder,
  submitOrder,
} from './execute.js';
import { checkRisk, deriveRiskState } from './riskFilter.js';
import { summarize, summarizePendingApproval } from './summarize.js';

const log = createLogger('trader:pipeline');

// Options language in message text: "call(s)"/"put(s)" words or strike+C/P
// notation ("397.5c", "365 C"). Used to veto equity parses of option messages.
const OPTION_CONTEXT = /\bcalls?\b|\bputs?\b|\b\d+(?:\.\d+)?\s?[cp]\b/i;

export interface PipelineDeps {
  readonly parser: CalloutParser;
  readonly db: TraderDb;
  readonly events: TraderEvents;
  readonly brokers: McpRegistry;
}

export interface ProcessOptions {
  /**
   * Seen too late to trade (the poller's staleness gate). The message is
   * recorded as missed and shown in every user's feed, but no order is ever
   * placed and the LLM is never called.
   */
  readonly missed?: boolean;
}

export interface MessageProcessor {
  process(envelope: DiscordEnvelope, options?: ProcessOptions): Promise<void>;
  /** Serialize work on one user's Robinhood session (callouts and Max Loss). */
  enqueue<T>(userId: string, run: () => Promise<T>): Promise<T>;
}

/**
 * Turns one Discord message into one outcome per connected user.
 *
 * The LLM parse happens once and is cached on the shared `callouts` row, so
 * adding users costs no extra tokens. Users then run CONCURRENTLY: they hold
 * separate Robinhood sessions, so the old single-session serialization buys
 * nothing, and one user's slow broker call must not delay everyone else's fill
 * on a time-sensitive callout. Each user's own messages stay serialized
 * through a per-user chain, preserving the "never two orders in flight on one
 * session" guarantee, and a failure is isolated to the user it happened to.
 */
export function createMessageProcessor(deps: PipelineDeps): MessageProcessor {
  // ponytail: unbounded map of settled promises, one entry per user seen this
  // process lifetime. Upgrade path is dropping the entry once its chain idles.
  const chains = new Map<string, Promise<unknown>>();

  const queueForUser = <T>(userId: string, run: () => Promise<T>): Promise<T> => {
    const chain = (chains.get(userId) ?? Promise.resolve()).then(run, run);
    chains.set(userId, chain);
    return chain as Promise<T>;
  };

  return {
    enqueue: queueForUser,
    async process(rawEnvelope: DiscordEnvelope, options: ProcessOptions = {}): Promise<void> {
      // The one flatten site on the trade path: producers send raw content +
      // embeds (envelope contract in shared/types.ts). Everything downstream
      // — parser, option-context guard, stored feed content — reads the
      // flattened text; `embeds` stay raw for storage/display.
      const envelope = flattenEnvelope(rawEnvelope);

      const userIds = await deps.db.listBrokerUserIds();
      for (const userId of userIds) {
        deps.events.emitStage(userId, {
          messageId: envelope.messageId,
          ticker: null,
          stage: 'received',
        });
      }

      // Roster upsert at ingest, once globally: the Caller's identity rides
      // every envelope, so the picker stays current without maintenance.
      await deps.db
        .upsertCaller({
          authorId: envelope.authorId,
          displayName: envelope.authorName,
          avatarUrl: envelope.authorAvatarUrl,
          lastSeenAt: envelope.timestamp,
        })
        .catch((err: unknown) =>
          log.warn('could not upsert caller', { authorId: envelope.authorId, error: errMsg(err) })
        );

      const parsed = await resolveCallout(envelope, deps, options);

      // Channel chatter: the outcome is identical for everyone and is already
      // recorded on the shared callouts row, so there is nothing to fan out
      // and no reason to write the same "not a callout" to N trade rows.
      if (parsed.status === 'not_callout') {
        for (const userId of userIds) {
          deps.events.emitStage(userId, {
            messageId: envelope.messageId,
            ticker: null,
            stage: 'done',
          });
        }
        return;
      }

      const settled = await Promise.allSettled(
        userIds.map((userId) =>
          queueForUser(userId, () => runForUser(userId, envelope, parsed, deps))
        )
      );

      for (const [index, result] of settled.entries()) {
        if (result.status === 'rejected') {
          log.error('user pipeline crashed', {
            userId: userIds[index],
            messageId: envelope.messageId,
            error: errMsg(result.reason),
          });
        }
      }
    },
  };
}

// =============================================================================
// Parse — once per Discord message, the verdict recorded on the messages row
// =============================================================================

type ParseStatus = Exclude<MessageDisposition, 'recap'>;

interface ParsedCallout {
  readonly status: ParseStatus;
  /** Only ever set when status is 'callout' — see the messages table constraint. */
  readonly callout: Callout | null;
  /** Set when the LLM itself failed, as opposed to producing a non-callout. */
  readonly parseError: string | null;
}

/**
 * Judge the message and stamp its disposition. No cache read: the poller only
 * feeds unprocessed rows, and its disposition guard handles crash replays, so
 * a message reaches this function at most once per verdict. 'failed' is
 * terminal — retry is an operator action (reset processed_at on the row).
 */
async function resolveCallout(
  envelope: DiscordEnvelope,
  deps: PipelineDeps,
  options: ProcessOptions
): Promise<ParsedCallout> {
  if (options.missed) {
    await setDisposition(deps, envelope.messageId, 'missed');
    return { status: 'missed', callout: null, parseError: null };
  }

  let callout: Callout;
  try {
    callout = await deps.parser.parse(envelope);
  } catch (err) {
    await setDisposition(deps, envelope.messageId, 'failed');
    return { status: 'failed', callout: null, parseError: errMsg(err) };
  }

  if (!callout.isCallout) {
    // The parse is dropped on purpose: a row only retains one when it
    // describes a trade, and nothing downstream reads a non-callout parse.
    await setDisposition(deps, envelope.messageId, 'not_callout');
    return { status: 'not_callout', callout: null, parseError: null };
  }

  // A sell that names no contract: "out of NBIS", or a Jev Trim/Sell.
  if (callout.action === 'sell' && callout.option === null && (callout.engine === 'jev' || callout.tickerOnlyExit)) {
    callout = await resolveCallerContract(callout, envelope, deps);
  }

  // Options only on the Jev path: a trade still without a contract is skipped
  // here, quietly, before anyone's trade row is written.
  if (callout.engine === 'jev' && callout.option === null) {
    log.info('jev trade has no options contract; skipped', {
      messageId: envelope.messageId,
      ticker: callout.ticker,
      rationale: callout.rationale,
    });
    await setDisposition(deps, envelope.messageId, 'not_callout');
    return { status: 'not_callout', callout: null, parseError: null };
  }

  await setDisposition(deps, envelope.messageId, 'callout', callout);
  return { status: 'callout', callout, parseError: null };
}

/** Recent entries a contract-less exit may be closing; far more than one Caller holds at once. */
const CALLER_ENTRY_LOOKBACK = 20;

/**
 * An exit that names no contract can only mean the Caller's own position,
 * never another Caller's entry that followers also hold. In order: the
 * Caller's card the exit replies to, then the Caller's one live entry in the
 * ticker; several live entries pick the newest and wait for approval. With
 * none, option stays null: the Jev path skips the message, and the parser path
 * rejects it per user as missing_contract — a visible miss, never a guess.
 */
async function resolveCallerContract(
  callout: Callout,
  envelope: DiscordEnvelope,
  deps: PipelineDeps
): Promise<Callout> {
  const card = await replyCard(envelope, deps);
  if (card && (callout.ticker === null || card.ticker === callout.ticker)) {
    return withContract(callout, card.ticker, card.option, 'the card it replies to');
  }
  const { ticker } = callout;
  if (ticker === null) return callout;

  const entries = await deps.db
    .listCallerEntries(envelope.authorId, ticker, new Date(envelope.timestamp), CALLER_ENTRY_LOOKBACK)
    .catch((err: unknown) => {
      log.error('could not load caller entries for a contract-less exit', {
        messageId: envelope.messageId,
        error: errMsg(err),
      });
      return [];
    });

  const live = liveCallerContracts(entries, envelope.timestamp);
  const [newest] = live;
  if (!newest) {
    log.warn('contract-less exit matched no open entry from its caller', {
      messageId: envelope.messageId,
      authorId: envelope.authorId,
      ticker,
    });
    return callout;
  }

  const resolved = withContract(callout, ticker, newest, `${envelope.authorName}'s entry`);
  if (live.length === 1) return resolved;
  const several = `${envelope.authorName} has ${live.length} open ${ticker} entries; picked the newest, ${optionLabel(newest)}`;
  return { ...resolved, reviewReason: [callout.reviewReason, several].filter(Boolean).join('; ') };
}

/** The Caller's own card this message replies to, when it names a contract. */
async function replyCard(
  envelope: DiscordEnvelope,
  deps: PipelineDeps
): Promise<{ ticker: string; option: OptionContract } | null> {
  if (!envelope.replyToMessageId) return null;
  const card = await deps.db.getMessageParse(envelope.replyToMessageId).catch((err: unknown) => {
    log.error('could not load the replied-to card', { messageId: envelope.messageId, error: errMsg(err) });
    return null;
  });
  if (!card || card.authorId !== envelope.authorId) return null;
  const { ticker, option } = card.parse;
  return ticker && option ? { ticker, option } : null;
}

function withContract(callout: Callout, ticker: string, option: OptionContract, source: string): Callout {
  return {
    ...callout,
    ticker,
    assetType: 'option',
    option,
    rationale: `${callout.rationale} (contract ${optionLabel(option)} from ${source})`,
  };
}

/**
 * The distinct contracts of the Caller's entries still live on the exit's
 * day, newest first. `entries` arrive newest first. Once the Caller has Jev
 * entries in the ticker only those count, so a watchlist post the old parser
 * stored as a buy no longer competes; until then the parser's own entries
 * (adds excluded) carry positions opened before the switch.
 *
 * ponytail: an entry the Caller already sold in full still counts until it
 * expires, which at worst sends an exit to approval. Upgrade path: subtract
 * the Caller's full Sells.
 */
export function liveCallerContracts(entries: readonly Callout[], exitTimestamp: string): OptionContract[] {
  const exitDay = new Date(exitTimestamp).toISOString().slice(0, 10);
  const jevEntries = entries.filter((entry) => entry.engine === 'jev');
  const pool = jevEntries.length > 0 ? jevEntries : entries.filter((entry) => !entry.isAddition);
  const live = new Map<string, OptionContract>();
  for (const { option } of pool) {
    if (option && option.expiration >= exitDay && !live.has(optionLabel(option))) live.set(optionLabel(option), option);
  }
  return [...live.values()];
}

async function setDisposition(
  deps: PipelineDeps,
  messageId: string,
  disposition: MessageDisposition,
  parse: Callout | null = null
): Promise<void> {
  // A failed write costs the recorded verdict and the feed entry, not the trade.
  await deps.db.setMessageDisposition(messageId, disposition, parse).catch((err: unknown) => {
    log.error('could not persist disposition', {
      messageId,
      disposition,
      error: errMsg(err),
    });
  });
}

// =============================================================================
// Per-user execution
// =============================================================================

/**
 * One user's run against an already-parsed callout:
 *  0. Following gate → a Caller this user does not follow produces nothing
 *     for them: no trade, no per-user record (silent skip, returns null)
 *  1. Risk check → deterministic guards + portfolio-percentage sizing, against
 *     this user's settings and their trade history
 *  2. Fetch buying power (always — needed for capital validation even when qty is explicit)
 *  3. Submit → place the equity or options order via this user's Robinhood MCP
 */
export async function runForUser(
  userId: string,
  envelope: DiscordEnvelope,
  parsed: ParsedCallout,
  deps: PipelineDeps
): Promise<Decision | null> {
  const at = new Date().toISOString();
  const base = { at, messageId: envelope.messageId, order: null };
  const { callout } = parsed;

  // ponytail: a settings DB failure here also drops missed/parser_error records
  // (they write to the same DB, so a fallback rarely helps); upgrade path is to
  // catch it and fall back to record-only default paths — never trade on defaults.
  const settings = await loadSettings(userId, deps);

  // ---- 0. Following gate ---------------------------------------------------
  // null = follow everyone (default); otherwise the list is exhaustive.
  if (settings.followedCallerIds !== null && !settings.followedCallerIds.includes(envelope.authorId)) {
    deps.events.emitStage(userId, {
      messageId: envelope.messageId,
      ticker: null,
      stage: 'done',
    });
    return null;
  }

  if (parsed.status === 'missed') {
    return finalize(userId, deps, {
      ...base,
      kind: 'missed',
      code: null,
      reason: 'callout was already stale when the trader woke up — not executed',
      ticker: null,
      action: null,
    });
  }

  if (!callout) {
    return finalize(userId, deps, {
      ...base,
      kind: 'parser_error',
      code: 'parse_failed',
      reason: parsed.parseError ?? 'callout could not be parsed',
      ticker: null,
      action: null,
    });
  }

  const identity = { ticker: callout.ticker, action: callout.action };

  // Guardrail: a message full of options language must never execute as an
  // equity trade — the "limit price" is almost certainly an option premium
  // (e.g. buying AAPL stock at $7.70 from "aapl calls 3.38 to 7.70").
  if (callout.assetType === 'equity' && OPTION_CONTEXT.test(envelope.content)) {
    return finalize(userId, deps, {
      ...base,
      ...identity,
      kind: 'risk_rejected',
      code: 'parse_inconsistent',
      reason:
        'message mentions options (calls/puts/strike notation) but parse says equity — refusing to trade on an inconsistent parse',
    });
  }

  // ---- 1. Risk check ------------------------------------------------------
  deps.events.emitStage(userId, {
    messageId: envelope.messageId,
    ticker: callout.ticker,
    stage: 'risk_check',
  });
  const state = await deriveRiskState(deps.db, userId, callout.ticker);
  const risk = checkRisk(callout, settings, state);
  if (!risk.allow) {
    return finalize(userId, deps, {
      ...base,
      ...identity,
      kind: 'risk_rejected',
      code: risk.code,
      reason: risk.reason,
    });
  }

  const symbol = callout.ticker!.toUpperCase();
  const side = callout.action!;
  const tools = deps.brokers.for(userId).tools;

  // Confirm Robinhood can quote the underlying before sizing or looking up
  // option instruments. Garbage tickers (e.g. ANSI-glued MTSLA) fail here
  // instead of after three empty get_option_instruments retries.
  try {
    const quote = await tools.getQuote(symbol);
    if (!(quote.price > 0)) {
      return finalize(userId, deps, {
        ...base,
        ...identity,
        kind: 'risk_rejected',
        code: 'ticker_invalid',
        reason: `${symbol} has no tradable Robinhood quote`,
      });
    }
  } catch (err) {
    // Only a broker that answered can call the ticker invalid. A session that
    // is down or a transport failure says nothing about the symbol.
    if (err instanceof SymbolNotFoundError) {
      return finalize(userId, deps, {
        ...base,
        ...identity,
        kind: 'risk_rejected',
        code: 'ticker_invalid',
        reason: `${symbol} is not a tradable Robinhood symbol: ${errMsg(err)}`,
      });
    }
    return finalize(userId, deps, {
      ...base,
      ...identity,
      kind: 'execution_failed',
      code: brokerErrorCode(err),
      reason: `quote fetch for ${symbol} failed: ${errMsg(err)}`,
    });
  }

  deps.events.emitStage(userId, {
    messageId: envelope.messageId,
    ticker: symbol,
    stage: 'executing',
  });

  // ---- 2. Fetch buying power ----------------------------------------------
  // Entries need capital validation. Option exits are sized from current
  // option holdings, so they should still work when cash is zero or unavailable.
  const needsBuyingPower = !(risk.assetType === 'option' && side === 'sell');
  let buyingPower = 0;
  if (needsBuyingPower) {
    try {
      const bp = await tools.getBuyingPower();
      buyingPower = bp.amountUsd;
    } catch (err) {
      return finalize(userId, deps, {
        ...base,
        ...identity,
        kind: 'execution_failed',
        code: brokerErrorCode(err),
        reason: `buying power fetch failed: ${errMsg(err)}`,
      });
    }

    if (buyingPower <= 0) {
      return finalize(userId, deps, {
        ...base,
        ...identity,
        kind: 'risk_rejected',
        code: 'insufficient_capital',
        reason: 'buying power is zero — no capital available',
      });
    }
  }

  // ---- 3. Size, then submit ------------------------------------------------
  // Sizing runs in both modes: it only reads from the broker, and a parked
  // trade that cannot say how many shares it is worth is not something anyone
  // can meaningfully approve.
  try {
    const quantity =
      risk.assetType === 'option'
        ? await sizeOptionsOrder(symbol, side, risk, callout, buyingPower, tools)
        : await sizeEquityOrder(symbol, side, risk, callout, buyingPower, tools);

    const sized: SubmittedOrder = {
      symbol,
      side,
      assetType: risk.assetType,
      quantity,
      orderType: risk.orderType,
      limitPrice: risk.limitPrice,
      option: risk.assetType === 'option' ? callout.option : null,
      orderId: null,
      status: null,
    };

    // Approval is the last gate: everything above has already passed, and the
    // row carries the sized order so the dashboard can show what is at stake.
    // A review reason (Jev unsure, or an ambiguous contract) parks the trade
    // even for accounts that otherwise trade immediately.
    if (settings.executionMode === 'approval' || callout.reviewReason) {
      const receipt = summarizePendingApproval(sized);
      return finalize(userId, deps, {
        ...base,
        ...identity,
        kind: 'pending_approval',
        code: null,
        reason: callout.reviewReason ? `${callout.reviewReason}. ${receipt}` : receipt,
        order: sized,
      });
    }

    const placed = await submitOrder(sized, tools);
    const order: SubmittedOrder = {
      ...sized,
      orderId: placed.orderId,
      status: placed.status ?? 'submitted',
    };

    return finalize(userId, deps, {
      at,
      messageId: envelope.messageId,
      ...identity,
      kind: 'submitted',
      code: null,
      reason: summarize(order, envelope.authorName),
      order,
    });
  } catch (err) {
    const capital = err instanceof CapitalConstraintError;
    const inconsistent = err instanceof ParseInconsistencyError;
    return finalize(userId, deps, {
      ...base,
      ...identity,
      kind: capital || inconsistent ? 'risk_rejected' : 'execution_failed',
      code: capital
        ? 'insufficient_capital'
        : inconsistent
          ? 'parse_inconsistent'
          : brokerErrorCode(err),
      reason: errMsg(err),
    });
  }
}

// =============================================================================
// Helpers
// =============================================================================

async function loadSettings(userId: string, deps: PipelineDeps): Promise<ResolvedTradeSettings> {
  return deps.db.getSettings(userId);
}

async function finalize(userId: string, deps: PipelineDeps, decision: Decision): Promise<Decision> {
  deps.events.emitStage(userId, {
    messageId: decision.messageId,
    ticker: decision.ticker,
    stage: 'done',
  });
  await deps.db.recordDecision(userId, decision).catch((err: unknown) =>
    log.error('could not persist decision', {
      userId,
      messageId: decision.messageId,
      error: errMsg(err),
    })
  );
  deps.events.emitDecision(userId, decision);
  log.info('pipeline complete', {
    userId,
    messageId: decision.messageId,
    kind: decision.kind,
    reason: decision.reason,
  });
  return decision;
}

const brokerErrorCode = (err: unknown): 'broker_unavailable' | 'execution_error' =>
  err instanceof BrokerUnavailableError ? 'broker_unavailable' : 'execution_error';

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
