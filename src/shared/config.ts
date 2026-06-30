import { config as loadDotenv } from 'dotenv';

loadDotenv();

const env = process.env;

const list = (s: string | undefined, t: (x: string) => string = (x) => x): string[] =>
  (s ?? '')
    .split(',')
    .map((p) => t(p.trim()))
    .filter((p) => p.length > 0);

export const config = {
  // ---- Discord ----------------------------------------------------------------
  discordBotToken: env.DISCORD_BOT_TOKEN!,
  /**
   * Comma-separated channel IDs to listen on (same server, one trader endpoint).
   * Leave empty to listen on all visible channels (not recommended).
   */
  discordAllowedChannelIds: list(env.DISCORD_ALLOWED_CHANNEL_IDS),
  discordAllowedAuthorIds: list(env.DISCORD_ALLOWED_AUTHOR_IDS),

  // ---- LLM -------------------------------------------------------------------
  llmProvider: (env.LLM_PROVIDER ?? 'anthropic') as 'anthropic' | 'openai',
  anthropicApiKey: env.ANTHROPIC_API_KEY!,
  anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
  openaiApiKey: env.OPENAI_API_KEY!,
  openaiModel: env.OPENAI_MODEL ?? 'gpt-4o-2024-08-06',

  // ---- Robinhood MCP ---------------------------------------------------------
  robinhoodMcpUrl: env.ROBINHOOD_MCP_URL ?? 'https://agent.robinhood.com/mcp/trading',
  robinhoodOAuthClientName: env.ROBINHOOD_OAUTH_CLIENT_NAME ?? 'rh-discord-trader',
  robinhoodOAuthRedirectUri: env.ROBINHOOD_OAUTH_REDIRECT_URI!,
  robinhoodOAuthCallbackPort: Number(env.ROBINHOOD_OAUTH_CALLBACK_PORT ?? 8788),

  // ---- Risk controls (all sizing in % of available capital) ------------------

  /**
   * Maximum equity notional per trade as a percentage of buying power.
   * e.g. 5 = "spend at most 5% of available cash on any single equity order".
   */
  maxNotionalPctPerTrade: Number(env.MAX_NOTIONAL_PCT_PER_TRADE ?? 5),

  /**
   * Maximum options premium spend per trade as a percentage of buying power.
   * Options premium = contracts × mark_price × 100.
   * e.g. 2 = "spend at most 2% of available cash on any single options order".
   */
  maxOptionsNotionalPct: Number(env.MAX_OPTIONS_NOTIONAL_PCT ?? 2),

  /**
   * Hard floor: if a single options contract would cost MORE than this
   * percentage of buying power, skip the trade entirely.
   * Prevents entering a position that is oversized relative to the account
   * even when only 1 contract is available.
   * e.g. 5 = skip if 1 contract > 5% of buying power.
   */
  maxSingleContractPct: Number(env.MAX_SINGLE_CONTRACT_PCT ?? 5),

  /**
   * How much of the per-trade cap to use for each position-size keyword.
   * POSITION_SMALL_PCT=25  → "small"  = 25% of cap  (e.g. 1.25% of portfolio)
   * POSITION_MEDIUM_PCT=50 → "medium" = 50% of cap  (e.g. 2.5%  of portfolio)
   * "full" always = 100% of cap.
   */
  positionSmallPct: Number(env.POSITION_SMALL_PCT ?? 25),
  positionMediumPct: Number(env.POSITION_MEDIUM_PCT ?? 50),

  maxTradesPerDay: Number(env.MAX_TRADES_PER_DAY ?? 10),
  cooldownSecondsPerTicker: Number(env.COOLDOWN_SECONDS_PER_TICKER ?? 300),
  allowedTickers: list(env.ALLOWED_TICKERS, (s) => s.toUpperCase()),
  blockedTickers: list(env.BLOCKED_TICKERS, (s) => s.toUpperCase()),
  regularHoursOnly: (env.REGULAR_HOURS_ONLY ?? 'true').toLowerCase() === 'true',
  /**
   * Halt trading for the day once realized P&L falls below this percentage of
   * starting buying power. e.g. 5 = stop after losing 5% of capital.
   */
  dailyLossCircuitBreakerPct: Number(env.DAILY_LOSS_CIRCUIT_BREAKER_PCT ?? 5),
  minConfidence: Number(env.MIN_CONFIDENCE ?? 0.7),

  // ---- Inter-service ---------------------------------------------------------
  botTraderSecret: env.BOT_TRADER_SECRET!,
  traderPort: Number(env.TRADER_PORT ?? 3000),
  traderWebhookUrl: env.TRADER_WEBHOOK_URL ?? 'http://localhost:3000/webhook/discord',

  // ---- State paths -----------------------------------------------------------
  decisionLogPath: env.DECISION_LOG_PATH ?? 'state/decisions.jsonl',
  riskStatePath: env.RISK_STATE_PATH ?? 'state/risk.json',
  rhTokensPath: env.RH_TOKENS_PATH ?? 'state/rh-tokens.json',
} as const;

export const isAllowed = (v: string, allowlist: readonly string[]): boolean =>
  allowlist.length === 0 || allowlist.includes(v);
