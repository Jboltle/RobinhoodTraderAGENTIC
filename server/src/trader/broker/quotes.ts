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
import { READY_TIMEOUT_MS } from '../robinhood/mcpClient.js';
import type { McpRegistry } from './registry.js';
import type { Broker, Instrument } from './types.js';

/** How long getMark keeps serving a price before asking the broker again. */
export const MARK_CACHE_MS = 15_000;

/** Which account's session served quotes last; tried first next time. */
export interface QuoteSessionState {
  preferredAccountId: string | null;
}

export interface QuoteSource {
  /**
   * The first connected account's ready session whose broker quotes options,
   * the last one that worked first. Null when there is none. A session that
   * needs consent is skipped, not started: reaching for a disconnected
   * account's broker would begin an OAuth flow nobody asked for.
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
  readonly db: Pick<TraderDb, 'listConnectedAccounts'>;
  readonly brokers: McpRegistry;
  readonly now?: () => Date;
}

interface CachedMark {
  readonly price: number;
  readonly readAt: number;
}

export function createQuoteSource(
  deps: QuoteSourceDeps,
  state: QuoteSessionState = { preferredAccountId: null }
): QuoteSource {
  // ponytail: never pruned — one small entry per instrument priced this
  // process lifetime, and two readers missing at once both ask the broker.
  // Upgrade path: drop expired entries on a timer and share the in-flight read.
  const marks = new Map<string, CachedMark>();

  async function broker(): Promise<Broker | null> {
    const accounts = await deps.db.listConnectedAccounts();
    const preferred = accounts.find((account) => account.id === state.preferredAccountId);
    const ordered = preferred
      ? [preferred, ...accounts.filter((account) => account !== preferred)]
      : accounts;
    // One ready timeout for the whole pick, not one per stalled session: the
    // entry check waits here on the serial poller, ahead of every queued exit.
    // A connected session answers at once whatever is left of it.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (const account of ordered) {
      try {
        const candidate = deps.brokers.for(account);
        if (!candidate.quotesOptions) continue;
        await candidate.session.ensureReady(Math.max(0, deadline - Date.now()));
        state.preferredAccountId = account.id;
        return candidate.broker;
      } catch (err) {
        if (!(err instanceof BrokerUnavailableError)) throw err;
      }
    }
    state.preferredAccountId = null;
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
