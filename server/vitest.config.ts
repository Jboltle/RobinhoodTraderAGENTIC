import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'vitest/config';

// src/shared/config.ts fails fast at import when its required vars are unset,
// which breaks the whole suite on machines without a populated .env (fresh
// clone / CI). Load .env first so real values always win, then supply
// obviously-fake dummies ONLY for vars that are still missing.
loadDotenv({ path: new URL('../.env', import.meta.url) });

const dummyEnvForMissingRequiredVars: Record<string, string> = {
  LLM_PROVIDER: 'ollama',
  LLM_MODEL: 'test-dummy-model',
  TRADE_EXECUTION_MODE: 'approval',
  // Not required at import, but forwardToTrader.test.ts signs real HMAC
  // payloads with config.botTraderSecret, and an empty secret fails verify.
  BOT_TRADER_SECRET: 'test-dummy-secret',
};

export default defineConfig({
  test: {
    env: Object.fromEntries(
      Object.entries(dummyEnvForMissingRequiredVars).filter(
        ([name]) => !process.env[name]?.trim()
      )
    ),
  },
});
