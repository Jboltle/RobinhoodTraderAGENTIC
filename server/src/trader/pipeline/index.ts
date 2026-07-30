import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import type {
  Callout,
  CalloutParser,
  Decision,
  DiscordEnvelope,
  PostReceipt,
  ResolvedTradeSettings,
  SubmittedOrder,
} from '../../shared/types.js';
import type { CalloutParseStatus, StoredCallout, TraderDb } from '../db.js';
import type { TraderEvents } from '../events.js';
import type { McpRegistry } from '../rh/mcpRegistry.js';
import {
  CapitalConstraintError,
  ParseInconsistencyError,
  executeEquity,
  executeOptions,
} from './execute.js';
import { checkRisk, deriveRiskState } from './riskFilter.js';
import { summarize, summarizeFanout, summarizePendingApproval } from './summarize.js';

export type { ExecutionContext } from './execute.js';

const log = createLogger('trader:pipeline');

// Options language in message text: "call(s)"/"put(s)" words or strike+C/P
// notation ("397.5c", "365 C"). Used to veto equity parses of option messages.
const OPTION_CONTEXT = /\bcalls?\b|\bputs?\b|\b\d+(?:\.\d+)?\s?[cp]\b/i;

export interface PipelineDeps {
  readonly parser: CalloutParser;
  readonly db: TraderDb;
  readonly events: TraderEvents;
  readonly brokers: McpRegistry;
  readonly postReceipt: PostReceipt;
}

export interface ProcessOptions {
  /**
   * Discord snapshot fields the webhook envelope doesn't carry. Catch-up
   * supplies the channel name it already resolved.
   */
  readonly channelName?: string | null;
  /**
   * Seen too late to trade (see catchup.ts). The callout is stored and shown
   * in every user's feed as missed, but no order is ever placed.
   */
  readonly missed?: boolean;
}

export interface MessageProcessor {
  process(envelope: DiscordEnvelope, options?: ProcessOptions): Promise<void>;
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

  const queueForUser = (
    userId: string,
    run: () => Promise<Decision | null>
  ): Promise<Decision | null> => {
    const chain = (chains.get(userId) ?? Promise.resolve()).then(run, run);
    chains.set(userId, chain);
    return chain;
  };

  return {
    async process(envelope: DiscordEnvelope, options: ProcessOptions = {}): Promise<void> {
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

      const outcomes: Decision[] = [];
      for (const [index, result] of settled.entries()) {
        if (result.status === 'fulfilled') {
          // null = the user does not follow this Caller (silent skip).
          if (result.value) outcomes.push(result.value);
        } else {
          log.error('user pipeline crashed', {
            userId: userIds[index],
            messageId: envelope.messageId,
            error: errMsg(result.reason),
          });
        }
      }

      await postFanoutReceipt(envelope, parsed.callout, outcomes, deps);
    },
  };
}

// =============================================================================
// Parse — once per Discord message, cached on the shared callouts row
// =============================================================================

type ParseStatus = CalloutParseStatus | 'missed';

interface ParsedCallout {
  readonly status: ParseStatus;
  /** Only ever set when status is 'parsed' — see the callouts table constraint. */
  readonly callout: Callout | null;
  /** Set when the LLM itself failed, as opposed to producing a non-callout. */
  readonly parseError: string | null;
}

async function resolveCallout(
  envelope: DiscordEnvelope,
  deps: PipelineDeps,
  options: ProcessOptions
): Promise<ParsedCallout> {
  const snapshot = {
    messageId: envelope.messageId,
    channelId: envelope.channelId,
    channelName: options.channelName ?? null,
    authorId: envelope.authorId,
    authorName: envelope.authorName,
    content: envelope.content,
    timestamp: envelope.timestamp,
    embeds: envelope.embeds ?? [],
    parse: null,
  };

  if (options.missed) {
    await save(deps, { ...snapshot, parseStatus: 'skipped' });
    return { status: 'missed', callout: null, parseError: null };
  }

  const cached = await deps.db.getCallout(envelope.messageId).catch((err: unknown) => {
    log.warn('could not read cached parse; re-parsing', { error: errMsg(err) });
    return null;
  });
  // A cached failure is worth retrying; a cached success or non-callout is not.
  if (cached?.parseStatus === 'parsed' || cached?.parseStatus === 'not_callout') {
    return { status: cached.parseStatus, callout: cached.parse, parseError: null };
  }

  let callout: Callout;
  try {
    callout = await deps.parser.parse(envelope);
  } catch (err) {
    await save(deps, { ...snapshot, parseStatus: 'failed' });
    return { status: 'failed', callout: null, parseError: errMsg(err) };
  }

  if (!callout.isCallout) {
    // The parse is dropped on purpose: the callouts row only retains one when
    // it describes a trade, and nothing downstream reads a non-callout parse.
    await save(deps, { ...snapshot, parseStatus: 'not_callout' });
    return { status: 'not_callout', callout: null, parseError: null };
  }

  await save(deps, { ...snapshot, parse: callout, parseStatus: 'parsed' });
  return { status: 'parsed', callout, parseError: null };
}

