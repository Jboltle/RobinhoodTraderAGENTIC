import { expect, test } from 'vitest'

import {
  discordDefaultAvatarUrl,
  resolveTradeCaller,
  toggleCaller,
} from './following'

const ROSTER = ['1', '2', '3']

test('first deselect while following everyone materializes the explicit list', () => {
  expect(toggleCaller(null, ROSTER, '2')).toEqual(['1', '3'])
})

test('toggles membership of an explicit list', () => {
  expect(toggleCaller(['1', '3'], ROSTER, '3')).toEqual(['1'])
  expect(toggleCaller(['1'], ROSTER, '2')).toEqual(['1', '2'])
  expect(toggleCaller([], ROSTER, '1')).toEqual(['1'])
})

const CALLOUTS = new Map([
  ['hit', { authorId: '111', authorName: 'Ingest Name' }],
  ['unknown', { authorId: '222', authorName: 'Ingest Only' }],
  ['legacy', { authorId: null, authorName: 'Legacy Poster' }],
  ['blank', { authorId: null, authorName: '  ' }],
])
const ROSTER_BY_ID = new Map([
  ['111', { displayName: 'Roster Name', avatarUrl: 'https://cdn.example/a.png' }],
])

test('resolveTradeCaller uses roster name and avatar when the author is known', () => {
  expect(resolveTradeCaller('hit', CALLOUTS, ROSTER_BY_ID)).toEqual({
    name: 'Roster Name',
    avatarUrl: 'https://cdn.example/a.png',
  })
})

test('resolveTradeCaller falls back to the callout name and Discord default avatar', () => {
  expect(resolveTradeCaller('unknown', CALLOUTS, ROSTER_BY_ID)).toEqual({
    name: 'Ingest Only',
    avatarUrl: discordDefaultAvatarUrl('222'),
  })
})

test('resolveTradeCaller shows a legacy name with no avatar', () => {
  expect(resolveTradeCaller('legacy', CALLOUTS, ROSTER_BY_ID)).toEqual({
    name: 'Legacy Poster',
    avatarUrl: null,
  })
})

test('resolveTradeCaller is null when the callout or author is missing', () => {
  expect(resolveTradeCaller('missing', CALLOUTS, ROSTER_BY_ID)).toBeNull()
  expect(resolveTradeCaller('blank', CALLOUTS, ROSTER_BY_ID)).toBeNull()
})
