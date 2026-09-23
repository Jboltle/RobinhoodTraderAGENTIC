/**
 * Max Loss: a process-lifetime monitor that market-sells one open position
 * when that position's unrealized loss hits the user's % or $ threshold.
 *
 * Entry-time risk is unchanged. This loop is independent of the dashboard —
 * SSE performance polling only runs while a client is connected.
 */
import { createLogger, errorFields } from '../shared/logger.js';
import {
  optionLabel,
  type AssetType,
  type Decision,
  type OptionContract,
  type SubmittedOrder,
} from '../shared/types.js';
import type { TraderDb } from './db.js';
import type { TraderEvents } from './events.js';
import { submitOrder } from './pipeline/execute.js';
import { isRegularUsTradingHours } from './pipeline/riskFilter.js';
import type { McpRegistry } from './rh/mcpRegistry.js';
import type { RobinhoodTools } from './rh/tools.js';
import type { OptionOrder, OptionPosition, Position } from './rh/types.js';

const log = createLogger('trader:max-loss');

export const MAX_LOSS_INTERVAL_MS = 15_000;
export const OPTION_MULTIPLIER = 100;
export const EQUITY_MULTIPLIER = 1;

/**
 * How long an in-flight close blocks re-selling the same position. A market
 * sell fills in seconds during regular hours; one still unfilled after this
 * long died somewhere (cancelled, expired, halted) and must be retried.
 */
export const FLATTEN_RETRY_MS = 10 * 60_000;

/** Submit-time statuses that mean the broker did not accept the close. */
const DEAD_ORDER_STATUSES = new Set(['rejected', 'canceled', 'cancelled', 'failed', 'expired']);

/** How far back we look for the buy that opened a position. Same depth as performance. */
const ENTRY_HISTORY_LIMIT = 500;

export interface LossInput {
  readonly entry: number;
  readonly mark: number;
  readonly quantity: number;
  readonly multiplier: number;
  readonly maxLossPct: number | null;
  readonly maxLossUsd: number | null;
}

/** True when either enabled threshold is hit. 0 / null = that side is off. */
export function lossBreached(input: LossInput): boolean {
  const { entry, mark, quantity, multiplier, maxLossPct, maxLossUsd } = input;
  if (!(entry > 0) || !(quantity > 0)) return false;

  const pctOn = maxLossPct !== null && maxLossPct > 0;
  const usdOn = maxLossUsd !== null && maxLossUsd > 0;
  if (!pctOn && !usdOn) return false;

  const pctLost = ((entry - mark) / entry) * 100;
  const usdLost = (entry - mark) * multiplier * quantity;

  return (pctOn && pctLost >= maxLossPct) || (usdOn && usdLost >= maxLossUsd);
}

export interface MaxLossDeps {
  readonly db: TraderDb;
  readonly brokers: McpRegistry;
  readonly events: TraderEvents;
  readonly enqueue: <T>(userId: string, run: () => Promise<T>) => Promise<T>;
  readonly now?: () => Date;
}

/**
 * Boot + interval. Returns a stop function for tests.
 * ponytail: in-flight closes live in one in-memory map (key → submit time)
 * per process. A restart or the retry TTL can double-fire one more market
 * sell; the broker rejects a close against a flat position. Upgrade path:
 * persist in-flight keys and poll order status instead of the TTL.
 */
