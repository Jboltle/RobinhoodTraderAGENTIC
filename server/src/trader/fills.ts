/**
 * Fill read-back: keeps every placed order's broker state current until it
 * reaches a terminal one, and records the fill (quantity, average price,
 * when) on the trades row.
 *
 * Robinhood answers `unconfirmed` the moment it accepts an order, and nothing
 * else in the system looked again — so "submitted" only ever meant "sent".
 * This loop polls the account's option order history (the same call Max Loss
 * uses for cost basis), matches by order id, and writes the change back. The
 * dashboard learns about it through the normal decision event, so the chip
 * flips from working to filled without a new frame type.
 *
 * ponytail: option orders only; the MCP advertises no equity order history
 * (TOOL_NAMES has no get_equity_orders), so equity rows keep their submit-time
 * status. Upgrade path: add the tool behind the same advertisedTools() guard
 * and this sweep needs no other change.
 */
import { createLogger, errorFields } from '../shared/logger.js';
import { isTerminalOrderState, type Decision, type SubmittedOrder, type TradeExecutionMode } from '../shared/types.js';
import type { OpenOrderRow, TraderDb } from './db.js';
import { restMissingStops } from './stops.js';
import type { TraderEvents } from './events.js';
import { normalizeOptionPremium } from './maxLoss.js';
import { BrokerUnavailableError } from './broker/errors.js';
import { supportedAccounts, type McpRegistry } from './broker/registry.js';
import type { AccountRow, BrokerOrder } from './broker/types.js';

const log = createLogger('trader:fills');

/** Tick while any order is open: a market order fills in seconds. */
export const FILL_POLL_ACTIVE_MS = 5_000;
/** Tick while nothing is open: one cheap indexed query. */
export const FILL_POLL_IDLE_MS = 30_000;
/**
 * How far back the sweep looks by default. A day order dies at the close, so
 * anything older than this that still reads non-terminal was never going to
 * resolve on its own; FILL_LOOKBACK_DAYS (config) widens it for one boot to
 * backfill history, and backfillFills.ts does the same from the CLI.
 */
export const FILL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface FillMonitorDeps {
  readonly db: TraderDb;
  readonly brokers: McpRegistry;
  readonly events: TraderEvents;
  /** Overrides FILL_LOOKBACK_MS for every sweep this monitor runs. */
  readonly lookbackMs?: number;
  readonly now?: () => Date;
  /** Immediate deployments rest a broker stop on a filled option buy when Max Loss is on. */
  readonly executionMode?: TradeExecutionMode;
}

export interface SweepResult {
  readonly open: number;
  readonly updated: number;
}

