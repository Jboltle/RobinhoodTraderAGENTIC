/**
 * Risk state derived from the trades table.
 *
 * The headline case is the restart: the daily cap used to live in a
 * module-level counter backed by state/risk.json, so every deploy reset it to
 * zero and the cap was not actually enforced. Deriving it from rows fixes that,
 * and the test below is what proves it — the module is torn down and
 * re-imported between the trades and the check, exactly as a restart would.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Callout, Decision, ResolvedTradeSettings } from '../../../shared/types.js';
import { TradeSettingsSchema } from '../../../shared/types.js';
import { createFakeDb, type FakeDb } from '../../__tests__/fakeDb.js';

const USER = 'user-1';
const OTHER_USER = 'user-2';

const SETTINGS: ResolvedTradeSettings = TradeSettingsSchema.parse({
  maxTradesPerDay: 3,
  cooldownSeconds: 60,
  regularHoursOnly: false,
});

const CALLOUT: Callout = {
  isCallout: true,
  assetType: 'equity',
  action: 'buy',
  ticker: 'AAPL',
  orderType: 'market',
  limitPrice: null,
  sizeHint: null,
  positionSize: null,
  option: null,
  confidence: 0.9,
  rationale: 'buy AAPL',
};

const submittedAt = (at: string, ticker = 'AAPL'): Decision => ({
  at,
  messageId: `msg-${at}`,
  kind: 'submitted',
  code: null,
  reason: 'fixture',
  ticker,
  action: 'buy',
  order: null,
});

/** Local noon, so "today" is unambiguous whatever the runner's timezone. */
const noonToday = (): Date => {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  return now;
};

const hoursAgo = (from: Date, hours: number): string =>
  new Date(from.getTime() - hours * 60 * 60 * 1000).toISOString();

let db: FakeDb;

beforeEach(() => {
  db = createFakeDb();
});

describe('maxTradesPerDay survives a process restart', () => {
  it('still rejects at the cap after the modules are reloaded', async () => {
    const now = noonToday();

    // Three orders earlier today — the cap for these settings.
    const first = await import('../riskFilter.js');
    for (let i = 0; i < 3; i++) {
      db.seedDecision(USER, submittedAt(hoursAgo(now, i + 1)));
    }
    const beforeRestart = first.checkRisk(
      CALLOUT,
      SETTINGS,
      await first.deriveRiskState(db, USER, 'AAPL', now),
      now
    );
    expect(beforeRestart.allow).toBe(false);
    expect((beforeRestart as { code: string }).code).toBe('daily_cap_reached');

    // Restart: every module-level value in the risk filter is thrown away.
    // Only the trades survive, because only the trades were ever the state.
    vi.resetModules();
    const afterRestart = await import('../riskFilter.js');
    expect(afterRestart.checkRisk).not.toBe(first.checkRisk);

    const state = await afterRestart.deriveRiskState(db, USER, 'AAPL', now);
    expect(state.submittedToday).toBe(3);

    const result = afterRestart.checkRisk(CALLOUT, SETTINGS, state, now);
    expect(result.allow).toBe(false);
    expect((result as { code: string }).code).toBe('daily_cap_reached');
  });

  it('lets the next trade through when the cap has not been reached', async () => {
    const now = noonToday();
    db.seedDecision(USER, submittedAt(hoursAgo(now, 5)));

    vi.resetModules();
    const { checkRisk, deriveRiskState } = await import('../riskFilter.js');

    const state = await deriveRiskState(db, USER, 'AAPL', now);
    expect(state.submittedToday).toBe(1);
    expect(checkRisk(CALLOUT, SETTINGS, state, now).allow).toBe(true);
  });
});

describe('deriveRiskState', () => {
  it('counts only this user, only today, only submitted orders', async () => {
    const now = noonToday();
    const { deriveRiskState } = await import('../riskFilter.js');

    db.seedDecision(USER, submittedAt(hoursAgo(now, 1)));
    db.seedDecision(USER, { ...submittedAt(hoursAgo(now, 2)), kind: 'risk_rejected' });
    db.seedDecision(USER, submittedAt(hoursAgo(now, 30))); // yesterday
    db.seedDecision(OTHER_USER, submittedAt(hoursAgo(now, 1)));
    db.seedDecision(OTHER_USER, submittedAt(hoursAgo(now, 2)));

    expect((await deriveRiskState(db, USER, 'AAPL', now)).submittedToday).toBe(1);
    expect((await deriveRiskState(db, OTHER_USER, 'AAPL', now)).submittedToday).toBe(2);
  });

  it('reads the cooldown clock from the last submitted order for that ticker', async () => {
    const now = noonToday();
    const { checkRisk, deriveRiskState } = await import('../riskFilter.js');

    db.seedDecision(USER, submittedAt(new Date(now.getTime() - 30_000).toISOString(), 'AAPL'));

    const onCooldown = checkRisk(
      CALLOUT,
      SETTINGS,
      await deriveRiskState(db, USER, 'AAPL', now),
      now
    );
    expect((onCooldown as { code: string }).code).toBe('cooldown_active');

    // A different ticker has its own clock.
    const other = checkRisk(
      { ...CALLOUT, ticker: 'TSLA' },
      SETTINGS,
      await deriveRiskState(db, USER, 'TSLA', now),
      now
    );
    expect(other.allow).toBe(true);
  });

  it("one user's trades never affect another user's cooldown", async () => {
    const now = noonToday();
    const { checkRisk, deriveRiskState } = await import('../riskFilter.js');

    db.seedDecision(OTHER_USER, submittedAt(new Date(now.getTime() - 1_000).toISOString()));

    const state = await deriveRiskState(db, USER, 'AAPL', now);
    expect(state.lastSubmittedForTicker).toBeNull();
    expect(checkRisk(CALLOUT, SETTINGS, state, now).allow).toBe(true);
  });
});