export function startMaxLossMonitor(deps: MaxLossDeps): () => void {
  const flattening = new Map<string, number>();
  const tick = (): void => {
    void sweepMaxLoss(deps, flattening).catch((err: unknown) =>
      log.error('max-loss sweep failed', errorFields(err))
    );
  };
  tick();
  const timer = setInterval(tick, MAX_LOSS_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export async function sweepMaxLoss(
  deps: MaxLossDeps,
  flattening: Map<string, number>
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  if (!isRegularUsTradingHours(now)) return;

  const userIds = await deps.db.listBrokerUserIds();
  await Promise.all(
    userIds.map((userId) =>
      deps
        .enqueue(userId, () => scanUser(userId, deps, flattening, now))
        .catch((err: unknown) =>
          log.warn('max-loss user scan failed', {
            userId,
            error: err instanceof Error ? err.message : String(err),
          })
        )
    )
  );
}

async function scanUser(
  userId: string,
  deps: MaxLossDeps,
  flattening: Map<string, number>,
  now: Date
): Promise<null> {
  const settings = await deps.db.getSettings(userId);
  if (!lossEnabled(settings.maxLossPct, settings.maxLossUsd)) return null;

  const broker = deps.brokers.for(userId);
  if (!broker.mcp.isConnected()) return null;

  const tools = broker.tools;
  const [equity, options, decisions] = await Promise.all([
    tools.getPositions(),
    tools.getOptionPositions(),
    deps.db.listDecisions(userId, ENTRY_HISTORY_LIMIT),
  ]);
  const submitted = decisions.filter((d) => d.kind === 'submitted' && d.order);
  const optionOrders =
    typeof tools.getOptionOrders === 'function'
      ? await tools.getOptionOrders().catch(() => null)
      : null;

  const openKeys = new Set<string>();

  for (const position of equity.positions) {
    const key = positionKey('equity', position.symbol);
    if (position.quantity > 0) openKeys.add(`${userId}:${key}`);
    await considerPosition({
      userId,
      deps,
      flattening,
      now,
      tools,
      settings,
      key,
      symbol: position.symbol,
      quantity: position.quantity,
      assetType: 'equity',
      option: null,
      entry: resolveEquityEntry(submitted, position),
      mark: await tools.getQuote(position.symbol).then((q) => q.price).catch(() => null),
      multiplier: EQUITY_MULTIPLIER,
    });
  }

  for (const position of options.positions) {
    const key = positionKey(
      'option',
      position.symbol,
      position.optionType,
      position.strike,
      position.expiration
    );
    if (position.quantity > 0) openKeys.add(`${userId}:${key}`);
    const mark = await tools
      .getOptionsMarkPrice(position.symbol, position.optionType, position.strike, position.expiration)
      .then((q) => q?.markPrice ?? null)
      .catch(() => null);
    await considerPosition({
      userId,
      deps,
      flattening,
      now,
      tools,
      settings,
      key,
      symbol: position.symbol,
      quantity: position.quantity,
      assetType: 'option',
      option: {
        optionType: position.optionType,
        strike: position.strike,
        expiration: position.expiration,
      },
      entry: resolveOptionEntry(submitted, position, optionOrders?.orders ?? null, mark),
      mark,
      multiplier: OPTION_MULTIPLIER,
    });
  }

  // A tracked close whose position is gone has completed: prune its key so
  // the same contract re-entered later is protected again. Without this the
  // in-flight guard silently disables Max Loss for every re-entry until the
  // process restarts.
  for (const inflight of flattening.keys()) {
    if (inflight.startsWith(`${userId}:`) && !openKeys.has(inflight)) {
      flattening.delete(inflight);
    }
  }

  return null;
}

interface ConsiderArgs {
  readonly userId: string;
  readonly deps: MaxLossDeps;
  readonly flattening: Map<string, number>;
  readonly now: Date;
  readonly tools: RobinhoodTools;
  readonly settings: { maxLossPct: number | null; maxLossUsd: number | null };
  readonly key: string;
  readonly symbol: string;
  readonly quantity: number;
  readonly assetType: AssetType;
  readonly option: SubmittedOrder['option'];
  readonly entry: number | null;
  readonly mark: number | null;
  readonly multiplier: number;
}

async function considerPosition(args: ConsiderArgs): Promise<void> {
  const { userId, flattening, key, quantity } = args;
  const inflight = `${userId}:${key}`;

  if (quantity <= 0) return;
  // A fresh in-flight close means the broker is still working the order; a
  // stale one means it died unseen (cancelled, expired, halted), so fall
  // through and re-sell. Worst case is a duplicate close the broker rejects.
  const closeSubmittedAtMs = flattening.get(inflight);
  if (closeSubmittedAtMs !== undefined && args.now.getTime() - closeSubmittedAtMs < FLATTEN_RETRY_MS) {
    return;
  }
  if (args.entry === null || args.mark === null) {
    if (args.entry === null) {
      log.info('max-loss skipped: no entry', { userId, key });
    }
    return;
  }
  if (
    !lossBreached({
      entry: args.entry,
      mark: args.mark,
      quantity,
      multiplier: args.multiplier,
      maxLossPct: args.settings.maxLossPct,
      maxLossUsd: args.settings.maxLossUsd,
    })
  ) {
    return;
  }

  flattening.set(inflight, args.now.getTime());
  try {
    const sized: SubmittedOrder = {
      symbol: args.symbol,
      side: 'sell',
      assetType: args.assetType,
      quantity: Math.floor(quantity),
      orderType: 'market',
      limitPrice: null,
      option: args.option,
      orderId: null,
      status: null,
    };
    const placed = await submitOrder(sized, args.tools);
    // A dead submit-time status means nothing will fill: surface it as a
    // failure (no max_loss_exit row) so the next sweep retries the close.
    if (placed.status !== null && DEAD_ORDER_STATUSES.has(placed.status.toLowerCase())) {
      throw new Error(`broker returned terminal status "${placed.status}" for the close`);
    }
    const order: SubmittedOrder = {
      ...sized,
      orderId: placed.orderId,
      status: placed.status ?? 'submitted',
    };
    const decision: Decision = {
      at: args.now.toISOString(),
      messageId: `max-loss:${userId}:${key}:${args.now.getTime()}`,
      kind: 'max_loss_exit',
      code: null,
      reason: maxLossReason(order, args.entry, args.mark),
      ticker: args.symbol,
      action: 'sell',
      order,
    };
    await args.deps.db.recordDecision(userId, decision);
    args.deps.events.emitDecision(userId, decision);
    log.info('max-loss flattened', { userId, key, orderId: placed.orderId });
  } catch (err) {
    flattening.delete(inflight);
    log.warn('max-loss flatten failed', {
      userId,
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function lossEnabled(maxLossPct: number | null, maxLossUsd: number | null): boolean {
  return (maxLossPct !== null && maxLossPct > 0) || (maxLossUsd !== null && maxLossUsd > 0);
}

function positionKey(
  assetType: AssetType,
  symbol: string,
  optionType?: string,
  strike?: number,
  expiration?: string
): string {
  if (assetType === 'equity') return `eq:${symbol.toUpperCase()}`;
  return `opt:${symbol.toUpperCase()}:${optionType}:${strike}:${expiration}`;
}

/** One buy lot: unit price paid and units bought. Callers pass lots newest-first. */
export interface BuyLot {
  readonly price: number;
  readonly quantity: number;
}

/**
 * Weighted-average price of the newest buy lots covering the open quantity.
 * The latest buy alone misstates the basis once a position is averaged down
 * (the bot's isAddition buys do exactly that): a cheap add makes the loss look
 * smaller than it is and the stop fires far below the user's threshold. Lots
 * older than the covering set are ignored (they were sold), and when history
 * covers less than the open quantity the average of what exists still beats
 * the latest lot alone.
 * ponytail: newest-lots-cover-the-position is LIFO matching; interleaved
 * partial sells accounted FIFO by the broker can skew the basis by a lot
 * boundary. Upgrade path: replay the full buy/sell order history.
 */
export function weightedAverageEntry(
  lots: readonly BuyLot[],
  openQuantity: number
): number | null {
  let remaining = openQuantity;
  let cost = 0;
  let covered = 0;
  for (const lot of lots) {
    if (remaining <= 0) break;
    if (!(lot.price > 0) || !(lot.quantity > 0)) continue;
    const take = Math.min(lot.quantity, remaining);
    cost += lot.price * take;
    covered += take;
    remaining -= take;
  }
  return covered > 0 ? cost / covered : null;
}

/**
 * Entry basis from the user's submitted buy limits for the position — the
 * fallback when the broker reports no cost data. `submitted` must be
 * newest-first so the covering walk starts from the latest lot.
 */
function findEquityEntry(
  submitted: readonly Decision[],
  symbol: string,
  openQuantity: number
): number | null {
  const lots = submitted
    .filter(
      (d) =>
        d.order!.side === 'buy' &&
        d.order!.assetType === 'equity' &&
        d.order!.symbol === symbol &&
        d.order!.limitPrice !== null
    )
    .map((d) => ({ price: d.order!.limitPrice!, quantity: d.order!.quantity }));
  return weightedAverageEntry(lots, openQuantity);
}

function findOptionEntry(
  submitted: readonly Decision[],
  position: OptionContract & { symbol: string },
  openQuantity: number
): number | null {
  const lots = submitted
    .filter((d) => {
      const order = d.order!;
      return (
        order.side === 'buy' &&
        order.assetType === 'option' &&
        order.symbol === position.symbol &&
        order.limitPrice !== null &&
        order.option !== null &&
        order.option.optionType === position.optionType &&
        Math.abs(order.option.strike - position.strike) < 0.0001 &&
        order.option.expiration === position.expiration
      );
    })
    .map((d) => ({ price: d.order!.limitPrice!, quantity: d.order!.quantity }));
  return weightedAverageEntry(lots, openQuantity);
}

/**
 * Entry basis for an equity position, matching the Robinhood app: the
 * broker's per-share average cost from the position row when present (it
 * already averages every fill, including adds), else the weighted average of
 * the submitted buy limits covering the open shares. Shared with the
 * dashboard's performance view (server.ts). `cost_basis` is deliberately not
 * read — it is a position total, not a per-share price.
 */
export function resolveEquityEntry(submitted: readonly Decision[], position: Position): number | null {
  return (
    numberFromRaw(position.raw, ['average_buy_price', 'average_price', 'average_cost']) ??
    findEquityEntry(submitted, position.symbol, position.quantity)
  );
}

/**
 * Entry basis for an option position, matching the Robinhood app: actual
 * fills first (average_price of filled buys from get_option_orders, newest
 * lots covering the open contracts), else the submitted limit premiums the
 * same way. Position rows carry no cost data, so fills are the best source.
 * Shared with the dashboard (server.ts).
 */
export function resolveOptionEntry(
  submitted: readonly Decision[],
  position: OptionPosition,
  orders: readonly OptionOrder[] | null,
  mark: number | null
): number | null {
  const fillLots = (orders ?? [])
    .filter(
      (o) =>
        o.side === 'buy' &&
        (o.state === null || o.state === 'filled') &&
        o.symbol === position.symbol &&
        o.optionType === position.optionType &&
        Math.abs(o.strike - position.strike) < 0.0001 &&
        o.expiration === position.expiration &&
        o.averagePrice !== null
    )
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .map((o) => ({
      price: normalizeOptionPremium(o.averagePrice!, mark),
      quantity: o.quantity > 0 ? o.quantity : 1,
    }));
  return (
    weightedAverageEntry(fillLots, position.quantity) ??
    findOptionEntry(submitted, position, position.quantity)
  );
}

/** Robinhood sometimes reports 159 when the premium is 1.59. */
export function normalizeOptionPremium(average: number, mark: number | null): number {
  if (mark !== null && mark > 0 && average / mark >= 20) return average / 100;
  if (mark === null && average > 20) return average / 100;
  return average;
}

function numberFromRaw(raw: unknown, keys: readonly string[]): number | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) > 0) {
      return Number(v);
    }
  }
  for (const child of Object.values(rec)) {
    if (child && typeof child === 'object') {
      const found = numberFromRaw(child, keys);
      if (found !== null) return found;
    }
  }
  return null;
}

function maxLossReason(order: SubmittedOrder, entry: number, mark: number): string {
  const contract =
    order.assetType === 'option' && order.option ? ` ${optionLabel(order.option)}` : '';
  return (
    `Max loss: sold ${order.quantity} ${order.symbol}${contract} ` +
    `at mark $${mark.toFixed(2)} (entry $${entry.toFixed(2)})`
  );
}
