/**
 * Max Loss: a process-lifetime monitor that market-sells one open position
 * when that position's unrealized loss hits the account's % or $ threshold.
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
import { sameOption, type OpenOptionLot } from './lots.js';
import { submitOrder } from './pipeline/execute.js';
import { isRegularUsTradingHours } from './pipeline/riskFilter.js';
import { BrokerUnavailableError, BrokerWritesDisabledError } from './broker/errors.js';
import { instrumentKey } from './broker/instrument.js';
import { supportedAccounts, type McpRegistry } from './broker/registry.js';
import type {
  AccountRow,
  Broker,
  BrokerOrder,
  BrokerPosition,
  OptionInstrument,
} from './broker/types.js';

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

/**
 * How far above its own limit a lot's stored fill can sit and still be
 * believed. A buy cannot fill above its limit, and the stored limit is the
 * caller's price before it is rounded to the contract's tick for the broker,
 * so a real fill can sit a tick above it. A fill beyond this is one the
 * read-back stored unscaled (a per-contract fill under 20x the limit: an entry
 * approved at its old limit after the contract fell more than 80%).
 */
const MAX_FILL_TO_LIMIT = 2;

/**
 * How far a lot's limit may sit from the broker's own figure for that order
 * and still stand in for a fill that was never stored. Covers ordinary price
 * improvement; an entry approved at its old limit after the contract fell
 * fills far under it, and the limit is then no measure of what was paid.
 */
const LIMIT_STANDS_FOR_FILL_WITHIN = 0.1;

/** How far back we look for the buy that opened a position. Same depth as performance. */
const ENTRY_HISTORY_LIMIT = 500;

