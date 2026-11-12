/**
 * Book monitor: a process-lifetime loop that prices every open tracked
 * callout against a live mark, fills its simulated ladder, and settles
 * contracts past expiry. Same shape as the Max Loss loop (maxLoss.ts).
 *
 * Marks are borrowed from ONE connected user's Robinhood session: the book is
 * shared data and quotes are the same for everyone, so the shared quote source
 * (broker/quotes.ts) picks the session that serves the whole book this sweep.
 * Each mark is read live rather than from that source's 15 s cache: the sweep
 * runs on the same 15 s, and a cached price would be re-applied every other
 * sweep. Read-only, so it runs under every TRADE_EXECUTION_MODE.
 *
 * ponytail: quotes are fetched one contract at a time (two MCP calls each),
 * which is ~30 contracts per 15 s sweep before a sweep overruns its interval.
 * Upgrade path: resolve instruments once per contract and quote them in one
 * get_option_quotes call.
 */
import { createLogger, errorFields } from '../../shared/logger.js';
import type { TraderDb } from '../db.js';
import type { TraderEvents } from '../events.js';
import { isRegularUsTradingHours } from '../pipeline/riskFilter.js';
import { instrumentOf } from '../broker/instrument.js';
import type { QuoteSource } from '../broker/quotes.js';
import type { Broker } from '../broker/types.js';
import {
  applyMark,
  isExpired,
  isoDateEt,
  marketCloseIso,
  settle,
  type TrackedPosition,
} from './ladder.js';

const log = createLogger('trader:book-monitor');

export const BOOK_INTERVAL_MS = 15_000;

export interface BookMonitorDeps {
  readonly db: TraderDb;
  readonly quotes: QuoteSource;
  readonly events: TraderEvents;
  readonly now?: () => Date;
}

export interface BookSweepResult {
  readonly open: number;
  readonly marked: number;
  readonly settled: number;
}

/** Boot + interval. Returns a stop function for tests. */
export function startBookMonitor(deps: BookMonitorDeps): () => void {
  const tick = (): void => {
    void sweepBook(deps).catch((err: unknown) =>
      log.error('book sweep failed', errorFields(err))
    );
  };
  tick();
  const timer = setInterval(tick, BOOK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * One pass: settle what has expired (any hour), then during regular hours
 * mark what is still open. One book event per sweep that changed anything.
 */
export async function sweepBook(deps: BookMonitorDeps): Promise<BookSweepResult> {
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  const today = isoDateEt(now);

  const open = await deps.db.listTrackedOpen();
  if (open.length === 0) return { open: 0, marked: 0, settled: 0 };

  let settled = 0;
  const live: TrackedPosition[] = [];
  for (const position of open) {
    if (!isExpired(position, today)) {
      live.push(position);
      continue;
    }
    await deps.db.saveTrackedCallout(settle(position, marketCloseIso(position.option.expiration)));
    settled += 1;
  }

  let marked = 0;
  if (live.length > 0 && isRegularUsTradingHours(now)) {
    const broker = await deps.quotes.broker();
    if (broker === null) {
      log.warn('no connected broker session to quote the book', { open: live.length });
    } else {
      for (const position of live) {
        const mark = await markFor(broker, position);
        if (mark === null) continue;
        await deps.db.saveTrackedCallout(applyMark(position, mark, at));
        marked += 1;
      }
    }
  }

  if (settled > 0 || marked > 0) deps.events.emitBook();
  return { open: open.length, marked, settled };
}

function markFor(broker: Broker, position: TrackedPosition): Promise<number | null> {
  return broker
    .getMark(instrumentOf({ symbol: position.ticker, assetType: 'option', option: position.option }))
    .catch(() => null);
}