/** Boot + self-rescheduling loop. Returns a stop function for tests. */
export function startFillMonitor(deps: FillMonitorDeps): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = async (): Promise<void> => {
    let delay = FILL_POLL_IDLE_MS;
    try {
      const { open } = await sweepFills(deps);
      if (open > 0) delay = FILL_POLL_ACTIVE_MS;
    } catch (err: unknown) {
      log.error('fill sweep failed', errorFields(err));
    }
    if (stopped) return;
    timer = setTimeout(() => void tick(), delay);
    timer.unref();
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * One pass over every open order. `since` defaults to the lookback window;
 * the backfill script widens it.
 */
export async function sweepFills(deps: FillMonitorDeps, since?: Date): Promise<SweepResult> {
  const now = deps.now?.() ?? new Date();
  const rows = await deps.db.listOpenOrders(
    since ?? new Date(now.getTime() - (deps.lookbackMs ?? FILL_LOOKBACK_MS))
  );
  if (rows.length === 0) return { open: 0, updated: 0 };

  // Only accounts with a connection of record, as Max Loss does: reaching for
  // a disconnected account's session would start an OAuth flow nobody asked for.
  // Equity orders have no history tool to read; they keep their submit-time state.
  const connected = new Map(
    (await supportedAccounts(deps.db, deps.brokers)).map((account) => [account.id, account])
  );
  const optionRows = rows.filter(
    (row) => connected.has(row.accountId) && row.decision.order?.assetType === 'option'
  );

  const byAccount = new Map<string, OpenOrderRow[]>();
  for (const row of optionRows) {
    const list = byAccount.get(row.accountId) ?? [];
    list.push(row);
    byAccount.set(row.accountId, list);
  }

  let updated = 0;
  for (const [accountId, accountRows] of byAccount) {
    try {
      updated += await syncAccount(connected.get(accountId)!, accountRows, deps, now);
    } catch (err: unknown) {
      log.warn('fill sync failed for account', { accountId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (deps.executionMode === 'immediate') {
    for (const account of await supportedAccounts(deps.db, deps.brokers)) {
      try {
        const broker = deps.brokers.for(account);
        await broker.session.ensureReady();
        await restMissingStops({
          accountId: account.id,
          db: deps.db,
          broker: broker.broker,
          executionMode: deps.executionMode,
        });
      } catch (err: unknown) {
        if (err instanceof BrokerUnavailableError) continue;
        log.warn('stop rest failed for account', {
          accountId: account.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { open: rows.length, updated };
}

async function syncAccount(
  account: AccountRow,
  rows: readonly OpenOrderRow[],
  deps: FillMonitorDeps,
  now: Date
): Promise<number> {
  const accountId = account.id;
  const broker = deps.brokers.for(account);
  // A session that needs consent is skipped this sweep; the rows stay open
  // and are picked up once the user reconnects.
  try {
    await broker.session.ensureReady();
  } catch (err) {
    if (err instanceof BrokerUnavailableError) return 0;
    throw err;
  }

  const history = await broker.broker.getOrders();
  if (history === null) return 0;
  const byId = new Map<string, BrokerOrder>();
  for (const order of history) {
    if (order.orderId) byId.set(order.orderId, order);
  }

  let updated = 0;
  for (const { decision } of rows) {
    const order = decision.order!;
    const live = byId.get(order.orderId!);
    // An id the broker does not list yet (or any more) is left exactly as is.
    if (!live) continue;
    const next = applyBrokerState(order, live, now);
    if (next === order) continue;

    await deps.db.updateOrder(accountId, decision.messageId, next);
    const updatedDecision: Decision = { ...decision, order: next };
    deps.events.emitDecision(accountId, updatedDecision);
    updated += 1;
    log.info('order state updated', {
      accountId,
      messageId: decision.messageId,
      orderId: order.orderId,
      from: order.status,
      to: next.status,
      filledQuantity: next.filledQuantity ?? null,
      averageFillPrice: next.averageFillPrice ?? null,
    });
  }
  return updated;
}

/**
 * The stored order with the broker's current state folded in. Returns the
 * same reference when nothing changed, so callers can skip the write.
 *
 * Fill price goes through the same scale fix Max Loss uses: Robinhood
 * sometimes reports 159 for a 1.59 premium, and the order's own limit is the
 * reference when there is one.
 */
export function applyBrokerState(order: SubmittedOrder, live: BrokerOrder, now: Date): SubmittedOrder {
  const status = live.status?.toLowerCase() ?? order.status;
  const filled = status === 'filled';
  const partial = status === 'partially_filled';

  const filledQuantity = filled
    ? order.quantity
    : partial && live.quantity > 0
      ? live.quantity
      : (order.filledQuantity ?? null);
  const averageFillPrice =
    (filled || partial) && live.fillPrice !== null
      ? normalizeOptionPremium(live.fillPrice, order.limitPrice)
      : (order.averageFillPrice ?? null);
  const filledAt = filled ? (order.filledAt ?? now.toISOString()) : (order.filledAt ?? null);

  const unchanged =
    status === order.status &&
    filledQuantity === (order.filledQuantity ?? null) &&
    averageFillPrice === (order.averageFillPrice ?? null) &&
    filledAt === (order.filledAt ?? null);
  if (unchanged) return order;

  return { ...order, status, filledQuantity, averageFillPrice, filledAt };
}

/** True once the monitor has nothing left to learn about this order. */
export const isSettled = (order: SubmittedOrder): boolean => isTerminalOrderState(order.status);
