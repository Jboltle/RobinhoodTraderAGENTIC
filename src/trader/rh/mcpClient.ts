import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { awaitAuthorizationCode } from './oauthCallback.js';
import { FileOAuthProvider } from './oauthProvider.js';
import { importCodexTokensIfNeeded, readTokenStatus } from './tokenBootstrap.js';
import type { CallToolResult } from './types.js';

export type { CallToolResult } from './types.js';

const log = createLogger('trader:rh:mcp');

const CLIENT_INFO = { name: 'rh-discord-trader', version: '0.1.0' };

export class RobinhoodMcpClient {
  private client: Client | undefined;
  private toolNames: string[] = [];
  private connectPromise: Promise<void> | undefined;

  /**
   * Idempotent: connects on first call, returns the same connection thereafter.
   * Triggers the OAuth flow (printing the auth URL and starting a one-shot
   * callback listener) the first time, when no tokens are saved.
   */
  async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (!this.connectPromise) {
      this.connectPromise = this.connect().catch((err) => {
        this.connectPromise = undefined;
        throw err;
      });
    }
    await this.connectPromise;
  }

  private async connect(): Promise<void> {
    const redirectUrl = new URL(config.robinhoodOAuthRedirectUri);

    // Detect the local auth state and, when the saved tokens can't carry us,
    // try to import fresh ones from Codex before falling back to browser OAuth.
    const status = await readTokenStatus(config.rhTokensPath);
    log.info('Robinhood token status', {
      state: status.state,
      expiresInMin: status.expiresInSec !== null ? Math.round(status.expiresInSec / 60) : null,
      hasRefreshToken: status.hasRefreshToken,
    });
    if (status.state === 'missing' || status.state === 'expired') {
      await importCodexTokensIfNeeded({
        path: config.rhTokensPath,
        redirectUri: config.robinhoodOAuthRedirectUri,
        clientName: config.robinhoodOAuthClientName,
      });
    }

    const provider = new FileOAuthProvider({
      path: config.rhTokensPath,
      clientName: config.robinhoodOAuthClientName,
      redirectUri: config.robinhoodOAuthRedirectUri,
      onAuthorizationUrl: (url) => {
        log.info('OAuth authorization required');
        process.stdout.write('\n========================================\n');
        process.stdout.write('Robinhood authorization required.\n');
        process.stdout.write('Open this URL in your browser to authorize:\n\n');
        process.stdout.write(`  ${url.toString()}\n`);
        process.stdout.write('\nWaiting for redirect to ');
        process.stdout.write(`${redirectUrl.origin}${redirectUrl.pathname} ...\n`);
        process.stdout.write('========================================\n\n');
      },
    });

    let transport = new StreamableHTTPClientTransport(new URL(config.robinhoodMcpUrl), {
      authProvider: provider,
    });
    let client = new Client(CLIENT_INFO);

    try {
      await client.connect(transport);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;

      // Unauthorized despite the preflight — try a Codex import once more (the
      // local tokens may have just expired), then reconnect before prompting.
      if (await importCodexTokensIfNeeded({
        path: config.rhTokensPath,
        redirectUri: config.robinhoodOAuthRedirectUri,
        clientName: config.robinhoodOAuthClientName,
      })) {
        transport = new StreamableHTTPClientTransport(new URL(config.robinhoodMcpUrl), {
          authProvider: provider,
        });
        client = new Client(CLIENT_INFO);
        try {
          await client.connect(transport);
          this.client = client;
          await this.introspect(client);
          return;
        } catch (retryErr) {
          if (!(retryErr instanceof UnauthorizedError)) throw retryErr;
        }
      }

      log.info('starting OAuth callback listener');
      const callbackPath = redirectUrl.pathname || '/oauth/callback';
      const port = config.robinhoodOAuthCallbackPort;
      const host = config.robinhoodOAuthCallbackHost;

      log.info('OAuth callback listener starting', {
        listenHost: host,
        port,
        callbackPath,
        redirectUri: config.robinhoodOAuthRedirectUri,
      });
      const { code } = await awaitAuthorizationCode(host, port, callbackPath);
      log.info('received authorization code, exchanging for tokens');
      await transport.finishAuth(code);

      // After finishAuth the transport's internal state is partly consumed;
      // create a fresh transport and client and reconnect with the saved tokens.
      transport = new StreamableHTTPClientTransport(new URL(config.robinhoodMcpUrl), {
        authProvider: provider,
      });
      client = new Client(CLIENT_INFO);
      await client.connect(transport);
    }

    this.client = client;
    await this.introspect(client);
  }

  private async introspect(client: Client): Promise<void> {
    const list = await client.listTools();
    this.toolNames = list.tools.map((t) => t.name);
    log.info('connected to Robinhood MCP', {
      toolCount: this.toolNames.length,
      tools: this.toolNames,
      serverInfo: client.getServerVersion(),
    });
  }

  getToolNames(): readonly string[] {
    return this.toolNames;
  }

  isConnected(): boolean {
    return this.client !== undefined;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.client) {
      throw new Error('MCP client not connected; call ensureConnected() first');
    }
    const result = (await this.client.callTool({ name, arguments: args })) as CallToolResult;
    if (result.isError) {
      const text = (result.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join(' ')
        .trim();
      throw new Error(`Tool ${name} returned error: ${text || '(no message)'}`);
    }
    return result;
  }
}
