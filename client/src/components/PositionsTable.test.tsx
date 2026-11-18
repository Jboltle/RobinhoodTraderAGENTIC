// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { PerformanceRow } from '../lib/api'
import { PositionsTable, positionValue } from './PositionsTable'

// Rows as GET /api/trades/performance answers for a SnapTrade account holding
// what SnapTrade's own recordings and docs show: whole and fractional shares
// priced by a live quote, and an option whose row carries no price.
const AAPL: PerformanceRow = {
  assetType: 'equity',
  symbol: 'AAPL',
  quantity: 5,
  entryPrice: 175,
  currentPrice: 180.5,
  pctChange: 3.142857142857143,
}
const FRACTIONAL_NVDA: PerformanceRow = {
  assetType: 'equity',
  symbol: 'NVDA',
  quantity: 10.5,
  entryPrice: 118.2,
  currentPrice: 123.45,
  pctChange: 4.441624365482233,
}
const SPY_CALL_UNPRICED: PerformanceRow = {
  assetType: 'option',
  symbol: 'SPY',
  quantity: 3,
  optionType: 'call',
  strike: 772,
  expiration: '2026-10-21',
  entryPrice: 1.59,
  currentPrice: null,
  pctChange: null,
}

/** When SnapTrade read the option's row from the brokerage. */
const ROW_READ_AT = '2026-11-12T07:10:12Z'
// The same option priced from its row: SnapTrade quotes no option live.
const SPY_CALL_LAST_KNOWN: PerformanceRow = {
  ...SPY_CALL_UNPRICED,
  currentPrice: 1.75,
  priceAsOf: ROW_READ_AT,
  pctChange: 10.062893081761008,
}

afterEach(cleanup)

describe('positionValue', () => {
  it('totals shares at one unit each, fractions included', () => {
    expect(positionValue(AAPL)).toEqual({ marketValue: 902.5, costBasis: 875, unrealizedPnl: 27.5 })

    const fractional = positionValue(FRACTIONAL_NVDA)
    expect(fractional.marketValue).toBeCloseTo(1296.225)
    expect(fractional.costBasis).toBeCloseTo(1241.1)
    expect(fractional.unrealizedPnl).toBeCloseTo(55.125)
  })

  it('totals an option at a hundred shares a contract, and a loss as a negative', () => {
    const priced = positionValue({ ...SPY_CALL_UNPRICED, currentPrice: 1.25 })
    expect(priced.marketValue).toBeCloseTo(375)
    expect(priced.costBasis).toBeCloseTo(477)
    expect(priced.unrealizedPnl).toBeCloseTo(-102)
  })

  it('guesses nothing the broker left out', () => {
    expect(positionValue(SPY_CALL_UNPRICED)).toMatchObject({ marketValue: null, unrealizedPnl: null })
    expect(positionValue(SPY_CALL_UNPRICED).costBasis).toBeCloseTo(477)
    expect(positionValue({ ...AAPL, entryPrice: null })).toEqual({
      marketValue: 902.5,
      costBasis: null,
      unrealizedPnl: null,
    })
  })
})

const rowTexts = (container: HTMLElement): string[][] =>
  Array.from(container.querySelectorAll('tbody tr')).map((row) =>
    Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent ?? ''),
  )

describe('PositionsTable', () => {
  it('lists each position with its totals, largest first, and a dash where a figure is missing', () => {
    const { container } = render(
      <PositionsTable positions={[SPY_CALL_UNPRICED, AAPL, FRACTIONAL_NVDA]} />,
    )

    expect(rowTexts(container)).toEqual([
      ['NVDA', '10.5', '$118.20', '$123.45', '$1,296.23', '$1,241.10', '+$55.13', '+4.44%'],
      ['AAPL', '5', '$175.00', '$180.50', '$902.50', '$875.00', '+$27.50', '+3.14%'],
      ["SPY Oct21 '26 772 C", '3', '$1.59', '—', '—', '$477.00', '—', '—'],
    ])
  })

  it('keeps an unpriced position last whichever way a column is sorted', () => {
    const { container, getByRole } = render(
      <PositionsTable positions={[SPY_CALL_UNPRICED, AAPL, FRACTIONAL_NVDA]} />,
    )
    const symbols = (): string[] => rowTexts(container).map((cells) => cells[0]!.split(' ')[0]!)

    // Market value starts descending; one click turns it ascending.
    fireEvent.click(getByRole('button', { name: /Market value/ }))

    expect(symbols()).toEqual(['AAPL', 'NVDA', 'SPY'])
  })

  it('says how old a price that is no live mark is, and nothing beside a live one', () => {
    const { container } = render(<PositionsTable positions={[SPY_CALL_LAST_KNOWN, AAPL]} />)
    const [shares, option] = rowTexts(container)

    expect(option).toEqual([
      "SPY Oct21 '26 772 C",
      '3',
      '$1.59',
      expect.stringMatching(/^\$1\.75as of \S/),
      '$525.00',
      '$477.00',
      '+$48.00',
      '+10.06%',
    ])
    // The time shown is the one the broker gave, in the reader's own zone.
    expect(Array.from(container.querySelectorAll('time')).map((time) => time.dateTime)).toEqual([ROW_READ_AT])
    expect(shares![3]).toBe('$180.50')
  })

  it('makes up no time for a last known price the broker gave none for', () => {
    const { container } = render(<PositionsTable positions={[{ ...SPY_CALL_LAST_KNOWN, priceAsOf: null }]} />)

    expect(rowTexts(container)[0]![3]).toBe('$1.75last known, time not given')
    expect(container.querySelector('time')).toBeNull()
  })

  it('says so when the account holds nothing', () => {
    const { container } = render(<PositionsTable positions={[]} />)

    expect(container.textContent).toContain('No open positions.')
  })
})
