import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createLogger } from '../shared/logger.js';
import type { Decision } from '../shared/types.js';

const log = createLogger('trader:decisions');

/**
 * Append-only JSONL record of every pipeline decision.
 *
 * Storage is JSONL today. To swap for SQLite/Postgres later, replace the
 * `appendFile` call with a row insert — nothing else changes.
 */
export class DecisionLog {
  private dirEnsured = false;

  constructor(private readonly path: string) {}

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
  }
}
