import { expect, test } from 'vitest'

import type { TrackedPosition } from './api'
import { contractLine, contractShort, filterByCaller, fmtUsd, summarizeBook } from './book'

const position = (overrides: Partial<TrackedPosition>): TrackedPosition => ({
  messageId: 'm',
  authorId: 'harvey',
  ticker: 'SPY',
  option: { optionType: 'call', strike: 680, expiration: '2026-10-23' },
  entryPrice: 1,
  nominalQty: 50,
  openedAt: '2026-10-21T14:00:00.000Z',
  closedAt: null,
  closedBy: null,
  exitPrice: null,
  lastMark: null,
  lastMarkAt: null,
  highestPct: null,
  highestPrice: null,
  ladder: [],
  fills: [],
  result: null,
  remainingQty: 50,
  realizedPnl: 0,
  unrealizedPnl: null,
  pctNow: null,
  ...overrides,
})

test('summarizeBook totals realized closes, unrealized opens and the win rate', () => {
  const summary = summarizeBook(
    [position({ unrealizedPnl: 300 }), position({ unrealizedPnl: null })],
    [
      position({ result: 'win', realizedPnl: 1200 }),
      position({ result: 'win', realizedPnl: 300 }),
      position({ result: 'loss', realizedPnl: -500 }),
      position({ result: 'be', realizedPnl: 0 }),
    ],
  )
  expect(summary).toEqual({
    netPnl: 1300,
    realizedPnl: 1000,
    unrealizedPnl: 300,
    winners: { count: 2, usd: 1500 },
    losers: { count: 1, usd: -500 },
    winRatePct: (2 / 3) * 100,
  })
  expect(summarizeBook([], []).winRatePct).toBeNull()
})

test('filterByCaller honours following, everyone and one Caller', () => {
  const rows = [position({ authorId: 'harvey' }), position({ authorId: 'swift' })]
  expect(filterByCaller(rows, 'all', ['harvey'])).toHaveLength(2)
  expect(filterByCaller(rows, 'following', ['harvey']).map((p) => p.authorId)).toEqual(['harvey'])
  expect(filterByCaller(rows, 'following', null)).toHaveLength(2)
  expect(filterByCaller(rows, { authorId: 'swift' }, []).map((p) => p.authorId)).toEqual(['swift'])
})

test('contract labels', () => {
  const put = position({ option: { optionType: 'put', strike: 1160, expiration: '2026-10-23' } })
  expect(contractLine(put)).toBe("Oct23 '26 1160 P")
  expect(contractShort(put)).toBe('1160P 10/23')
})

test('fmtUsd signs and rounds', () => {
  expect(fmtUsd(1250.4)).toBe('+$1,250')
  expect(fmtUsd(-80)).toBe('-$80')
  expect(fmtUsd(62.4, { cents: true })).toBe('+$62.40')
  expect(fmtUsd(5000, { signed: false })).toBe('$5,000')
})
