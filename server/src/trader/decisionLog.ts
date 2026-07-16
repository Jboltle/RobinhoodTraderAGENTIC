import { EventEmitter } from 'node:events';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createLogger } from '../shared/logger.js';
import type { Decision } from '../shared/types.js';

const log = createLogger('trader:decisions');

/**
 * Live trade-lifecycle stage for the dashboard. Ephemeral (never persisted):
 * 'done' means the pipeline finished and the outcome is in the decision log.
 */
export interface StageEvent {
  readonly messageId: string;
  readonly ticker: string | null;
  readonly stage: 'received' | 'parsing' | 'risk_check' | 'executing' | 'done';
  readonly at: string;
}

/**
 * Append-only JSONL record of every pipeline decision.
 *
 * Storage is JSONL today. To swap for SQLite/Postgres later, replace the
 * `appendFile` call with a row insert — nothing else changes.
 *
 * Emits `'decision'` after each successful append so the SSE stream can push
 * live updates. ponytail: in-process EventEmitter — enough for this
 * single-process service; upgrade path is a real pub/sub if it ever shards.
 */
export class DecisionLog extends EventEmitter {
  private dirEnsured = false;

  constructor(private readonly path: string) {
    super();
  }

  /**
   * Broadcast a live lifecycle stage to SSE listeners. Reuses this emitter
   * because it is already the only in-process channel between the pipeline
   * and the stream route — no persistence, no new wiring.
   */
  emitStage(event: Omit<StageEvent, 'at'>): void {
    this.emit('stage', { ...event, at: new Date().toISOString() } satisfies StageEvent);
  }

  async append(decision: Decision): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(dirname(this.path), { recursive: true });
      this.dirEnsured = true;
    }
    try {
      await appendFile(this.path, JSON.stringify(decision) + '\n', 'utf8');
      this.emit('decision', decision);
    } catch (err) {
      log.error('failed to persist decision', { error: (err as Error).message });
    }
  }

  /** All decisions in append order; unparseable lines are skipped. */
  async readAll(): Promise<Decision[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('failed to read decision log', { error: (err as Error).message });
      }
      return [];
    }
    const decisions: Decision[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        decisions.push(JSON.parse(line) as Decision);
      } catch {
        log.warn('skipping unparseable decision log line');
      }
    }
    return decisions;
  }
}