async function save(deps: PipelineDeps, callout: StoredCallout): Promise<void> {
  // A failed write costs the parse cache and the feed entry, not the trade.
  await deps.db.saveCallout(callout).catch((err: unknown) => {
    log.error('could not persist callout', {
      messageId: callout.messageId,
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

  if (settings.executionMode === 'approval') {
    return finalize(userId, deps, {
      ...base,
      ...identity,
      kind: 'pending_approval',
      code: null,
      reason: summarizePendingApproval(callout),
    });
  }

  deps.events.emitStage(userId, {
    messageId: envelope.messageId,
    ticker: symbol,
    stage: 'executing',
  });

  const context = { tools: deps.brokers.for(userId).tools };

  // ---- 2. Fetch buying power ----------------------------------------------
  // Entries need capital validation. Option exits are sized from current
  // option holdings, so they should still work when cash is zero or unavailable.
  const needsBuyingPower = !(risk.assetType === 'option' && side === 'sell');
  let buyingPower = 0;
  if (needsBuyingPower) {
    try {
      const bp = await context.tools.getBuyingPower();
      buyingPower = bp.amountUsd;
    } catch (err) {
      return finalize(userId, deps, {
        ...base,
        ...identity,
        kind: 'execution_failed',
        code: 'execution_error',
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

  // ---- 3. Execute ---------------------------------------------------------
  try {
    const placed =
      risk.assetType === 'option'
        ? await executeOptions(symbol, side, risk, callout, buyingPower, context)
        : await executeEquity(symbol, side, risk, callout, buyingPower, context);

    const order: SubmittedOrder = {
      symbol,
      side,
      assetType: risk.assetType,
      quantity: placed.quantity,
      orderType: risk.orderType,
      limitPrice: risk.limitPrice,
      option: risk.assetType === 'option' ? callout.option : null,
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
      code: capital ? 'insufficient_capital' : inconsistent ? 'parse_inconsistent' : 'execution_error',
      reason: errMsg(err),
    });
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * MCP sessions are only wired up when the trader boots in immediate mode, so a
 * user setting 'immediate' on a trader booted in approval mode would execute
 * against disabled stubs. Clamp escalation to the boot mode; de-escalation
 * (immediate → approval) is always honoured.
 */
async function loadSettings(userId: string, deps: PipelineDeps): Promise<ResolvedTradeSettings> {
  const settings = await deps.db.getSettings(userId);
  if (settings.executionMode === 'immediate' && config.tradeExecutionMode === 'approval') {
    log.warn(
      "executionMode 'immediate' ignored: trader booted in approval mode without live MCP; restart with TRADE_EXECUTION_MODE=immediate to enable",
      { userId }
    );
    return { ...settings, executionMode: 'approval' };
  }
  return settings;
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

/**
 * One Discord receipt per message, not per user: the source channel is shared,
 * so posting each account's fill there would both spam it N times and tell
 * everyone else what each user holds.
 */
async function postFanoutReceipt(
  envelope: DiscordEnvelope,
  callout: Callout | null,
  outcomes: readonly Decision[],
  deps: PipelineDeps
): Promise<void> {
  const text = summarizeFanout(callout, outcomes);
  if (text === null) return;
  await deps.postReceipt(envelope.channelId, text).catch((err: unknown) =>
    log.warn('postReceipt failed', { error: errMsg(err) })
  );
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
