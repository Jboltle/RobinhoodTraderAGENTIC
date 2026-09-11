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
 * ponytail: one in-memory flattening set per process. A restart can double-fire
 * one more market sell if the first order is still queued; the broker rejects
 * a close against a flat position. Upgrade path: persist in-flight keys.
 */
export function startMaxLossMonitor(deps: MaxLossDeps): () => void {
  const flattening = new Set<string>();
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

export async function sweepMaxLoss(deps: MaxLossDeps, flattening: Set<string>): Promise<void> {
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
  flattening: Set<string>,
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

  for (const position of equity.positions) {
    await considerPosition({
      userId,
      deps,
      flattening,
      now,
      tools,
      settings,
      key: positionKey('equity', position.symbol),
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
      key: positionKey(
        'option',
        position.symbol,
        position.optionType,
        position.strike,
        position.expiration
      ),
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

  return null;
}

interface ConsiderArgs {
  readonly userId: string;
  readonly deps: MaxLossDeps;
  readonly flattening: Set<string>;
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

  if (quantity <= 0) {
    flattening.delete(inflight);
    return;
  }
  if (flattening.has(inflight)) return;
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

  flattening.add(inflight);
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

/**
 * Entry price from the user's most recent submitted buy for the position.
 * Shared with the dashboard's performance view (server.ts) — `submitted` must
 * be newest-first so find() picks the latest entry.
 */
export function findEquityEntry(submitted: readonly Decision[], symbol: string): number | null {
  const match = submitted.find(
    (d) => d.order!.side === 'buy' && d.order!.assetType === 'equity' && d.order!.symbol === symbol
  );
  return match?.order?.limitPrice ?? null;
}

export function findOptionEntry(
  submitted: readonly Decision[],
  position: OptionContract & { symbol: string }
): number | null {
  const match = submitted.find((d) => {
    const order = d.order!;
    return (
      order.side === 'buy' &&
      order.assetType === 'option' &&
      order.symbol === position.symbol &&
      order.option !== null &&
      order.option.optionType === position.optionType &&
      Math.abs(order.option.strike - position.strike) < 0.0001 &&
      order.option.expiration === position.expiration
    );
  });
  return match?.order?.limitPrice ?? null;
}

function resolveEquityEntry(submitted: readonly Decision[], position: Position): number | null {
  return findEquityEntry(submitted, position.symbol) ?? numberFromRaw(position.raw, [
    'average_buy_price',
    'average_price',
    'average_cost',
    'cost_basis',
  ]);
}

function resolveOptionEntry(
  submitted: readonly Decision[],
  position: OptionPosition,
  orders: readonly OptionOrder[] | null,
  mark: number | null
): number | null {
  const fromTrade = findOptionEntry(submitted, position);
  if (fromTrade !== null) return fromTrade;
  if (orders === null) return null;

  const fills = orders
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
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const average = fills[0]?.averagePrice ?? null;
  if (average === null) return null;
  return normalizeOptionPremium(average, mark);
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
