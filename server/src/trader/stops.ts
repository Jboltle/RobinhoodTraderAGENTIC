/**
 * The broker stop Max Loss rests on an option lot once the entry fills.
 * Any other sell cancels it first: a resting stop holds the contracts, and
 * selling past the free quantity is rejected as a sell-to-open.
 */
import { createLogger } from '../shared/logger.js';
import type { OptionContract, TradeExecutionMode } from '../shared/types.js';
import type { TraderDb } from './db.js';
import { stopTrigger } from './lots.js';
import { instrumentOf, roundPremiumToTick } from './broker/instrument.js';
import type { Broker } from './broker/types.js';

const log = createLogger('trader:stops');

/** Cancel resting stops on this contract. Clears the id even if the cancel 404s. */
export async function cancelStops(
  db: TraderDb,
  userId: string,
  broker: Broker,
  symbol: string,
  option: OptionContract | null
): Promise<void> {
  if (!option) return;
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
      await broker.cancelOrder(lot.stopOrderId);
    } catch (err: unknown) {
      log.warn('stop cancel failed', {
        userId,
        orderId: lot.stopOrderId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    await db.updateOrder(userId, lot.messageId, { ...lot.buyOrder, stopOrderId: null });
  }
}

/**
 * Rest a stop on each open option lot that doesn't have one, when Max
 * Loss is on and this deployment is allowed to trade.
 *
 * ponytail: the gap between a cancel and the next sweep leaves the remainder
 * without a stop for one poll. Upgrade path: re-rest in the same turn as the sell.
 */
export async function restMissingStops(args: {
  readonly userId: string;
  readonly db: TraderDb;
  readonly broker: Broker;
  readonly executionMode: TradeExecutionMode;
}): Promise<void> {
  if (args.executionMode !== 'immediate') return;
  const settings = await args.db.getSettings(args.userId);
  if (settings.maxLossPct == null || settings.maxLossPct <= 0) return;

  const lots = await args.db.listOpenOptionLots(args.userId);
  for (const lot of lots) {
    if (lot.stopOrderId || lot.entryPrice <= 0 || lot.openQty < 1) continue;
    try {
      const placed = await args.broker.placeOrder({
        instrument: instrumentOf({ symbol: lot.symbol, assetType: 'option', option: lot.option }),
        side: 'sell',
        quantity: lot.openQty,
        type: 'stop',
        stopPrice: roundPremiumToTick(stopTrigger(lot.entryPrice, settings.maxLossPct), 'sell', null),
        timeInForce: 'gtc',
      });
      if (!placed.orderId) continue;
      await args.db.updateOrder(args.userId, lot.messageId, { ...lot.buyOrder, stopOrderId: placed.orderId });
      log.info('rested max-loss stop', {
        userId: args.userId,
        symbol: lot.symbol,
        contracts: lot.openQty,
        orderId: placed.orderId,
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
