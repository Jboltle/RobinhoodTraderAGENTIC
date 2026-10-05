import { describe, expect, it, vi } from 'vitest';

import {
  DECIDER_QUESTIONS,
  DEFAULT_JEV_MODEL,
  JevClient,
  JevError,
  readJevResponse,
  typesafeKeyFor,
} from '../jev.js';

const KEY = 'jev-secret-key';

const answer = (choice: string, actingNow = 0.9) => ({
  model: DEFAULT_JEV_MODEL,
  answers: {
    action: {
      type: 'choice',
      choice,
      probabilities: { BUY: 0.91, AVERAGE: 0.02, TRIM: 0.03, SELL: 0.02, INFO: 0.01, NONE: 0.01 },
    },
    acting_now: { type: 'noul', noul: actingNow },
  },
  usage: { input_tokens: 600, output_tokens: 0 },
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('readJevResponse', () => {
  it('reads the Action, every probability and the act-now answer', () => {
    expect(readJevResponse(answer('BUY', 0.42))).toMatchObject({
      model: DEFAULT_JEV_MODEL,
      choice: 'BUY',
      answerConfidence: 0.91,
      actingNow: 0.42,
      inputTokens: 600,
    });
  });

  it('throws a response error on a shape it cannot map', () => {
    const read = () => readJevResponse({ answers: { action: { choice: 'HOLD', probabilities: {} } } });
    expect(read).toThrow(JevError);
    expect(read).toThrow(/unexpected System One response/);
  });
});

describe('typesafeKeyFor', () => {
  it('attaches the key for api.typesafe.ai and nowhere else', () => {
    expect(typesafeKeyFor('https://api.typesafe.ai', KEY)).toBe(KEY);
    expect(typesafeKeyFor('https://thejevai.com', KEY)).toBeUndefined();
    expect(typesafeKeyFor('http://127.0.0.1:8765', KEY)).toBeUndefined();
  });
});

describe('JevClient', () => {
  it('posts the decider questions to TypeSafe with the pinned model and the key', async () => {
    const fetchImpl = vi.fn(async () => json(answer('SELL')));
    const verdict = await new JevClient({ apiKey: KEY, fetchImpl }).ask({ message: 'Out of NBIS', pattern_match: null });

    expect(verdict.choice).toBe('SELL');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'jev-1.13.0',
      state: { message: 'Out of NBIS', pattern_match: null },
      questions: JSON.parse(JSON.stringify(DECIDER_QUESTIONS)),
    });
  });

  it('retries a transient server error inside the budget', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ error: 'busy' }, 503))
      .mockResolvedValueOnce(json(answer('TRIM')));
    const verdict = await new JevClient({ apiKey: KEY, fetchImpl, budgetMs: 5_000 }).ask('Trimming');
    expect(verdict.choice).toBe('TRIM');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up on a client error without retrying, and never leaks the key', async () => {
    const fetchImpl = vi.fn(async () => json({ error: `bad key ${KEY}` }, 401));
    const error = await new JevClient({ apiKey: KEY, fetchImpl }).ask('x').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(JevError);
    expect(error).toMatchObject({ kind: 'http', status: 401 });
    expect((error as Error).message).not.toContain(KEY);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('times out within the budget when Jev does not answer', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      );
    const startedAt = performance.now();
    const error = await new JevClient({ apiKey: KEY, fetchImpl: hang as typeof fetch, budgetMs: 80 })
      .ask('x')
      .catch((err: unknown) => err);
    expect(error).toMatchObject({ kind: 'timeout' });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
