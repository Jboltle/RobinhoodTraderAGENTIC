/**
 * In-memory TraderDb for route and pipeline tests.
 *
 * It stores rows the way Postgres does — keyed by account — and filters every
 * read by the `accountId` it was handed, so a route that passes the wrong
 * account (or a hardcoded one) sees the wrong data and the test fails. It also
 * records every scoped call, which is what isolation.test.ts asserts against:
 * no endpoint may query an id other than the caller's.
 *
 * A user's first account takes the user's own id unless the test names another
 * (addUser's third argument), so a single-account fixture needs one identifier.
 * Tests about the user/account distinction give the two different ids.
 */
import { createHash } from 'node:crypto';

import {
  EmbedLike,
  MAX_CONTENT_LENGTH,
  assembleMessageText,
  truncateSafe,
} from '../../shared/embedText.js';
import { openOptionLots } from '../lots.js';
import {
  TradeSettingsSchema,
  isTerminalOrderState,
  type Callout,
  type Decision,
  type ResolvedTradeSettings,
  type TradeSettings,
} from '../../shared/types.js';
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
import type { PersistedState } from '../robinhood/types.js';
import { optionLabel } from '../../shared/types.js';
import type { TrackedPosition } from '../book/ladder.js';
import type { AccountRow } from '../broker/types.js';

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
  readonly replyToMessageId?: string | null;
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
  /** The account id the call was scoped to. */
  readonly scopeId: string;
}

/** A direct Robinhood account row, owned by the user of the same id unless told otherwise. */
export const fakeAccount = (id: string, userId: string = id): AccountRow => ({
  id,
  userId,
  adapter: 'robinhood',
  institution: 'robinhood',
  externalAccountId: null,
  label: 'Robinhood',
  isPaper: false,
  needsReconnect: false,
  adapterData: {},
});

/** A stored broker connection, shaped like what the MCP SDK persists. */
export const fakeTokens = (accessToken: string, refreshToken?: string): PersistedState => ({
  tokens: {
    access_token: accessToken,
    token_type: 'Bearer',
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  },
});

export interface FakeDb extends TraderDb {
  /** Every scoped query this db has served, in order. */
  readonly calls: ScopedCall[];
  /**
   * Register a user with a never-expiring session for `accessToken`, and their
   * direct Robinhood account (selected), whose id is the user's unless given.
   */
  addUser(user: AuthUser, accessToken: string, accountId?: string): void;
  /** Add a further account to its user; `select` makes it the one their routes act on. */
  addAccount(account: AccountRow, options?: { readonly select?: boolean }): void;
  /**
   * Write users.selected_account_id as a bad row would hold it: an id the
   * user does not own, or null where the selected account was deleted.
   */
  corruptSelection(userId: string, accountId: string | null): void;
  /** The account row for an id, created as a direct Robinhood account when unknown. */
  account(accountId: string): AccountRow;
  seedSettings(accountId: string, settings: TradeSettings): void;
  seedDecision(accountId: string, decision: Decision): void;
  seedBrokerTokens(accountId: string, state: PersistedState): void;
  /** Seed an already-judged message row from its feed shape. */
  seedCallout(callout: StoredCallout): void;
  /** Seed a raw messages row (unprocessed unless marks are given). */
  seedMessage(row: SeedMessage): void;
  /** Inspect a messages row (verdict marks included); null when unknown. */
  getMessage(messageId: string): FakeMessageRow | null;
  /** Put an email on the invite list. */
  allowEmail(email: string): void;
  /** Inspect a tracked callout row; null when unknown. */
  getTracked(messageId: string): TrackedPosition | null;
}

