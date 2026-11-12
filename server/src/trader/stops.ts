/**
 * The broker stop Max Loss rests on an option lot once the entry fills.
 * Any other sell cancels it first: a resting stop holds the contracts, and
 * selling past the free quantity is rejected as a sell-to-open.
 */
import { createLogger } from '../shared/logger.js';
import { optionLabel, type Decision, type OptionContract, type TradeExecutionMode } from '../shared/types.js';
import { isoDateEt } from './book/ladder.js';
import type { TraderDb } from './db.js';
import { heldByLot, stopTrigger, type OpenOptionLot } from './lots.js';
import { roundPremiumToTick, type RobinhoodTools } from './rh/tools.js';
import type { OptionOrder } from './rh/types.js';

const log = createLogger('trader:stops');

/** Broker states of a stop that sold nothing and never will. */
const DEAD_STOP_STATES: ReadonlySet<string> = new Set(['cancelled', 'canceled', 'rejected', 'failed', 'voided']);
const FILLED_STOP_STATE = 'filled';

/**
 * Cancel resting stops on this contract, clearing each stored id once its
 * cancel succeeds.
 *
 * A failed cancel says nothing about the stop, so its state is read back by id:
 * - dead, nothing filled: the id is cleared and the remaining lots carry on;
 * - filled: the lot is closed by the stop's own sell, the id is cleared, and
 *   this call still throws, so the caller places nothing;
 * - anything else (working, dead after a partial fill, unknown, not listed,
 *   unreadable): the id stays and the cancel error is rethrown. A sell next to
 *   a live stop can sell twice, and one sized on an overstated lot oversells.
 */
