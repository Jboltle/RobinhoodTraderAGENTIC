/**
 * Trade-settings resolution: payload override → client dashboard pull →
 * state/settings.json → env defaults from config.
 * Resolved ONCE per incoming message; the risk filter
 * receives the result as plain parameters. Persistent risk STATE (cooldowns,
 * daily counters) stays in state/risk.json and is never carried in payloads.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import {
  TradeSettingsSchema,
  type ResolvedTradeSettings,
  type TradeSettings,
} from '../shared/types.js';

const log = createLogger('trader:settings');

/** Last-resort defaults sourced from env (see the risk section of config.ts). */
export function envDefaultSettings(): ResolvedTradeSettings {
  return {
    executionMode: config.tradeExecutionMode,
    maxNotionalPct: config.maxNotionalPctPerTrade,
    maxOptionsNotionalPct: config.maxOptionsNotionalPct,
    maxSingleContractPct: config.maxSingleContractPct,
    positionSmallPct: config.positionSmallPct,
    positionMediumPct: config.positionMediumPct,
    maxTradesPerDay: config.maxTradesPerDay,
    cooldownSeconds: config.cooldownSecondsPerTicker,
    allowedTickers: config.allowedTickers,
    blockedTickers: config.blockedTickers,
    minConfidence: config.minConfidence,
    regularHoursOnly: config.regularHoursOnly,
  };
}

/** Validated contents of state/settings.json; {} when absent or invalid. */
export async function readSettingsFile(): Promise<TradeSettings> {
  let raw: string;
  try {
    raw = await readFile(config.settingsPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('failed to read settings file', { error: (err as Error).message });
    }
    return {};
  }
  try {
    const parsed = TradeSettingsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log.warn('settings file failed validation, ignoring', { error: parsed.error.message });
      return {};
    }
    return parsed.data;
  } catch (err) {
    log.warn('settings file is not valid JSON, ignoring', { error: (err as Error).message });
    return {};
  }
}

export async function writeSettingsFile(settings: TradeSettings): Promise<void> {
  await mkdir(dirname(config.settingsPath), { recursive: true });
  // Write-then-rename so a crash mid-write can never leave a truncated file
  // (readSettingsFile would silently fall back to env defaults, loosening limits).
  const tmpPath = `${config.settingsPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(settings, null, 2), 'utf8');
  await rename(tmpPath, config.settingsPath);
}

const CLIENT_PULL_TIMEOUT_MS = 500;

// Log the first pull failure, then stay quiet until a pull succeeds again —
// resolution runs per message and an offline dashboard would spam the log.
let clientPullFailureLogged = false;

/**
 * Session settings pulled from the client dashboard; {} when
 * CLIENT_SETTINGS_URL is unset or on any failure (unreachable, timeout,
 * non-2xx, invalid body). The client is untrusted input: the body must pass
 * TradeSettingsSchema before use.
 */
export async function readClientSettings(): Promise<TradeSettings> {
  if (!config.clientSettingsUrl) return {};
  try {
    const res = await fetch(config.clientSettingsUrl, {
      signal: AbortSignal.timeout(CLIENT_PULL_TIMEOUT_MS),
    });
    if (res.status === 204) return {};
    if (!res.ok) throw new Error(`status ${res.status}`);
    const parsed = TradeSettingsSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error(`invalid body: ${parsed.error.message}`);
    clientPullFailureLogged = false;
    return parsed.data;
  } catch (err) {
    if (!clientPullFailureLogged) {
      clientPullFailureLogged = true;
      log.info('client settings pull failed, falling through', {
        url: config.clientSettingsUrl,
        error: (err as Error).message,
      });
    }
    return {};
  }
}

const definedFields = (settings: TradeSettings): Partial<ResolvedTradeSettings> =>
  Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined));

/** Resolution chain: payload override → client pull → settings file → env defaults. */
export async function resolveSettings(override: TradeSettings = {}): Promise<ResolvedTradeSettings> {
  const [file, client] = await Promise.all([readSettingsFile(), readClientSettings()]);
  return {
    ...envDefaultSettings(),
    ...definedFields(file),
    ...definedFields(client),
    ...definedFields(override),
  };
}
