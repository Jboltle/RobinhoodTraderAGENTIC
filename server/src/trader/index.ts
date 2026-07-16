import { REST, Routes } from 'discord.js';

import { assertConfigValid, config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { PostReceipt } from '../shared/types.js';
import { createCalloutHistory } from './callouts.js';
import { DecisionLog } from './decisionLog.js';
import { LlmCalloutParser } from './pipeline/parseCallout.js';
import { RobinhoodMcpClient } from './rh/mcpClient.js';
import { backupTokens, restoreTokens } from './rh/tokenVault.js';
import { RobinhoodTools } from './rh/tools.js';
import { buildServer } from './server.js';

const log = createLogger('trader');

const RECEIPT_MAX_LENGTH = 1900;

function buildDiscordRestClient(): REST {
  return new REST({ version: '10' }).setToken(config.discordBotToken);
}

function buildPostReceipt(rest: REST): PostReceipt {
  return async (channelId: string, content: string) => {
    try {
      const trimmed =
        content.length > RECEIPT_MAX_LENGTH
          ? content.slice(0, RECEIPT_MAX_LENGTH - 3) + '...'
          : content;
      await rest.post(Routes.channelMessages(channelId), {
        body: { content: trimmed },
      });
    } catch (err) {
      log.warn('failed to post receipt to discord', {
        channelId,
        error: (err as Error).message,
      });
    }
  };
}

function buildDisabledRobinhoodTools(): RobinhoodTools {
  const disabled = async (): Promise<never> => {
    throw new Error('Robinhood tools are disabled while TRADE_EXECUTION_MODE=approval');
  };

  return {
    getBuyingPower: disabled,
    getQuote: disabled,
    getOptionsMarkPrice: disabled,
    placeOrder: disabled,
    placeOptionsOrder: disabled,
    getPositions: disabled,
    getOptionPositions: disabled,
  } as unknown as RobinhoodTools;
}

async function main(): Promise<void> {
  assertConfigValid('trader');

  const parser = new LlmCalloutParser();
  const decisions = new DecisionLog(config.decisionLogPath);
  const discordRest = buildDiscordRestClient();
  const postReceipt = buildPostReceipt(discordRest);

  // Token vault: serialized backups (chained like server.ts's pipeline chain
  // so concurrent persists never interleave). Null channel = vault disabled.
  const vaultChannelId = config.rhTokensVaultChannelId;
  let backupChain: Promise<void> = Promise.resolve();
  const onTokensPersisted = vaultChannelId
    ? () => {
        backupChain = backupChain.then(() =>
          backupTokens(discordRest, vaultChannelId, config.rhTokensPath)
        );
      }
    : undefined;

  const mcp =
    config.tradeExecutionMode === 'immediate'
      ? new RobinhoodMcpClient({ onTokensPersisted })
      : null;
  const tools = mcp ? new RobinhoodTools(mcp) : buildDisabledRobinhoodTools();

  if (!mcp) {
    log.warn('Robinhood MCP disabled in approval mode; no orders will be submitted');
  }

  const fastify = buildServer({
    parser,
    tools,
    decisions,
    postReceipt,
    mcp,
    callouts: createCalloutHistory(),
  });

  // Listen before connecting: on Render the OAuth flow can only complete via
  // the dashboard hitting /api/auth/*, so the port must be open while auth is
  // pending. No fail-fast on auth errors — a deployed server must stay up.
  await fastify.listen({ port: config.traderPort, host: config.traderHost });
  log.info('trader listening', { host: config.traderHost, port: config.traderPort });

  if (mcp) {
    if (vaultChannelId) {
      await restoreTokens(discordRest, vaultChannelId, config.rhTokensPath);
    }
    log.info('connecting to Robinhood MCP', { url: config.robinhoodMcpUrl });
    void mcp
      .ensureConnected()
      .then(async () => {
        log.info('Robinhood MCP connected', { tools: mcp.getToolNames() });
        // Also warms the accountNumber cache in RobinhoodTools for later orders.
        const account = await tools.getBuyingPower();
        log.info('Robinhood account snapshot', {
          accountNumber: account.accountNumber,
          portfolioValueUsd: account.portfolioValueUsd,
          buyingPowerUsd: account.amountUsd,
        });
      })
      .catch((err) => {
        log.error('Robinhood MCP connection failed', {
          error: (err as Error).message,
          stack: (err as Error).stack,
        });
      });
  }
}

main().catch((err) => {
  log.error('startup failed', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
