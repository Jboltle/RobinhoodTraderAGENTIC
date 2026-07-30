import { expect, test } from 'vitest'

import { toggleCaller } from './following'

const ROSTER = ['1', '2', '3']

test('first deselect while following everyone materializes the explicit list', () => {
  expect(toggleCaller(null, ROSTER, '2')).toEqual(['1', '3'])
})

test('toggles membership of an explicit list', () => {
  expect(toggleCaller(['1', '3'], ROSTER, '3')).toEqual(['1'])
  expect(toggleCaller(['1'], ROSTER, '2')).toEqual(['1', '2'])
  expect(toggleCaller([], ROSTER, '1')).toEqual(['1'])
})
