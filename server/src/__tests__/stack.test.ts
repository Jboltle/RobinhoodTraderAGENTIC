/**
 * The supervisor must never outlive a child.
 *
 * This is the whole reason trader and bot share a process: a service that keeps
 * answering /health while its Discord Gateway socket is dead drops callouts
 * silently, which is worse than being down. The check below kills the trader at
 * startup and asserts the supervisor exits non-zero instead of hanging around
 * with a half-dead tree.
 *
 * The child is failed by clearing a required variable rather than by omitting
 * env wholesale, because dotenv will not override a key that already exists —
 * so this behaves the same whether or not the developer has a real .env.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url));
const EXIT_TIMEOUT_MS = 30_000;

describe('stack supervisor', () => {
  it('exits non-zero when a child dies at startup', async () => {
    const child = spawn('bun', ['src/index.ts'], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        // Enough for the supervisor's own config import to succeed...
        LLM_PROVIDER: 'ollama',
        LLM_MODEL: 'qwen3:8b',
        TRADE_EXECUTION_MODE: 'approval',
        // ...and guaranteed to fail assertConfigValid('trader') in the child.
        SUPABASE_SERVICE_ROLE_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('supervisor did not exit after its child died'));
      }, EXIT_TIMEOUT_MS);
      // 'close', not 'exit': the supervisor's own log line is still in flight
      // through the pipe when the process goes away.
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('process exited unexpectedly');
  }, EXIT_TIMEOUT_MS);
});
