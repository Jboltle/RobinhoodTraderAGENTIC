/**
 * Service entrypoint: supervises the trader and the Discord bot as one process
 * tree. Used for `bun run dev` and in production — they are the same thing, and
 * a production path that differs from the one you develop against is a
 * production path nobody has tested.
 *
 * Why one process at all: the bot holds a Discord Gateway websocket and binds
 * no port of its own, so nothing can ping it awake. On a host that suspends
 * idle services (Render's free tier) a sleeping bot silently drops callouts —
 * no order is placed and nothing surfaces as an error. Sharing the trader's
 * port means the one keep-alive ping on /health also keeps the Gateway alive.
 *
 * Failure is deliberately all-or-nothing: if either child exits, the whole tree
 * goes down with a non-zero code. A process still answering /health while its
 * Gateway socket is dead is the exact silent failure this file exists to
 * prevent, so the honest signal is to stop answering. The platform restarts us
 * and catchUpOnWake replays whatever arrived in the gap.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { config } from './shared/config.js';
import { createLogger } from './shared/logger.js';

const log = createLogger('stack');

const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 750;
/** Render's free tier sleeps a service after 15 idle minutes; 10 keeps margin. */
const KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000;
/** Time a child gets to exit on its own before it is killed outright. Render
 *  allows 30s after SIGTERM, so this leaves plenty of room. */
const SHUTDOWN_GRACE_MS = 5_000;
const SHUTDOWN_POLL_MS = 50;

const children = new Map<string, ChildProcess>();
let shuttingDown = false;

async function main(): Promise<void> {
  const trader = start('trader', 'src/trader/index.ts');

  // The bot POSTs every callout to the trader's webhook, so starting it first
  // would drop whatever arrives before the trader is listening.
  await waitForTraderHealth(trader);
  start('bot', 'src/bot/index.ts');
  startKeepAlive();

  log.info('stack running', {
    health: `http://localhost:${config.traderPort}/health`,
    webhook: config.traderWebhookUrl,
  });
}

/**
 * Self-ping so Render's free tier never idles us out. Render suspends a free
 * web service after 15 minutes without inbound HTTP traffic; requests to the
 * service's own public URL go through Render's proxy and count as inbound, so
 * pinging /health every 10 minutes keeps the whole tree (Gateway socket
 * included) awake without an external cron. RENDER_EXTERNAL_URL is injected by
 * Render, so locally this is a no-op. If the process ever does die, Render's
 * restart brings the ping loop back with it.
 */
function startKeepAlive(): void {
  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (!externalUrl) return;

  const url = `${externalUrl}/health`;
  log.info('keep-alive self-ping enabled', { url, intervalMs: KEEP_ALIVE_INTERVAL_MS });
  setInterval(() => {
    // A failed ping is worth a log line but not a shutdown: the platform
    // health check is the real liveness signal.
    fetch(url).catch((err: unknown) =>
      log.warn('keep-alive ping failed', { error: (err as Error).message })
    );
  }, KEEP_ALIVE_INTERVAL_MS);
}

function start(name: string, entrypoint: string): ChildProcess {
  log.info('starting process', { name, entrypoint });

  const child = spawn('bun', [entrypoint], { env: process.env, stdio: 'inherit' });

  children.set(name, child);
  child.once('exit', (code, signal) => {
    children.delete(name);
    if (shuttingDown) return;

    // Always a failure, whatever the child's own exit code says: neither half
    // is supposed to finish while the service is meant to be up.
    log.error('process exited unexpectedly', { name, code, signal });
    void shutdown(1);
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
      // Still binding its port.
    }

    await sleep(HEALTH_POLL_MS);
  }

  throw new Error(`trader did not become healthy within ${HEALTH_TIMEOUT_MS}ms`);
}

/**
 * Forwards `signal` to every child, then escalates to SIGKILL for any that is
 * still alive once the grace period is up.
 */
async function shutdown(code: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<never> {
  shuttingDown = true;
  for (const [name, child] of children) {
    log.info('stopping process', { name, signal });
    child.kill(signal);
  }

  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (children.size > 0 && Date.now() < deadline) {
    await sleep(SHUTDOWN_POLL_MS);
  }

  for (const [name, child] of children) {
    log.warn('killing unresponsive process', { name });
    child.kill('SIGKILL');
  }

  process.exit(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown(0, signal));
}

main().catch((err) => {
  log.error('stack failed to start', { error: (err as Error).message });
  void shutdown(1);
});
