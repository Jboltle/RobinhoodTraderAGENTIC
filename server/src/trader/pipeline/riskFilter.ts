import { isAllowed } from '../../shared/config.js';
import type { Callout, ResolvedTradeSettings, RiskCheck } from '../../shared/types.js';

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
// Daily state, derived from the trades table
//
// Nothing is cached in the process: the counters ARE the trade rows, so the
// daily cap and cooldowns survive a restart. They previously lived in a
// module-level object backed by state/risk.json, which meant every deploy
// silently reset the daily cap to zero.
// =============================================================================

/** One user's trading history, reduced to what the guards below need. */
export interface DerivedRiskState {
  /** Orders this user has submitted since the start of the local day. */
  readonly submittedToday: number;
  /** When this user last submitted an order for the callout's ticker. */
  readonly lastSubmittedForTicker: Date | null;
}

export const NO_TRADES_YET: DerivedRiskState = {
  submittedToday: 0,
  lastSubmittedForTicker: null,
};

/** Source of the two count queries behind DerivedRiskState. */
export interface RiskHistory {
  countSubmittedSince(userId: string, since: Date): Promise<number>;
  lastSubmittedAt(userId: string, ticker: string): Promise<Date | null>;
}

/** Local midnight — the daily cap resets with the trading day, not with UTC. */
export function startOfDay(now: Date = new Date()): Date {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight;
}

export async function deriveRiskState(
  history: RiskHistory,
  userId: string,
  ticker: string | null,
  now: Date = new Date()
): Promise<DerivedRiskState> {
  const [submittedToday, lastSubmittedForTicker] = await Promise.all([
    history.countSubmittedSince(userId, startOfDay(now)),
    ticker ? history.lastSubmittedAt(userId, ticker) : Promise.resolve(null),
  ]);
  return { submittedToday, lastSubmittedForTicker };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Evaluate a callout against deterministic risk rules using the acting user's
 * settings and their trade history. Supports both equity (notional-based
 * sizing) and options (contract-count sizing).
 */
export function checkRisk(
  callout: Callout,
  settings: ResolvedTradeSettings,
  state: DerivedRiskState = NO_TRADES_YET,
  now: Date = new Date()
): RiskCheck {
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
  if (state.submittedToday >= settings.maxTradesPerDay) {
    return { allow: false, code: 'daily_cap_reached', reason: `daily trade cap reached (${settings.maxTradesPerDay})` };
  }

  if (state.lastSubmittedForTicker !== null) {
    const elapsed = now.getTime() - state.lastSubmittedForTicker.getTime();
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
