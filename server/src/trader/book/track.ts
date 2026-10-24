/**
 * The pipeline's hook into the tracked-callout book: a Caller's Buy opens a
 * tracked position, their Trim or Sell records an exit against it.
 *
 * Bookkeeping only, off the trade path: a failure here is logged and never
 * delays or changes anyone's order.
 */
import { createLogger } from '../../shared/logger.js';
import { optionLabel, type Callout, type DiscordEnvelope } from '../../shared/types.js';
import type { TraderDb } from '../db.js';
import type { TraderEvents } from '../events.js';
import { applyCallerExit, openPosition } from './ladder.js';

const log = createLogger('trader:book');

export interface TrackDeps {
  readonly db: TraderDb;
  readonly events: TraderEvents;
}

export async function trackCallout(
  deps: TrackDeps,
  envelope: DiscordEnvelope,
  callout: Callout
): Promise<void> {
  const { ticker, option } = callout;
  if (ticker === null || option === null) return;
  try {
    // A Caller's Average extends their own position; it opens nothing new and
    // the ladder stays as built off the original entry.
    if (callout.action === 'buy' && !callout.isAddition) {
      await deps.db.openTrackedCallout(
        openPosition({
          messageId: envelope.messageId,
          authorId: envelope.authorId,
          ticker,
          option,
          entryPrice: callout.limitPrice,
          sizeHint: callout.sizeHint,
          openedAt: envelope.timestamp,
        })
      );
      deps.events.emitBook();
      return;
    }
    if (callout.action === 'sell') {
      const open = await deps.db.findTrackedOpen(envelope.authorId, ticker, option);
      if (open === null) {
        log.info('exit matched no tracked entry', {
          messageId: envelope.messageId,
          authorId: envelope.authorId,
          contract: `${ticker} ${optionLabel(option)}`,
        });
        return;
      }
      const next = applyCallerExit(open, {
        at: envelope.timestamp,
        price: callout.limitPrice,
        portion: callout.exitPortion ?? { kind: 'all' },
        messageId: envelope.messageId,
      });
      if (next === open) return;
      await deps.db.saveTrackedCallout(next);
      deps.events.emitBook();
    }
  } catch (err: unknown) {
    log.error('could not track callout', {
      messageId: envelope.messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
