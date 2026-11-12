/**
 * The order fence of a `paper_only` deployment (staging): which accounts may
 * receive an order there, and so what the deployment's mode is for one account.
 */
import type { TradeExecutionMode } from '../../shared/types.js';
import type { AccountRow } from './types.js';

/**
 * SnapTrade brokerage slugs that hold simulated money only, compared exactly
 * as SnapTrade writes them. A slug belongs here only when the brokerage it
 * names has no real-money accounts at all.
 */
export const PAPER_BROKERAGE_SLUGS: ReadonlySet<string> = new Set(['ALPACA-PAPER']);

/** A deployment mode once the account is known: `paper_only` has been decided either way. */
export type AccountExecutionMode = Exclude<TradeExecutionMode, 'paper_only'>;

/**
 * True only for an account that cannot hold real money. All three are
 * required: reached through SnapTrade, flagged paper by SnapTrade, and at a
 * brokerage on the allowlist. The flag alone is a third party's label, and
 * under `paper_only` this is all that stands between staging and a real order.
 */
export function isPaperAccount(account: AccountRow): boolean {
  if (account.adapter !== 'snaptrade' || account.isPaper !== true) return false;
  // Read as untyped data: the row's type is a promise made where it was loaded.
  const slug: unknown = (account.adapterData as { institutionSlug?: unknown } | null | undefined)?.institutionSlug;
  return typeof slug === 'string' && PAPER_BROKERAGE_SLUGS.has(slug);
}

/**
 * The deployment's mode as it applies to one account. Only `paper_only`
 * depends on the account: a paper account trades as its own settings say
 * (`immediate`), every other account is held as under `read_only`.
 */
export function executionModeFor(deployment: TradeExecutionMode, account: AccountRow): AccountExecutionMode {
  if (deployment !== 'paper_only') return deployment;
  return isPaperAccount(account) ? 'immediate' : 'read_only';
}
