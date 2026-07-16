// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { expect, test } from 'vitest'

import { CalloutCard, parseContent } from './CalloutCard'

// Real message shape from GET /api/callouts.
const RAW =
  '<@&1455078048666882170>\nClose or Trim\n```ansi\n\u001b[1;32mTSLA 402C 2026-07-17\n3.3500  \u2192  3.8   P/L: +13.43%\u001b[0m\n```\n**Notes:** *From $4.80*\n[@Namrood](https://x.com/)  -  [LIVE DASHBOARD](https://y.com/)\n@Optionality | Wednesday - 07-15-2026  11:20 AM EST\nimage: https://cdn.discordapp.com/attachments/1/2/unknown.png?ex=abc'

test('strips role mentions and ANSI, splits fences, detects images/footers', () => {
  expect(parseContent(RAW)).toEqual([
    { kind: 'text', text: 'Close or Trim', footer: false },
    {
      kind: 'code',
      text: 'TSLA 402C 2026-07-17\n3.3500  \u2192  3.8   P/L: +13.43%',
    },
    { kind: 'text', text: '**Notes:** *From $4.80*', footer: false },
    {
      kind: 'text',
      text: '[@Namrood](https://x.com/)  -  [LIVE DASHBOARD](https://y.com/)',
      footer: true,
    },
    {
      kind: 'text',
      text: '@Optionality | Wednesday - 07-15-2026  11:20 AM EST',
      footer: true,
    },
    {
      kind: 'image',
      url: 'https://cdn.discordapp.com/attachments/1/2/unknown.png?ex=abc',
    },
  ])
})

test('card renders cleaned blocks: code, links, bold, image', () => {
  const { container } = render(
    <CalloutCard
      authorName="Optionality"
      channelName="callouts"
      timestamp="2026-07-15T15:20:00.000Z"
      content={RAW}
      footer={<span>backfill: not processed</span>}
    />,
  )
  expect(container.textContent).not.toContain('<@&')
  expect(container.textContent).not.toContain('\u001b')
  expect(container.querySelector('pre')?.textContent).toContain('TSLA 402C')
  const link = container.querySelector('a[href="https://y.com/"]')
  expect(link?.getAttribute('target')).toBe('_blank')
  expect(link?.textContent).toBe('LIVE DASHBOARD')
  expect(container.querySelector('strong')?.textContent).toBe('Notes:')
  expect(
    container.querySelector('img')?.getAttribute('src'),
  ).toContain('cdn.discordapp.com')
  expect(container.textContent).toContain('backfill: not processed')
})
