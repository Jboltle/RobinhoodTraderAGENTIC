/**
 * Settings resolution tests — payload override → client pull →
 * state/settings.json → env defaults, with config, fs and fetch fully mocked
 * (no disk, no network, no .env dependence).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/config.js', () => ({
  config: {
    tradeExecutionMode: 'immediate',
    maxNotionalPctPerTrade: 5,
    maxOptionsNotionalPct: 2,
    maxSingleContractPct: 5,
    positionSmallPct: 25,
    positionMediumPct: 50,
    maxTradesPerDay: 10,
    cooldownSecondsPerTicker: 300,
    allowedTickers: ['*'],
    blockedTickers: [],
    minConfidence: 0.7,
    regularHoursOnly: true,
    settingsPath: '/tmp/test-settings.json',
    clientSettingsUrl: null as string | null,
  },
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { readFile } from 'node:fs/promises';
import { config } from '../../shared/config.js';
import { envDefaultSettings, resolveSettings } from '../settings.js';

const readFileMock = vi.mocked(readFile);
const mutableConfig = config as { clientSettingsUrl: string | null };

const noFile = () =>
  readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
const fileWith = (contents: unknown) =>
  readFileMock.mockResolvedValue(JSON.stringify(contents));

beforeEach(() => {
  readFileMock.mockReset();
  mutableConfig.clientSettingsUrl = null;
  vi.unstubAllGlobals();
});

describe('resolveSettings — precedence', () => {
  it('falls back to env defaults when there is no file and no payload', async () => {
    noFile();
    const resolved = await resolveSettings();
    expect(resolved).toEqual(envDefaultSettings());
    expect(resolved.minConfidence).toBe(0.7);
    expect(resolved.executionMode).toBe('immediate');
  });

  it('file values override env defaults, untouched fields keep env values', async () => {
    fileWith({ maxTradesPerDay: 3, minConfidence: 0.5 });
    const resolved = await resolveSettings();
    expect(resolved.maxTradesPerDay).toBe(3);
    expect(resolved.minConfidence).toBe(0.5);
    expect(resolved.cooldownSeconds).toBe(300); // env default
  });

  it('payload overrides both file and env', async () => {
    fileWith({ minConfidence: 0.5, maxTradesPerDay: 3 });
    const resolved = await resolveSettings({ minConfidence: 0.9 });
    expect(resolved.minConfidence).toBe(0.9); // payload wins
    expect(resolved.maxTradesPerDay).toBe(3); // file wins over env
    expect(resolved.maxNotionalPct).toBe(5);  // env fallback
  });

  it('explicit undefined payload fields do not clobber lower layers', async () => {
    fileWith({ minConfidence: 0.5 });
    const resolved = await resolveSettings({ minConfidence: undefined });
    expect(resolved.minConfidence).toBe(0.5);
  });
});

describe('resolveSettings — invalid file', () => {
  it('ignores a file that is not valid JSON', async () => {
    readFileMock.mockResolvedValue('not json{');
    const resolved = await resolveSettings();
    expect(resolved).toEqual(envDefaultSettings());
  });

  it('ignores a file that fails schema validation', async () => {
    fileWith({ minConfidence: 5 }); // > 1, invalid
    const resolved = await resolveSettings();
    expect(resolved.minConfidence).toBe(0.7);
  });
});

describe('resolveSettings — client pull', () => {
  const clientResponds = (body: unknown, status = 200) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(status === 204 ? null : JSON.stringify(body), { status })
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('skips the pull entirely when CLIENT_SETTINGS_URL is unset', async () => {
    noFile();
    const fetchMock = clientResponds({ maxTradesPerDay: 1 });
    const resolved = await resolveSettings();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolved.maxTradesPerDay).toBe(10);
  });

  it('pulled settings win over the settings file, payload still wins over both', async () => {
    mutableConfig.clientSettingsUrl = 'http://client:3001/api/settings-state';
    fileWith({ maxTradesPerDay: 3, minConfidence: 0.5 });
    clientResponds({ maxTradesPerDay: 7, cooldownSeconds: 60 });
    const resolved = await resolveSettings({ cooldownSeconds: 30 });
    expect(resolved.maxTradesPerDay).toBe(7); // client wins over file
    expect(resolved.cooldownSeconds).toBe(30); // payload wins over client
    expect(resolved.minConfidence).toBe(0.5); // file wins over env
  });

  it('falls through to the file when the client is unreachable', async () => {
    mutableConfig.clientSettingsUrl = 'http://client:3001/api/settings-state';
    fileWith({ maxTradesPerDay: 3 });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const resolved = await resolveSettings();
    expect(resolved.maxTradesPerDay).toBe(3);
  });

  it('rejects a pulled body that fails schema validation and falls through', async () => {
    mutableConfig.clientSettingsUrl = 'http://client:3001/api/settings-state';
    fileWith({ minConfidence: 0.5 });
    clientResponds({ minConfidence: 5 }); // > 1, invalid
    const resolved = await resolveSettings();
    expect(resolved.minConfidence).toBe(0.5);
  });

  it('treats a 204 (nothing pushed this session) as empty', async () => {
    mutableConfig.clientSettingsUrl = 'http://client:3001/api/settings-state';
    fileWith({ maxTradesPerDay: 3 });
    clientResponds(null, 204);
    const resolved = await resolveSettings();
    expect(resolved.maxTradesPerDay).toBe(3);
  });
});
