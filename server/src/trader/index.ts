import { REST, Routes } from 'discord.js';

import { assertConfigValid, config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { PostReceipt } from '../shared/types.js';
import { createCalloutHistory } from './callouts.js';
import { DecisionLog } from './decisionLog.js';
import { LlmCalloutParser } from './pipeline/parseCallout.js';
import { RobinhoodMcpClient } from './rh/mcpClient.js';
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

  const mcp = config.tradeExecutionMode === 'immediate' ? new RobinhoodMcpClient() : null;
  const tools = mcp ? new RobinhoodTools(mcp) : buildDisabledRobinhoodTools();

  if (mcp) {
    log.info('connecting to Robinhood MCP', { url: config.robinhoodMcpUrl });
    await mcp.ensureConnected();
    log.info('Robinhood MCP connected', { tools: mcp.getToolNames() });

    // ponytail: fail-fast on purpose — immediate mode is useless if the account
    // can't be read, and main().catch already exits 1. Also warms the
    // accountNumber cache in RobinhoodTools for later order placement.
    const account = await tools.getBuyingPower();
    log.info('Robinhood account snapshot', {
      accountNumber: account.accountNumber,
      portfolioValueUsd: account.portfolioValueUsd,
      buyingPowerUsd: account.amountUsd,
    });
  } else {
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

  await fastify.listen({ port: config.traderPort, host: config.traderHost });
  log.info('trader listening', { host: config.traderHost, port: config.traderPort });
}

main().catch((err) => {
  log.error('startup failed', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
