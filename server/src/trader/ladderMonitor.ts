/**
 * Own-target exits. For each open lot of an account on the ladder, sell a level's
 * contracts once the mark reaches it. The Caller's trims are not involved;
 * their full close still goes through the pipeline.
 */
import { createLogger, errorFields } from '../shared/logger.js';
import { optionLabel, type Decision, type SubmittedOrder, type TradeExecutionMode } from '../shared/types.js';
import type { TraderDb } from './db.js';
import type { TraderEvents } from './events.js';
import { contractsAtLevel, heldByLot } from './lots.js';
import { submitOrder } from './pipeline/execute.js';
import { startOfDay } from './pipeline/riskFilter.js';
import { unheldAccounts, type McpRegistry } from './broker/registry.js';
import type { AccountRow } from './broker/types.js';
import { BrokerUnavailableError, BrokerWritesDisabledError } from './broker/errors.js';
import { instrumentOf } from './broker/instrument.js';
import { markFor, type QuoteSource } from './broker/quotes.js';
import { cancelStops } from './stops.js';

const log = createLogger('trader:ladder');

export const LADDER_INTERVAL_MS = 15_000;

/**
 * Sells of one level of one lot per day: the first and two retries. A level
 * whose sell died is due again on the next sweep, and each sell is a recorded
 * trade that counts toward the daily trade cap and renews the buy cooldown, so
 * a sell Robinhood keeps rejecting would use the cap up within minutes and
 * block every callout, exits included. Two retries cover a rejection that
 * clears on its own, such as a stop whose cancel had not settled.
 */
export const MAX_LADDER_PLACEMENTS_PER_DAY = 3;

/** A sell status the lot ledger reads as dead: its contracts stay open. */
const FAILED_SELL_STATUS = 'failed';

// ponytail: what was already logged (a lot not held, a level left alone for the
// day), kept for the process so a sweep every 15 s logs it once. Upgrade path:
// close stale lots in the ledger; show a level left alone on the dashboard.
const loggedOnce = new Set<string>();

function firstTime(key: string): boolean {
  if (loggedOnce.has(key)) return false;
  loggedOnce.add(key);
  return true;
}

export interface LadderDeps {
  readonly db: TraderDb;
  readonly brokers: McpRegistry;
  /** Prices the lots of an account whose own broker prices no option. */
  readonly quotes: QuoteSource;
  readonly events: TraderEvents;
  readonly executionMode: TradeExecutionMode;
}

export function startLadderMonitor(deps: LadderDeps): () => void {
  // Two sweeps at once both see a level as due and both sell it.
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweepLadders(deps)
      .catch((err: unknown) => log.error('ladder sweep failed', errorFields(err)))
      .finally(() => {
        sweeping = false;
      });
  }, LADDER_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export async function sweepLadders(deps: LadderDeps): Promise<number> {
  let placed = 0;
  for (const account of await unheldAccounts(deps.db, deps.brokers, deps.executionMode)) {
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
  // The same day the daily trade cap counts.
  const dayStart = startOfDay().getTime();
  // Read on the first due level, so a sweep with nothing to sell adds no call.
  let held: Map<string, number> | null = null;
  let placed = 0;
  for (const lot of lots) {
    if (lot.entryPrice <= 0) continue;
    const mark = await markFor(
      broker,
      deps.quotes,
      instrumentOf({ symbol: lot.symbol, assetType: 'option', option: lot.option })
    ).catch(() => null);
    if (mark === null) continue;
    for (const level of contractsAtLevel(lot.originalQty, settings.trimLevels)) {
      if (level.contracts < 1) continue;
      const due = level.contracts - (lot.soldAtGain[level.gainPct] ?? 0);
      if (due < 1) continue;
      const target = lot.entryPrice * (1 + level.gainPct / 100);
      if (mark < target) continue;
      const placedToday = lot.ownTargetSells.filter(
        (sell) => sell.gainPct === level.gainPct && Date.parse(sell.at) >= dayStart
      ).length;
      if (placedToday >= MAX_LADDER_PLACEMENTS_PER_DAY) {
        if (firstTime(`${lot.lotId}:${level.gainPct}:${dayStart}`)) {
          log.warn('ladder level left alone until tomorrow: its sells keep dying', {
            accountId,
            lotId: lot.lotId,
            symbol: lot.symbol,
            option: optionLabel(lot.option),
            gainPct: level.gainPct,
            placedToday,
          });
        }
        continue;
      }
      // The ledger alone can claim contracts sold in the broker's own app. A
      // failed read throws: nothing is cancelled or sold on a guess.
      held ??= heldByLot(lots, await broker.broker.getPositions('option'));
      const quantity = Math.min(due, lot.openQty, held.get(lot.lotId) ?? 0);
      if (quantity < 1) {
        if (firstTime(lot.lotId)) {
          log.info('ladder skipped lot: account does not hold the contract', {
            accountId,
            lotId: lot.lotId,
            symbol: lot.symbol,
            option: optionLabel(lot.option),
            openQty: lot.openQty,
          });
        }
        break;
      }
      // Unique per placement: recordDecision drops a repeated id, and a level
      // whose sell died is placed again.
      const messageId = `ladder:${lot.lotId}:${level.gainPct}:${Date.now()}`;
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
      // A submit that throws is recorded too, so it counts toward the day's
      // maximum. It closes nothing and is not a trade for the daily cap. A
      // deployment that holds writes refused it before the broker was asked:
      // that is no dead sell, and nothing is recorded for it.
      const result = await submitOrder(order, broker.broker).catch((err: unknown) =>
        err instanceof Error ? err : new Error(String(err))
      );
      if (result instanceof BrokerWritesDisabledError) throw result;
      const failed = result instanceof Error;
      const ownTarget = `own target +${level.gainPct}% on ${lot.symbol} ${optionLabel(lot.option)}`;
      const decision: Decision = {
        at: new Date().toISOString(),
        messageId,
        kind: failed ? 'execution_failed' : 'submitted',
        code: failed ? 'execution_error' : null,
        reason: failed ? `${ownTarget} failed: ${result.message}` : ownTarget,
        ticker: lot.symbol,
        action: 'sell',
        order: failed
          ? { ...order, status: FAILED_SELL_STATUS }
          : { ...order, orderId: result.orderId, status: result.status ?? 'submitted' },
      };
      await deps.db.recordDecision(accountId, decision);
      deps.events.emitDecision(accountId, decision);
      if (failed) throw result;
      placed += 1;
      break;
    }
  }
  return placed;
}
