/**
 * The SnapTrade calls the connect flow makes, behind an interface a test can
 * fake. Order placing is not here: it is the adapter's (./adapter.ts).
 *
 * The key is a SnapTrade *Personal* key: it is the owner's own SnapTrade
 * login, so there is no registered user, user id or user secret, and only the
 * owner's dashboard sign-in may use it (SnapTradeAccess.ownerEmail).
 *
 * The real client is built once, in trader/index.ts, and handed to the server
 * as a dependency. Nothing else constructs it, so a test never reaches
 * SnapTrade whatever the environment holds.
 */
import { Snaptrade, SnaptradeAuth } from 'snaptrade-typescript-sdk';

const TRADE_CONNECTION_TYPE = 'trade';
const PORTAL_VERSION = 'v4';
/** The one kind of SnapTrade account that holds positions and takes orders. */
const INVESTMENT_ACCOUNT_KIND = 'investment';

/** A brokerage login the owner made in the Connection Portal. */
export interface SnapTradeConnection {
  readonly id: string;
  /** SnapTrade's own slug, e.g. 'ALPACA-PAPER'. */
  readonly brokerageSlug: string;
  /** What the brokerage is called on screen, e.g. 'Alpaca Paper'. */
  readonly brokerageName: string;
  /** 'trade' may place orders; 'read' may not. */
  readonly type: string;
  /** The brokerage login broke; the owner has to repair it in the portal. */
  readonly disabled: boolean;
}

/** One brokerage account under a connection. */
export interface SnapTradeAccount {
  readonly id: string;
  readonly connectionId: string;
  readonly displayName: string | null;
  /** Last four digits only; SnapTrade gives no full number. */
  readonly maskedAccountNumber: string | null;
  readonly isPaper: boolean;
}

export interface SnapTradeClient {
  /**
   * A fresh Connection Portal link, for any broker the owner picks there, or
   * to repair one connection. It expires five minutes after it is issued, so
   * ask for it when the portal is about to open and never earlier.
   */
  portalLink(reconnectConnectionId?: string): Promise<string>;
  listConnections(): Promise<SnapTradeConnection[]>;
  /**
   * Investment accounts across every connection. SnapTrade serves this from a
   * daily cache: a connection made a moment ago may list no account yet.
   */
  listAccounts(): Promise<SnapTradeAccount[]>;
}

/** The client and the one dashboard sign-in allowed to use it. */
export interface SnapTradeAccess {
  readonly client: SnapTradeClient;
  readonly ownerEmail: string;
}

export interface SnapTradeKeys {
  readonly clientId: string | null;
  readonly consumerKey: string | null;
  readonly ownerEmail: string | null;
}

/** Null when any of the three is absent: the feature is then off, not broken. */
export function createSnapTradeAccess(keys: SnapTradeKeys): SnapTradeAccess | null {
  const { clientId, consumerKey, ownerEmail } = keys;
  if (!clientId || !consumerKey || !ownerEmail) return null;
  return { client: createSnapTradeClient(clientId, consumerKey), ownerEmail };
}

function createSnapTradeClient(clientId: string, consumerKey: string): SnapTradeClient {
  const sdk = new Snaptrade({ auth: SnaptradeAuth.personalApiKey({ clientId, consumerKey }) });

  return {
    async portalLink(reconnectConnectionId) {
      const login = await sdk.authentication.loginSnapTradeUser({
        connectionType: TRADE_CONNECTION_TYPE,
        connectionPortalVersion: PORTAL_VERSION,
        ...(reconnectConnectionId === undefined ? {} : { reconnect: reconnectConnectionId }),
      });
      const link = 'redirectURI' in login.data ? login.data.redirectURI : undefined;
      if (!link) throw new Error('SnapTrade answered without a Connection Portal link');
      return link;
    },

    async listConnections() {
      const { data } = await sdk.connections.listBrokerageAuthorizations();
      return data.flatMap((connection): SnapTradeConnection[] => {
        const { id, brokerage } = connection;
        // Neither is ever absent in practice; a connection without them could
        // not be matched to an account or told apart from the sandbox.
        if (!id || !brokerage?.slug) return [];
        return [
          {
            id,
            brokerageSlug: brokerage.slug,
            brokerageName: brokerage.display_name ?? brokerage.name ?? brokerage.slug,
            type: connection.type ?? '',
            disabled: connection.disabled === true,
          },
        ];
      });
    },

    async listAccounts() {
      const { data } = await sdk.accountInformation.listAllUserAccounts();
      return (data.results ?? []).flatMap((account): SnapTradeAccount[] =>
        account.kind === INVESTMENT_ACCOUNT_KIND
          ? [
              {
                id: account.id,
                connectionId: account.connection_id,
                displayName: account.display_name ?? null,
                maskedAccountNumber: account.masked_account_number ?? null,
                isPaper: account.is_paper,
              },
            ]
          : []
      );
    },
  };
}