export function createFakeDb(): FakeDb {
  const calls: ScopedCall[] = [];
  /** Account id -> row, in creation order. */
  const accounts = new Map<string, AccountRow>();
  /** User id -> the account their routes act on. */
  const selectedAccounts = new Map<string, string>();
  const settings = new Map<string, ResolvedTradeSettings>();
  const trades: Array<{ accountId: string; decision: Decision }> = [];
  const brokerTokens = new Map<string, PersistedState>();
  const messages = new Map<string, FakeMessageRow>();
  const callers = new Map<string, Caller>();
  const recaps = new Map<string, StoredRecap>();
  const recapInsights = new Map<number, StoredRecapInsight>();
  const tracked = new Map<string, TrackedPosition>();
  const usersByEmail = new Map<string, AuthUser>();
  const allowedEmails = new Set<string>();
  /** Bearer token -> session; a null expiry never ends (addUser's tokens). */
  const sessions = new Map<string, { user: AuthUser; expiresAt: Date | null }>();

  const record = <T>(method: string, scopeId: string, value: T): T => {
    calls.push({ method, scopeId });
    return value;
  };
  const decisionsFor = (accountId: string): Decision[] =>
    trades.filter((row) => row.accountId === accountId).map((row) => row.decision);
  // The selected account, or the user's oldest when that selection is not theirs.
  const selectedAccountOf = (userId: string): AccountRow | null => {
    const selected = accounts.get(selectedAccounts.get(userId) ?? '');
    if (selected?.userId === userId) return selected;
    return [...accounts.values()].find((account) => account.userId === userId) ?? null;
  };
  // Seeding or opening an account nobody registered creates it, as the
  // pipeline and monitor tests do: they never sign a user in.
  const ensureAccount = (accountId: string): AccountRow => {
    const existing = accounts.get(accountId);
    if (existing) return existing;
    const created = fakeAccount(accountId);
    accounts.set(accountId, created);
    if (!selectedAccounts.has(created.userId)) selectedAccounts.set(created.userId, accountId);
    return created;
  };
  const feedRows = (limit: number): FakeMessageRow[] =>
    [...messages.values()]
      .filter((row) => row.disposition !== null && row.disposition !== 'recap')
      .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
      .slice(0, limit);

  return {
    calls,

    addUser(user, accessToken, accountId = user.id) {
      sessions.set(accessToken, { user, expiresAt: null });
      if (user.email) usersByEmail.set(user.email.toLowerCase(), user);
      accounts.set(accountId, fakeAccount(accountId, user.id));
      selectedAccounts.set(user.id, accountId);
    },
    addAccount(account, options = {}) {
      accounts.set(account.id, account);
      if (options.select || !selectedAccounts.has(account.userId)) {
        selectedAccounts.set(account.userId, account.id);
      }
    },
    corruptSelection(userId, accountId) {
      if (accountId === null) selectedAccounts.delete(userId);
      else selectedAccounts.set(userId, accountId);
    },
    account: ensureAccount,
    seedSettings(accountId, value) {
      ensureAccount(accountId);
      settings.set(accountId, TradeSettingsSchema.parse(value));
    },
    seedDecision(accountId, decision) {
      ensureAccount(accountId);
      trades.push({ accountId, decision });
    },
    seedBrokerTokens(accountId, state) {
      ensureAccount(accountId);
      brokerTokens.set(accountId, state);
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
    getTracked(messageId) {
      return tracked.get(messageId) ?? null;
    },

    // ---- Per-account ---------------------------------------------------------

    async getSettings(accountId) {
      return record('getSettings', accountId, settings.get(accountId) ?? TradeSettingsSchema.parse({}));
    },
    async saveSettings(accountId, value) {
      const parsed = TradeSettingsSchema.parse(value);
      settings.set(accountId, parsed);
      return record('saveSettings', accountId, parsed);
    },
    async listDecisions(accountId, limit) {
      const newestFirst = [...decisionsFor(accountId)].sort((a, b) => b.at.localeCompare(a.at));
      return record('listDecisions', accountId, newestFirst.slice(0, limit));
    },
    async listOpenOptionLots(accountId) {
      const rows = trades
        .filter((row) => row.accountId === accountId)
        .map((row) => ({
          id: row.decision.messageId,
          messageId: row.decision.messageId,
          action: row.decision.action,
          authorId: messages.get(row.decision.messageId)?.authorId ?? null,
          at: row.decision.at,
          order: row.decision.order,
        }));
      return record('listOpenOptionLots', accountId, openOptionLots(rows));
    },
    async recordDecision(accountId, decision) {
      // Mirrors trades_account_message_uidx + ON CONFLICT DO NOTHING.
      if (trades.some((r) => r.accountId === accountId && r.decision.messageId === decision.messageId)) {
        return;
      }
      trades.push({ accountId, decision });
      record('recordDecision', accountId, undefined);
    },
    async resolvePendingApproval(accountId, messageId, outcome) {
      const row = trades.find(
        (r) =>
          r.accountId === accountId &&
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
      return record('resolvePendingApproval', accountId, row !== undefined);
    },
    async updateOrder(accountId, messageId, order) {
      const row = trades.find((r) => r.accountId === accountId && r.decision.messageId === messageId);
      if (row) row.decision = { ...row.decision, order };
      record('updateOrder', accountId, undefined);
    },
    async decisionsByMessageId(accountId, messageIds) {
      const wanted = new Set(messageIds);
      const found = new Map<string, Decision>();
      for (const decision of decisionsFor(accountId)) {
        if (wanted.has(decision.messageId)) found.set(decision.messageId, decision);
      }
      return record('decisionsByMessageId', accountId, found);
    },
    async feedVersion(accountId, limit) {
      const rows = feedRows(limit);
      const ids = new Set(rows.map((row) => row.messageId));
      const decisions = decisionsFor(accountId).filter((d) => ids.has(d.messageId));
      const version = createHash('md5')
        .update(JSON.stringify([accountId, rows, decisions]))
        .digest('hex');
      return record('feedVersion', accountId, version);
    },
    async countSubmittedSince(accountId, since) {
      const count = decisionsFor(accountId).filter(
        (d) => d.kind === 'submitted' && Date.parse(d.at) >= since.getTime()
      ).length;
      return record('countSubmittedSince', accountId, count);
    },
    async lastSubmittedAt(accountId, ticker) {
      const times = decisionsFor(accountId)
        .filter((d) => d.kind === 'submitted' && d.ticker === ticker.toUpperCase())
        .map((d) => Date.parse(d.at));
      return record('lastSubmittedAt', accountId, times.length ? new Date(Math.max(...times)) : null);
    },
    async getBrokerTokens(accountId) {
      return record('getBrokerTokens', accountId, brokerTokens.get(accountId) ?? null);
    },
    async saveBrokerTokens(accountId, state) {
      brokerTokens.set(accountId, state);
      record('saveBrokerTokens', accountId, undefined);
    },
    async deleteBrokerTokens(accountId) {
      brokerTokens.delete(accountId);
      record('deleteBrokerTokens', accountId, undefined);
    },

    // ---- Shared --------------------------------------------------------------

    async listConnectedAccounts() {
      return [...brokerTokens.keys()].map(ensureAccount);
    },
    async listOpenOrders(since) {
      return trades
        .filter(
          ({ decision }) =>
            (decision.kind === 'submitted' || decision.kind === 'max_loss_exit') &&
            Date.parse(decision.at) >= since.getTime() &&
            decision.order?.orderId != null &&
            !isTerminalOrderState(decision.order.status)
        )
        .sort((a, b) => a.decision.at.localeCompare(b.decision.at))
        .map(({ accountId, decision }) => ({ accountId, decision }));
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
            replyToMessageId: row.replyToMessageId ?? null,
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
    async listenForMessages() {
      return false;
    },
    async listCallouts(limit) {
      return feedRows(limit).map(
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
    async listCallerEntries(authorId, ticker, before, limit) {
      return [...messages.values()]
        .filter(
          (row) =>
            row.authorId === authorId &&
            row.disposition === 'callout' &&
            row.parse?.action === 'buy' &&
            row.parse.ticker === ticker.toUpperCase() &&
            Date.parse(row.sentAt) < before.getTime()
        )
        .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
        .slice(0, limit)
        .flatMap((row) => (row.parse ? [row.parse] : []));
    },
    async getMessageParse(messageId) {
      const row = messages.get(messageId);
      return row?.disposition === 'callout' && row.parse ? { authorId: row.authorId, parse: row.parse } : null;
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
    async openTrackedCallout(position) {
      if (!tracked.has(position.messageId)) tracked.set(position.messageId, position);
    },
    async saveTrackedCallout(position) {
      if (tracked.has(position.messageId)) tracked.set(position.messageId, position);
    },
    async listTrackedOpen() {
      return [...tracked.values()]
        .filter((p) => p.closedAt === null)
        .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
    },
    async findTrackedOpen(authorId, ticker, option) {
      return (
        [...tracked.values()]
          .filter(
            (p) =>
              p.closedAt === null &&
              p.authorId === authorId &&
              p.ticker === ticker.toUpperCase() &&
              optionLabel(p.option) === optionLabel(option)
          )
          .sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0] ?? null
      );
    },
    async listTrackedClosedSince(since) {
      return [...tracked.values()]
        .filter((p) => p.closedAt !== null && (since === null || Date.parse(p.closedAt) >= since.getTime()))
        .sort((a, b) => b.closedAt!.localeCompare(a.closedAt!));
    },

    // ---- Auth ----------------------------------------------------------------

    async userForSignIn(email) {
      const normalized = email.trim().toLowerCase();
      const existing = usersByEmail.get(normalized);
      if (existing) return existing;
      if (!allowedEmails.has(normalized)) return null;
      const created: AuthUser = { id: `user-${usersByEmail.size + 1}`, email: normalized };
      usersByEmail.set(normalized, created);
      ensureAccount(created.id);
      return created;
    },
    async getSelectedAccount(userId) {
      return selectedAccountOf(userId);
    },
    async listAccounts(userId) {
      return [...accounts.values()]
        .filter((account) => account.userId === userId)
        .map((account) => {
          const resolved = settings.get(account.id) ?? TradeSettingsSchema.parse({});
          return {
            account,
            connected: brokerTokens.has(account.id),
            executionMode: resolved.executionMode,
            followedCallerIds: resolved.followedCallerIds,
          };
        });
    },
    async selectAccount(userId, accountId) {
      // Mirrors the real UPDATE: matched among this user's own accounts only.
      if (accounts.get(accountId)?.userId !== userId) return false;
      selectedAccounts.set(userId, accountId);
      return true;
    },
    async createSession(userId, token, expiresAt) {
      const user = [...usersByEmail.values()].find((candidate) => candidate.id === userId);
      if (!user) throw new Error(`no user ${userId}`);
      sessions.set(token, { user, expiresAt });
    },
    async deleteSession(token) {
      sessions.delete(token);
    },
    async findUserByEmail(email) {
      return usersByEmail.get(email.trim().toLowerCase()) ?? null;
    },
    async verifyAccessToken(token) {
      const session = sessions.get(token);
      if (!session) return null;
      if (session.expiresAt !== null && session.expiresAt <= new Date()) return null;
      return { user: session.user, account: selectedAccountOf(session.user.id) };
    },
  };
}
