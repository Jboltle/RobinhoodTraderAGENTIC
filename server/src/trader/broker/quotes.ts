/**
 * The shared quote source. A contract's price is the same for everyone, so one
 * connected session that can quote options serves every reader that has no
 * account of its own to ask: the entry check on a fresh callout and the
 * tracked-callout book. Read-only, so it runs under every TRADE_EXECUTION_MODE.
 *
 * This is the swap point for a market-data feed later.
 */
import type { TraderDb } from '../db.js';
import { BrokerUnavailableError } from './errors.js';
import { instrumentKey } from './instrument.js';
import type { McpRegistry } from './registry.js';
import type { Broker, Instrument } from './types.js';

/** How long getMark keeps serving a price before asking the broker again. */
export const MARK_CACHE_MS = 15_000;

/** Which user's session served quotes last; tried first next time. */
export interface QuoteSessionState {
  preferredUserId: string | null;
}

export interface QuoteSource {
  /**
   * The first connected user's ready session whose broker quotes options, the
   * last one that worked first. Null when there is none. A session that needs
   * consent is skipped, not started: reaching for a disconnected user's broker
   * would begin an OAuth flow nobody asked for.
   *
   * Reads through it are live; whatever decides an order reads here.
   */
  broker(): Promise<Broker | null>;
  /**
   * The instrument's price, at most MARK_CACHE_MS old. Null when no session
   * can price it right now; a missing price is never remembered.
   */
  getMark(instrument: Instrument): Promise<number | null>;
}

export interface QuoteSourceDeps {
  readonly db: Pick<TraderDb, 'listBrokerUserIds'>;
  readonly brokers: McpRegistry;
  readonly now?: () => Date;
}

interface CachedMark {
  readonly price: number;
  readonly readAt: number;
}

export function createQuoteSource(
  deps: QuoteSourceDeps,
  state: QuoteSessionState = { preferredUserId: null }
): QuoteSource {
  // ponytail: never pruned — one small entry per instrument priced this
  // process lifetime, and two readers missing at once both ask the broker.
  // Upgrade path: drop expired entries on a timer and share the in-flight read.
  const marks = new Map<string, CachedMark>();

  async function broker(): Promise<Broker | null> {
    const userIds = await deps.db.listBrokerUserIds();
    const ordered =
      state.preferredUserId !== null && userIds.includes(state.preferredUserId)
        ? [state.preferredUserId, ...userIds.filter((id) => id !== state.preferredUserId)]
        : userIds;
    for (const userId of ordered) {
      const candidate = deps.brokers.for(userId);
      if (!candidate.quotesOptions) continue;
      try {
        await candidate.session.ensureReady();
        state.preferredUserId = userId;
        return candidate.broker;
      } catch (err) {
        if (!(err instanceof BrokerUnavailableError)) throw err;
      }
    }
    state.preferredUserId = null;
    return null;
  }

  async function getMark(instrument: Instrument): Promise<number | null> {
    const key = instrumentKey(instrument);
    const now = (deps.now?.() ?? new Date()).getTime();
    const cached = marks.get(key);
    if (cached !== undefined && now - cached.readAt < MARK_CACHE_MS) return cached.price;

    const source = await broker();
    if (source === null) return null;
    const price = await source.getMark(instrument).catch(() => null);
    if (price !== null) marks.set(key, { price, readAt: now });
    return price;
  }

  return { broker, getMark };
}
