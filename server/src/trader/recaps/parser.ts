/**
 * Deterministic parser for Optionality "PRO DAILY RECAP" posts.
 *
 * Pure regex, no LLM: recap lines are machine-formatted and this data feeds
 * the Performance & Metrix stats, where a transposed digit is worse than a
 * visible parse failure. Raw content is the source of truth — the parse is a
 * cache stamped with PARSER_VERSION, and bumping the version re-parses every
 * stored row (see sweep.ts), so format drift costs a regex tweak, not a
 * migration or a Discord re-fetch.
 *
 * Built-in validation: the recap's own STATS footer claims totals (trades,
 * winners). The checksum compares them against what we parsed — options lines
 * plus futures win/loss counts — and any mismatch or unmatched marker line
 * downgrades the row to 'parsed_partial', never silently.
 */

export const PARSER_VERSION = 1;

// =============================================================================
// Shapes stored in recaps.parse (jsonb)
// =============================================================================

export interface RecapTrade {
  /** Normalized caller name from the section header ("DEMON CALLS:" -> "Demon"). */
  readonly caller: string;
  readonly ticker: string;
  /** Raw expiration token as posted ("8/19", "0DTE"); display-only. */
  readonly expiration: string | null;
  readonly strike: number | null;
  readonly optionType: 'call' | 'put' | null;
  readonly entryPrice: number | null;
  readonly exitPrice: number | null;
  readonly pctGain: number;
  readonly isWin: boolean;
  /**
   * The recap itself hedges the number ("If held...", "most members already
   * exited"). Soft trades count toward the parse checksum but are excluded
   * from every stat (analytics.ts).
   */
  readonly isSoft: boolean;
  readonly note: string | null;
  readonly lineRaw: string;
}

/** Futures callers report day aggregates, not trade lines. Checksum-only in v1. */
export interface RecapFuturesLine {
  readonly caller: string;
  readonly wins: number;
  readonly losses: number;
  readonly avgPointsPerTrade: number | null;
}

/** The recap's own STATS footer, kept verbatim as the parse checksum source. */
export interface RecapClaimedStats {
  readonly totalTrades: number | null;
  readonly winRatePct: number | null;
  readonly winners: number | null;
  readonly losers: number | null;
  readonly totalOptionsGainPct: number | null;
  readonly avgGainPerOptionsCallPct: number | null;
}

export interface RecapChecksum {
  /** Options trade lines + futures wins + futures losses. */
  readonly parsedTotal: number;
  readonly claimedTotal: number | null;
  /** Null when the footer claimed nothing to compare against. */
  readonly totalMatches: boolean | null;
  readonly parsedWinners: number;
  readonly claimedWinners: number | null;
  readonly winnersMatch: boolean | null;
}

export interface RecapParse {
  /** ISO trading day from the header ("AUGUST 19, 2026" -> "2026-08-19"). */
  readonly recapDate: string | null;
  readonly trades: readonly RecapTrade[];
  readonly futures: readonly RecapFuturesLine[];
  readonly claimed: RecapClaimedStats;
  readonly checksum: RecapChecksum;
  /** Marker (🟩/🟥) lines that matched neither the trade nor futures shape. */
  readonly unparsedLines: readonly string[];
}

export type RecapParseStatus = 'parsed' | 'parsed_partial' | 'not_recap' | 'failed';

export interface RecapParseResult {
  readonly status: RecapParseStatus;
  readonly parse: RecapParse | null;
}

// =============================================================================
// Regexes
// =============================================================================

