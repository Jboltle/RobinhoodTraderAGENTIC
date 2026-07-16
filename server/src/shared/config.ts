import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// .env lives at the repo root (one level above server/). Resolve it relative
// to this file, not cwd, so env loads no matter where the process starts.
// In Docker the file doesn't exist (compose env_file injects vars) and dotenv
// silently no-ops.
loadDotenv({ path: new URL('../../../.env', import.meta.url) });

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

const bool = (s: string | undefined, fallback: boolean): boolean =>
  s === undefined ? fallback : s.toLowerCase() === 'true';

/**
 * Fail-fast enum parse: a missing or unknown value aborts startup instead of
 * silently defaulting, which matters for anything that changes trading behavior.
 */
const requiredEnum = <const T extends readonly [string, ...Array<string>]>(
  name: string,
  values: T
): T[number] => {
  const parsed = z.enum(values).safeParse(env[name]);
  if (!parsed.success) {
    const got = env[name] === undefined ? 'unset' : `"${env[name]}"`;
    throw new Error(
      `${name} must be one of: ${values.join(' | ')} (got ${got}). ` +
        `Set it in .env (see .env.example).`
    );
  }
  return parsed.data;
};

const requiredString = (name: string): string => {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required. Set it in .env (see .env.example).`);
  }
  return value;
};

const llmProvider = requiredEnum('LLM_PROVIDER', ['ollama', 'openai', 'anthropic']);

// OAuth: the browser is redirected to `redirectUri`; the local listener binds
// `callbackHost:callbackPort`. `redirectUri` defaults to the redirect host so
// it need not be set explicitly, but stays overridable for WSL/remote setups.
const oauthCallbackPort = num(env.ROBINHOOD_OAUTH_CALLBACK_PORT, 8788);
const oauthRedirectHost = env.ROBINHOOD_OAUTH_REDIRECT_HOST?.trim() || '127.0.0.1';
const oauthRedirectUri =
  env.ROBINHOOD_OAUTH_REDIRECT_URI?.trim() ||
  `http://${oauthRedirectHost}:${oauthCallbackPort}${OAUTH_CALLBACK_PATH}`;

export const config = {
  // ---- Discord ----------------------------------------------------------------
  discordBotToken: env.DISCORD_BOT_TOKEN ?? '',
  /**
   * Comma-separated channel IDs to listen on (same server, one trader endpoint).
   * Leave empty to ignore all Discord messages.
   */
  discordAllowedChannelIds: list(env.DISCORD_ALLOWED_CHANNEL_IDS),
  discordAllowedAuthorIds: list(env.DISCORD_ALLOWED_AUTHOR_IDS),
  discordForwardChannelId: env.DISCORD_FORWARD_CHANNEL_ID?.trim() || null,
  discordLogIgnoredMessages: bool(env.DISCORD_LOG_IGNORED_MESSAGES, false),

  // ---- LLM -------------------------------------------------------------------
  llmProvider,
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

  // ---- Execution -------------------------------------------------------------
  /**
   * immediate = submit orders as soon as a callout passes risk checks.
   * approval  = parse/risk-check/log callouts but do not submit orders.
   */
  tradeExecutionMode: requiredEnum('TRADE_EXECUTION_MODE', ['immediate', 'approval']),

  // ---- Risk controls (all sizing in % of available capital) ------------------
  // These are the env-fallback DEFAULTS of the settings resolution chain:
  // payload override → state/settings.json → these values (see trader/settings.ts).

  /**
   * Maximum equity notional per trade as a percentage of buying power.
   * e.g. 5 = "spend at most 5% of available cash on any single equity order".
   */
  maxNotionalPctPerTrade: num(env.MAX_NOTIONAL_PCT_PER_TRADE, 5),

  /**
   * Maximum options premium spend per trade as a percentage of buying power.
   * Options premium = contracts × mark_price × 100.
   */
  maxOptionsNotionalPct: num(env.MAX_OPTIONS_NOTIONAL_PCT, 2),

  /**
   * Hard floor: if a single options contract would cost MORE than this
   * percentage of buying power, skip the trade entirely.
   */
  maxSingleContractPct: num(env.MAX_SINGLE_CONTRACT_PCT, 5),

  /**
   * How much of the per-trade cap to use for each position-size keyword.
   * "full" always = 100% of cap.
   */
  positionSmallPct: num(env.POSITION_SMALL_PCT, 25),
  positionMediumPct: num(env.POSITION_MEDIUM_PCT, 50),

  maxTradesPerDay: num(env.MAX_TRADES_PER_DAY, 10),
  cooldownSecondsPerTicker: num(env.COOLDOWN_SECONDS_PER_TICKER, 300),
  allowedTickers: list(env.ALLOWED_TICKERS, (s) => s.toUpperCase()),
  blockedTickers: list(env.BLOCKED_TICKERS, (s) => s.toUpperCase()),
  regularHoursOnly: bool(env.REGULAR_HOURS_ONLY, true),
  minConfidence: num(env.MIN_CONFIDENCE, 0.7),

  // ---- Inter-service ---------------------------------------------------------
  botTraderSecret: env.BOT_TRADER_SECRET ?? '',
  /**
   * Optional URL of the client dashboard's session-settings endpoint
   * (GET, TradeSettings-shaped JSON). Unset = the pull layer is skipped.
   */
  clientSettingsUrl: env.CLIENT_SETTINGS_URL?.trim() || null,
  // 127.0.0.1 by default: the dashboard API has no auth, so binding is the
  // access control. Set 0.0.0.0 only when another container must reach it.
  // ponytail: a set PORT env var (Render/PaaS convention) flips the default
  // to 0.0.0.0 so the platform proxy can reach us; explicit TRADER_HOST wins.
  traderHost: env.TRADER_HOST ?? (env.PORT ? '0.0.0.0' : '127.0.0.1'),
  traderPort: num(env.PORT ?? env.TRADER_PORT, 3000),
  traderWebhookUrl: env.TRADER_WEBHOOK_URL ?? 'http://localhost:3000/webhook/discord',

  // ---- State paths -----------------------------------------------------------
  decisionLogPath: env.DECISION_LOG_PATH ?? 'state/decisions.jsonl',
  riskStatePath: env.RISK_STATE_PATH ?? 'state/risk.json',
  rhTokensPath: env.RH_TOKENS_PATH ?? 'state/rh-tokens.json',
  settingsPath: env.SETTINGS_PATH ?? 'state/settings.json',
} as const;

export const isAllowed = (v: string, allowlist: readonly string[]): boolean =>
  allowlist.length === 0 || allowlist.includes(v);

/**
 * Fail fast at process startup with a single message listing every missing
 * required variable, instead of surfacing cryptic runtime errors later.
 *
 * Both processes need Discord + the shared HMAC secret. Only the trader parses
 * callouts, so only it requires the LLM key for the selected provider.
 */
export function assertConfigValid(scope: 'trader' | 'bot'): void {
  const missing: string[] = [];
  if (!config.discordBotToken) missing.push('DISCORD_BOT_TOKEN');
  if (!config.botTraderSecret) missing.push('BOT_TRADER_SECRET');
  if (scope === 'trader') {
    if (config.llmProvider === 'openai' && !config.openaiApiKey) missing.push('OPENAI_API_KEY');
    if (config.llmProvider === 'anthropic' && !config.anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `Set them in .env (see .env.example).`
    );
  }
}
