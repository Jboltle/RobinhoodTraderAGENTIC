/**
 * AI narration over the computed recap stats — the one place the LLM touches
 * this feature. Code computes every number (analytics.ts); the model only
 * writes the qualitative read, so a hallucination can mis-describe but never
 * mis-count. Output is cached per window in `recap_insights` and regenerated
 * by the sweep when rows change, so page loads never wait on a model call.
 */
import { z } from 'zod';

import { createLlmProvider } from '../../shared/llm.js';
import { createLogger } from '../../shared/logger.js';
import type { LlmProvider, ToolJsonSchema } from '../../shared/types.js';
import type { TraderDb } from '../db.js';
import {
  RECAP_WINDOW_DAYS_CHOICES,
  computeRecapPerformance,
  isoDateDaysAgo,
  type RecapPerformance,
} from './analytics.js';

const log = createLogger('trader:recaps:insights');

const INSIGHT_SCHEMA: ToolJsonSchema = {
  type: 'object',
  properties: {
    insight: {
      type: 'string',
      description:
        'Plain-text performance read: 2-4 sentences on the overall window, ' +
        'then one short line per qualifying caller.',
    },
  },
  required: ['insight'],
  additionalProperties: false,
};

const InsightResultSchema = z.object({ insight: z.string().min(1) });

const SYSTEM_PROMPT =
  'You are a quantitative trading-performance analyst reviewing a Discord ' +
  "service's own daily recap data. Write plain, factual prose — no hype, no " +
  'financial advice, no emojis, no markdown headers. Every number you mention ' +
  'must come verbatim from the provided stats; never invent or recompute ' +
  'figures. Note concentration risks, streaks, and volatility (std dev) ' +
  'where the data shows them.';

/**
 * The refresh currently running, if any. The live webhook and the hourly
 * sweep can both land on the same fresh recap, and each pass spends one model
 * call per window — overlapping triggers join the run in flight instead of
 * paying twice and racing each other's writes.
 *
 * ponytail: in-process only, which is all a single-instance deployment needs
 * (see render.yaml). Upgrade path if the backend ever scales out: an advisory
 * lock or a `generating` flag on recap_insights.
 */
let refreshInFlight: Promise<void> | null = null;

/**
 * Recompute stats and regenerate the cached narration for every window.
 * Callers gate this on recap rows having actually changed, so in steady state
 * it runs once per recap — never on a page load.
 */
export function refreshRecapInsights(
  db: TraderDb,
  provider: LlmProvider = createLlmProvider()
): Promise<void> {
  refreshInFlight ??= regenerateEveryWindow(db, provider).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Failures are logged and skipped — a down model must never block ingestion,
 * and the dashboard just keeps showing the previous narration.
 */
async function regenerateEveryWindow(db: TraderDb, provider: LlmProvider): Promise<void> {
  for (const windowDays of RECAP_WINDOW_DAYS_CHOICES) {
    try {
      const recaps = await db.listRecapsSince(isoDateDaysAgo(windowDays));
      const performance = computeRecapPerformance(recaps, windowDays);
      if (performance.tradeCount === 0) continue;

      const insight = await generateInsight(provider, performance);
      await db.saveRecapInsight({
        windowDays,
        generatedAt: new Date().toISOString(),
        content: insight,
      });
      log.info('recap insight refreshed', { windowDays, chars: insight.length });
    } catch (err) {
      log.warn('recap insight generation failed', {
        windowDays,
        error: (err as Error).message,
      });
    }
  }
}

async function generateInsight(
  provider: LlmProvider,
  performance: RecapPerformance
): Promise<string> {
  const user = [
    `Window: last ${performance.windowDays} days (${performance.fromDate} to ${performance.toDate}).`,
    `Overall: ${JSON.stringify(performance.totals)} across ${performance.tradeCount} trades ` +
      `from ${performance.recapCount} daily recaps (${performance.softExcluded} hedged results excluded).`,
    `Leaderboard (per-caller stats, percentages are per-trade option gains):`,
    JSON.stringify(performance.leaderboard),
    `Top trades: ${JSON.stringify(performance.topTrades.slice(0, 5))}`,
    `Write the overall read first (2-4 sentences), then one line per caller, ` +
      `formatted "Name: observation."` +
      (performance.minTradesForAwards > 1
        ? ` Cover every caller with at least ${performance.minTradesForAwards} trades; ` +
          `mention the ones below that threshold only if something stands out.`
        : ` Flag thin samples explicitly — several callers may have only a handful of trades.`),
  ].join('\n');

  const raw = await provider.callStructured({
    system: SYSTEM_PROMPT,
    user,
    tool: {
      name: 'report_insight',
      description: 'Narrative read over the computed recap performance stats.',
      schema: INSIGHT_SCHEMA,
    },
  });

  return InsightResultSchema.parse(raw).insight.trim();
}
