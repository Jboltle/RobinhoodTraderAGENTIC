/**
 * Shared wiring for the HTTP tests: a real Fastify app built by buildServer,
 * behind the real auth hook, over an in-memory db and stubbed broker sessions.
 *
 * Broker stubs are keyed by user id like the real registry, so a route that
 * reaches for the wrong user's Robinhood session gets that user's numbers and
 * the test notices.
 */
import { vi, type Mock } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

import type { OptionType, TradeExecutionMode } from '../../shared/types.js';
import { TraderEvents } from '../events.js';
import { createMcpRegistry, type McpRegistry } from '../broker/registry.js';
import type {
  Broker,
  BrokerAdapter,
  BrokerOrder,
  BrokerPosition,
  Instrument,
  OptionInstrument,
  OrderRequest,
  UserBroker,
} from '../broker/types.js';
import type { RobinhoodMcpClient } from '../robinhood/mcpClient.js';
import { buildServer } from '../server.js';
import { createFakeDb, type FakeDb } from './fakeDb.js';

// =============================================================================
// The one fake broker every test file shares
// =============================================================================

const FAKE_BUYING_POWER_USD = 10_000;
const FAKE_EQUITY_PRICE = 150;
const FAKE_OPTION_MARK = 0.97;

/** A fixed answer, or a function of what was asked (to vary it, or to throw). */
type Answer<T, Asked> = T | ((asked: Asked) => T | Promise<T>);

export interface FakeBrokerOptions {
  readonly buyingPowerUsd?: number;
  readonly portfolioValueUsd?: number | null;
  /** Equity and option rows together; getPositions(kind) filters them. */
  readonly positions?: readonly BrokerPosition[];
  /** Stock price, asked by symbol. */
  readonly equityMark?: Answer<number | null, string>;
  /** Contract mark; null means the broker cannot price it. */
  readonly optionMark?: Answer<number | null, OptionInstrument>;
  readonly orders?: readonly BrokerOrder[] | null;
  /** Replace a port method outright: a rejection, a sequence of answers. */
  readonly overrides?: Partial<Broker>;
}

export type FakeBroker = { readonly [Method in keyof Broker]: Mock<Broker[Method]> };

const answer = <T, Asked>(configured: Answer<T, Asked>, asked: Asked): T | Promise<T> =>
  typeof configured === 'function'
    ? (configured as (asked: Asked) => T | Promise<T>)(asked)
    : configured;

export function makeFakeBroker(options: FakeBrokerOptions = {}): FakeBroker {
  const positions = options.positions ?? [];
  const equityMark = options.equityMark ?? FAKE_EQUITY_PRICE;
  const optionMark = options.optionMark === undefined ? FAKE_OPTION_MARK : options.optionMark;
  const fake: FakeBroker = {
    getAccount: vi.fn<Broker['getAccount']>(async () => ({
      buyingPowerUsd: options.buyingPowerUsd ?? FAKE_BUYING_POWER_USD,
      portfolioValueUsd: options.portfolioValueUsd === undefined ? 0 : options.portfolioValueUsd,
    })),
    getMark: vi.fn<Broker['getMark']>(async (instrument) =>
      instrument.kind === 'equity'
        ? answer(equityMark, instrument.symbol)
        : answer(optionMark, instrument)
    ),
    confirmInstrument: vi.fn<Broker['confirmInstrument']>(async () => undefined),
    getPositions: vi.fn<Broker['getPositions']>(async (kind) =>
      kind === undefined ? positions : positions.filter((p) => p.instrument.kind === kind)
    ),
    getOrders: vi.fn<Broker['getOrders']>(async () => options.orders ?? null),
    placeOrder: vi.fn<Broker['placeOrder']>(async (order) => ({
      orderId: order.instrument.kind === 'equity' ? 'eq-001' : 'opt-001',
      status: 'queued',
    })),
    cancelOrder: vi.fn<Broker['cancelOrder']>(async () => undefined),
  };
  return { ...fake, ...(options.overrides as Partial<FakeBroker>) };
}

