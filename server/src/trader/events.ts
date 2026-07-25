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

/**
 * In-process fan-out from the pipeline to connected dashboards.
 *
 * Subscription is per user by construction — there is no way to listen to
 * every user's events, so an SSE connection cannot leak another account's
 * trades. ponytail: a plain EventEmitter, so this only reaches dashboards
 * attached to *this* process; upgrade path is real pub/sub if it ever shards.
 */
export class TraderEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener pair per connected dashboard, and a user may have several
    // tabs open; the default limit of 10 is not a leak signal here.
    this.emitter.setMaxListeners(0);
  }

  emitStage(userId: string, event: Omit<StageEvent, 'at'>): void {
    this.emitter.emit(`stage:${userId}`, { ...event, at: new Date().toISOString() });
  }

  emitDecision(userId: string, decision: Decision): void {
    this.emitter.emit(`decision:${userId}`, decision);
  }

  /** Subscribe to one user's events. Returns the unsubscribe function. */
  subscribe(userId: string, handlers: UserEventHandlers): () => void {
    const stageKey = `stage:${userId}`;
    const decisionKey = `decision:${userId}`;
    const { onStage, onDecision } = handlers;
    if (onStage) this.emitter.on(stageKey, onStage);
    if (onDecision) this.emitter.on(decisionKey, onDecision);
    return () => {
      if (onStage) this.emitter.off(stageKey, onStage);
      if (onDecision) this.emitter.off(decisionKey, onDecision);
    };
  }
}
