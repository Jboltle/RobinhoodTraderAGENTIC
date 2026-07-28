/**
 * In-memory TraderDb for route and pipeline tests.
 *
 * It stores rows the way Postgres does — keyed by user — and filters every
 * read by the `userId` it was handed, so a route that passes the wrong user
 * (or a hardcoded one) sees the wrong data and the test fails. It also records
 * every per-user call, which is what isolation.test.ts asserts against: no
 * endpoint may query a user id other than the caller's.
 */
import { TradeSettingsSchema, type Decision, type ResolvedTradeSettings, type TradeSettings } from '../../shared/types.js';
import type { AuthUser, StoredCallout, TraderDb } from '../db.js';
import type { PersistedState } from '../rh/types.js';

export interface ScopedCall {
  readonly method: string;
  readonly userId: string;
}

/** A stored broker connection, shaped like what the MCP SDK persists. */
export const fakeTokens = (accessToken: string, refreshToken?: string): PersistedState => ({
  tokens: {
    access_token: accessToken,
    token_type: 'Bearer',
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  },
});

export interface FakeDb extends TraderDb {
  /** Every per-user query this db has served, in order. */
  readonly calls: ScopedCall[];
  /** Register a bearer token that resolves to a user. */
  addUser(user: AuthUser, accessToken: string): void;
  seedSettings(userId: string, settings: TradeSettings): void;
  seedDecision(userId: string, decision: Decision): void;
  seedBrokerTokens(userId: string, state: PersistedState): void;
  seedCallout(callout: StoredCallout): void;
  allowEmail(email: string): void;
}

export function createFakeDb(): FakeDb {
  const calls: ScopedCall[] = [];
  const settings = new Map<string, ResolvedTradeSettings>();
  const trades: Array<{ userId: string; decision: Decision }> = [];
  const brokerTokens = new Map<string, PersistedState>();
  const callouts = new Map<string, StoredCallout>();
  const allowedEmails = new Set<string>();
  const usersByToken = new Map<string, AuthUser>();
  const usersByEmail = new Map<string, AuthUser>();

  const record = <T>(method: string, userId: string, value: T): T => {
    calls.push({ method, userId });
    return value;
  };
  const decisionsFor = (userId: string): Decision[] =>
    trades.filter((row) => row.userId === userId).map((row) => row.decision);

  return {
    calls,

    addUser(user, accessToken) {
      usersByToken.set(accessToken, user);
      if (user.email) usersByEmail.set(user.email.toLowerCase(), user);
    },
    seedSettings(userId, value) {
      settings.set(userId, TradeSettingsSchema.parse(value));
    },
    seedDecision(userId, decision) {
      trades.push({ userId, decision });
    },
    seedBrokerTokens(userId, state) {
      brokerTokens.set(userId, state);
    },
    seedCallout(callout) {
      callouts.set(callout.messageId, callout);
    },
    allowEmail(email) {
      allowedEmails.add(email.toLowerCase());
    },

    // ---- Per-user ------------------------------------------------------------

    async getSettings(userId) {
      return record('getSettings', userId, settings.get(userId) ?? TradeSettingsSchema.parse({}));
    },
    async saveSettings(userId, value) {
      const parsed = TradeSettingsSchema.parse(value);
      settings.set(userId, parsed);
      return record('saveSettings', userId, parsed);
    },
    async listDecisions(userId, limit) {
      const newestFirst = [...decisionsFor(userId)].sort((a, b) => b.at.localeCompare(a.at));
      return record('listDecisions', userId, newestFirst.slice(0, limit));
    },
    async recordDecision(userId, decision) {
      trades.push({ userId, decision });
      record('recordDecision', userId, undefined);
    },
    async decisionsByMessageId(userId, messageIds) {
      const wanted = new Set(messageIds);
      const found = new Map<string, Decision>();
      for (const decision of decisionsFor(userId)) {
        if (wanted.has(decision.messageId)) found.set(decision.messageId, decision);
      }
      return record('decisionsByMessageId', userId, found);
    },
    async countSubmittedSince(userId, since) {
      const count = decisionsFor(userId).filter(
        (d) => d.kind === 'submitted' && Date.parse(d.at) >= since.getTime()
      ).length;
      return record('countSubmittedSince', userId, count);
    },
    async lastSubmittedAt(userId, ticker) {
      const times = decisionsFor(userId)
        .filter((d) => d.kind === 'submitted' && d.ticker === ticker.toUpperCase())
        .map((d) => Date.parse(d.at));
      return record('lastSubmittedAt', userId, times.length ? new Date(Math.max(...times)) : null);
    },
    async getBrokerTokens(userId) {
      return record('getBrokerTokens', userId, brokerTokens.get(userId) ?? null);
    },
    async saveBrokerTokens(userId, state) {
      brokerTokens.set(userId, state);
      record('saveBrokerTokens', userId, undefined);
    },
    async deleteBrokerTokens(userId) {
      brokerTokens.delete(userId);
      record('deleteBrokerTokens', userId, undefined);
    },

    // ---- Shared --------------------------------------------------------------

    async listBrokerUserIds() {
      return [...brokerTokens.keys()];
    },
    async getCallout(messageId) {
      return callouts.get(messageId) ?? null;
    },
    async saveCallout(callout) {
      callouts.set(callout.messageId, callout);
    },
    async listCallouts(limit) {
      return [...callouts.values()]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, limit);
    },

    // ---- Auth ----------------------------------------------------------------

    async isEmailAllowed(email) {
      return allowedEmails.has(email.trim().toLowerCase());
    },
    async createUser(email, _password) {
      const normalized = email.trim().toLowerCase();
      if (usersByEmail.has(normalized)) throw new Error('user already exists');
      const user: AuthUser = { id: `user-${usersByEmail.size + 1}`, email: normalized };
      usersByEmail.set(normalized, user);
      return user;
    },
    async findUserByEmail(email) {
      return usersByEmail.get(email.trim().toLowerCase()) ?? null;
    },
    async verifyAccessToken(token) {
      return usersByToken.get(token) ?? null;
    },
  };
}
