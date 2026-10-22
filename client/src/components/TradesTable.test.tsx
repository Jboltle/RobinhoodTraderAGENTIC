import { describe, expect, it } from 'vitest'

import type { DecisionKind, SubmittedOrder } from '../lib/api'
import { isCompactKind, matchesTradeFilter, orderStateLabel } from './TradesTable'

const placed = (overrides: Partial<SubmittedOrder>): SubmittedOrder => ({
  symbol: 'SPY',
  side: 'buy',
  assetType: 'option',
  quantity: 3,
  orderType: 'limit',
  limitPrice: 0.865,
  option: { optionType: 'call', strike: 772, expiration: '2026-10-21' },
  orderId: 'ord-1',
  status: 'unconfirmed',
  ...overrides,
})

describe('orderStateLabel', () => {
  it('reads a fresh or in-flight order as working, whatever the broker calls it', () => {
    for (const status of ['unconfirmed', 'confirmed', 'queued', 'submitted', null]) {
      expect(orderStateLabel(placed({ status })), String(status)).toEqual({ text: 'working', tone: 'muted' })
    }
  })

  it('shows the fill price once the monitor has recorded one', () => {
    expect(orderStateLabel(placed({ status: 'filled', filledQuantity: 3, averageFillPrice: 0.86 }))).toEqual({
      text: 'filled @ $0.86',
      tone: 'gain',
    })
    expect(orderStateLabel(placed({ status: 'partially_filled', filledQuantity: 1 }))).toEqual({
      text: 'partial 1/3',
      tone: 'gain',
    })
  })

  it('names a dead order for what it is', () => {
    for (const status of ['cancelled', 'rejected', 'expired']) {
      expect(orderStateLabel(placed({ status }))).toEqual({ text: status, tone: 'loss' })
    }
  })
})

describe('isCompactKind', () => {
  it('collapses only the kinds that never carried an order', () => {
    expect(isCompactKind('risk_rejected')).toBe(true)
    expect(isCompactKind('rejected')).toBe(true)

    const fullKinds: DecisionKind[] = [
      'submitted',
      'pending_approval',
      'execution_failed',
      'max_loss_exit',
    ]
    for (const kind of fullKinds) {
      expect(isCompactKind(kind), kind).toBe(false)
    }
  })
})

describe('matchesTradeFilter', () => {
  it('buckets every trade kind into exactly one non-all filter', () => {
    const tradeKinds: DecisionKind[] = [
      'risk_rejected',
      'pending_approval',
      'rejected',
      'submitted',
      'execution_failed',
      'max_loss_exit',
    ]
    const filters = ['pending', 'executed', 'skipped', 'failed'] as const

    for (const kind of tradeKinds) {
      expect(matchesTradeFilter(kind, 'all'), kind).toBe(true)
      const matches = filters.filter((f) => matchesTradeFilter(kind, f))
      expect(matches, kind).toHaveLength(1)
    }
  })

  it('sorts outcomes into the buckets the chips advertise', () => {
    expect(matchesTradeFilter('pending_approval', 'pending')).toBe(true)
    expect(matchesTradeFilter('submitted', 'executed')).toBe(true)
    expect(matchesTradeFilter('max_loss_exit', 'executed')).toBe(true)
    expect(matchesTradeFilter('risk_rejected', 'skipped')).toBe(true)
    expect(matchesTradeFilter('rejected', 'skipped')).toBe(true)
    expect(matchesTradeFilter('execution_failed', 'failed')).toBe(true)
  })
})
