/**
 * A fake of the SDK calls the SnapTrade adapter makes, for every test that
 * puts the real adapter in front of it. It records each call, so a test can
 * count what a path costs against SnapTrade's request budget. No test builds
 * the SDK client: nothing here can reach SnapTrade whatever the environment holds.
 */
import type {
  AccountOrderRecord,
  AllAccountPositionsResponse,
  Balance,
  CancelOrderResponse,
  MlegOrderResponse,
  RecentOrdersResponse,
  SymbolsQuotesInner,
} from 'snaptrade-typescript-sdk';

import type { SnapTradeBrokerClient } from '../broker.js';

/** What each call answers. Read when the call is made, so a test may change it between calls. */
export interface FakeSnapTradeAnswers {
  balances?: Balance[];
  positions?: AllAccountPositionsResponse;
  orders?: RecentOrdersResponse;
  quotes?: SymbolsQuotesInner[];
  optionOrder?: MlegOrderResponse;
  equityOrder?: AccountOrderRecord;
  cancel?: CancelOrderResponse;
  /** When the key is present, thrown by every call in place of an answer. */
  failure?: unknown;
}

export type RecordedCall = readonly [call: string, request: unknown];

export interface FakeSnapTradeClient {
  readonly client: SnapTradeBrokerClient;
  /** Every SDK call made, in order. */
  readonly calls: RecordedCall[];
  readonly answers: FakeSnapTradeAnswers;
}

export function fakeSnapTradeClient(answers: FakeSnapTradeAnswers = {}): FakeSnapTradeClient {
  const calls: RecordedCall[] = [];
  const answer =
    <T>(name: string, data: () => T | undefined) =>
    async (request: unknown): Promise<{ data: T }> => {
      calls.push([name, request]);
      if ('failure' in answers) throw answers.failure;
      const answered = data();
      if (answered === undefined) throw new Error(`the test gave no answer for ${name}`);
      return { data: answered };
    };
  const client: SnapTradeBrokerClient = {
    accountInformation: {
      getUserAccountBalance: answer('accountInformation.getUserAccountBalance', () => answers.balances),
      getAllAccountPositions: answer('accountInformation.getAllAccountPositions', () => answers.positions),
      getUserAccountRecentOrders: answer('accountInformation.getUserAccountRecentOrders', () => answers.orders),
    },
    trading: {
      getUserAccountQuotes: answer('trading.getUserAccountQuotes', () => answers.quotes),
      placeMlegOrder: answer('trading.placeMlegOrder', () => answers.optionOrder),
      placeForceOrder: answer('trading.placeForceOrder', () => answers.equityOrder),
      cancelOrder: answer('trading.cancelOrder', () => answers.cancel),
    },
  };
  return { client, calls, answers };
}

/** The names of the calls made, in order: what a path cost in requests. */
export const callNames = (fake: FakeSnapTradeClient): string[] => fake.calls.map(([name]) => name);
