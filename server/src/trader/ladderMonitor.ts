/**
 * Own-target exits. For each open lot of a user on the ladder, sell a level's
 * contracts once the mark reaches it. The Caller's trims are not involved;
 * their full close still goes through the pipeline.
 */
import { createLogger, errorFields } from '../shared/logger.js';
import { optionLabel, type Decision, type SubmittedOrder, type TradeExecutionMode } from '../shared/types.js';
import type { TraderDb } from './db.js';
import type { TraderEvents } from './events.js';
import { contractsAtLevel } from './lots.js';
import { submitOrder } from './pipeline/execute.js';
import type { McpRegistry } from './rh/mcpRegistry.js';
import { BrokerUnavailableError } from './rh/mcpClient.js';
import { cancelStops } from './stops.js';

const log = createLogger('trader:ladder');

export const LADDER_INTERVAL_MS = 15_000;

export interface LadderDeps {
  readonly db: TraderDb;
  readonly brokers: McpRegistry;
  readonly events: TraderEvents;
  readonly executionMode: TradeExecutionMode;
}

export function startLadderMonitor(deps: LadderDeps): () => void {
  const timer = setInterval(() => {
    void sweepLadders(deps).catch((err: unknown) => log.error('ladder sweep failed', errorFields(err)));
  }, LADDER_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export async function sweepLadders(deps: LadderDeps): Promise<number> {
  if (deps.executionMode !== 'immediate') return 0;
  let placed = 0;
  for (const userId of await deps.db.listBrokerUserIds()) {
    try {
      placed += await sweepUser(userId, deps);
    } catch (err: unknown) {
      if (err instanceof BrokerUnavailableError) continue;
      log.warn('ladder sweep skipped user', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return placed;
}

async function sweepUser(userId: string, deps: LadderDeps): Promise<number> {
  const settings = await deps.db.getSettings(userId);
  if (settings.exitMode !== 'ladder') return 0;
  const broker = deps.brokers.for(userId);
  await broker.mcp.ensureReady();
  const lots = await deps.db.listOpenOptionLots(userId);
  let placed = 0;
  for (const lot of lots) {
    if (lot.entryPrice <= 0) continue;
    const mark = await broker.tools
      .getOptionsMarkPrice(lot.symbol, lot.option.optionType, lot.option.strike, lot.option.expiration)
      .then((quote) => quote?.markPrice ?? null)
      .catch(() => null);
    if (mark === null) continue;
    for (const level of contractsAtLevel(lot.originalQty, settings.trimLevels)) {
      if (level.contracts < 1) continue;
      const due = level.contracts - (lot.soldAtGain[level.gainPct] ?? 0);
      if (due < 1) continue;
      const target = lot.entryPrice * (1 + level.gainPct / 100);
      if (mark < target) continue;
      const quantity = Math.min(due, lot.openQty);
      if (quantity < 1) continue;
      const messageId = `ladder:${lot.lotId}:${level.gainPct}`;
      const order: SubmittedOrder = {
        symbol: lot.symbol,
        side: 'sell',
        assetType: 'option',
        quantity,
        orderType: 'limit',
        limitPrice: target,
        option: lot.option,
        orderId: null,
        status: null,
        lots: [{ lotId: lot.lotId, quantity, gainPct: level.gainPct }],
      };
      await cancelStops(deps.db, userId, broker.tools, lot.symbol, lot.option);
      const result = await submitOrder(order, broker.tools, deps.executionMode);
      const decision: Decision = {
        at: new Date().toISOString(),
        messageId,
        kind: 'submitted',
        code: null,
        reason: `own target +${level.gainPct}% on ${lot.symbol} ${optionLabel(lot.option)}`,
        ticker: lot.symbol,
        action: 'sell',
        order: { ...order, orderId: result.orderId, status: result.status ?? 'submitted' },
      };
      await deps.db.recordDecision(userId, decision);
      deps.events.emitDecision(userId, decision);
      placed += 1;
      break;
    }
  }
  return placed;
}
