import type { CalloutParser, PostReceipt } from '../../shared/types.js';
import type { RobinhoodTools } from '../rh/tools.js';
import type { DecisionLog } from '../decisionLog.js';
import type { checkRisk } from './riskFilter.js';

export interface PipelineDeps {
  readonly parser: CalloutParser;
  readonly tools: RobinhoodTools;
  readonly decisions: DecisionLog;
  readonly postReceipt: PostReceipt;
}

/** The allow=true branch of a risk check — the shape execution paths consume. */
export type RiskAllow = Extract<Awaited<ReturnType<typeof checkRisk>>, { allow: true }>;

export interface PlacedResult {
  readonly orderId: string | null;
  readonly status: string | null;
  readonly quantity: number;
}
