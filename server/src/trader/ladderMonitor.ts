/**
 * Own-target exits. For each open lot of an account on the ladder, sell a level's
 * contracts once the mark reaches it. The Caller's trims are not involved;
 * their full close still goes through the pipeline.
 */
import { createLogger, errorFields } from '../shared/logger.js';
import { optionLabel, type Decision, type SubmittedOrder, type TradeExecutionMode } from '../shared/types.js';
import type { TraderDb } from './db.js';
import type { TraderEvents } from './events.js';
import { contractsAtLevel } from './lots.js';
import { submitOrder } from './pipeline/execute.js';
import { supportedAccounts, type McpRegistry } from './broker/registry.js';
import type { AccountRow } from './broker/types.js';
import { BrokerUnavailableError } from './broker/errors.js';
import { instrumentOf } from './broker/instrument.js';
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
  for (const account of await supportedAccounts(deps.db, deps.brokers)) {
    try {
      placed += await sweepAccount(account, deps);
    } catch (err: unknown) {
      if (err instanceof BrokerUnavailableError) continue;
      log.warn('ladder sweep skipped account', {
        accountId: account.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return placed;
}

async function sweepAccount(account: AccountRow, deps: LadderDeps): Promise<number> {
  const accountId = account.id;
  const settings = await deps.db.getSettings(accountId);
  if (settings.exitMode !== 'ladder') return 0;
  const broker = deps.brokers.for(account);
  await broker.session.ensureReady();
  const lots = await deps.db.listOpenOptionLots(accountId);
  let placed = 0;
  for (const lot of lots) {
    if (lot.entryPrice <= 0) continue;
    const mark = await broker.broker
      .getMark(instrumentOf({ symbol: lot.symbol, assetType: 'option', option: lot.option }))
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
      await cancelStops(deps.db, accountId, broker.broker, lot.symbol, lot.option);
      const result = await submitOrder(order, broker.broker);
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
      await deps.db.recordDecision(accountId, decision);
      deps.events.emitDecision(accountId, decision);
      placed += 1;
      break;
    }
  }
  return placed;
}
