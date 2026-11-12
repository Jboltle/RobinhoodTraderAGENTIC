/**
 * One-shot Robinhood MCP connect + introspect for one user.
 *
 *   npm run connect <email or user id>
 *
 * On first run this triggers the OAuth flow: the script prints an
 * authorization URL, spins up a local listener at the configured redirect,
 * persists the encrypted tokens to that user's direct Robinhood account, then
 * lists the tools the server advertises and verifies our canonical TOOL_NAMES
 * line up with what the server actually exposes.
 */
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { createTraderDb } from '../trader/db.js';
import { RobinhoodMcpClient } from '../trader/robinhood/mcpClient.js';
import { RobinhoodTools, TOOL_NAMES } from '../trader/robinhood/tools.js';

const log = createLogger('rh-connect');

async function main(): Promise<void> {
  const identifier = process.argv[2]?.trim();
  if (!identifier) {
    throw new Error('usage: npm run connect <email or user id>');
  }

  const db = createTraderDb();
  const userId = identifier.includes('@')
    ? (await db.findUserByEmail(identifier))?.id
    : identifier;
  if (!userId) {
    throw new Error(`no such user: ${identifier}`);
  }

  // Every user has exactly one direct Robinhood account, and until a second
  // adapter exists it is the one they have selected.
  const account = await db.getSelectedAccount(userId);
  if (account?.adapter !== 'robinhood') {
    throw new Error(`user ${userId} has no direct Robinhood account selected`);
  }

  log.info('connecting to Robinhood MCP', { url: config.robinhoodMcpUrl, accountId: account.id });

  const mcp = new RobinhoodMcpClient({ accountId: account.id, db });
  await mcp.ensureConnected();

  const advertised = mcp.getToolNames();
  log.info('connected', { toolCount: advertised.length, tools: advertised });
  const instrumentsSchema = mcp.getToolInputSchema(TOOL_NAMES.optionInstruments);
  log.info('get_option_instruments input schema', { schema: instrumentsSchema });

  // ---- Verify our canonical mapping ----------------------------------
  const summary: Record<string, { canonical: string; advertised: boolean }> = {};
  let missing = 0;
  for (const kind of Object.keys(TOOL_NAMES) as (keyof typeof TOOL_NAMES)[]) {
    const canonical = TOOL_NAMES[kind];
    const present = advertised.includes(canonical);
    summary[kind] = { canonical, advertised: present };
    if (!present) missing += 1;
  }
  log.info('canonical tool name check', { missing, summary });

  // ---- Quick read-only smoke -----------------------------------------
  const tools = new RobinhoodTools(mcp);

  try {
    const bp = await tools.getBuyingPower();
    log.info('buying power', { amountUsd: bp.amountUsd });
  } catch (err) {
    log.warn('getBuyingPower failed', { error: (err as Error).message });
  }

  try {
    const positions = await tools.getPositions();
    log.info('positions', {
      count: positions.positions.length,
      symbols: positions.positions.map((p) => p.symbol),
    });
  } catch (err) {
    log.warn('getPositions failed', { error: (err as Error).message });
  }

  if (missing > 0) {
    log.warn(
      'one or more canonical tool names do not match the live MCP surface ' +
        '— update src/trader/robinhood/tools.ts TOOL_NAMES to the values shown above'
    );
  }
  log.info('done');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error('connect failed', { error: (err as Error).message, stack: (err as Error).stack });
    process.exit(1);
  });
