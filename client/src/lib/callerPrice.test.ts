import { describe, expect, it } from 'vitest'

import type { CalloutItem } from './api'
import { callerPrice, priceGapPct } from './callerPrice'

const callout = (overrides: Partial<CalloutItem>): CalloutItem => ({
  messageId: 'm1',
  channelId: 'c1',
  channelName: null,
  authorId: 'a1',
  authorName: 'Swift Alerts',
  timestamp: '2026-10-21T13:43:06.000Z',
  content: '',
  embeds: [],
  parseStatus: 'parsed',
  parse: null,
  decision: null,
  ...overrides,
})

describe('callerPrice', () => {
  it("an entry's price is the parsed limit, the Caller's stated premium", () => {
    expect(callerPrice(callout({ parse: { action: 'buy', limitPrice: 0.555 } }), 'buy')).toBe(0.555)
  })

  it("an exit's price comes from a Swift card's Exit field", () => {
    const swift = callout({
      embeds: [{ fields: [{ name: 'Entry', value: '`$0.555`' }, { name: 'Exit', value: '`$0.585`' }] }],
    })
    expect(callerPrice(swift, 'sell')).toBe(0.585)
  })

  it("an exit's price falls back to the 'entry -> price' arrow on a milestone line", () => {
    const namrood = callout({ content: 'TRIM\nQQQ 707C 2026-06-11\n1.5900 -> 1.75 P/L: +10.06% ($16.00)' })
    expect(callerPrice(namrood, 'sell')).toBe(1.75)
  })

  it('is null without a callout, a side, or any price in the card', () => {
    expect(callerPrice(undefined, 'buy')).toBeNull()
    expect(callerPrice(callout({}), null)).toBeNull()
    expect(callerPrice(callout({ content: 'all out' }), 'sell')).toBeNull()
  })
})

describe('priceGapPct', () => {
  it('is our fill against theirs, signed, as a percent of theirs', () => {
    expect(priceGapPct(0.66, 0.73)).toBeCloseTo(-9.589, 2)
    expect(priceGapPct(0.26, 0.255)).toBeCloseTo(1.96, 2)
  })

  it('is null when either side is missing', () => {
    expect(priceGapPct(null, 0.73)).toBeNull()
    expect(priceGapPct(0.66, null)).toBeNull()
  })
})
