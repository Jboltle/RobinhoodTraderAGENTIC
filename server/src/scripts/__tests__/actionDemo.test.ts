import { describe, expect, it } from 'vitest';

import {
  ACTIONS,
  assignSplits,
  coarseAction,
  confidenceBand,
  confusionMatrix,
  labelQueue,
  mergedAction,
  parserAction,
  readLayaResponse,
  wilson,
  type Action,
  type LabelRecord,
  type ParsedCallout,
  type Split,
} from '../actionDemo.js';

describe('wilson', () => {
  it('matches the textbook 95% interval for 8 of 10', () => {
    const { lo, hi } = wilson(8, 10);
    expect(lo).toBeCloseTo(0.4902, 4);
    expect(hi).toBeCloseTo(0.9433, 4);
  });

  it('stays inside [0, 1] at the extremes', () => {
    expect(wilson(0, 10).lo).toBeCloseTo(0, 10);
    expect(wilson(0, 10).hi).toBeCloseTo(0.2775, 4);
    expect(wilson(10, 10).lo).toBeCloseTo(0.7225, 4);
    expect(wilson(10, 10).hi).toBeCloseTo(1, 10);
  });

  it('is uninformative with no data', () => {
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
});

describe('confusionMatrix', () => {
  it('counts rows as your label and columns as the prediction', () => {
    const pairs: [Action, Action][] = [
      ['BUY', 'BUY'],
      ['SELL', 'TRIM'],
      ['SELL', 'TRIM'],
      ['SELL', 'SELL'],
      ['NONE', 'BUY'],
    ];
    const matrix = confusionMatrix(pairs, ACTIONS);
    const cell = (truth: Action, predicted: Action): number | undefined =>
      matrix[ACTIONS.indexOf(truth)]?.[ACTIONS.indexOf(predicted)];

    expect(cell('SELL', 'TRIM')).toBe(2);
    expect(cell('SELL', 'SELL')).toBe(1);
    expect(cell('NONE', 'BUY')).toBe(1);
    expect(cell('BUY', 'NONE')).toBe(0);
    expect(matrix.flat().reduce((sum, n) => sum + n, 0)).toBe(pairs.length);
  });
});

describe('confidenceBand', () => {
  it.each([
    [0.2, '<0.6'],
    [0.5999, '<0.6'],
    [0.6, '0.6-0.8'],
    [0.7999, '0.6-0.8'],
    [0.8, '0.8-0.9'],
    [0.9, '0.9-0.97'],
    [0.9699, '0.9-0.97'],
    [0.97, '≥0.97'],
    [1, '≥0.97'],
  ])('%f → %s', (p, band) => {
    expect(confidenceBand(p)).toBe(band);
  });
});

describe('parserAction', () => {
  const buy: ParsedCallout = { isCallout: true, action: 'buy', positionSize: null };
  const sell: ParsedCallout = { ...buy, action: 'sell' };

  it.each<[string, ParsedCallout | null, Action | null]>([
    ['parser error → no verdict', null, null],
    ['not_callout → NONE', { ...buy, isCallout: false }, 'NONE'],
    ['callout without an action → NONE', { ...buy, action: null }, 'NONE'],
    ['buy → BUY', buy, 'BUY'],
    ['saved verdict with no isAddition field → BUY', { ...buy, positionSize: 'small' }, 'BUY'],
    ['buy + isAddition → AVERAGE', { ...buy, isAddition: true }, 'AVERAGE'],
    ['sell with no size word → SELL', sell, 'SELL'],
    ['sell + small → TRIM', { ...sell, positionSize: 'small' }, 'TRIM'],
    ['sell + medium → TRIM', { ...sell, positionSize: 'medium' }, 'TRIM'],
    ['sell + full ("TRIM TRIM", runners only) → TRIM', { ...sell, positionSize: 'full' }, 'TRIM'],
  ])('%s', (_name, callout, expected) => {
    expect(parserAction(callout)).toBe(expected);
  });

  it('scores the parser against INFO and NONE as one NO_TRADE class', () => {
    const noTrade = parserAction({ ...buy, isCallout: false });
    expect(noTrade).toBe('NONE');
    expect(mergedAction(noTrade!)).toBe('NO_TRADE');
    expect(mergedAction('INFO')).toBe(mergedAction('NONE'));
    expect(ACTIONS.map(mergedAction)).toEqual(['BUY', 'AVERAGE', 'TRIM', 'SELL', 'NO_TRADE', 'NO_TRADE']);
  });

  it('merges TRIM and SELL into EXIT, and INFO and NONE into NO_TRADE, for the coarse comparison', () => {
    expect(ACTIONS.map(coarseAction)).toEqual(['BUY', 'AVERAGE', 'EXIT', 'EXIT', 'NO_TRADE', 'NO_TRADE']);
  });
});

describe('readLayaResponse', () => {
  // Captured from the live LAYA server for "BTO SPY 450c 9/27 @1.20" (5-option
  // question); INFO added at 0 because every option now needs a probability.
  const live = {
    model: 'laya-rl-agent',
    answers: {
      action: {
        type: 'choice',
        choice: 'NONE',
        probabilities: { BUY: 0.0959, AVERAGE: 0.1416, TRIM: 0.271, SELL: 0.1134, INFO: 0, NONE: 0.3781 },
        confidence: 0.0866,
        answer_confidence: 0.3781,
        action: { act_probability: 1.0 },
      },
    },
    usage: { input_tokens: 148, output_tokens: 0 },
    routing: { model: 'english', repo: 'convaiinnovations/laya', reason: "explicit model='english'" },
  };

  it('keeps answer_confidence as the calibrated number and the routed checkpoint as the model', () => {
    expect(readLayaResponse(live)).toMatchObject({
      model: 'english',
      choice: 'NONE',
      answerConfidence: 0.3781,
      confidence: 0.0866,
      inputTokens: 148,
      truncated: false,
    });
  });

  it('flags a state LAYA cut to fit 512 tokens', () => {
    expect(readLayaResponse({ ...live, usage: { input_tokens: 512, output_tokens: 0 } }).truncated).toBe(true);
  });

  it('falls back to p(choice) where answer_confidence is absent, as on hosted Jev', () => {
    const { answer_confidence: _dropped, ...jevAnswer } = live.answers.action;
    expect(readLayaResponse({ ...live, answers: { action: jevAnswer } }).answerConfidence).toBe(0.3781);
  });

  it('throws on a shape it cannot map', () => {
    expect(() => readLayaResponse({ answers: { action: { choice: 'HOLD', probabilities: {} } } })).toThrow(
      /unexpected LAYA response/
    );
  });
});

describe('labelQueue', () => {
  const corpus = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }));
  const at = '2026-09-24T23:00:00.000Z';
  const labels: LabelRecord[] = [
    { id: 'a', label: 'NONE', at },
    { id: 'b', label: 'UNSURE', at },
    { id: 'c', label: 'TRIM', at },
    { id: 'd', label: 'TRIM', at },
    { id: 'd', label: 'NONE', at }, // latest row wins
    { id: 'e', label: 'NONE', at },
    { id: 'e', label: 'NONE', at, relabeled: true }, // already re-sorted
  ];

  it('shows only never-labeled messages by default', () => {
    expect(labelQueue(corpus, labels, false).map((row) => row.id)).toEqual(['f']);
  });

  it('re-shows latest NONE/UNSURE labels not yet re-sorted, with --relabel', () => {
    expect(labelQueue(corpus, labels, true).map((row) => row.id)).toEqual(['a', 'b', 'd']);
  });
});

