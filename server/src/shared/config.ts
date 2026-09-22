import { config as loadDotenv } from 'dotenv';

// Env files live at the repo root (one level above server/). Resolve them
// relative to this file, not cwd, so env loads no matter where the process
// starts. In Docker the files don't exist (compose env_file injects vars) and
// dotenv silently no-ops.
const rootEnvFile = (name: string) => new URL(`../../../${name}`, import.meta.url);

// Base .env first (shared config; may set NODE_ENV), then the profile it
// selects. dotenv never overrides variables that are already set, so a
// NODE_ENV from the shell or a package.json script beats the .env line, and
// base values beat profile values on overlap.
loadDotenv({ path: rootEnvFile('.env') });
const nodeEnv = process.env.NODE_ENV === 'production' ? 'production' : 'development';
loadDotenv({ path: rootEnvFile(`.env.${nodeEnv}`) });

const env = process.env;

const OAUTH_CALLBACK_PATH = '/oauth/callback';

const list = (s: string | undefined, t: (x: string) => string = (x) => x): string[] =>
  (s ?? '')
    .split(',')
    .map((p) => t(p.trim()))
    .filter((p) => p.length > 0);

const num = (s: string | undefined, fallback: number): number => {
  const parsed = Number(s);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const requiredString = (name: string): string => {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required. Set it in .env (see .env.example).`);
  }
  return value;
};

// OAuth: the browser is redirected to `redirectUri`; the local listener binds
// `callbackHost:callbackPort`. `redirectUri` defaults to the redirect host so
// it need not be set explicitly, but stays overridable for WSL/remote setups.
const traderPort = num(env.PORT ?? env.TRADER_PORT, 3000);
const oauthCallbackPort = num(env.ROBINHOOD_OAUTH_CALLBACK_PORT, 8788);
const oauthRedirectHost = env.ROBINHOOD_OAUTH_REDIRECT_HOST?.trim() || '127.0.0.1';
const oauthRedirectUri =
  env.ROBINHOOD_OAUTH_REDIRECT_URI?.trim() ||
  `http://${oauthRedirectHost}:${oauthCallbackPort}${OAUTH_CALLBACK_PATH}`;

export const config = {
  // ---- Discord ----------------------------------------------------------------
  // Capture-side channel/author allowlists (DISCORD_ALLOWED_CHANNEL_IDS,
  // DISCORD_ALLOWED_AUTHOR_IDS, DISCORD_USER_TOKEN) are read by the Listener
  // (server/listener) from the same .env; the trader only needs to know which
  // captured channels are recaps.
  /**
   * Channels carrying daily trade-recap posts. The poller routes their
   * `messages` rows to the recaps table; structurally isolated from trading.
   */
  discordRecapChannelIds: list(env.DISCORD_RECAP_CHANNEL_IDS),

  // ---- LLM -------------------------------------------------------------------
  // Backend is inferred from this id in llm.ts. Optional `openai/`,
  // `anthropic/`, or `ollama/` prefix overrides the heuristic.
  llmModel: requiredString('LLM_MODEL'),
  ollamaBaseUrl: env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
  openaiApiKey: env.OPENAI_API_KEY ?? '',

  // ---- Robinhood MCP ---------------------------------------------------------
  robinhoodMcpUrl: env.ROBINHOOD_MCP_URL ?? 'https://agent.robinhood.com/mcp/trading',
  // Constant, not env-driven: OAuth client display name for dynamic registration.
  // Lives here (not at the consumer in trader/rh/) so it stays next to the other
  // Robinhood OAuth settings.
  //
  // Robinhood's DCR endpoint maps this name to a pre-provisioned client_id whose
  // redirect-URI allowlist is fixed server-side (the redirect_uris we submit are
  // ignored). Only its blessed clients allowlist loopback (loose on port AND
  // path, verified via Codex CLI's working flow). Unknown names (e.g.
  // "rh-discord-trader") get a generic client whose consent flow never
  // redirects back. "Claude Code" -> ...-claude is used here instead of
  // "Codex CLI" -> ...-chatgpt because the consent page short-circuits (no
  // redirect) when the account already has an active connection for that
  // client, and this account is already connected via Codex.
  // ponytail: piggybacking on a blessed client id is the only unauthenticated
  // way to get loopback allowlisted. Ceiling: if Robinhood ever locks per-client
  // redirect shapes or the user connects Claude, register a first-party client.
  robinhoodOAuthClientName: 'Claude Code',
  robinhoodOAuthRedirectUri: oauthRedirectUri,
  robinhoodOAuthCallbackPort: oauthCallbackPort,
  robinhoodOAuthCallbackHost: env.ROBINHOOD_OAUTH_CALLBACK_HOST ?? '0.0.0.0',

  // ---- HTTP ------------------------------------------------------------------
  // 127.0.0.1 by default; every /api route verifies a Supabase JWT, but a
  // loopback bind keeps a misconfigured box off the local network anyway.
  // ponytail: a set PORT env var (Render/PaaS convention) flips the default
  // to 0.0.0.0 so the platform proxy can reach us; explicit TRADER_HOST wins.
  traderHost: env.TRADER_HOST ?? (env.PORT ? '0.0.0.0' : '127.0.0.1'),
  traderPort,

  // ---- Supabase ---------------------------------------------------------------
  supabaseUrl: env.SUPABASE_URL?.trim() ?? '',
  /** Browser-safe key; the server uses it only to verify user JWTs. */
  supabaseAnonKey: env.SUPABASE_ANON_KEY?.trim() ?? '',
  /** Bypasses RLS. Server-only, never sent to a browser. */
  supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '',
  /**
   * Direct Postgres connection string (Supabase session pooler, port 5432).
   * All table queries go through Drizzle on this connection; supabase-js keeps
   * only the auth methods (see server/src/trader/db.ts).
   */
  supabaseDbUrl: env.SUPABASE_DB_URL?.trim() ?? '',
  /** AES-256-GCM key material for broker tokens at rest. */
  rhTokensVaultKey: env.RH_TOKENS_VAULT_KEY?.trim() ?? '',
} as const;

export const isAllowed = (v: string, allowlist: readonly string[]): boolean =>
  allowlist.length === 0 || allowlist.includes(v);

/**
 * Fail fast at process startup with a single message listing every missing
 * required variable, instead of surfacing cryptic runtime errors later.
 * (The Listener validates its own env — DISCORD_USER_TOKEN etc. — in Python.)
 */
export function assertConfigValid(): void {
  const missing: string[] = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseAnonKey) missing.push('SUPABASE_ANON_KEY');
  if (!config.supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!config.supabaseDbUrl) missing.push('SUPABASE_DB_URL');
  if (!config.rhTokensVaultKey) missing.push('RH_TOKENS_VAULT_KEY');

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `Set them in .env (see .env.example).`
    );
  }
}
