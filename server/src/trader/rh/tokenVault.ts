/**
 * Encrypted Robinhood token backup ("token vault") in a private Discord
 * channel. Render's free tier has no persistent disk, so state/rh-tokens.json
 * is wiped on every deploy; the vault restores it at startup and backs it up
 * after every token persist. Tokens are AES-256-GCM encrypted before leaving
 * the box — Discord only ever sees ciphertext.
 *
 * SAFETY: best-effort by design. Every REST/fs failure is caught and logged
 * at warn — the vault must never crash or block trading. The plain OAuth
 * dashboard flow remains the fallback when restore fails.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { Routes, type REST } from 'discord.js';

import { createLogger } from '../../shared/logger.js';
import { config } from '../../shared/config.js';

const log = createLogger('trader:rh:vault');

const VAULT_FILE_NAME = 'rh-tokens.enc';
const VAULT_MESSAGE_CONTENT = 'Robinhood token vault backup — do not delete';
const RESTORE_MESSAGE_LIMIT = 10;

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

// ponytail: the encryption key is derived from BOT_TRADER_SECRET instead of a
// dedicated key — single-user setup, one less env var to manage. Upgrade path:
// a dedicated RH_TOKENS_VAULT_KEY if the secret ever needs rotating separately.
const deriveKey = (secret: string): Buffer => createHash('sha256').update(secret).digest();

/**
 * AES-256-GCM encrypt. Blob layout: iv (12 bytes) || authTag (16 bytes) || ciphertext.
 */
export function encryptTokens(plaintext: string, secret: string): Buffer {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Inverse of encryptTokens; throws on tampering or a wrong secret. */
export function decryptTokens(blob: Buffer, secret: string): string {
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const authTag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Subset of Discord's REST message object the vault consumes. */
interface VaultMessage {
  readonly id: string;
  readonly attachments?: readonly { readonly filename: string; readonly url: string }[];
}

// Last vault message posted by THIS process; deleted after the next successful
// post so the channel holds one fresh backup instead of an unbounded pile.
let lastBackupMessageId: string | null = null;

/**
 * Encrypt the local token file and post it to the vault channel as an
 * attachment, then delete the previous backup message from this process.
 */
export async function backupTokens(rest: REST, channelId: string, tokensPath: string): Promise<void> {
  try {
    const plaintext = await readFile(tokensPath, 'utf8');
    const blob = encryptTokens(plaintext, config.botTraderSecret);
    const posted = (await rest.post(Routes.channelMessages(channelId), {
      body: { content: VAULT_MESSAGE_CONTENT },
      files: [{ name: VAULT_FILE_NAME, data: blob }],
    })) as { id: string };

    const previousId = lastBackupMessageId;
    lastBackupMessageId = posted.id;
    if (previousId) {
      await rest.delete(Routes.channelMessage(channelId, previousId)).catch((err: unknown) => {
        log.warn('failed to delete previous vault message', { error: (err as Error).message });
      });
    }
    log.info('backed up encrypted Robinhood tokens to vault channel');
  } catch (err) {
    log.warn('token vault backup failed', { error: (err as Error).message });
  }
}

/**
 * Restore the token file from the newest vault backup in the channel.
 * No-op (false) when the file already exists; false on any failure — the
 * normal OAuth flow is the fallback.
 */
export async function restoreTokens(
  rest: REST,
  channelId: string,
  tokensPath: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  if (existsSync(tokensPath)) return false;
  try {
    // Discord returns messages newest-first.
    const messages = (await rest.get(Routes.channelMessages(channelId), {
      query: new URLSearchParams({ limit: String(RESTORE_MESSAGE_LIMIT) }),
    })) as VaultMessage[];
    const attachment = messages
      .flatMap((m) => m.attachments ?? [])
      .find((a) => a.filename === VAULT_FILE_NAME);
    if (!attachment) {
      log.info('no token vault backup found in channel');
      return false;
    }

    const res = await fetchImpl(attachment.url);
    if (!res.ok) throw new Error(`attachment download failed: HTTP ${res.status}`);
    const blob = Buffer.from(await res.arrayBuffer());
    const plaintext = decryptTokens(blob, config.botTraderSecret);

    await mkdir(dirname(tokensPath), { recursive: true });
    await writeFile(tokensPath, plaintext, { mode: 0o600 });
    log.info('restored Robinhood tokens from vault channel');
    return true;
  } catch (err) {
    log.warn('token vault restore failed', { error: (err as Error).message });
    return false;
  }
}
