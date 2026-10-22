/**
 * Fill read-back: keeps every placed order's broker state current until it
 * reaches a terminal one, and records the fill (quantity, average price,
 * when) on the trades row.
 *
 * Robinhood answers `unconfirmed` the moment it accepts an order, and nothing
 * else in the system looked again — so "submitted" only ever meant "sent".
 * This loop polls the user's option order history (the same call Max Loss
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
import { isTerminalOrderState, type Decision, type SubmittedOrder } from '../shared/types.js';
import type { OpenOrderRow, TraderDb } from './db.js';
import type { TraderEvents } from './events.js';
import { normalizeOptionPremium } from './maxLoss.js';
import { BrokerUnavailableError } from './rh/mcpClient.js';
import type { McpRegistry } from './rh/mcpRegistry.js';
import type { OptionOrder } from './rh/types.js';

const log = createLogger('trader:fills');

/** Tick while any order is open: a market order fills in seconds. */
export const FILL_POLL_ACTIVE_MS = 5_000;
/** Tick while nothing is open: one cheap indexed query. */
export const FILL_POLL_IDLE_MS = 30_000;
/**
 * How far back the sweep looks. A day order dies at the close, so anything
 * older than this that still reads non-terminal was never going to resolve
 * on its own; backfillFills.ts covers history with a wider window.
 */
export const FILL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface FillMonitorDeps {
  readonly db: TraderDb;
  readonly brokers: McpRegistry;
  readonly events: TraderEvents;
  readonly now?: () => Date;
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
  const rows = await deps.db.listOpenOrders(since ?? new Date(now.getTime() - FILL_LOOKBACK_MS));
  if (rows.length === 0) return { open: 0, updated: 0 };

  // Only users with a connection of record, as Max Loss does: reaching for a
  // disconnected user's session would start an OAuth flow nobody asked for.
  // Equity orders have no history tool to read; they keep their submit-time state.
  const connected = new Set(await deps.db.listBrokerUserIds());
  const optionRows = rows.filter(
    (row) => connected.has(row.userId) && row.decision.order?.assetType === 'option'
  );

  const byUser = new Map<string, OpenOrderRow[]>();
  for (const row of optionRows) {
    const list = byUser.get(row.userId) ?? [];
    list.push(row);
    byUser.set(row.userId, list);
  }

  let updated = 0;
  for (const [userId, userRows] of byUser) {
    try {
      updated += await syncUser(userId, userRows, deps, now);
    } catch (err: unknown) {
      log.warn('fill sync failed for user', { userId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { open: rows.length, updated };
}

async function syncUser(
  userId: string,
  rows: readonly OpenOrderRow[],
  deps: FillMonitorDeps,
  now: Date
): Promise<number> {
  const broker = deps.brokers.for(userId);
  // A session that needs consent is skipped this sweep; the rows stay open
  // and are picked up once the user reconnects.
  try {
    await broker.mcp.ensureReady();
  } catch (err) {
    if (err instanceof BrokerUnavailableError) return 0;
    throw err;
  }

  const history = await broker.tools.getOptionOrders();
  if (history === null) return 0;
  const byId = new Map<string, OptionOrder>();
  for (const order of history.orders) {
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

    await deps.db.updateOrder(userId, decision.messageId, next);
    const updatedDecision: Decision = { ...decision, order: next };
    deps.events.emitDecision(userId, updatedDecision);
    updated += 1;
    log.info('order state updated', {
      userId,
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
export function applyBrokerState(order: SubmittedOrder, live: OptionOrder, now: Date): SubmittedOrder {
  const status = live.state?.toLowerCase() ?? order.status;
  const filled = status === 'filled';
  const partial = status === 'partially_filled';

  const filledQuantity = filled
    ? order.quantity
    : partial && live.quantity > 0
      ? live.quantity
      : (order.filledQuantity ?? null);
  const averageFillPrice =
    (filled || partial) && live.averagePrice !== null
      ? normalizeOptionPremium(live.averagePrice, order.limitPrice)
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
