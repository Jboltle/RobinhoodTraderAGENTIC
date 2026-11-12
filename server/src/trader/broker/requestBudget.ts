/**
 * Accounts whose broker meters requests.
 *
 * SnapTrade allows 10 requests a minute per account, reads and writes
 * together, and its SDK answers a refusal (HTTP 429) by sleeping 5, 10, then
 * 20 seconds inside the call. So nothing reads such an account on a timer:
 * its orders are read only while one is working, its dashboard figures are
 * kept between polls, and the sweeps that would read it every 15 seconds
 * leave it out. What is left of the budget is the callouts'.
 */
import type { AccountRow } from './types.js';

export const isRequestMetered = (account: AccountRow): boolean => account.adapter === 'snaptrade';

/** The least time between two order reads of a metered account, made only while it has an order working: 4 a minute. */
export const METERED_ORDER_READ_INTERVAL_MS = 15_000;

/** How long a metered account's dashboard figures are served from memory before its broker is read again. */
export const METERED_DASHBOARD_READ_INTERVAL_MS = 120_000;

/**
 * Whether a read of the account may be made now, recording it when it may. A
 * metered account is due once `intervalMs` has passed since its last read; any
 * other account always is. The read counts from when it is made, so one that
 * fails is not made again any sooner.
 */
export function readIsDue(
  account: AccountRow,
  lastReadAt: Map<string, number>,
  nowMs: number,
  intervalMs: number
): boolean {
  if (!isRequestMetered(account)) return true;
  const last = lastReadAt.get(account.id);
  if (last !== undefined && nowMs - last < intervalMs) return false;
  lastReadAt.set(account.id, nowMs);
  return true;
}

export interface SpacedRead<T> {
  /** `fresh()`, or for a metered account its last answer while that is younger than the interval. */
  read(account: AccountRow, fresh: () => Promise<T>): Promise<T>;
  /** The account's next read asks its broker again. */
  forget(accountId: string): void;
}

/**
 * One kind of read, spaced per metered account and shared by everyone who
 * asks for it. A failed read is kept like any other: asking again at once
 * would spend the budget the failure may have come from.
 * ponytail: one entry per metered account read this process lifetime, never
 * pruned. Upgrade path: drop an entry when its account disconnects.
 */
export function createSpacedRead<T>(intervalMs: number, now: () => number = Date.now): SpacedRead<T> {
  const lastReadAt = new Map<string, number>();
  const answers = new Map<string, Promise<T>>();
  return {
    read(account, fresh) {
      const kept = answers.get(account.id);
      if (!readIsDue(account, lastReadAt, now(), intervalMs) && kept !== undefined) return kept;
      const answer = fresh();
      if (isRequestMetered(account)) answers.set(account.id, answer);
      return answer;
    },
    forget(accountId) {
      lastReadAt.delete(accountId);
      answers.delete(accountId);
    },
  };
}
