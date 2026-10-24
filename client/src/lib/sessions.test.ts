import { expect, test } from 'vitest'

import type { BookResponse, RecapTrade, TrackedPosition } from './api'
import { recapText } from './recapText'
import { buildSessions, groupByMonth, nominalPnl, sessionsKpis } from './sessions'

const tracked = (overrides: Partial<TrackedPosition>): TrackedPosition => ({
  messageId: 'm',
  authorId: 'harvey',
  ticker: 'SPY',
  option: { optionType: 'call', strike: 680, expiration: '2026-10-21' },
  entryPrice: 0.5,
  nominalQty: 100,
  openedAt: '2026-10-21T14:00:00.000Z',
  closedAt: '2026-10-21T15:00:00.000Z',
  closedBy: 'caller_exit',
  exitPrice: 1,
  lastMark: 1,
  lastMarkAt: '2026-10-21T15:00:00.000Z',
  highestPct: 120,
  highestPrice: 1.1,
  ladder: [],
  fills: [{ at: '2026-10-21T15:00:00.000Z', qty: 100, price: 1, pctGain: 100, source: 'caller', messageId: 'x' }],
  result: 'win',
  remainingQty: 0,
  realizedPnl: 5000,
  unrealizedPnl: null,
  pctNow: 100,
  ...overrides,
})

const recap = (overrides: Partial<RecapTrade>): RecapTrade => ({
  caller: 'Demon',
  ticker: 'AAPL',
  expiration: '8/19',
  strike: 312.5,
  optionType: 'call',
  entryPrice: 0.74,
  exitPrice: 6.12,
  pctGain: 726.5,
  isWin: true,
  isSoft: false,
  note: null,
  lineRaw: '$AAPL - 8/19 312.50C @ 0.74 --> 6.12 | +726.50%',
  recapDate: '2026-08-19',
  ...overrides,
})

const book: BookResponse = {
  period: 'all',
  today: '2026-10-21',
  asOf: '2026-10-21T16:00:00.000Z',
  open: [tracked({ messageId: 'open', closedAt: null, closedBy: null, result: null, realizedPnl: 0, fills: [] })],
  closed: [
    tracked({ messageId: 'w1' }),
    tracked({ messageId: 'l1', result: 'loss', realizedPnl: -1000, exitPrice: 0.4 }),
    // Closes after 8 pm UTC still belong to the 21st in New York.
    tracked({ messageId: 'late', closedAt: '2026-10-22T02:00:00.000Z', realizedPnl: 200 }),
    tracked({ messageId: 'earlier', closedAt: '2026-10-19T15:00:00.000Z', realizedPnl: -300, result: 'loss' }),
  ],
}

test('buildSessions groups tracked closes by ET day and keeps open entries as still running', () => {
  const sessions = buildSessions(book, [recap({ recapDate: '2026-10-21' }), recap({})])
  expect(sessions.map((s) => [s.date, s.source, s.net, s.wins, s.losses])).toEqual([
    ['2026-10-21', 'tracked', 4200, 2, 1],
    ['2026-10-19', 'tracked', -300, 0, 1],
    ['2026-08-19', 'recap', nominalPnl(recap({})), 1, 0],
  ])
  // The recap for a tracked day is ignored rather than double-counted.
  expect(sessions[0]!.trades).toHaveLength(3)
  expect(sessions[0]!.stillRunning.map((p) => p.messageId)).toEqual(['open'])
  expect(sessions[2]!.trades[0]).toMatchObject({ nominal: true, callerName: 'Demon', contract: '312.5C 8/19' })
})

test('nominalPnl applies the $5k rule to a recap line', () => {
  // 5000 / 74 = 67.6 -> 68 contracts; (6.12 - 0.74) * 68 * 100
  expect(nominalPnl({ entryPrice: 0.74, exitPrice: 6.12, pctGain: 726.5 })).toBeCloseTo(36584)
  expect(nominalPnl({ entryPrice: null, exitPrice: null, pctGain: -50 })).toBe(-2500)
})

test('sessionsKpis and month groups', () => {
  const sessions = buildSessions(book, [recap({})])
  const kpis = sessionsKpis(sessions)
  expect(kpis).toMatchObject({ wins: 3, losses: 2, breakEvens: 0, green: 2, red: 1, flat: 0 })
  expect(kpis.best?.date).toBe('2026-08-19')
  expect(kpis.worst?.date).toBe('2026-10-19')
  expect(groupByMonth(sessions).map((g) => [g.label, g.sessions.length])).toEqual([
    ['October 2026', 2],
    ['August 2026', 1],
  ])
})

test('recapText writes the DAILY RECAP the server parser reads', () => {
  const [session] = buildSessions({ ...book, open: [], closed: [tracked({ messageId: 'w1' }), tracked({ messageId: 'l1', result: 'loss', realizedPnl: -1000, exitPrice: 0.4 })] }, [])
  expect(recapText(session!, new Map([['harvey', 'Harvey']]))).toBe(
    [
      'DAILY RECAP | OCTOBER 21, 2026',
      '',
      'HARVEY CALLS:',
      '\u{1F7E9} $SPY - 10/21 680C @ 0.50 --> 1.00 | +100.00%',
      '\u{1F7E5} $SPY - 10/21 680C @ 0.50 --> 0.40 | -20.00%',
      '',
      '\u{1F4CA} STATS:',
      'Total Trades: 2',
      'Winners: 1',
      'Losers: 1',
      'Total Options Gain: +80.00%',
      'Average Gain per Options Call: +40.00%',
    ].join('\n'),
  )
})
