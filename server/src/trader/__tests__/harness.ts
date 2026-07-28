/**
 * Shared wiring for the HTTP tests: a real Fastify app built by buildServer,
 * behind the real auth hook, over an in-memory db and stubbed broker sessions.
 *
 * Broker stubs are keyed by user id like the real registry, so a route that
 * reaches for the wrong user's Robinhood session gets that user's numbers and
 * the test notices.
 */
import { vi } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

import { TraderEvents } from '../events.js';
import type { MessageProcessor } from '../pipeline/index.js';
import type { McpRegistry, UserBroker } from '../rh/mcpRegistry.js';
import type { RobinhoodMcpClient } from '../rh/mcpClient.js';
import type { RobinhoodTools } from '../rh/tools.js';
import { buildServer } from '../server.js';
import { createFakeDb, type FakeDb } from './fakeDb.js';

export interface BrokerStubOptions {
  readonly connected?: boolean;
  readonly authPending?: boolean;
  readonly authUrl?: string | null;
  readonly portfolioValueUsd?: number;
  readonly equityPositions?: Array<{ symbol: string; quantity: number; raw: unknown }>;
  readonly optionPositions?: Array<{
    symbol: string;
    optionType: 'call' | 'put';
    strike: number;
    expiration: string;
    quantity: number;
    raw: unknown;
  }>;
  readonly quotePrice?: number;
  readonly markPrice?: number;
  readonly toolsOverrides?: Partial<RobinhoodTools>;
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly db: FakeDb;
  readonly events: TraderEvents;
  readonly brokers: McpRegistry;
  readonly process: ReturnType<typeof vi.fn>;
  /** Inject a request carrying this user's bearer token. */
  as(accessToken: string, options: InjectOptions): Promise<LightMyRequestResponse>;
  /** The stub session for a user, creating it if the test hasn't configured one. */
  brokerFor(userId: string): UserBroker;
  configureBroker(userId: string, options: BrokerStubOptions): void;
}

export function makeHarness(): Harness {
  const db = createFakeDb();
  const events = new TraderEvents();
  const stubs = new Map<string, UserBroker>();
  const configured = new Map<string, BrokerStubOptions>();

  const brokers: McpRegistry = {
    for(userId: string): UserBroker {
      let stub = stubs.get(userId);
      if (!stub) {
        stub = makeBrokerStub(userId, configured.get(userId) ?? {});
        stubs.set(userId, stub);
      }
      return stub;
    },
    existing: (userId: string) => stubs.get(userId),
    drop: (userId: string) => void stubs.delete(userId),
  };

  const process = vi.fn().mockResolvedValue(undefined);
  const processor: MessageProcessor = { process: process as MessageProcessor['process'] };
  const app = buildServer({ db, events, brokers, processor });

  return {
    app,
    db,
    events,
    brokers,
    process,
    as: (accessToken, options) =>
      app.inject({
        ...options,
        headers: { ...options.headers, authorization: `Bearer ${accessToken}` },
      }),
    brokerFor: (userId) => brokers.for(userId),
    configureBroker(userId, options) {
      configured.set(userId, options);
      stubs.set(userId, makeBrokerStub(userId, options));
    },
  };
}

function makeBrokerStub(userId: string, options: BrokerStubOptions): UserBroker {
  const mcp = {
    isConnected: vi.fn().mockReturnValue(options.connected ?? false),
    getPendingAuthUrl: vi.fn().mockReturnValue(options.authUrl ?? null),
    isAuthPending: vi.fn().mockReturnValue(options.authPending ?? false),
    submitAuthCode: vi.fn(),
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getTokenStatus: vi
      .fn()
      .mockResolvedValue({ state: 'missing', expiresInSec: null, hasRefreshToken: false }),
    getToolNames: vi.fn().mockReturnValue([]),
  } as unknown as RobinhoodMcpClient;

  const tools = {
    getBuyingPower: vi.fn().mockResolvedValue({
      amountUsd: 10_000,
      accountNumber: `acct-${userId}`,
      portfolioValueUsd: options.portfolioValueUsd ?? 0,
    }),
    getQuote: vi.fn().mockResolvedValue({ price: options.quotePrice ?? 150 }),
    getOptionsMarkPrice: vi.fn().mockResolvedValue({ markPrice: options.markPrice ?? 0.97 }),
    placeOrder: vi.fn().mockResolvedValue({ orderId: 'eq-001', status: 'queued' }),
    placeOptionsOrder: vi.fn().mockResolvedValue({ orderId: 'opt-001', status: 'queued' }),
    getPositions: vi
      .fn()
      .mockResolvedValue({ positions: options.equityPositions ?? [], raw: {} }),
    getOptionPositions: vi
      .fn()
      .mockResolvedValue({ positions: options.optionPositions ?? [], raw: {} }),
    ...options.toolsOverrides,
  } as unknown as RobinhoodTools;

  return { mcp, tools };
}
