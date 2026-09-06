/**
 * Insight generation is the only model call in the recap feature, and it must
 * stay off the request path: it runs when a recap lands, writes to
 * recap_insights, and page loads read that row. These tests pin the cost —
 * one model call per window per recap, no matter how many triggers overlap.
 */

import { describe, expect, it, vi } from 'vitest';

import type { LlmProvider } from '../../../shared/types.js';
import type { StoredRecap } from '../../db.js';
import { createFakeDb } from '../../__tests__/fakeDb.js';
import { RECAP_WINDOW_DAYS_CHOICES, isoDateDaysAgo } from '../analytics.js';
import { refreshRecapInsights } from '../insights.js';
import type { RecapParse } from '../parser.js';

const WINDOW_COUNT = RECAP_WINDOW_DAYS_CHOICES.length;

/** One recap dated today, so it falls inside every window. */
function todaysRecap(): StoredRecap {
  const recapDate = isoDateDaysAgo(0);
  const parse: RecapParse = {
    recapDate,
    trades: [
      {
        caller: 'Demon',
        ticker: 'SPY',
        expiration: '0DTE',
        strike: 500,
        optionType: 'call',
        entryPrice: 1,
        exitPrice: 2,
        pctGain: 100,
        isWin: true,
        isSoft: false,
        note: null,
        lineRaw: 'synthetic',
      },
    ],
    futures: [],
    claimed: {
      totalTrades: 1,
      winRatePct: null,
      winners: null,
      losers: null,
      totalOptionsGainPct: null,
      avgGainPerOptionsCallPct: null,
    },
    checksum: {
      parsedTotal: 1,
      claimedTotal: 1,
      totalMatches: true,
      parsedWinners: 1,
      claimedWinners: null,
      winnersMatch: null,
    },
    unparsedLines: [],
  };
  return {
    messageId: 'msg-1',
    channelId: 'recap-chan',
    postedAt: `${recapDate}T21:00:00.000Z`,
    recapDate,
    content: 'synthetic',
    contentHash: 'hash',
    parse,
    parseStatus: 'parsed',
    parserVersion: 1,
  };
}

/** A provider whose calls all block until `release()` is invoked. */
function blockingProvider(): { provider: LlmProvider; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: LlmProvider = {
    callStructured: vi.fn(async () => {
      await gate;
      return { insight: 'synthetic read' };
    }),
  };
  return { provider, release };
}

describe('refreshRecapInsights', () => {
  it('coalesces overlapping triggers into one pass', async () => {
    const db = createFakeDb();
    await db.saveRecap(todaysRecap());
    const { provider, release } = blockingProvider();

    // The live webhook and the hourly sweep firing on the same recap.
    const webhook = refreshRecapInsights(db, provider);
    const sweep = refreshRecapInsights(db, provider);
    release();
    await Promise.all([webhook, sweep]);

    // One call per window, not two.
    expect(provider.callStructured).toHaveBeenCalledTimes(WINDOW_COUNT);
    for (const days of RECAP_WINDOW_DAYS_CHOICES) {
      expect((await db.getRecapInsight(days))?.content).toBe('synthetic read');
    }
  });

  it('runs again once the previous pass has finished', async () => {
    const db = createFakeDb();
    await db.saveRecap(todaysRecap());
    const first = blockingProvider();
    first.release();
    await refreshRecapInsights(db, first.provider);

    const second = blockingProvider();
    second.release();
    await refreshRecapInsights(db, second.provider);

    expect(second.provider.callStructured).toHaveBeenCalledTimes(WINDOW_COUNT);
  });

  it('skips windows with no trades instead of calling the model', async () => {
    const db = createFakeDb();
    const { provider, release } = blockingProvider();
    release();

    await refreshRecapInsights(db, provider);

    expect(provider.callStructured).not.toHaveBeenCalled();
  });
});
