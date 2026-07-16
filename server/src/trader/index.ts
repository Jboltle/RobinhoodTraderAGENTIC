import { REST, Routes } from 'discord.js';
import Fastify from 'fastify';

import { assertConfigValid, config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { DiscordEnvelopeSchema, PostReceipt } from '../shared/types.js';
import { verifyWebhookBody } from '../shared/webhookAuth.js';
import { DecisionLog } from './decisionLog.js';
import { runPipeline } from './pipeline/index.js';
import { LlmCalloutParser } from './pipeline/parseCallout.js';
import { RobinhoodMcpClient } from './rh/mcpClient.js';
import { readTokenStatus } from './rh/tokenBootstrap.js';
import { RobinhoodTools } from './rh/tools.js';

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
  } else {
    log.warn('Robinhood MCP disabled in approval mode; no orders will be submitted');
  }

  // Serialize pipeline so we never have two trades in flight on the same session.
  let chain: Promise<void> = Promise.resolve();

  const fastify = Fastify({ logger: false });

  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    try {
      (request as { rawBody?: string }).rawBody = body as string;
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error);
    }
  });

  fastify.post('/webhook/discord', async (request, reply) => {
    const rawBody = (request as { rawBody?: string }).rawBody ?? JSON.stringify(request.body);
    const auth = verifyWebhookBody(rawBody, request.headers, config.botTraderSecret);
    if (!auth.ok) {
      log.warn('webhook: rejected - unauthorized', { reason: auth.reason });
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const result = DiscordEnvelopeSchema.safeParse(request.body);
    if (!result.success) {
      log.warn('webhook: rejected — invalid envelope', {
        error: result.error.message,
      });
      return reply.status(400).send({ error: 'invalid envelope' });
    }

    const envelope = result.data;
    log.info('webhook: received callout candidate', {
      messageId: envelope.messageId,
      author: envelope.authorName,
      channel: envelope.channelId,
    });

    // Acknowledge immediately; the pipeline runs async so the bot never times out.
    chain = chain
      .then(() => runPipeline(envelope, { parser, tools, decisions, postReceipt }))
      .then(() => undefined)
      .catch((err) =>
        log.error('pipeline crashed', {
          messageId: envelope.messageId,
          error: (err as Error).message,
        })
      );

    return reply.status(202).send({ ok: true });
  });

  fastify.get('/health', async (_request, reply) => {
    const tokenStatus = mcp ? await readTokenStatus(config.rhTokensPath) : null;
    return reply.send({
      ok: true,
      executionMode: config.tradeExecutionMode,
      rhConnected: mcp?.isConnected() ?? false,
      rhTokenState: tokenStatus?.state ?? null,
      rhTokenExpiresInSec: tokenStatus?.expiresInSec ?? null,
      rhTools: mcp?.getToolNames() ?? [],
    });
  });

  await fastify.listen({ port: config.traderPort, host: '0.0.0.0' });
  log.info('trader listening', { port: config.traderPort });
}

main().catch((err) => {
  log.error('startup failed', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