/** One account's entry history, kept across sweeps; see entryHistory for when it is re-read. */
interface EntryHistory {
  /** Submitted orders from the last trades read; null = read on the next sweep. */
  submitted: Promise<readonly Decision[]> | null;
  /** Keys of the positions held at the last sweep. */
  held: ReadonlySet<string>;
}

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
  readonly enqueue: <T>(accountId: string, run: () => Promise<T>) => Promise<T>;
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
  const entries = new Map<string, EntryHistory>();
  const tick = (): void => {
    void sweepMaxLoss(deps, flattening, entries).catch((err: unknown) =>
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
  flattening: Map<string, number>,
  entries: Map<string, EntryHistory> = new Map()
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  if (!isRegularUsTradingHours(now)) return;

  const accounts = await supportedAccounts(deps.db, deps.brokers);
  await Promise.all(
    accounts.map((account) =>
      deps
        .enqueue(account.id, () => scanAccount(account, deps, flattening, now, entries))
        .catch((err: unknown) =>
          log.warn('max-loss account scan failed', {
            accountId: account.id,
            error: err instanceof Error ? err.message : String(err),
          })
        )
    )
  );
}

async function scanAccount(
  account: AccountRow,
  deps: MaxLossDeps,
  flattening: Map<string, number>,
  now: Date,
  entries: Map<string, EntryHistory>
): Promise<null> {
  const accountId = account.id;
  const settings = await deps.db.getSettings(accountId);
  if (!lossEnabled(settings.maxLossPct, settings.maxLossUsd)) return null;

  const { session, broker } = deps.brokers.for(account);
  // Reconnect from stored tokens so a dropped session does not silently turn
  // Max Loss off; a session that needs OAuth consent is skipped this sweep.
  try {
    await session.ensureReady();
  } catch (err) {
    if (err instanceof BrokerUnavailableError) return null;
    throw err;
  }

  const positions = await broker.getPositions();
  const held = new Set(
    positions.filter((p) => p.quantity > 0).map((p) => instrumentKey(p.instrument))
  );
  const submitted = await entryHistory(accountId, deps, entries, held);
  const orders = await broker.getOrders().catch(() => null);

  const openLots = await deps.db.listOpenOptionLots(accountId).catch(() => null);
  if (openLots === null) {
    log.warn('max-loss: ledger unreadable, option positions wait a sweep', { accountId });
  }
  const openKeys = new Set<string>();

  for (const position of positions) {
    const { instrument } = position;
    const key = instrumentKey(instrument);
    if (position.quantity > 0) openKeys.add(`${accountId}:${key}`);
    // An unreadable ledger is not an empty one. Pricing an option from broker
    // history because the lots could not be read would sell the winner the
    // lot's own fill rules out, so options wait for the next sweep.
    if (instrument.kind === 'option' && openLots === null) continue;
    const lots = openLots ?? [];
    // A resting broker stop is this position's Max Loss. Selling here too would
    // double-close it. ponytail: the dollar cap does not fire while that stop
    // rests. Upgrade path: cancel the stop and software-flatten only the usd breach.
    const stopped =
      instrument.kind === 'option' &&
      lots.some(
        (lot) =>
          lot.stopOrderId !== null &&
          lot.symbol === instrument.symbol.toUpperCase() &&
          lot.option.optionType === instrument.optionType &&
          lot.option.strike === instrument.strike &&
          lot.option.expiration === instrument.expiration
      );
    if (stopped) continue;
    const mark = await broker.getMark(instrument).catch(() => null);
    await considerPosition({
      accountId,
      ownerUserId: account.userId,
      deps,
      flattening,
      now,
      broker,
      settings,
      key,
      symbol: instrument.symbol,
      quantity: position.quantity,
      assetType: instrument.kind,
      option:
        instrument.kind === 'option'
          ? {
              optionType: instrument.optionType,
              strike: instrument.strike,
              expiration: instrument.expiration,
            }
          : null,
      entry:
        instrument.kind === 'option'
          ? resolveOptionEntry(lots, submitted, instrument, position.quantity, orders, mark)
          : resolveEquityEntry(submitted, position),
      mark,
      multiplier: instrument.kind === 'option' ? OPTION_MULTIPLIER : EQUITY_MULTIPLIER,
    });
  }

  // A tracked close whose position is gone has completed: prune its key so
  // the same contract re-entered later is protected again. Without this the
  // in-flight guard silently disables Max Loss for every re-entry until the
  // process restarts.
  for (const inflight of flattening.keys()) {
    if (inflight.startsWith(`${accountId}:`) && !openKeys.has(inflight)) {
      flattening.delete(inflight);
    }
  }

  return null;
}

/**
 * The account's submitted orders, re-read from the trades table only when the
 * cached copy may be stale: the first sweep, the sweep after any decision is
 * logged for the account (a buy opens a position, an add re-averages one), and a
 * sweep holding a position the previous one did not, so a new position never
 * waits on that event alone.
 * ponytail: one history and one decision subscription per account, never
 * dropped; fine at invite-only scale. Events reach only this process, so an
 * add logged by another instance goes unseen until a local decision. Upgrade
 * path: invalidate from a Postgres NOTIFY on trades writes.
 */
function entryHistory(
  accountId: string,
  deps: MaxLossDeps,
  entries: Map<string, EntryHistory>,
  held: ReadonlySet<string>
): Promise<readonly Decision[]> {
  const history: EntryHistory = entries.get(accountId) ?? { submitted: null, held };
  if (!entries.has(accountId)) {
    entries.set(accountId, history);
    deps.events.subscribe(accountId, {
      onDecision: () => {
        history.submitted = null;
      },
    });
  }
  const previouslyHeld = history.held;
  history.held = held;
  if (history.submitted !== null && [...held].every((key) => previouslyHeld.has(key))) {
    return history.submitted;
  }
  // Cached while still in flight, so a decision logged mid-read voids it too.
  const read = deps.db
    .listDecisions(accountId, ENTRY_HISTORY_LIMIT)
    .then((decisions) => decisions.filter((d) => d.kind === 'submitted' && d.order));
  history.submitted = read;
  // A failed read is not kept: the next sweep tries again.
  read.catch(() => {
    if (history.submitted === read) history.submitted = null;
  });
  return read;
}

interface ConsiderArgs {
  readonly accountId: string;
  /** The account's owner: named in the exit's synthetic message id, as it always was. */
  readonly ownerUserId: string;
  readonly deps: MaxLossDeps;
  readonly flattening: Map<string, number>;
  readonly now: Date;
  readonly broker: Broker;
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
  const { accountId, flattening, key, quantity } = args;
  const inflight = `${accountId}:${key}`;

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
      log.info('max-loss skipped: no entry', { accountId, key });
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
    const placed = await submitOrder(sized, args.broker);
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
      messageId: `max-loss:${args.ownerUserId}:${key}:${args.now.getTime()}`,
      kind: 'max_loss_exit',
      code: null,
      reason: maxLossReason(order, args.entry, args.mark),
      ticker: args.symbol,
      action: 'sell',
      order,
    };
    await args.deps.db.recordDecision(accountId, decision);
    args.deps.events.emitDecision(accountId, decision);
    log.info('max-loss flattened', { accountId, key, orderId: placed.orderId });
  } catch (err) {
    if (err instanceof BrokerWritesDisabledError) {
      // Max Loss is protection the user opted into, so `approval` does not
      // hold it; only a read-only deployment does, and its Broker refuses the
      // sell. The in-flight key stays set so the same breach is logged once
      // per FLATTEN_RETRY_MS, not once per 15 s sweep.
      log.info('max-loss breach observed; read-only deployment, not flattening', {
        accountId,
        key,
        entry: args.entry,
        mark: args.mark,
      });
      return;
    }
    flattening.delete(inflight);
    log.warn('max-loss flatten failed', {
      accountId,
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function lossEnabled(maxLossPct: number | null, maxLossUsd: number | null): boolean {
  return (maxLossPct !== null && maxLossPct > 0) || (maxLossUsd !== null && maxLossUsd > 0);
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
 * Entry basis from the account's submitted buy limits for the position — the
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
 * dashboard's performance view (server.ts).
 */
export function resolveEquityEntry(
  submitted: readonly Decision[],
  position: BrokerPosition
): number | null {
  return (
    position.averageEntryPrice ??
    findEquityEntry(submitted, position.instrument.symbol, position.quantity)
  );
}

/**
 * Entry basis for an option position: the account's own open lots where they
 * can be shown to describe it (ledgerOptionEntry), else the rebuild from
 * broker order history. `lots` are that account's open lots. Shared with the
 * dashboard (server.ts), so the sweep and the percent shown always agree.
 */
export function resolveOptionEntry(
  lots: readonly OpenOptionLot[],
  submitted: readonly Decision[],
  contract: OptionInstrument,
  openQuantity: number,
  orders: readonly BrokerOrder[] | null,
  mark: number | null
): number | null {
  const buys = pricedBuysNewestFirst(orders, contract);
  return (
    ledgerOptionEntry(lots, submitted, contract, openQuantity, buys.filter(mayHaveBought)) ??
    rebuildOptionEntry(submitted, contract, openQuantity, buys, mark)
  );
}

/**
 * The broker's buy orders of one contract that carry a price, newest first.
 * Robinhood reports an unfilled order's limit where a fill price would be, so
 * a price alone does not mean the order bought anything.
 */
function pricedBuysNewestFirst(
  orders: readonly BrokerOrder[] | null,
  contract: OptionInstrument
): BrokerOrder[] {
  return (orders ?? [])
    .filter(
      (o) =>
        o.side === 'buy' &&
        o.instrument.kind === 'option' &&
        o.instrument.symbol === contract.symbol &&
        o.instrument.optionType === contract.optionType &&
        Math.abs(o.instrument.strike - contract.strike) < 0.0001 &&
        o.instrument.expiration === contract.expiration &&
        o.fillPrice !== null
    )
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/**
 * False only for a buy the broker reports dead with nothing bought: it added
 * no contracts and never will, so it says nothing about what is held. An
 * order still working may fill between two reads, and a cancelled one may
 * have filled in part, so both count.
 */
function mayHaveBought(order: BrokerOrder): boolean {
  return order.quantity > 0 || !DEAD_ORDER_STATUSES.has(order.status?.toLowerCase() ?? '');
}

/**
 * Entry basis from the ledger, or null when the lots cannot be shown to
 * describe the position; the caller then rebuilds, exactly as before the
 * ledger was read. A lot's price was scaled once against its own order's
 * limit (fills.ts), which does not move; the rebuild rescales against today's
 * mark and reads a 1.59 fill reported as 159 as the entry once the mark
 * passes 5x it.
 *
 * A lot outlives its contracts when a Max Loss exit, a fired broker stop or a
 * sale in the broker's app closes them, a new buy is no lot until its fill is
 * read back, and a sell counts against its lot before it fills. So the lots
 * price the position only when all of this holds:
 *
 * - The broker's latest buy of the contract (`buys`, newest first) is the
 *   newest lot's own order. No such buy in the broker's history means the
 *   rebuild, which then reads only submitted limits and has no fill to misread.
 * - The newest lot still holds the whole position, and alone prices it. Or
 *   the books balance (booksBalance) and every lot prices what it holds. Or
 *   it is the only lot, and either its own order bought the whole position
 *   (a sell working against it, a fill not read back yet) or the rest was
 *   bought outside the system.
 * - Every lot used has a price to trust (hasTrustedPrice).
 *
 * ponytail: contracts bought outside the system before the only lot take
 * that lot's price; the basis is off by the real gap between those buys,
 * never by the 100x scale. "Outside" means no submitted order of ours in the
 * history read (ENTRY_HISTORY_LIMIT rows). Upgrade path: close a lot when its
 * contracts leave the account, and replay the broker's buys and sells.
 */
function ledgerOptionEntry(
  lots: readonly OpenOptionLot[],
  submitted: readonly Decision[],
  contract: OptionInstrument,
  openQuantity: number,
  buys: readonly BrokerOrder[]
): number | null {
  const ofContract = lots.filter((lot) => sameOption(lot, contract.symbol, contract)).reverse();
  const [newest] = ofContract;
  const [latestBuy, ...earlierBuys] = buys;
  if (!newest || !latestBuy?.orderId || newest.buyOrder.orderId !== latestBuy.orderId) return null;

  const newestCovers = newest.openQty >= openQuantity;
  if (!newestCovers) {
    const explained =
      ofContract.length > 1
        ? booksBalance(ofContract, submitted, openQuantity, earlierBuys)
        : latestBuy.quantity >= openQuantity ||
          !earlierBuys.some((buy) => submitted.some((d) => d.order!.orderId === buy.orderId));
    if (!explained) return null;
  }
  const priced = newestCovers ? [newest] : ofContract;
  if (!priced.every((lot) => hasTrustedPrice(lot, buys))) return null;
  const contracts = priced.reduce((sum, lot) => sum + lot.openQty, 0);
  return priced.reduce((sum, lot) => sum + lot.entryPrice * lot.openQty, 0) / contracts;
}

/**
 * True when several lots of one contract account for the position exactly,
 * with nothing that could hide a lot whose contracts are gone: the lots hold
 * what the account holds, each is filled in full, every contract they show
 * as sold was sold by a filled sell (a working or parked one is still held),
 * and every earlier buy the broker shows is one of them.
 */
function booksBalance(
  lots: readonly OpenOptionLot[],
  submitted: readonly Decision[],
  openQuantity: number,
  earlierBuys: readonly BrokerOrder[]
): boolean {
  const lotIds = new Set(lots.map((lot) => lot.lotId));
  const soldPerLots = lots.reduce((sum, lot) => sum + lot.originalQty - lot.openQty, 0);
  const soldAndFilled = submitted
    .filter((d) => d.order!.side === 'sell' && d.order!.status?.toLowerCase() === 'filled')
    .flatMap((d) => d.order!.lots ?? [])
    .filter((link) => lotIds.has(link.lotId))
    .reduce((sum, link) => sum + link.quantity, 0);
  return (
    lots.reduce((sum, lot) => sum + lot.openQty, 0) === openQuantity &&
    lots.every((lot) => lot.buyOrder.status?.toLowerCase() === 'filled') &&
    soldPerLots === soldAndFilled &&
    earlierBuys.every((buy) => lots.some((lot) => lot.buyOrder.orderId === buy.orderId))
  );
}

/**
 * A lot's price is trusted when it is a limit buy's stored fill no further
 * above the limit than MAX_FILL_TO_LIMIT, or, with no fill stored, a limit
 * the broker's own figure for that order bears out.
 *
 * ponytail: a market buy's lot has no price to trust. Its fill was scaled
 * with no limit to compare against (fills.ts), so the stored price can be
 * 100x off either way; a 0.15 premium stored as 15 would sell the position
 * at once. Ceiling: a position with a market buy among its lots keeps the
 * rebuild's misread. Upgrade path: scale a market fill against the mark read
 * when it fills, and store that.
 *
 * ponytail: a fill under about 2% of its limit, reported per contract, still
 * passes both checks 100x high. Upgrade path: apply the limit bound where
 * the fill is stored (fills.ts), so the lot never holds such a price.
 */
function hasTrustedPrice(lot: OpenOptionLot, buys: readonly BrokerOrder[]): boolean {
  const { limitPrice, averageFillPrice, orderId } = lot.buyOrder;
  if (limitPrice === null || !(lot.entryPrice > 0)) return false;
  if (averageFillPrice != null) return lot.entryPrice <= limitPrice * MAX_FILL_TO_LIMIT;
  // No fill was stored, so the lot's price is its limit: believed only next
  // to the broker's figure for the same order, read at either scale.
  const reported = buys.find((buy) => buy.orderId === orderId)?.fillPrice;
  return (
    reported != null &&
    [reported, reported / OPTION_MULTIPLIER].some(
      (fill) => Math.abs(limitPrice / fill - 1) <= LIMIT_STANDS_FOR_FILL_WITHIN
    )
  );
}

/**
 * Entry basis rebuilt from broker order history, for a contract the ledger
 * does not price (bought before the ledger, or outside the system): actual
 * fills first (average_price of filled buys from get_option_orders, newest
 * lots covering the open contracts), else the submitted limit premiums the
 * same way. Position rows carry no cost data, so fills are the best source.
 */
function rebuildOptionEntry(
  submitted: readonly Decision[],
  contract: OptionInstrument,
  openQuantity: number,
  bought: readonly BrokerOrder[],
  mark: number | null
): number | null {
  const fillLots = bought
    .filter((o) => o.status === null || o.status === 'filled')
    .map((o) => ({
      price: normalizeOptionPremium(o.fillPrice!, mark),
      quantity: o.quantity > 0 ? o.quantity : 1,
    }));
  return (
    weightedAverageEntry(fillLots, openQuantity) ??
    findOptionEntry(submitted, contract, openQuantity)
  );
}

/** Robinhood sometimes reports 159 when the premium is 1.59. */
export function normalizeOptionPremium(average: number, mark: number | null): number {
  if (mark !== null && mark > 0 && average / mark >= 20) return average / 100;
  if (mark === null && average > 20) return average / 100;
  return average;
}

function maxLossReason(order: SubmittedOrder, entry: number, mark: number): string {
  const contract =
    order.assetType === 'option' && order.option ? ` ${optionLabel(order.option)}` : '';
  return (
    `Max loss: sold ${order.quantity} ${order.symbol}${contract} ` +
    `at mark $${mark.toFixed(2)} (entry $${entry.toFixed(2)})`
  );
}
