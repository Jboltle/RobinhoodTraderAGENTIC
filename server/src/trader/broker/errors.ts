/**
 * The user's Robinhood session cannot serve a call right now: not authorized,
 * waiting on an interactive OAuth consent, or the connect timed out. Distinct
 * from a broker that answered — callers must never read this as "bad ticker".
 */
export class BrokerUnavailableError extends Error {
  override readonly name = 'BrokerUnavailableError';
}

/**
 * The broker was reached and has no usable quote for the symbol — the one
 * failure that really means "not a tradable ticker".
 */
export class SymbolNotFoundError extends Error {
  override readonly name = 'SymbolNotFoundError';
}

/**
 * A broker write was attempted on a read-only deployment
 * (TRADE_EXECUTION_MODE=read_only), or under paper_only on an account that is
 * not paper. Raised before any broker call, so a staging process can run the
 * whole pipeline and never place or cancel a real-money order.
 */
export class BrokerWritesDisabledError extends Error {
  override readonly name = 'BrokerWritesDisabledError';

  constructor(attempted: string) {
    super(`read-only deployment: would have ${attempted}`);
  }
}