const RECAP_HEADER_RE = /\bDAILY\s+RECAP\s*\|\s*([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/i;

/** "DEMON CALLS:" / "MITRO CALLS:" — a caller section header on its own line. */
const SECTION_RE = /^([A-Z][A-Z0-9 .'&_-]*?)\s+CALLS:\s*$/i;

/** Result markers the recap prefixes trade/futures lines with. */
const WIN_MARKER = '\u{1F7E9}'; // 🟩
const LOSS_MARKER = '\u{1F7E5}'; // 🟥
const MARKER_RE = new RegExp(`^(${WIN_MARKER}|${LOSS_MARKER})\\s*`, 'u');

/**
 * One options trade line, marker already stripped:
 *   "$AAPL - 8/19 312.50C @ 0.74 --> 6.12 | +726.50% (note)"
 *   "$SPY - 0DTE 771C @ 1.00 --> 2.05 | +105.00%"
 *   "$TMUS - 9/18 185C | +83.00% (Closed last contract.)"      (no entry/exit)
 *   "$AAPL - 8/21 310P @ 0.92 --> 1.03 | +11.96% | $11.00"     (trailing segment)
 */
const TRADE_LINE_RE = new RegExp(
  [
    /^\$?([A-Z]{1,6})\s*[-–—]\s*/, //                                 1 ticker
    /(?:(0DTE|TODAY|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+)?/, //         2 expiration (optional)
    /(\d+(?:\.\d+)?)\s*([CP])\b/, //                                  3 strike, 4 C/P
    /(?:\s*@\s*\$?(\d+(?:\.\d+)?)\s*(?:-{1,2}>|→|➔|⇒)\s*\$?(\d+(?:\.\d+)?))?/, // 5 entry, 6 exit
    /\s*\|\s*([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*%/, //             7 pct gain
    /(?:\s*\|[^()\n]*?)?/, //                                         trailing "| $11.00" segments
    /(?:\s*\((.*)\))?\s*$/, //                                        8 parenthesized note
  ]
    .map((r) => r.source)
    .join(''),
  'i'
);

/** Futures aggregate line: "Wins: 3 | Losses: 0 | Avg. Points Per Trade: +31.00 POINTS". */
const FUTURES_LINE_RE =
  /^Wins:\s*(\d+)\s*\|\s*Losses:\s*(\d+)(?:\s*\|\s*Avg\.?\s*Points(?:\s+Per\s+Trade)?:\s*([+-]?\d+(?:\.\d+)?))?/i;

/** Note wordings that mean "theoretical result" — excluded from stats. */
const SOFT_NOTE_RE = /\bif\s+held\b|\balready\s+exited\b|\bno\s+more\s+alerts\b|\bif\s+you\s+held\b/i;

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// =============================================================================
// Parser
// =============================================================================

/** Gate: whether a recap-channel message is a daily recap at all. */
export function isDailyRecap(content: string): boolean {
  return /\bDAILY\s+RECAP\b/i.test(content);
}

export function parseRecapDate(content: string): string | null {
  const match = RECAP_HEADER_RE.exec(content);
  if (!match) return null;
  const month = MONTHS[match[1]!.toLowerCase()];
  if (!month) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseRecap(content: string): RecapParseResult {
  if (!isDailyRecap(content)) return { status: 'not_recap', parse: null };

  try {
    const parse = parseRecapBody(content);
    const partial =
      parse.unparsedLines.length > 0 ||
      parse.checksum.totalMatches === false ||
      parse.checksum.winnersMatch === false;
    return { status: partial ? 'parsed_partial' : 'parsed', parse };
  } catch {
    return { status: 'failed', parse: null };
  }
}

function parseRecapBody(content: string): RecapParse {
  const trades: RecapTrade[] = [];
  const futures: RecapFuturesLine[] = [];
  const unparsedLines: string[] = [];

  let currentCaller: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    // Markdown emphasis must not hide a section header or trade line.
    const line = rawLine.replace(/\*\*|__|`/g, '').trim();
    if (!line) continue;

    const section = SECTION_RE.exec(line);
    if (section) {
      currentCaller = normalizeCaller(section[1]!);
      continue;
    }

    const markerMatch = MARKER_RE.exec(line);
    if (!markerMatch) continue;
    const body = line.slice(markerMatch[0].length).trim();

    const futuresMatch = FUTURES_LINE_RE.exec(body);
    if (futuresMatch) {
      futures.push({
        caller: currentCaller ?? 'Unknown',
        wins: Number(futuresMatch[1]),
        losses: Number(futuresMatch[2]),
        avgPointsPerTrade: futuresMatch[3] !== undefined ? Number(futuresMatch[3]) : null,
      });
      continue;
    }

    const trade = parseTradeLine(body, currentCaller, line);
    if (trade) trades.push(trade);
    else unparsedLines.push(line);
  }

  const claimed = parseClaimedStats(content);
  return {
    recapDate: parseRecapDate(content),
    trades,
    futures,
    claimed,
    checksum: buildChecksum(trades, futures, claimed),
    unparsedLines,
  };
}

function parseTradeLine(body: string, caller: string | null, lineRaw: string): RecapTrade | null {
  const match = TRADE_LINE_RE.exec(body);
  if (!match || caller === null) return null;

  const [, ticker, expiration, strike, optionType, entry, exit, pct, note] = match;
  const pctGain = parseNumber(pct!);
  const trimmedNote = note?.trim() || null;

  return {
    caller,
    ticker: ticker!.toUpperCase(),
    expiration: expiration ?? null,
    strike: strike !== undefined ? Number(strike) : null,
    optionType: optionType!.toUpperCase() === 'C' ? 'call' : 'put',
    entryPrice: entry !== undefined ? Number(entry) : null,
    exitPrice: exit !== undefined ? Number(exit) : null,
    pctGain,
    isWin: pctGain > 0,
    isSoft: trimmedNote !== null && SOFT_NOTE_RE.test(trimmedNote),
    note: trimmedNote,
    lineRaw,
  };
}

function parseClaimedStats(content: string): RecapClaimedStats {
  const grab = (re: RegExp): number | null => {
    const match = re.exec(content);
    return match ? parseNumber(match[1]!) : null;
  };
  return {
    totalTrades: grab(/Total\s+Trades:\s*([\d,]+)/i),
    winRatePct: grab(/Win\s+Rate:\s*([\d.,]+)\s*%/i),
    winners: grab(/Winners:\s*([\d,]+)/i),
    losers: grab(/Losers:\s*([\d,]+)/i),
    totalOptionsGainPct: grab(/Total\s+Options\s+Gain:\s*([+-]?[\d,]+(?:\.\d+)?)\s*%/i),
    avgGainPerOptionsCallPct: grab(
      /Average\s+Gain\s+per\s+Options\s+Call:\s*([+-]?[\d,]+(?:\.\d+)?)\s*%/i
    ),
  };
}

function buildChecksum(
  trades: readonly RecapTrade[],
  futures: readonly RecapFuturesLine[],
  claimed: RecapClaimedStats
): RecapChecksum {
  const futuresTrades = futures.reduce((sum, f) => sum + f.wins + f.losses, 0);
  const futuresWins = futures.reduce((sum, f) => sum + f.wins, 0);
  const parsedTotal = trades.length + futuresTrades;
  const parsedWinners = trades.filter((t) => t.isWin).length + futuresWins;
  return {
    parsedTotal,
    claimedTotal: claimed.totalTrades,
    totalMatches: claimed.totalTrades === null ? null : parsedTotal === claimed.totalTrades,
    parsedWinners,
    claimedWinners: claimed.winners,
    winnersMatch: claimed.winners === null ? null : parsedWinners === claimed.winners,
  };
}

/** "DEMON" -> "Demon", "MITRO." -> "Mitro." — title-case each word. */
function normalizeCaller(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-z])/g, (_, boundary: string, ch: string) => boundary + ch.toUpperCase());
}

/** Number with optional sign and thousands commas ("+1,365.40" -> 1365.4). */
function parseNumber(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}
