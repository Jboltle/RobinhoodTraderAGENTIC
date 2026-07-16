import { spawn, type ChildProcess } from 'node:child_process';

import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { readTokenStatus } from '../trader/rh/tokenBootstrap.js';

const log = createLogger('dev');
const HEALTH_TIMEOUT_MS = Number(process.env.DEV_TRADER_HEALTH_TIMEOUT_MS ?? 10 * 60 * 1000);
const HEALTH_POLL_MS = 750;

const children = new Map<string, ChildProcess>();
let shuttingDown = false;

async function main(): Promise<void> {
  await logAuthPreflight();

  const trader = start('trader', 'tsx', ['src/trader/index.ts']);

  await waitForTraderHealth(trader);
  start('bot', 'tsx', ['src/bot/index.ts']);

  log.info('dev stack running', {
    traderHealth: `http://localhost:${config.traderPort}/health`,
    webhook: config.traderWebhookUrl,
  });
}

/**
 * Report the Robinhood auth state before the trader starts so the operator
 * knows whether to expect a browser OAuth prompt during the health wait.
 */
async function logAuthPreflight(): Promise<void> {
  if (config.tradeExecutionMode !== 'immediate') {
    log.info('approval mode: Robinhood MCP disabled, no auth required');
    return;
  }

  const status = await readTokenStatus(config.rhTokensPath);
  const browserOAuthLikely = status.state === 'missing' || status.state === 'expired';
  log.info('Robinhood auth preflight', {
    tokenState: status.state,
    expiresInMin: status.expiresInSec !== null ? Math.round(status.expiresInSec / 60) : null,
    hasRefreshToken: status.hasRefreshToken,
    browserOAuthLikely,
    hint: browserOAuthLikely
      ? 'trader will try a Codex token import, then print an OAuth URL if needed'
      : 'trader should connect with saved tokens',
  });
}

function start(name: string, command: string, args: string[]): ChildProcess {
  log.info('starting process', { name, command: [command, ...args].join(' ') });

  const child = spawn(command, args, {
    env: process.env,
    stdio: 'inherit',
  });

  children.set(name, child);
  child.once('exit', (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;

    log.error('process exited', { name, code, signal });
    void shutdown(code ?? 1);
  });
  child.once('error', (err) => {
    children.delete(name);
    if (shuttingDown) return;

    log.error('failed to start process', { name, error: err.message });
    void shutdown(1);
  });

  return child;
}

async function waitForTraderHealth(trader: ChildProcess): Promise<void> {
  const url = `http://127.0.0.1:${config.traderPort}/health`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  log.info('waiting for trader health', { url, timeoutMs: HEALTH_TIMEOUT_MS });

  while (Date.now() < deadline) {
    if (trader.exitCode !== null || trader.signalCode !== null) {
      throw new Error('trader exited before becoming healthy');
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Trader is still starting or waiting for first-time Robinhood OAuth.
    }

    await sleep(HEALTH_POLL_MS);
  }

  throw new Error(`trader did not become healthy within ${HEALTH_TIMEOUT_MS}ms`);
}

async function shutdown(code = 0): Promise<never> {
  shuttingDown = true;
  for (const [name, child] of children) {
    log.info('stopping process', { name });
    child.kill('SIGINT');
  }

  await sleep(500);
  for (const [name, child] of children) {
    if (child.exitCode === null && child.signalCode === null) {
      log.warn('force stopping process', { name });
      child.kill('SIGTERM');
    }
  }

  process.exit(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

main().catch((err) => {
  log.error('dev stack failed', { error: (err as Error).message });
  void shutdown(1);
});
