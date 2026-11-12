import { EventEmitter } from 'node:events';

import type { Decision } from '../shared/types.js';

/**
 * Live trade-lifecycle stage for the dashboard. Ephemeral (never persisted):
 * 'done' means the pipeline finished and the outcome is in the trades table.
 */
export interface StageEvent {
  readonly messageId: string;
  readonly ticker: string | null;
  readonly stage: 'received' | 'parsing' | 'risk_check' | 'executing' | 'done';
  readonly at: string;
}

export interface UserEventHandlers {
  readonly onStage?: (event: StageEvent) => void;
  readonly onDecision?: (decision: Decision) => void;
}

/** The shared tracked-callout book changed (a mark, a fill, an open or a close). */
export interface BookEvent {
  readonly at: string;
}

/**
 * In-process fan-out from the pipeline to connected dashboards.
 *
 * Subscription is per account by construction — there is no way to listen to
 * every account's events, so an SSE connection cannot leak another account's
 * trades. The one exception is the book event: the tracked-callout book is
 * shared data (Caller entries, not anyone's trades), so it is process-wide.
 * ponytail: a plain EventEmitter, so this only reaches dashboards
 * attached to *this* process; upgrade path is real pub/sub if it ever shards.
 */
export class TraderEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener pair per connected dashboard, and a user may have several
    // tabs open; the default limit of 10 is not a leak signal here.
    this.emitter.setMaxListeners(0);
  }

  emitStage(accountId: string, event: Omit<StageEvent, 'at'>): void {
    this.emitter.emit(`stage:${accountId}`, { ...event, at: new Date().toISOString() });
  }

  emitDecision(accountId: string, decision: Decision): void {
    this.emitter.emit(`decision:${accountId}`, decision);
  }

  emitBook(): void {
    this.emitter.emit('book', { at: new Date().toISOString() } satisfies BookEvent);
  }

  /** Subscribe to book changes (shared, not per account). Returns the unsubscribe function. */
  subscribeBook(onBook: (event: BookEvent) => void): () => void {
    this.emitter.on('book', onBook);
    return () => this.emitter.off('book', onBook);
  }

  /** Subscribe to one account's events. Returns the unsubscribe function. */
  subscribe(accountId: string, handlers: UserEventHandlers): () => void {
    const stageKey = `stage:${accountId}`;
    const decisionKey = `decision:${accountId}`;
    const { onStage, onDecision } = handlers;
    if (onStage) this.emitter.on(stageKey, onStage);
    if (onDecision) this.emitter.on(decisionKey, onDecision);
    return () => {
      if (onStage) this.emitter.off(stageKey, onStage);
      if (onDecision) this.emitter.off(decisionKey, onDecision);
    };
  }
}
