/**
 * Hosted Jev — TypeSafe's System One model — and the one module that knows
 * the /v1/systemone wire shape. The trade path asks it which Action a message
 * announces (decide.ts); the action demo sends the same protocol to LAYA or
 * Jev for its offline comparisons.
 */
import { setTimeout as sleep } from 'node:timers/promises';

// ---------------------------------------------------------------------------
// Actions and the questions Jev answers
// ---------------------------------------------------------------------------

/** Every Action a message can announce: four trades, then INFO and NONE, the two no-trade answers. */
export const ACTIONS = ['BUY', 'AVERAGE', 'TRIM', 'SELL', 'INFO', 'NONE'] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_QUESTION_ID = 'action';
export const ACTING_NOW_QUESTION_ID = 'acting_now';

export const ACTION_INSTRUCTIONS = 'Which Action does this Discord options-trading message announce?';

/** Order matters: jev-1.13 leans toward the first-listed option. */
export const ACTION_CRITERIA: Readonly<Record<Action, string>> = {
  BUY: 'Opens a new position.',
  AVERAGE: 'Buys more of a position the caller already holds.',
  TRIM: 'Sells part of a position and keeps the rest.',
  SELL: "Closes the whole position, even if headed TRIM. A sale that doesn't say how much is a SELL.",
  INFO:
    'News or a plan about a position the caller still holds, with no trade now: ' +
    "'still in', P/L updates, targets, stops, 'not trimming yet'.",
  NONE: "Anything else that isn't a trade: commentary, hype, watchlists, questions, or recaps of closed trades.",
};

/** A literal yes/no asked next to the Action, so hype and maybes never buy. */
export const ACTING_NOW_QUESTION = {
  type: 'noul',
  instructions: 'Is the caller telling followers to make a trade right now?',
  criteria: {
    true: 'A live instruction to buy, add to, trim or sell a position now.',
    false: 'Hype, a recap, a status update, a question, or a plan that may or may not happen.',
  },
} as const;

// Waxui posts "SPY here 10/02 770C Avg. 1.20": his average is the entry price.
const AVG_PRICE_NOTE =
  '"Avg. 1.20" or "Avg, 3.50" right after a contract is the caller\'s entry price on a new position, which is BUY.';

/**
 * The trade path's questions, as measured in the Oct 4 tests (docs/adr/0002):
 * the demo's wording plus the Avg. note, reading `pattern_match` as evidence.
 */
export const DECIDER_QUESTIONS = {
  [ACTION_QUESTION_ID]: {
    type: 'choice',
    instructions: `${ACTION_INSTRUCTIONS} Treat \`pattern_match\` as evidence; the message decides.`,
    criteria: {
      ...ACTION_CRITERIA,
      BUY: `${ACTION_CRITERIA.BUY} ${AVG_PRICE_NOTE}`,
      AVERAGE:
        `${ACTION_CRITERIA.AVERAGE} Needs words about adding to or averaging down a held position: ` +
        `added, adding, averaging down, doubling down, new average. ${AVG_PRICE_NOTE}`,
    },
  },
  [ACTING_NOW_QUESTION_ID]: ACTING_NOW_QUESTION,
} as const;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export interface JevVerdict {
  /** The model that answered: LAYA's routed checkpoint, else the response's model id. */
  readonly model: string;
  readonly choice: Action;
  readonly probabilities: Readonly<Record<Action, number>>;
  /** Calibrated top probability: LAYA's answer_confidence, else probabilities[choice] as on hosted Jev. */
  readonly answerConfidence: number;
  /** LAYA: 1 − normalized entropy, NOT calibrated. Hosted Jev: (n·p_max − 1)/(n − 1). */
  readonly confidence: number | null;
  readonly inputTokens: number | null;
  /** Probability the caller is telling followers to trade now; null when not asked. */
  readonly actingNow: number | null;
}

export type JevErrorKind = 'timeout' | 'http' | 'network' | 'response';

