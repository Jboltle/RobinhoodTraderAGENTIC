import { describe, expect, it } from 'vitest'

import type { DecisionKind } from '../lib/api'
import { isCompactKind, matchesTradeFilter } from './TradesTable'

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
