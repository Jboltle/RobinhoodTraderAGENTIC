/**
 * One-shot introspection: connect to the live Robinhood MCP server with the
 * tokens in state/rh-tokens.json and print the input schemas of the option
 * tools. Read-only (initialize + tools/list); places no orders.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOKENS_PATH = new URL('../state/rh-tokens.json', import.meta.url).pathname;
const MCP_URL = 'https://agent.robinhood.com/mcp/trading';

const state = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));

const authProvider = {
  get redirectUrl() {
    return state.client.redirect_uris[0];
  },
  get clientMetadata() {
    return { redirect_uris: state.client.redirect_uris };
  },
  clientInformation: () => state.client,
  tokens: () => state.tokens,
  saveTokens: (tokens: unknown) => {
    state.tokens = tokens;
    writeFileSync(TOKENS_PATH, JSON.stringify(state, null, 2));
    console.error('[tokens refreshed and saved]');
  },
  redirectToAuthorization: () => {
    throw new Error('interactive auth required — stored tokens unusable');
  },
  saveCodeVerifier: () => {},
  codeVerifier: () => state.codeVerifier,
};

const client = new Client({ name: 'schema-introspect', version: '0.0.1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider })
);
const list = await client.listTools();
console.log('tool names:', list.tools.map((t) => t.name).join(', '));
for (const t of list.tools) {
  if (/option|place_equity/.test(t.name)) {
    console.log(`\n===== ${t.name} =====`);
    console.log(JSON.stringify(t.inputSchema, null, 2));
  }
}
await client.close();
