/**
 * The order fence of a paper_only deployment: which account rows count as
 * paper, and what the deployment mode becomes for one account.
 */
import { describe, expect, it } from 'vitest';

import { TRADE_EXECUTION_MODES } from '../../../shared/types.js';
import { PAPER_BROKERAGE_SLUGS, executionModeFor, isPaperAccount } from '../paperAccount.js';
import type { AccountRow } from '../types.js';

const ALPACA_PAPER: AccountRow = {
  id: 'account-paper',
  userId: 'user-1',
  adapter: 'snaptrade',
  institution: 'alpaca-paper',
  externalAccountId: 'snaptrade-account-1',
  label: 'Alpaca Paper',
  isPaper: true,
  needsReconnect: false,
  adapterData: { connectionId: 'connection-1', institutionSlug: 'ALPACA-PAPER', maskedAccountNumber: '1234' },
};

const ROBINHOOD: AccountRow = {
  id: 'account-robinhood',
  userId: 'user-1',
  adapter: 'robinhood',
  institution: 'robinhood',
  externalAccountId: null,
  label: 'Robinhood',
  isPaper: false,
  needsReconnect: false,
  adapterData: {},
};

/** A row as the database could hand it over if its shape check were ever bypassed. */
const row = (fields: Record<string, unknown>): AccountRow => ({ ...ALPACA_PAPER, ...fields }) as AccountRow;
const withSlug = (institutionSlug: unknown): AccountRow =>
  row({ adapterData: { ...ALPACA_PAPER.adapterData, institutionSlug } });

describe('isPaperAccount', () => {
  it('the allowlist holds ALPACA-PAPER and nothing else', () => {
    expect([...PAPER_BROKERAGE_SLUGS]).toEqual(['ALPACA-PAPER']);
  });

  it('a SnapTrade account flagged paper at an allowlisted brokerage is paper', () => {
    expect(isPaperAccount(ALPACA_PAPER)).toBe(true);
  });

  it.each([
    ['not flagged paper', row({ isPaper: false })],
    ['flagged paper, at a brokerage that is not on the allowlist', withSlug('ALPACA')],
    ['a live broker', row({ isPaper: false, adapterData: { ...ALPACA_PAPER.adapterData, institutionSlug: 'SCHWAB' } })],
    ['not reached through SnapTrade', row({ adapter: 'robinhood' })],
    ['reached through an adapter this code has never heard of', row({ adapter: 'alpaca' })],
  ])('each of the three conditions is required: %s', (_name, account) => {
    expect(isPaperAccount(account)).toBe(false);
  });

  it.each([
    ['as it is today', ROBINHOOD],
    ['flagged paper', { ...ROBINHOOD, isPaper: true }],
    ['flagged paper and carrying the allowlisted slug', row({ adapter: 'robinhood' })],
  ])('a Robinhood row is never paper: %s', (_name, account) => {
    expect(isPaperAccount(account)).toBe(false);
  });

  // The slug is compared exactly as SnapTrade writes it: a near match is a
  // brokerage this code has not been told about.
  it.each(['alpaca-paper', 'Alpaca-Paper', ' ALPACA-PAPER', 'ALPACA-PAPER ', 'ALPACA_PAPER', 'ALPACA-PAPER-2', ''])(
    'the slug is matched exactly, case included: %j is not paper',
    (slug) => {
      expect(isPaperAccount(withSlug(slug))).toBe(false);
    }
  );

  it.each([
    ['adapter_data missing', row({ adapterData: undefined })],
    ['adapter_data null', row({ adapterData: null })],
    ['adapter_data empty', row({ adapterData: {} })],
    ['adapter_data a string', row({ adapterData: 'ALPACA-PAPER' })],
    ['adapter_data a list', row({ adapterData: ['ALPACA-PAPER'] })],
    ['no slug', withSlug(undefined)],
    ['slug null', withSlug(null)],
    ['slug a list holding the allowlisted one', withSlug(['ALPACA-PAPER'])],
    ['slug an object that prints as the allowlisted one', withSlug({ toString: () => 'ALPACA-PAPER' })],
    ['paper flag the string "true"', row({ isPaper: 'true' })],
    ['paper flag 1', row({ isPaper: 1 })],
    ['paper flag missing', row({ isPaper: undefined })],
  ])('malformed data is never paper: %s', (_name, account) => {
    expect(isPaperAccount(account)).toBe(false);
  });
});

describe('executionModeFor', () => {
  it.each(['immediate', 'approval', 'read_only'] as const)(
    '%s applies to every account as it is',
    (deployment) => {
      expect(executionModeFor(deployment, ALPACA_PAPER)).toBe(deployment);
      expect(executionModeFor(deployment, ROBINHOOD)).toBe(deployment);
    }
  );

  it('paper_only is immediate for a paper account: its own settings decide', () => {
    expect(executionModeFor('paper_only', ALPACA_PAPER)).toBe('immediate');
  });

  it.each([
    ['a Robinhood account', ROBINHOOD],
    ['a SnapTrade account at a live broker', row({ isPaper: false, adapterData: { ...ALPACA_PAPER.adapterData, institutionSlug: 'SCHWAB' } })],
    ['a SnapTrade account flagged paper at a brokerage not on the allowlist', withSlug('SCHWAB')],
    ['a SnapTrade account at an allowlisted brokerage, not flagged paper', row({ isPaper: false })],
    ['a row with malformed adapter_data', row({ adapterData: null })],
  ])('paper_only is read_only for %s', (_name, account) => {
    expect(executionModeFor('paper_only', account)).toBe('read_only');
  });

  it('no mode is ever handed on as paper_only', () => {
    for (const deployment of TRADE_EXECUTION_MODES) {
      for (const account of [ALPACA_PAPER, ROBINHOOD]) {
        expect(executionModeFor(deployment, account)).not.toBe('paper_only');
      }
    }
  });
});