describe('assignSplits', () => {
  const truths = new Map<string, Action>(
    ACTIONS.flatMap((action) =>
      Array.from({ length: 30 }, (_, i): [string, Action] => [`${action}-${i}`, action])
    )
  );

  it('is deterministic and ignores input order', () => {
    const reversed = new Map([...truths].reverse());
    const sorted = (pairs: [string, Split][]): [string, Split][] =>
      [...pairs].sort(([a], [b]) => a.localeCompare(b));
    expect(sorted(assignSplits(new Map(), truths, 42))).toEqual(sorted(assignSplits(new Map(), reversed, 42)));
  });

  it('puts a third of every Action in test', () => {
    const splits = new Map(assignSplits(new Map(), truths, 42));
    for (const action of ACTIONS) {
      const tests = [...splits].filter(([id, split]) => id.startsWith(`${action}-`) && split === 'test');
      expect(tests).toHaveLength(10);
    }
  });

  it('keeps an assignment when its label changes from NONE to INFO', () => {
    const before = new Map<string, Action>([['m1', 'NONE'], ['m2', 'NONE'], ['m3', 'NONE']]);
    const existing = new Map(assignSplits(new Map(), before, 42));
    const after = new Map<string, Action>([...before, ['m2', 'INFO'], ['m4', 'INFO']]);
    const fresh = assignSplits(existing, after, 42);
    expect(fresh.map(([id]) => id)).toEqual(['m4']);
  });

  it('never moves or re-emits an existing assignment', () => {
    const existing = new Map<string, Split>([['BUY-0', 'test'], ['BUY-1', 'train']]);
    const fresh = assignSplits(existing, truths, 42);
    expect(fresh.map(([id]) => id)).not.toContain('BUY-0');
    expect(fresh.map(([id]) => id)).not.toContain('BUY-1');
    const buyTests = fresh.filter(([id, split]) => id.startsWith('BUY-') && split === 'test').length + 1;
    expect(buyTests).toBe(10);
  });
});
