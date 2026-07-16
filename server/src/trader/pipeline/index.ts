import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import type {
  Callout,
  Decision,
  DecisionKind,
  DiscordEnvelope,
  SubmittedOrder,
  TradeSettings,
} from '../../shared/types.js';
import { resolveSettings } from '../settings.js';
import { CapitalConstraintError, ParseInconsistencyError, executeEquity, executeOptions, type PipelineDeps } from './execute.js';
import { checkRisk, recordTrade } from './riskFilter.js';
import { summarize, summarizePendingApproval } from './summarize.js';

export type { PipelineDeps } from './execute.js';

const log = createLogger('trader:pipeline');

// Options language in message text: "call(s)"/"put(s)" words or strike+C/P
// notation ("397.5c", "365 C"). Used to veto equity parses of option messages.
const OPTION_CONTEXT = /\bcalls?\b|\bputs?\b|\b\d+(?:\.\d+)?\s?[cp]\b/i;

/**
 * Full pipeline for one Discord message:
 *  1. LLM parse  → structured Callout
 *  2. Risk check → deterministic guards + portfolio-percentage sizing,
 *     against settings resolved once per message (payload → file → env)
 *  3. Fetch buying power (always — needed for capital validation even when qty is explicit)
 *  4. Submit     → place equity or options order via Robinhood MCP
 */
export async function runPipeline(
  envelope: DiscordEnvelope,
  deps: PipelineDeps,
  settingsOverride: TradeSettings = {}
): Promise<Decision> {
  const at = new Date().toISOString();
  const settings = await resolveSettings(settingsOverride);

  // MCP tools are wired at boot: in approval mode the trader never connects to
  // Robinhood, so an 'immediate' override would fail on disabled stubs. Clamp
  // escalation to the boot mode; de-escalation (immediate → approval) is fine.
  if (settings.executionMode === 'immediate' && config.tradeExecutionMode === 'approval') {
    log.warn(
      "executionMode override to 'immediate' ignored: trader booted in approval mode without live MCP; restart with TRADE_EXECUTION_MODE=immediate to enable"
    );
    settings.executionMode = 'approval';
  }

  // ---- 1. Parse -----------------------------------------------------------
  deps.decisions.emitStage({ messageId: envelope.messageId, ticker: null, stage: 'parsing' });
  let callout: Callout;
  try {
    callout = await deps.parser.parse(envelope);
  } catch (err) {
    return finalize(deps, { at, envelope, callout: null, kind: 'parser_error', code: 'parse_failed', reason: errMsg(err), order: null });
  }

  if (!callout.isCallout) {
    return finalize(deps, { at, envelope, callout, kind: 'not_callout', code: 'not_callout', reason: callout.rationale || 'not a callout', order: null });
  }

  // Guardrail: a message full of options language must never execute as an
  // equity trade — the "limit price" is almost certainly an option premium
  // (e.g. buying AAPL stock at $7.70 from "aapl calls 3.38 to 7.70").
  if (callout.assetType === 'equity' && OPTION_CONTEXT.test(envelope.content)) {
    return finalize(deps, {
      at,
      envelope,
      callout,
      kind: 'risk_rejected',
      code: 'parse_inconsistent',
      reason: 'message mentions options (calls/puts/strike notation) but parse says equity — refusing to trade on an inconsistent parse',
      order: null,
    });
  }

  // ---- 2. Risk check ------------------------------------------------------
  deps.decisions.emitStage({ messageId: envelope.messageId, ticker: callout.ticker, stage: 'risk_check' });
  const risk = await checkRisk(callout, settings);
  if (!risk.allow) {
    return finalize(deps, { at, envelope, callout, kind: 'risk_rejected', code: risk.code, reason: risk.reason, order: null });
  }

  const symbol = callout.ticker!.toUpperCase();
  const side   = callout.action!;

  if (settings.executionMode === 'approval') {
    return finalize(deps, {
      at,
      envelope,
      callout,
      kind: 'pending_approval',
      code: null,
      reason: summarizePendingApproval(callout),
      order: null,
    });
  }

  deps.decisions.emitStage({ messageId: envelope.messageId, ticker: symbol, stage: 'executing' });

  // ---- 3. Fetch buying power ----------------------------------------------
  // Entries need capital validation. Option exits are sized from current
  // option holdings, so they should still work when cash is zero or unavailable.
  const needsBuyingPower = !(risk.assetType === 'option' && side === 'sell');
  let buyingPower = 0;
  if (needsBuyingPower) {
    try {
      const bp = await deps.tools.getBuyingPower();
      buyingPower = bp.amountUsd;
    } catch (err) {
      return finalize(deps, { at, envelope, callout, kind: 'execution_failed', code: 'execution_error', reason: `buying power fetch failed: ${errMsg(err)}`, order: null });
    }

    if (buyingPower <= 0) {
      return finalize(deps, { at, envelope, callout, kind: 'risk_rejected', code: 'insufficient_capital', reason: 'buying power is zero — no capital available', order: null });
    }
  }

  // ---- 4. Execute ---------------------------------------------------------
  try {
    const placed =
      risk.assetType === 'option'
        ? await executeOptions(symbol, side, risk, callout, buyingPower, deps)
        : await executeEquity(symbol, side, risk, callout, buyingPower, deps);

    await recordTrade(symbol);

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

    return finalize(deps, { at, envelope, callout, kind: 'submitted', code: null, reason: summarize(order, envelope.authorName), order });
  } catch (err) {
    const capital = err instanceof CapitalConstraintError;
    const inconsistent = err instanceof ParseInconsistencyError;
    return finalize(deps, {
      at,
      envelope,
      callout,
      kind: capital || inconsistent ? 'risk_rejected' : 'execution_failed',
      code: capital ? 'insufficient_capital' : inconsistent ? 'parse_inconsistent' : 'execution_error',
      reason: errMsg(err),
      order: null,
    });
  }
}

// =============================================================================
// Helpers
// =============================================================================

async function finalize(deps: PipelineDeps, decision: Decision): Promise<Decision> {
  deps.decisions.emitStage({
    messageId: decision.envelope.messageId,
    ticker: decision.callout?.ticker ?? null,
    stage: 'done',
  });
  await deps.decisions.append(decision);
  log.info('pipeline complete', { messageId: decision.envelope.messageId, kind: decision.kind, reason: decision.reason });
  if (shouldNotify(decision.kind)) {
    await deps.postReceipt(decision.envelope.channelId, decision.reason).catch((err) =>
      log.warn('postReceipt failed', { error: errMsg(err) })
    );
  }
  return decision;
}

const shouldNotify = (kind: DecisionKind): boolean =>
  kind === 'risk_rejected' ||
  kind === 'pending_approval' ||
  kind === 'submitted' ||
  kind === 'execution_failed';

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