export const equityPosition = (
  symbol: string,
  quantity: number,
  averageEntryPrice: number | null = null
): BrokerPosition => ({ instrument: { kind: 'equity', symbol }, quantity, averageEntryPrice });

export const optionPosition = (
  symbol: string,
  optionType: OptionType,
  strike: number,
  expiration: string,
  quantity: number
): BrokerPosition => ({
  instrument: { kind: 'option', symbol, optionType, strike, expiration },
  quantity,
  averageEntryPrice: null,
});

/** The orders placed for stock or for contracts, in order. */
export const placedOrders = (broker: FakeBroker, kind: Instrument['kind']): OrderRequest[] =>
  broker.placeOrder.mock.calls.map(([order]) => order).filter((order) => order.instrument.kind === kind);

/** The instruments priced, for stock or for contracts, in order. */
export const markReads = (broker: FakeBroker, kind: Instrument['kind']): Instrument[] =>
  broker.getMark.mock.calls.map(([instrument]) => instrument).filter((asked) => asked.kind === kind);

/** The production registry over fake sessions and brokers. */
export const makeFakeRegistry = (
  open: BrokerAdapter['open'],
  executionMode: TradeExecutionMode = 'immediate'
): McpRegistry => createMcpRegistry({ quotesOptions: true, open }, executionMode);

// =============================================================================
// HTTP harness
// =============================================================================

export interface BrokerStubOptions extends FakeBrokerOptions {
  readonly connected?: boolean;
  readonly authPending?: boolean;
  readonly authUrl?: string | null;
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly db: FakeDb;
  readonly events: TraderEvents;
  readonly brokers: McpRegistry;
  /** Inject a request carrying this user's bearer token. */
  as(accessToken: string, options: InjectOptions): Promise<LightMyRequestResponse>;
  /** The stub session for a user, creating it if the test hasn't configured one. */
  brokerFor(userId: string): UserBroker;
  /** That user's fake broker, for asserting what the app asked of it. */
  fakeBroker(userId: string): FakeBroker;
  configureBroker(userId: string, options: BrokerStubOptions): void;
}

export interface HarnessOptions {
  /** Deployment kill switch under test; defaults to the mode that lets Approve submit. */
  readonly executionMode?: TradeExecutionMode;
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const db = createFakeDb();
  const events = new TraderEvents();
  const configured = new Map<string, BrokerStubOptions>();
  const fakes = new Map<string, FakeBroker>();
  const executionMode = options.executionMode ?? 'immediate';

  const brokers = makeFakeRegistry((userId) => {
    const options = configured.get(userId) ?? {};
    const broker = makeFakeBroker(options);
    fakes.set(userId, broker);
    return { session: makeSessionStub(options), broker };
  }, executionMode);

  const app = buildServer({ db, events, brokers, executionMode });

  return {
    app,
    db,
    events,
    brokers,
    as: (accessToken, options) =>
      app.inject({
        ...options,
        headers: { ...options.headers, authorization: `Bearer ${accessToken}` },
      }),
    brokerFor: (userId) => brokers.for(userId),
    fakeBroker(userId) {
      brokers.for(userId);
      return fakes.get(userId)!;
    },
    // Replaces the user's session at once, as a (re)connect does.
    configureBroker(userId, options) {
      configured.set(userId, options);
      brokers.drop(userId);
      brokers.for(userId);
    },
  };
}

function makeSessionStub(options: BrokerStubOptions): RobinhoodMcpClient {
  return {
    isConnected: vi.fn().mockReturnValue(options.connected ?? false),
    getPendingAuthUrl: vi.fn().mockReturnValue(options.authUrl ?? null),
    isAuthPending: vi.fn().mockReturnValue(options.authPending ?? false),
    submitAuthCode: vi.fn(),
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    ensureReady: vi.fn().mockResolvedValue(undefined),
    getTokenStatus: vi
      .fn()
      .mockResolvedValue({ state: 'missing', hasRefreshToken: false }),
    getToolNames: vi.fn().mockReturnValue([]),
  } as unknown as RobinhoodMcpClient;
}
