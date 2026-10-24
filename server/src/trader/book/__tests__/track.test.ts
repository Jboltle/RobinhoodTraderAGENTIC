import { describe, expect, it, vi } from 'vitest';

import type { Callout, DiscordEnvelope } from '../../../shared/types.js';
import { createFakeDb } from '../../__tests__/fakeDb.js';
import { TraderEvents } from '../../events.js';
import { trackCallout } from '../track.js';

const CONTRACT = { optionType: 'call' as const, strike: 680, expiration: '2026-10-23' };

const envelope = (messageId: string, timestamp: string): DiscordEnvelope => ({
  messageId,
  channelId: 'chan-1',
  guildId: null,
  authorId: 'harvey',
  authorName: 'Harvey',
  authorAvatarUrl: null,
  content: '',
  timestamp,
});

const callout = (overrides: Partial<Callout>): Callout => ({
  isCallout: true,
  assetType: 'option',
  action: 'buy',
  ticker: 'SPY',
  orderType: 'limit',
  isAddition: false,
  limitPrice: 0.5,
  sizeHint: null,
  positionSize: null,
  option: CONTRACT,
  confidence: 0.9,
  rationale: 'test',
  ...overrides,
});

function setup() {
  const db = createFakeDb();
  const events = new TraderEvents();
  const onBook = vi.fn();
  events.subscribeBook(onBook);
  return { db, events, onBook, deps: { db, events } };
}

describe('trackCallout', () => {
  it('a Buy opens a tracked position sized by the $5k rule', async () => {
    const { deps, db, onBook } = setup();
    await trackCallout(deps, envelope('m-buy', '2026-10-20T14:00:00.000Z'), callout({}));

    expect(db.getTracked('m-buy')).toMatchObject({
      authorId: 'harvey',
      ticker: 'SPY',
      entryPrice: 0.5,
      nominalQty: 100,
      closedAt: null,
    });
    expect(onBook).toHaveBeenCalledTimes(1);
  });

  it('an Average opens nothing', async () => {
    const { deps, db, onBook } = setup();
    await trackCallout(deps, envelope('m-add', '2026-10-20T14:00:00.000Z'), callout({ isAddition: true }));

    expect(db.getTracked('m-add')).toBeNull();
    expect(onBook).not.toHaveBeenCalled();
  });

  it('a Trim sells part of the Caller entry and a Sell closes it', async () => {
    const { deps, db } = setup();
    await trackCallout(deps, envelope('m-buy', '2026-10-20T14:00:00.000Z'), callout({}));
    await trackCallout(
      deps,
      envelope('m-trim', '2026-10-20T14:30:00.000Z'),
      callout({ action: 'sell', limitPrice: 0.75, engine: 'jev', exitPortion: { kind: 'fraction', value: 0.5 } })
    );
    expect(db.getTracked('m-buy')).toMatchObject({ closedAt: null });
    expect(db.getTracked('m-buy')!.fills).toEqual([
      expect.objectContaining({ qty: 50, price: 0.75, source: 'caller', messageId: 'm-trim' }),
    ]);

    await trackCallout(
      deps,
      envelope('m-sell', '2026-10-20T15:00:00.000Z'),
      callout({ action: 'sell', limitPrice: 1.0 })
    );
    const closed = db.getTracked('m-buy')!;
    expect(closed).toMatchObject({ closedBy: 'caller_exit', exitPrice: 1.0, result: 'win' });
    expect(closed.fills).toHaveLength(2);
  });

  it('an exit with no tracked entry is a quiet no-op', async () => {
    const { deps, onBook } = setup();
    await trackCallout(deps, envelope('m-sell', '2026-10-20T15:00:00.000Z'), callout({ action: 'sell' }));
    expect(onBook).not.toHaveBeenCalled();
  });

  it('a replayed Buy never resets the tracked row', async () => {
    const { deps, db } = setup();
    await trackCallout(deps, envelope('m-buy', '2026-10-20T14:00:00.000Z'), callout({}));
    await trackCallout(
      deps,
      envelope('m-sell', '2026-10-20T15:00:00.000Z'),
      callout({ action: 'sell', limitPrice: 1.0 })
    );
    await trackCallout(deps, envelope('m-buy', '2026-10-20T14:00:00.000Z'), callout({}));
    expect(db.getTracked('m-buy')!.closedBy).toBe('caller_exit');
  });

  it('a database failure is contained', async () => {
    const { deps, db } = setup();
    db.openTrackedCallout = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(
      trackCallout(deps, envelope('m-buy', '2026-10-20T14:00:00.000Z'), callout({}))
    ).resolves.toBeUndefined();
  });
});
