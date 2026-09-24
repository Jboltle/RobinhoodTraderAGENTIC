/**
 * In-memory TraderDb for route and pipeline tests.
 *
 * It stores rows the way Postgres does — keyed by user — and filters every
 * read by the `userId` it was handed, so a route that passes the wrong user
 * (or a hardcoded one) sees the wrong data and the test fails. It also records
 * every per-user call, which is what isolation.test.ts asserts against: no
 * endpoint may query a user id other than the caller's.
 */
import {
  EmbedLike,
  MAX_CONTENT_LENGTH,
  assembleMessageText,
  truncateSafe,
} from '../../shared/embedText.js';
import { TradeSettingsSchema, type Callout, type Decision, type ResolvedTradeSettings, type TradeSettings } from '../../shared/types.js';
import type {
  AuthUser,
  Caller,
  CalloutFeedStatus,
  MessageDisposition,
  PendingMessage,
  StoredCallout,
  StoredRecap,
  StoredRecapInsight,
  TraderDb,
} from '../db.js';
import type { PersistedState } from '../rh/types.js';

/** An in-memory `messages` row: capture columns + the trader's verdict marks. */
export interface FakeMessageRow {
  readonly messageId: string;
  readonly channelId: string;
  readonly channelName: string | null;
  readonly authorId: string;
  readonly authorName: string;
  readonly authorAvatarUrl: string | null;
  readonly content: string;
  readonly embeds: readonly Record<string, unknown>[];
  readonly sentAt: string;
  readonly deletedAt: string | null;
  readonly disposition: MessageDisposition | null;
  readonly parse: Callout | null;
  readonly processedAt: string | null;
  readonly claimedAt?: string | null;
  readonly claimedBy?: string | null;
}

/** Seed shape for messages rows; everything optional except identity + time. */
export type SeedMessage = Partial<FakeMessageRow> &
  Pick<FakeMessageRow, 'messageId' | 'sentAt'>;

const FEED_STATUS: Record<Exclude<MessageDisposition, 'recap'>, CalloutFeedStatus> = {
  callout: 'parsed',
  not_callout: 'not_callout',
  failed: 'failed',
  missed: 'skipped',
};

const DISPOSITION_FROM_FEED_STATUS: Record<CalloutFeedStatus, MessageDisposition> = {
  parsed: 'callout',
  not_callout: 'not_callout',
  failed: 'failed',
  skipped: 'missed',
};

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
  /** Emails a magic link was "sent" to, in order. */
  readonly magicLinksSent: string[];
  /** Register a bearer token that resolves to a user. */
  addUser(user: AuthUser, accessToken: string): void;
  seedSettings(userId: string, settings: TradeSettings): void;
  seedDecision(userId: string, decision: Decision): void;
  seedBrokerTokens(userId: string, state: PersistedState): void;
  /** Seed an already-judged message row from its feed shape. */
  seedCallout(callout: StoredCallout): void;
  /** Seed a raw messages row (unprocessed unless marks are given). */
  seedMessage(row: SeedMessage): void;
  /** Inspect a messages row (verdict marks included); null when unknown. */
  getMessage(messageId: string): FakeMessageRow | null;
  allowEmail(email: string): void;
}

