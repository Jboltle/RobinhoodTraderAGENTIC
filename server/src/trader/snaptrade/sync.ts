/**
 * What a SnapTrade sync writes: one `accounts` row per brokerage account that
 * may take orders. Pure, so the rules are tested without a database; the
 * write itself is TraderDb.syncSnapTradeAccounts.
 */
import type { SnapTradeAdapterData } from '../broker/types.js';
import type { SnapTradeAccount, SnapTradeConnection } from './client.js';

const TRADE_CONNECTION_TYPE = 'trade';
/**
 * "SnapTrade Sandbox": a simulator that every Personal key has connected by
 * default. It lists fake accounts and cannot place a trade.
 */
const SANDBOX_BROKERAGE_SLUG = 'SANDBOX';
const UNNAMED_ACCOUNT = 'Account';
const MASKED_NUMBER_DIGITS = 4;

/** The columns a sync writes on an account row, new or existing. */
export interface SnapTradeAccountRow {
  readonly externalAccountId: string;
  /** The brokerage slug in our own form: 'alpaca-paper'. */
  readonly institution: string;
  readonly label: string;
  readonly isPaper: boolean;
  readonly needsReconnect: boolean;
  readonly adapterData: SnapTradeAdapterData;
}

export interface SnapTradeSyncPlan {
  readonly rows: SnapTradeAccountRow[];
  readonly skippedReadOnlyConnections: number;
  readonly skippedSandboxConnections: number;
  /** Trade connections SnapTrade lists no account for (yet: its list is cached daily). */
  readonly connectionsAwaitingAccounts: number;
}

/** Tells two accounts at one broker apart: 'Alpaca Paper · Individual (…1234)'. */
function accountLabel(connection: SnapTradeConnection, account: SnapTradeAccount): string {
  const name = `${connection.brokerageName} · ${account.displayName?.trim() || UNNAMED_ACCOUNT}`;
  const lastDigits = account.maskedAccountNumber?.slice(-MASKED_NUMBER_DIGITS);
  return lastDigits ? `${name} (…${lastDigits})` : name;
}

export function planSnapTradeSync(
  connections: readonly SnapTradeConnection[],
  accounts: readonly SnapTradeAccount[]
): SnapTradeSyncPlan {
  // ponytail: the sandbox is left out by its slug. Upgrade path: if SnapTrade
  // adds another simulator, skip on the brokerage's `allows_trading` instead.
  const sandbox = connections.filter((connection) => connection.brokerageSlug === SANDBOX_BROKERAGE_SLUG);
  const real = connections.filter((connection) => !sandbox.includes(connection));
  const trading = real.filter((connection) => connection.type === TRADE_CONNECTION_TYPE);

  // Keyed by SnapTrade's account id, so an account listed twice is one row.
  const rows = new Map<string, SnapTradeAccountRow>();
  const connectionsWithAccounts = new Set<string>();
  for (const account of accounts) {
    const connection = trading.find((candidate) => candidate.id === account.connectionId);
    if (connection === undefined) continue;
    connectionsWithAccounts.add(connection.id);
    rows.set(account.id, {
      externalAccountId: account.id,
      institution: connection.brokerageSlug.toLowerCase(),
      label: accountLabel(connection, account),
      isPaper: account.isPaper,
      needsReconnect: connection.disabled,
      adapterData: {
        connectionId: connection.id,
        institutionSlug: connection.brokerageSlug,
        maskedAccountNumber: account.maskedAccountNumber,
      },
    });
  }

  return {
    rows: [...rows.values()],
    skippedReadOnlyConnections: real.length - trading.length,
    skippedSandboxConnections: sandbox.length,
    connectionsAwaitingAccounts: trading.filter((connection) => !connectionsWithAccounts.has(connection.id)).length,
  };
}
