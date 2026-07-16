import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { config, isAllowed } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import type { Callout, ResolvedTradeSettings, RiskCheck } from '../../shared/types.js';

const log = createLogger('trader:risk');

/**
 * Qualitative position-size keywords extracted from the message.
 * - small / light / scalp  →  small
 * - medium / half          →  medium
 * - full / max / heavy     →  full
 * null = no size qualifier present (sizing defaults per asset type below).
 */
type PositionSize = 'small' | 'medium' | 'full';

// =============================================================================
// Sizing — keyword → portfolio percentage
//
// All sizing is expressed as a percentage of available buying power so the
// position scales automatically as the account grows or shrinks.
//
// Equity:   portfolioPct → notional = buyingPower × pct/100 → shares via quote
// Options:  portfolioPct → notional = buyingPower × pct/100 → contracts via premium
//
// The pipeline fetches buying power once and does the dollar conversion.
// =============================================================================

function sizeFraction(size: PositionSize, settings: ResolvedTradeSettings): number {
  switch (size) {
    case 'small':  return settings.positionSmallPct  / 100;
    case 'medium': return settings.positionMediumPct / 100;
    case 'full':   return 1.0;
  }
}

function resolveSize(
  callout: Callout,
  settings: ResolvedTradeSettings
): { portfolioPct: number; quantityHint: number | null } {
  const capPct =
    callout.assetType === 'option'
      ? settings.maxOptionsNotionalPct
      : settings.maxNotionalPct;

  // Explicit share / contract count bypasses percentage sizing entirely.
  if (callout.sizeHint?.kind === 'shares') {
    return { portfolioPct: capPct, quantityHint: Math.floor(callout.sizeHint.value) };
  }
  if (callout.sizeHint?.kind === 'contracts') {
    return { portfolioPct: capPct, quantityHint: Math.floor(callout.sizeHint.value) };
  }

  // Explicit USD amount: honour it up to the cap (pipeline enforces cap).
  // We still return portfolioPct = capPct so the pipeline knows the ceiling.
  // The pipeline reads callout.sizeHint.kind === 'usd' and uses min(usdAmt, notional_from_cap).
  if (callout.sizeHint?.kind === 'usd') {
    return { portfolioPct: capPct, quantityHint: null };
  }

  // Keyword / default — pure percentage sizing.
  const size: PositionSize = callout.positionSize ?? (callout.assetType === 'option' ? 'small' : 'medium');
  return { portfolioPct: capPct * sizeFraction(size, settings), quantityHint: null };
}

// =============================================================================
// Persisted daily state
// =============================================================================

interface RiskState {
  date: string;
  trades: number;
  lastTradeAtByTicker: Record<string, number>;
}

const todayKey = (now: Date = new Date()): string => now.toISOString().slice(0, 10);
const emptyState = (): RiskState => ({ date: todayKey(), trades: 0, lastTradeAtByTicker: {} });

let state: RiskState = emptyState();
let stateLoaded = false;

async function ensureStateLoaded(): Promise<void> {
  if (stateLoaded) {
    resetStateIfNewDay();
    return;
  }
  try {
    const raw = await readFile(config.riskStatePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RiskState>;
    state = {
      date: typeof parsed.date === 'string' ? parsed.date : todayKey(),
      trades: typeof parsed.trades === 'number' ? parsed.trades : 0,
      lastTradeAtByTicker:
        parsed.lastTradeAtByTicker && typeof parsed.lastTradeAtByTicker === 'object'
          ? parsed.lastTradeAtByTicker
          : {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('failed to read risk state, starting fresh', { error: (err as Error).message });
    }
    state = emptyState();
  }
  resetStateIfNewDay();
  stateLoaded = true;
}

function resetStateIfNewDay(now: Date = new Date()): void {
  const date = todayKey(now);
  if (state.date !== date) {
    state = { date, trades: 0, lastTradeAtByTicker: {} };
  }
}

async function persistState(): Promise<void> {
  await mkdir(dirname(config.riskStatePath), { recursive: true });
  await writeFile(config.riskStatePath, JSON.stringify(state, null, 2), 'utf8');
}



// =============================================================================
// Public API
// =============================================================================

/**
 * Evaluate a callout against deterministic risk rules using pre-resolved
 * settings (payload → settings file → env; see trader/settings.ts).
 * Supports both equity (notional-based sizing) and options (contract-count sizing).
 */
export async function checkRisk(
  callout: Callout,
  settings: ResolvedTradeSettings,
  now: Date = new Date()
): Promise<RiskCheck> {
  await ensureStateLoaded();

  if (!callout.isCallout || !callout.action || !callout.ticker) {
    return { allow: false, code: 'not_callout', reason: 'not a callout' };
  }
  if (callout.assetType === 'option' && !callout.option) {
    return { allow: false, code: 'missing_contract', reason: 'option callout missing contract details' };
  }
  if (callout.assetType === 'equity' && callout.sizeHint?.kind === 'contracts') {
    return { allow: false, code: 'invalid_sizing', reason: 'contracts sizing is not valid for equity orders' };
  }
  if (callout.confidence < settings.minConfidence) {
    return {
      allow: false,
      code: 'low_confidence',
      reason: `confidence ${callout.confidence.toFixed(2)} < threshold ${settings.minConfidence}`,
    };
  }

  const ticker = callout.ticker.toUpperCase();

  if (settings.blockedTickers.includes(ticker)) {
    return { allow: false, code: 'ticker_blocked', reason: `${ticker} is blocked` };
  }
  if (
    settings.allowedTickers.length > 0 &&
    !settings.allowedTickers.includes('*') &&
    !isAllowed(ticker, settings.allowedTickers)
  ) {
    return { allow: false, code: 'ticker_not_allowed', reason: `${ticker} not in allowlist` };
  }
  if (settings.regularHoursOnly && !isRegularUsTradingHours(now)) {
    return { allow: false, code: 'outside_market_hours', reason: 'outside regular US trading hours' };
  }
  if (state.trades >= settings.maxTradesPerDay) {
    return { allow: false, code: 'daily_cap_reached', reason: `daily trade cap reached (${settings.maxTradesPerDay})` };
  }

  const lastTradeAt = state.lastTradeAtByTicker[ticker];
  if (typeof lastTradeAt === 'number') {
    const elapsed = now.getTime() - lastTradeAt;
    if (elapsed < settings.cooldownSeconds * 1000) {
      const secs = Math.ceil((settings.cooldownSeconds * 1000 - elapsed) / 1000);
      return { allow: false, code: 'cooldown_active', reason: `${ticker} cooldown active (${secs}s remaining)` };
    }
  }

  const { portfolioPct, quantityHint } = resolveSize(callout, settings);
  const limitPrice = callout.orderType === 'limit' ? callout.limitPrice : null;

  return {
    allow: true,
    assetType: callout.assetType,
    portfolioPct,
    quantityHint,
    limitPrice,
    orderType: callout.orderType,
    maxSingleContractPct: settings.maxSingleContractPct,
    maxOptionsNotionalPct: settings.maxOptionsNotionalPct,
  };
}

/** Increment daily counter and stamp per-ticker cooldown after a successful order. */
export async function recordTrade(ticker: string, now: Date = new Date()): Promise<void> {
  await ensureStateLoaded();
  state.trades += 1;
  state.lastTradeAtByTicker[ticker.toUpperCase()] = now.getTime();
  await persistState();
}

// =============================================================================
// Helpers
// =============================================================================

export function isRegularUsTradingHours(now: Date): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const minutes = hour * 60 + minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
