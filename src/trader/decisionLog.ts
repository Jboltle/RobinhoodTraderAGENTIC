import { EventEmitter } from 'node:events';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createLogger } from '../shared/logger.js';
import type { Decision } from '../shared/types.js';

const log = createLogger('trader:decisions');

const DEFAULT_RING_SIZE = 200;

/**
 * Append-only record of every pipeline decision, plus a small in-memory ring
 * buffer and pub/sub for live subscribers.
 *
 *  - `append(d)`      writes one JSONL line, pushes to the ring, and emits
 *                     `'decision'` to all subscribers.
 *  - `recent()`       returns the most recent decisions (cheapest possible
 *                     "first paint" for a dashboard).
 *  - `subscribe(fn)`  registers a live listener; returns an unsubscribe fn.
 *
 * Storage: JSONL today. To swap for SQLite/Postgres later, replace the
 * `appendFile` call with a row insert — nothing else changes.
 */
export class DecisionLog {
  private readonly emitter = new EventEmitter();
  private readonly ring: Decision[] = [];
  private dirEnsured = false;

  constructor(
    private readonly path: string,
    private readonly ringSize: number = DEFAULT_RING_SIZE
  ) {}

  async append(decision: Decision): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(dirname(this.path), { recursive: true });
      this.dirEnsured = true;
    }
    try {
      await appendFile(this.path, JSON.stringify(decision) + '\n', 'utf8');
    } catch (err) {
      log.error('failed to persist decision', { error: (err as Error).message });
    }

    this.ring.push(decision);
    if (this.ring.length > this.ringSize) this.ring.shift();
    this.emitter.emit('decision', decision);
  }

  /** Most recent decisions (newest last). Backed by the in-memory ring. */
  recent(limit?: number): readonly Decision[] {
    if (limit === undefined || limit >= this.ring.length) return this.ring.slice();
    return this.ring.slice(this.ring.length - limit);
  }

  /** Live subscribe. Returns an unsubscribe function. */
  subscribe(handler: (d: Decision) => void): () => void {
    this.emitter.on('decision', handler);
    return () => this.emitter.off('decision', handler);
  }
}
