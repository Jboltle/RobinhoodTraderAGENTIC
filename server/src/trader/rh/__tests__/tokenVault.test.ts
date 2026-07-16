/**
 * Token vault: encrypt/decrypt round-trip, restore short-circuit and happy
 * path, backup posting a files attachment.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/config.js', () => ({
  config: { botTraderSecret: 'test-secret' },
}));

import { backupTokens, decryptTokens, encryptTokens, restoreTokens } from '../tokenVault.js';

import type { REST } from 'discord.js';

const SECRET = 'test-secret';
const TOKENS_JSON = JSON.stringify({ tokens: { access_token: 'abc', refresh_token: 'def' } });

const tempTokensPath = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), 'vault-test-')), 'rh-tokens.json');

describe('encryptTokens / decryptTokens', () => {
  it('round-trips plaintext', () => {
    const blob = encryptTokens(TOKENS_JSON, SECRET);
    expect(blob.toString('utf8')).not.toContain('access_token');
    expect(decryptTokens(blob, SECRET)).toBe(TOKENS_JSON);
  });

  it('throws when decrypting with the wrong secret', () => {
    const blob = encryptTokens(TOKENS_JSON, SECRET);
    expect(() => decryptTokens(blob, 'wrong-secret')).toThrow();
  });
});

describe('restoreTokens', () => {
  it('returns false without any REST call when the token file exists', async () => {
    const tokensPath = await tempTokensPath();
    await writeFile(tokensPath, TOKENS_JSON);
    const rest = { get: vi.fn() } as unknown as REST;

    expect(await restoreTokens(rest, 'chan-1', tokensPath)).toBe(false);
    expect(rest.get).not.toHaveBeenCalled();
  });

  it('downloads, decrypts, and writes the newest vault attachment', async () => {
    const tokensPath = await tempTokensPath();
    const blob = encryptTokens(TOKENS_JSON, SECRET);
    const rest = {
      get: vi.fn(async () => [
        { id: 'msg-2', attachments: [] },
        {
          id: 'msg-1',
          attachments: [{ filename: 'rh-tokens.enc', url: 'https://cdn.test/rh-tokens.enc' }],
        },
      ]),
    } as unknown as REST;
    const fetchImpl = vi.fn(async () =>
      new Response(new Uint8Array(blob), { status: 200 })
    ) as unknown as typeof fetch;

    expect(await restoreTokens(rest, 'chan-1', tokensPath, fetchImpl)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('https://cdn.test/rh-tokens.enc');
    expect(await readFile(tokensPath, 'utf8')).toBe(TOKENS_JSON);
  });

  it('returns false and writes nothing when no backup message exists', async () => {
    const tokensPath = await tempTokensPath();
    const rest = { get: vi.fn(async () => []) } as unknown as REST;

    expect(await restoreTokens(rest, 'chan-1', tokensPath)).toBe(false);
    expect(existsSync(tokensPath)).toBe(false);
  });
});

describe('backupTokens', () => {
  it('posts the encrypted file as an attachment', async () => {
    const tokensPath = await tempTokensPath();
    await writeFile(tokensPath, TOKENS_JSON);
    const post = vi.fn(async () => ({ id: 'msg-1' }));
    const rest = { post, delete: vi.fn() } as unknown as REST;

    await backupTokens(rest, 'chan-1', tokensPath);

    expect(post).toHaveBeenCalledTimes(1);
    const [, options] = post.mock.calls[0] as unknown as [
      string,
      { files: Array<{ name: string; data: Buffer }> },
    ];
    expect(options.files).toHaveLength(1);
    const file = options.files[0]!;
    expect(file.name).toBe('rh-tokens.enc');
    expect(decryptTokens(file.data, SECRET)).toBe(TOKENS_JSON);
  });
});
