/**
 * Book monitor: a process-lifetime loop that prices every open tracked
 * callout against a live mark, fills its simulated ladder, and settles
 * contracts past expiry. Same shape as the Max Loss loop (maxLoss.ts).
 *
 * Marks are borrowed from ONE connected user's Robinhood session: the book is
 * shared data and quotes are the same for everyone, so the first session that
 * is ready this sweep serves the whole book. Read-only, so it runs under every
 * TRADE_EXECUTION_MODE.
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
import { BrokerUnavailableError } from '../rh/mcpClient.js';
import type { McpRegistry } from '../rh/mcpRegistry.js';
import type { RobinhoodTools } from '../rh/tools.js';
import { applyMark, isExpired, isoDateEt, settle, type TrackedPosition } from './ladder.js';

const log = createLogger('trader:book-monitor');

export const BOOK_INTERVAL_MS = 15_000;

export interface BookMonitorDeps {
  readonly db: TraderDb;
  readonly brokers: McpRegistry;
  readonly events: TraderEvents;
  readonly now?: () => Date;
}

export interface BookSweepResult {
  readonly open: number;
  readonly marked: number;
  readonly settled: number;
}

/** Which user's session served quotes last; tried first next sweep. */
export interface QuoteSessionState {
  preferredUserId: string | null;
}

/** Boot + interval. Returns a stop function for tests. */
export function startBookMonitor(deps: BookMonitorDeps): () => void {
  const state: QuoteSessionState = { preferredUserId: null };
  const tick = (): void => {
    void sweepBook(deps, state).catch((err: unknown) =>
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
export async function sweepBook(
  deps: BookMonitorDeps,
  state: QuoteSessionState = { preferredUserId: null }
): Promise<BookSweepResult> {
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
    await deps.db.saveTrackedCallout(settle(position, at));
    settled += 1;
  }

  let marked = 0;
  if (live.length > 0 && isRegularUsTradingHours(now)) {
    const tools = await quoteSession(deps, state);
    if (tools === null) {
      log.warn('no connected broker session to quote the book', { open: live.length });
    } else {
      for (const position of live) {
        const mark = await markFor(tools, position);
        if (mark === null) continue;
        await deps.db.saveTrackedCallout(applyMark(position, mark, at));
        marked += 1;
      }
    }
  }

  if (settled > 0 || marked > 0) deps.events.emitBook();
  return { open: open.length, marked, settled };
}

/**
 * The first connected user's ready session, the last one that worked first.
 * A session that needs consent is skipped, not started: reaching for a
 * disconnected user's broker would begin an OAuth flow nobody asked for.
 */
async function quoteSession(
  deps: BookMonitorDeps,
  state: QuoteSessionState
): Promise<RobinhoodTools | null> {
  const userIds = await deps.db.listBrokerUserIds();
  const ordered =
    state.preferredUserId !== null && userIds.includes(state.preferredUserId)
      ? [state.preferredUserId, ...userIds.filter((id) => id !== state.preferredUserId)]
      : userIds;
  for (const userId of ordered) {
    const broker = deps.brokers.for(userId);
    try {
      await broker.mcp.ensureReady();
      state.preferredUserId = userId;
      return broker.tools;
    } catch (err) {
      if (!(err instanceof BrokerUnavailableError)) throw err;
    }
  }
  state.preferredUserId = null;
  return null;
}

async function markFor(tools: RobinhoodTools, position: TrackedPosition): Promise<number | null> {
  const { option } = position;
  const quote = await tools
    .getOptionsMarkPrice(position.ticker, option.optionType, option.strike, option.expiration)
    .catch(() => null);
  return quote?.markPrice ?? null;
}