export function createFakeDb(): FakeDb {
  const calls: ScopedCall[] = [];
  const magicLinksSent: string[] = [];
  const settings = new Map<string, ResolvedTradeSettings>();
  const trades: Array<{ userId: string; decision: Decision }> = [];
  const brokerTokens = new Map<string, PersistedState>();
  const messages = new Map<string, FakeMessageRow>();
  const callers = new Map<string, Caller>();
  const recaps = new Map<string, StoredRecap>();
  const recapInsights = new Map<number, StoredRecapInsight>();
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
    magicLinksSent,

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
      messages.set(callout.messageId, {
        messageId: callout.messageId,
        channelId: callout.channelId,
        channelName: callout.channelName,
        authorId: callout.authorId ?? '',
        authorName: callout.authorName,
        authorAvatarUrl: null,
        content: callout.content,
        embeds: callout.embeds,
        sentAt: callout.timestamp,
        deletedAt: null,
        disposition: DISPOSITION_FROM_FEED_STATUS[callout.parseStatus],
        parse: callout.parse,
        processedAt: callout.timestamp,
      });
    },
    seedMessage(row) {
      messages.set(row.messageId, {
        channelId: 'chan-001',
        channelName: null,
        authorId: 'author-001',
        authorName: 'Demon Alerts',
        authorAvatarUrl: null,
        content: '',
        embeds: [],
        deletedAt: null,
        disposition: null,
        parse: null,
        processedAt: null,
        ...row,
      });
    },
    getMessage(messageId) {
      return messages.get(messageId) ?? null;
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
      // Mirrors trades_user_message_uidx + ON CONFLICT DO NOTHING.
      if (trades.some((r) => r.userId === userId && r.decision.messageId === decision.messageId)) {
        return;
      }
      trades.push({ userId, decision });
      record('recordDecision', userId, undefined);
    },
    async resolvePendingApproval(userId, messageId, outcome) {
      const row = trades.find(
        (r) =>
          r.userId === userId &&
          r.decision.messageId === messageId &&
          r.decision.kind === 'pending_approval'
      );
      if (row) {
        row.decision = {
          ...row.decision,
          kind: outcome.kind,
          code: outcome.code,
          reason: outcome.reason,
          order: outcome.order,
        };
      }
      return record('resolvePendingApproval', userId, row !== undefined);
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
    async listUnprocessedMessages(limit) {
      return [...messages.values()]
        .filter((row) => row.processedAt === null)
        .sort((a, b) => a.sentAt.localeCompare(b.sentAt))
        .slice(0, limit)
        .map(
          (row): PendingMessage => ({
            messageId: row.messageId,
            channelId: row.channelId,
            channelName: row.channelName,
            authorId: row.authorId,
            authorName: row.authorName,
            authorAvatarUrl: row.authorAvatarUrl,
            content: row.content,
            embeds: row.embeds,
            sentAt: row.sentAt,
            deletedAt: row.deletedAt,
            disposition: row.disposition,
          })
        );
    },
    async setMessageDisposition(messageId, disposition, parse) {
      // Mirrors the real UPDATE, except a missing row is created so pipeline
      // tests can process bare envelopes and still assert the verdict.
      const existing = messages.get(messageId);
      messages.set(messageId, {
        channelId: 'chan-001',
        channelName: null,
        authorId: 'author-001',
        authorName: 'Demon Alerts',
        authorAvatarUrl: null,
        content: '',
        embeds: [],
        sentAt: new Date(0).toISOString(),
        deletedAt: null,
        processedAt: null,
        messageId,
        ...existing,
        disposition,
        parse,
      });
    },
    async claimMessage(messageId, instanceId, staleBefore) {
      const existing = messages.get(messageId);
      if (!existing || existing.processedAt !== null) return false;
      const claimedAt = existing.claimedAt ?? null;
      const claimable =
        claimedAt === null ||
        existing.claimedBy === instanceId ||
        Date.parse(claimedAt) < staleBefore.getTime();
      if (!claimable) return false;
      messages.set(messageId, {
        ...existing,
        claimedAt: new Date().toISOString(),
        claimedBy: instanceId,
      });
      return true;
    },
    async getMessageClaimant(messageId) {
      return messages.get(messageId)?.claimedBy ?? null;
    },
    async markMessageProcessed(messageId) {
      const existing = messages.get(messageId);
      if (existing) {
        messages.set(messageId, {
          ...existing,
          processedAt: new Date().toISOString(),
          claimedAt: null,
        });
      }
    },
    async listCallouts(limit) {
      return [...messages.values()]
        .filter((row) => row.disposition !== null && row.disposition !== 'recap')
        .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
        .slice(0, limit)
        .map(
          (row): StoredCallout => ({
            messageId: row.messageId,
            channelId: row.channelId,
            channelName: row.channelName,
            authorId: row.authorId,
            authorName: row.authorName,
            // Same read-time flatten the real listCallouts performs.
            content: truncateSafe(
              assembleMessageText({
                body: row.content,
                stickerNames: [],
                attachmentUrls: [],
                embeds: row.embeds as readonly EmbedLike[],
              }),
              MAX_CONTENT_LENGTH
            ),
            timestamp: row.sentAt,
            embeds: row.embeds,
            parse: row.parse,
            parseStatus: FEED_STATUS[row.disposition as Exclude<MessageDisposition, 'recap'>],
          })
        );
    },
    async upsertCaller(caller) {
      // Mirrors the real upsert: a null avatar never overwrites a stored one.
      const avatarUrl = caller.avatarUrl ?? callers.get(caller.authorId)?.avatarUrl ?? null;
      callers.set(caller.authorId, { ...caller, avatarUrl });
    },
    async listCallers() {
      return [...callers.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
    },
    async saveRecap(recap) {
      recaps.set(recap.messageId, recap);
    },
    async listRecapMetas(messageIds) {
      const metas = new Map<string, { messageId: string; contentHash: string; parserVersion: number }>();
      for (const id of messageIds) {
        const row = recaps.get(id);
        if (row) {
          metas.set(id, {
            messageId: row.messageId,
            contentHash: row.contentHash,
            parserVersion: row.parserVersion,
          });
        }
      }
      return metas;
    },
    async listRecapsSince(sinceDate) {
      return [...recaps.values()]
        .filter((r) => r.recapDate !== null && r.recapDate >= sinceDate)
        .sort((a, b) => a.recapDate!.localeCompare(b.recapDate!));
    },
    async latestRecapPostedAt() {
      const times = [...recaps.values()].map((r) => r.postedAt);
      return times.length ? times.sort().at(-1)! : null;
    },
    async listRecapsWithStaleParse(version) {
      return [...recaps.values()].filter((r) => r.parserVersion < version);
    },
    async getRecapInsight(windowDays) {
      return recapInsights.get(windowDays) ?? null;
    },
    async saveRecapInsight(insight) {
      recapInsights.set(insight.windowDays, insight);
    },

    // ---- Auth ----------------------------------------------------------------

    async isEmailAllowed(email) {
      return allowedEmails.has(email.trim().toLowerCase());
    },
    async ensureUser(email) {
      const normalized = email.trim().toLowerCase();
      if (usersByEmail.has(normalized)) return;
      const user: AuthUser = { id: `user-${usersByEmail.size + 1}`, email: normalized };
      usersByEmail.set(normalized, user);
    },
    async sendMagicLink(email) {
      const normalized = email.trim().toLowerCase();
      if (!usersByEmail.has(normalized)) throw new Error('no user to send a link to');
      magicLinksSent.push(normalized);
    },
    async findUserByEmail(email) {
      return usersByEmail.get(email.trim().toLowerCase()) ?? null;
    },
    async verifyAccessToken(token) {
      return usersByToken.get(token) ?? null;
    },
  };
}
