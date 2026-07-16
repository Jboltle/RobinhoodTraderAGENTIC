import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import type {
  Callout,
  Decision,
  DecisionKind,
  DiscordEnvelope,
  SubmittedOrder,
} from '../../shared/types.js';
import { CapitalConstraintError, executeEquity, executeOptions } from './execute.js';
import { checkRisk, recordTrade } from './riskFilter.js';
import { summarize, summarizePendingApproval } from './summarize.js';
import type { PipelineDeps } from './types.js';

export type { PipelineDeps } from './types.js';

const log = createLogger('trader:pipeline');

/**
 * Full pipeline for one Discord message:
 *  1. LLM parse  → structured Callout
 *  2. Risk check → deterministic guards + portfolio-percentage sizing
 *  3. Fetch buying power (always — needed for capital validation even when qty is explicit)
 *  4. Submit     → place equity or options order via Robinhood MCP
 */
export async function runPipeline(
  envelope: DiscordEnvelope,
  deps: PipelineDeps
): Promise<Decision> {
  const at = new Date().toISOString();

  // ---- 1. Parse -----------------------------------------------------------
  let callout: Callout;
  try {
    callout = await deps.parser.parse(envelope);
  } catch (err) {
    return finalize(deps, { at, envelope, callout: null, kind: 'parser_error', reason: errMsg(err), order: null });
  }

  if (!callout.isCallout) {
    return finalize(deps, { at, envelope, callout, kind: 'not_callout', reason: callout.rationale || 'not a callout', order: null });
  }

  // ---- 2. Risk check ------------------------------------------------------
  const risk = await checkRisk(callout);
  if (!risk.allow) {
    return finalize(deps, { at, envelope, callout, kind: 'risk_rejected', reason: risk.reason, order: null });
  }

  const symbol = callout.ticker!.toUpperCase();
  const side   = callout.action!;

  if (config.tradeExecutionMode === 'approval') {
    return finalize(deps, {
      at,
      envelope,
      callout,
      kind: 'pending_approval',
      reason: summarizePendingApproval(callout),
      order: null,
    });
  }

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
      return finalize(deps, { at, envelope, callout, kind: 'execution_failed', reason: `buying power fetch failed: ${errMsg(err)}`, order: null });
    }

    if (buyingPower <= 0) {
      return finalize(deps, { at, envelope, callout, kind: 'risk_rejected', reason: 'buying power is zero — no capital available', order: null });
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

    return finalize(deps, { at, envelope, callout, kind: 'submitted', reason: summarize(order, envelope.authorName), order });
  } catch (err) {
    const kind = err instanceof CapitalConstraintError ? 'risk_rejected' : 'execution_failed';
    return finalize(deps, { at, envelope, callout, kind, reason: errMsg(err), order: null });
  }
}

// =============================================================================
// Helpers
// =============================================================================

async function finalize(deps: PipelineDeps, decision: Decision): Promise<Decision> {
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