export async function cancelStops(
  db: TraderDb,
  userId: string,
  tools: RobinhoodTools,
  symbol: string,
  option: OptionContract | null
): Promise<void> {
  if (!option || typeof tools.cancelOptionOrder !== 'function') return;
  const lots = await db.listOpenOptionLots(userId);
  for (const lot of lots) {
    if (!lot.stopOrderId) continue;
    if (lot.symbol !== symbol.toUpperCase()) continue;
    if (
      lot.option.optionType !== option.optionType ||
      lot.option.strike !== option.strike ||
      lot.option.expiration !== option.expiration
    ) {
      continue;
    }
    try {
      await tools.cancelOptionOrder(lot.stopOrderId);
    } catch (err: unknown) {
      const stop = await readStop(tools, lot.stopOrderId);
      const state = stop?.state?.toLowerCase() ?? null;
      log.warn('stop cancel failed', {
        userId,
        lotId: lot.lotId,
        orderId: lot.stopOrderId,
        state: stop?.state ?? null,
        stopQuantity: stop?.quantity ?? null,
        processedQuantity: stop?.processedQuantity ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
      if (stop !== null && state === FILLED_STOP_STATE) {
        const sold = Math.min(lot.openQty, Math.floor(stop.quantity));
        if (sold < 1) throw err;
        // Recorded before the id is cleared: an open lot with no stop id gets a
        // new stop on the next fill sweep, and with this lot's contracts gone
        // that stop would rest on a newer lot's contracts at this lot's trigger.
        await db.recordDecision(userId, stopFillDecision(lot, lot.stopOrderId, sold));
        await db.updateOrder(userId, lot.messageId, { ...lot.buyOrder, stopOrderId: null });
        // The caller sized and linked its sell while this lot still looked
        // open, so that sell is not placed. The next exit sees the closed lot.
        throw new Error(
          `Max Loss stop had already filled: ${sold} ${lot.symbol} ${optionLabel(lot.option)} sold at Robinhood, ` +
            'that lot is now closed. This exit was not placed.',
          { cause: err }
        );
      }
      if (state === null || !DEAD_STOP_STATES.has(state)) throw err;
      // Dead after selling part of the lot: clearing the id would leave the
      // ledger claiming contracts that stop already sold.
      if ((stop?.processedQuantity ?? 0) > 0) throw err;
    }
    await db.updateOrder(userId, lot.messageId, { ...lot.buyOrder, stopOrderId: null });
  }
}

/** The stop as Robinhood lists it now. Null when it is not listed or cannot be read. */
async function readStop(tools: RobinhoodTools, orderId: string): Promise<OptionOrder | null> {
  if (typeof tools.getOptionOrders !== 'function') return null;
  try {
    const history = await tools.getOptionOrders(orderId);
    // Matched by id, so a server that ignored the filter cannot lend another order's state.
    return history?.orders.find((order) => order.orderId === orderId) ?? null;
  } catch (err: unknown) {
    log.warn('stop state read failed', {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The stop's fill as the sell that closed `sold` contracts of its lot.
 *
 * ponytail: no fill price or fill time. The broker's average price has no limit
 * to check its scale against here, and nobody watched the fill happen. Upgrade
 * path: the fill sweep follows resting stops and records the fill as it lands.
 */
function stopFillDecision(lot: OpenOptionLot, stopOrderId: string, sold: number): Decision {
  return {
    at: new Date().toISOString(),
    // One row per stop order: recordDecision ignores a repeat of the same id.
    messageId: `stop:${stopOrderId}`,
    kind: 'max_loss_exit',
    code: null,
    reason: `Max Loss stop filled at Robinhood: sold ${sold} ${lot.symbol} ${optionLabel(lot.option)}`,
    ticker: lot.symbol,
    action: 'sell',
    order: {
      symbol: lot.symbol,
      side: 'sell',
      assetType: 'option',
      quantity: sold,
      orderType: 'market',
      limitPrice: null,
      option: lot.option,
      orderId: stopOrderId,
      status: FILLED_STOP_STATE,
      filledQuantity: sold,
      lots: [{ lotId: lot.lotId, quantity: sold }],
    },
  };
}

/**
 * Rest a stop_market on each open option lot that doesn't have one, when Max
 * Loss is on and this deployment is allowed to trade.
 *
 * ponytail: the gap between a cancel and the next sweep leaves the remainder
 * without a stop for one poll. Upgrade path: re-rest in the same turn as the sell.
 */
export async function restMissingStops(args: {
  readonly userId: string;
  readonly db: TraderDb;
  readonly tools: RobinhoodTools;
  readonly executionMode: TradeExecutionMode;
  /** Decides which contracts have expired. Defaults to the clock. */
  readonly now?: Date;
  /** Connects the user's session; called only once a lot needs a stop. */
  readonly ensureReady?: () => Promise<void>;
}): Promise<void> {
  if (args.executionMode !== 'immediate') return;
  if (typeof args.tools.placeOptionsOrder !== 'function') return;
  const settings = await args.db.getSettings(args.userId);
  if (settings.maxLossPct == null || settings.maxLossPct <= 0) return;

  const lots = await args.db.listOpenOptionLots(args.userId);
  // Read on the first lot that needs a stop. A failed read throws out of this
  // call: no stop is rested on the ledger's word alone.
  let held: Map<string, number> | null = null;
  const today = isoDateEt(args.now ?? new Date());
  for (const lot of lots) {
    if (lot.stopOrderId || lot.entryPrice <= 0 || lot.openQty < 1) continue;
    // An expired contract needs no stop, and its lot never closes: without
    // this, one stale lot would cost a positions read on every sweep for ever.
    if (lot.option.expiration < today) continue;
    if (held === null) {
      await args.ensureReady?.();
      held = heldByLot(lots, (await args.tools.getOptionPositions()).positions);
    }
    const contracts = held.get(lot.lotId) ?? 0;
    if (contracts < 1) continue;
    try {
      const placed = await args.tools.placeOptionsOrder({
        symbol: lot.symbol,
        optionType: lot.option.optionType,
        strike: lot.option.strike,
        expiration: lot.option.expiration,
        contracts,
        side: 'sell',
        orderType: 'stop_market',
        stopPrice: roundPremiumToTick(stopTrigger(lot.entryPrice, settings.maxLossPct), 'sell', null),
        timeInForce: 'gtc',
      });
      if (!placed.orderId) continue;
      await args.db.updateOrder(args.userId, lot.messageId, { ...lot.buyOrder, stopOrderId: placed.orderId });
      log.info('rested max-loss stop', {
        userId: args.userId,
        symbol: lot.symbol,
        contracts,
        orderId: placed.orderId,
        status: placed.status,
      });
    } catch (err: unknown) {
      log.warn('max-loss stop was not accepted', {
        userId: args.userId,
        symbol: lot.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