/** Any way a System One call can fail. Messages never contain the API key. */
export class JevError extends Error {
  constructor(
    message: string,
    readonly kind: JevErrorKind,
    readonly status: number | null = null
  ) {
    super(message);
    this.name = 'JevError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAction = (value: unknown): value is Action => ACTIONS.includes(value as Action);

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);

/** Map a /v1/systemone response to a verdict; throws on any shape it does not expect. */
export function readJevResponse(json: unknown): JevVerdict {
  const body = isRecord(json) ? json : {};
  const answers = isRecord(body.answers) ? body.answers : {};
  const answer = answers[ACTION_QUESTION_ID];
  const choice = isRecord(answer) ? answer.choice : undefined;
  const probabilities =
    isRecord(answer) && isRecord(answer.probabilities) ? answer.probabilities : undefined;
  if (
    !isRecord(answer) ||
    !isAction(choice) ||
    !probabilities ||
    !ACTIONS.every((action) => typeof probabilities[action] === 'number')
  ) {
    throw new JevError(`unexpected System One response: ${String(JSON.stringify(json)).slice(0, 300)}`, 'response');
  }
  const probabilityOf = (action: Action): number => probabilities[action] as number;
  const routing = isRecord(body.routing) ? body.routing : {};
  const gate = answers[ACTING_NOW_QUESTION_ID];
  return {
    model:
      typeof routing.model === 'string'
        ? routing.model
        : typeof body.model === 'string'
          ? body.model
          : 'unknown',
    choice,
    probabilities: Object.fromEntries(
      ACTIONS.map((action) => [action, probabilityOf(action)])
    ) as Record<Action, number>,
    answerConfidence: numberOrNull(answer.answer_confidence) ?? probabilityOf(choice),
    confidence: numberOrNull(answer.confidence),
    inputTokens: isRecord(body.usage) ? numberOrNull(body.usage.input_tokens) : null,
    actingNow: isRecord(gate) ? numberOrNull(gate.noul) : null,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export const JEV_BASE_URL = 'https://api.typesafe.ai';
export const SYSTEMONE_PATH = '/v1/systemone';
/** The only host a TypeSafe key (JEV_API_KEY) is ever sent to. */
export const TYPESAFE_API_HOST = 'api.typesafe.ai';
/** Pinned: the cutoffs were measured on this model, and jev-latest moves under us. */
export const DEFAULT_JEV_MODEL = 'jev-1.13.0';
/** The trade path's whole budget for one message, retries included. */
export const DECIDER_BUDGET_MS = 1_500;

/** TypeSafe SDK retry defaults: 2 retries, 0.5 s backoff doubling to 5 s, on 408/429/5xx. */
const MAX_RETRIES = 2;
const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 5_000;
const RETRYABLE_CLIENT_STATUSES = new Set([408, 429]);
const FIRST_SERVER_ERROR_STATUS = 500;

const isRetryableStatus = (status: number): boolean =>
  RETRYABLE_CLIENT_STATUSES.has(status) || status >= FIRST_SERVER_ERROR_STATUS;

// ponytail: honours Retry-After in seconds only (not retry-after-ms) and adds no
// jitter, which is fine for one client per process. Upgrade: the SDK's RetryPolicy.
function backoffMs(attempt: number, retryAfterSeconds: string | null): number {
  const wanted = retryAfterSeconds
    ? Number(retryAfterSeconds) * 1000
    : BACKOFF_INITIAL_MS * 2 ** (attempt - 1);
  return Math.min(Number.isFinite(wanted) ? wanted : BACKOFF_MAX_MS, BACKOFF_MAX_MS);
}

const isTimeout = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

/** A TypeSafe key goes to TypeSafe only; every other server gets no key. */
export function typesafeKeyFor(baseUrl: string, apiKey: string | undefined): string | undefined {
  if (new URL(baseUrl).host !== TYPESAFE_API_HOST) return undefined;
  return apiKey?.trim() || undefined;
}

export interface SystemOneCall {
  readonly json: unknown;
  readonly latencyMs: number;
  readonly attempts: number;
}

export interface PostOptions {
  readonly apiKey?: string;
  /** Wall-clock budget for every attempt and backoff together. */
  readonly budgetMs: number;
  /** Cap on one attempt; defaults to whatever budget remains. */
  readonly attemptTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** POST one request, retrying transient failures while the budget lasts. Throws JevError. */
export async function postSystemOne(
  url: string,
  body: unknown,
  options: PostOptions
): Promise<SystemOneCall> {
  const { apiKey, budgetMs, attemptTimeoutMs = Infinity, fetchImpl = fetch } = options;
  const deadline = performance.now() + budgetMs;
  const redact = (text: string): string => (apiKey ? text.replaceAll(apiKey, '[redacted]') : text);
  let lastError = new JevError(`no answer within ${budgetMs} ms`, 'timeout');
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
    const startedAt = performance.now();
    const timeoutMs = Math.min(deadline - startedAt, attemptTimeoutMs);
    let retryAfter: string | null = null;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1, Math.round(timeoutMs))),
      });
      if (response.ok) {
        const json: unknown = await response.json();
        return { json, latencyMs: Math.round(performance.now() - startedAt), attempts: attempt };
      }
      const detail = redact((await response.text().catch(() => '')).slice(0, 300));
      lastError = new JevError(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`, 'http', response.status);
      if (!isRetryableStatus(response.status)) break;
      retryAfter = response.headers.get('retry-after');
    } catch (err) {
      lastError = isTimeout(err)
        ? new JevError(`no answer within ${Math.round(timeoutMs)} ms`, 'timeout')
        : new JevError(redact(err instanceof Error ? err.message : String(err)), 'network');
    }
    if (attempt > MAX_RETRIES) break;
    const waitMs = backoffMs(attempt, retryAfter);
    if (performance.now() + waitMs >= deadline) break;
    await sleep(waitMs);
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// The trade path's client
// ---------------------------------------------------------------------------

export interface JevDecisionSource {
  /** Ask the decider's questions about one message; throws JevError. */
  ask(state: unknown): Promise<JevVerdict>;
}

export interface JevClientOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly budgetMs?: number;
  /** Injected in tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/** Always api.typesafe.ai, a pinned model, and one 1.5 s budget per message. */
export class JevClient implements JevDecisionSource {
  constructor(private readonly options: JevClientOptions) {}

  async ask(state: unknown): Promise<JevVerdict> {
    const call = await postSystemOne(
      `${JEV_BASE_URL}${SYSTEMONE_PATH}`,
      { model: this.options.model ?? DEFAULT_JEV_MODEL, state, questions: DECIDER_QUESTIONS },
      {
        apiKey: typesafeKeyFor(JEV_BASE_URL, this.options.apiKey),
        budgetMs: this.options.budgetMs ?? DECIDER_BUDGET_MS,
        fetchImpl: this.options.fetchImpl,
      }
    );
    return readJevResponse(call.json);
  }
}
