import { config as loadDotenv } from 'dotenv';

loadDotenv();

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

const llmProvider = (env.LLM_PROVIDER ?? 'anthropic') as 'anthropic' | 'openai';

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
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
  openaiApiKey: env.OPENAI_API_KEY ?? '',
  openaiModel: env.OPENAI_MODEL ?? 'gpt-4o-2024-08-06',

  // ---- Robinhood MCP ---------------------------------------------------------
  robinhoodMcpUrl: env.ROBINHOOD_MCP_URL ?? 'https://agent.robinhood.com/mcp/trading',
  robinhoodOAuthClientName: env.ROBINHOOD_OAUTH_CLIENT_NAME ?? 'rh-discord-trader',
  robinhoodOAuthRedirectUri: oauthRedirectUri,
  robinhoodOAuthCallbackPort: oauthCallbackPort,
  robinhoodOAuthCallbackHost: env.ROBINHOOD_OAUTH_CALLBACK_HOST ?? '0.0.0.0',

  // ---- Execution -------------------------------------------------------------
  /**
   * immediate = submit orders as soon as a callout passes risk checks.
   * approval  = parse/risk-check/log callouts but do not submit orders.
   */
  tradeExecutionMode: (env.TRADE_EXECUTION_MODE ?? 'immediate') as 'immediate' | 'approval',

  // ---- Risk controls (all sizing in % of available capital) ------------------

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
  traderPort: num(env.TRADER_PORT, 3000),
  traderWebhookUrl: env.TRADER_WEBHOOK_URL ?? 'http://localhost:3000/webhook/discord',

  // ---- State paths -----------------------------------------------------------
  decisionLogPath: env.DECISION_LOG_PATH ?? 'state/decisions.jsonl',
  riskStatePath: env.RISK_STATE_PATH ?? 'state/risk.json',
  rhTokensPath: env.RH_TOKENS_PATH ?? 'state/rh-tokens.json',
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
