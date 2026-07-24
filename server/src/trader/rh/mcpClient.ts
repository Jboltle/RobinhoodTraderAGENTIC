import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { awaitAuthorizationCode } from './oauthCallback.js';
import { FileOAuthProvider } from './oauthProvider.js';
import { readTokenStatus } from './tokenBootstrap.js';
import type { CallToolResult } from './types.js';

export type { CallToolResult } from './types.js';

const log = createLogger('trader:rh:mcp');

const CLIENT_INFO = { name: 'rh-discord-trader', version: '0.1.0' };

interface AuthCodeSubmission {
  readonly code: string;
  readonly state: string | null;
}

export interface RobinhoodMcpClientOptions {
  /** Fire-and-forget hook invoked after each successful token persist (e.g. vault backup). */
  readonly onTokensPersisted?: () => void;
}

export class RobinhoodMcpClient {
  constructor(private readonly options: RobinhoodMcpClientOptions = {}) {}

  private client: Client | undefined;
  private toolNames: string[] = [];
  private connectPromise: Promise<void> | undefined;
  /** Authorization URL awaiting user consent; null once connected. */
  private pendingAuthUrl: string | null = null;
  /** Resolver for a manually pasted redirect URL (dashboard flow); null when no auth is pending. */
  private manualAuthResolve: ((submission: AuthCodeSubmission) => void) | null = null;

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

    // Log the local auth state; the SDK transport handles refresh on 401 and
    // we fall back to browser OAuth below only when that fails.
    const status = await readTokenStatus(config.rhTokensPath);
    log.info('Robinhood token status', {
      state: status.state,
      expiresInMin: status.expiresInSec !== null ? Math.round(status.expiresInSec / 60) : null,
      hasRefreshToken: status.hasRefreshToken,
    });

    const provider = new FileOAuthProvider({
      path: config.rhTokensPath,
      clientName: config.robinhoodOAuthClientName,
      redirectUri: config.robinhoodOAuthRedirectUri,
      onAuthorizationUrl: (url) => {
        // Robinhood's advertised authorization_endpoint (robinhood.com/oauth)
        // loads a login shell that never redirects back for agent consent.
        // The working consent SPA (captured from Codex CLI's flow) lives at
        // robinhood.com/mcp/trading with identical query params.
        if (url.pathname === '/oauth') url.pathname = '/mcp/trading';
        this.pendingAuthUrl = url.toString();
        log.info('OAuth authorization required');
        process.stdout.write('\n========================================\n');
        process.stdout.write('Robinhood authorization required.\n');
        process.stdout.write('Open this URL in your browser to authorize:\n\n');
        process.stdout.write(`  ${url.toString()}\n`);
        process.stdout.write('\nWaiting for redirect to ');
        process.stdout.write(`${redirectUrl.origin}${redirectUrl.pathname} ...\n`);
        process.stdout.write('========================================\n\n');
      },
      onPersist: this.options.onTokensPersisted,
    });

    let transport = new StreamableHTTPClientTransport(new URL(config.robinhoodMcpUrl), {
      authProvider: provider,
    });
    let client = new Client(CLIENT_INFO);

    try {
      await client.connect(transport);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;

      // Tokens missing or refresh failed — fall back to browser OAuth.
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
      // Race the loopback listener (local dev) against a manually pasted
      // redirect URL (deployed dashboard, POST /api/auth/callback).
      // ponytail: a listener failure (port in use, 30-min timeout) must not
      // kill the race while the manual path is viable, so it collapses into a
      // never-resolving promise. The manual path has no timeout — a single-user
      // service just waits for a paste that may never come.
      const manualSubmission = new Promise<AuthCodeSubmission>((resolve) => {
        this.manualAuthResolve = resolve;
      });
      const localListener = awaitAuthorizationCode(host, port, callbackPath).catch((err) => {
        log.warn('OAuth callback listener unavailable; manual paste still works', {
          error: (err as Error).message,
        });
        return new Promise<never>(() => {});
      });
      const { code, state } = await Promise.race([localListener, manualSubmission]);
      this.manualAuthResolve = null;
      if (provider.expectedState !== undefined && state !== provider.expectedState) {
        throw new Error('OAuth state mismatch on callback; aborting token exchange');
      }
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

    // Introspect BEFORE exposing the client: isConnected()/getToolNames() must
    // never report connected-with-zero-tools, or concurrent API calls fail with
    // 'does not advertise "get_accounts"'.
    await this.introspect(client);
    this.client = client;
    this.pendingAuthUrl = null;
  }

  /** Authorization URL awaiting user consent, or null when none is pending. */
  getPendingAuthUrl(): string | null {
    return this.pendingAuthUrl;
  }

  /**
   * Completes the OAuth flow with a code the user pasted into the dashboard
   * (the deployed alternative to the loopback listener). Throws when no auth
   * flow is waiting for a code.
   */
  submitAuthCode(code: string, state: string | null): void {
    if (!this.manualAuthResolve) {
      throw new Error('no OAuth authorization is pending');
    }
    this.manualAuthResolve({ code, state });
    this.manualAuthResolve = null;
  }

  isAuthPending(): boolean {
    return this.manualAuthResolve !== null;
  }

  private async introspect(client: Client): Promise<void> {
    const list = await client.listTools();
    this.toolNames = list.tools.map((t) => t.name);
    log.info('connected to Robinhood MCP', {
      toolCount: this.toolNames.length,
      tools: this.toolNames,
      serverInfo: client.getServerVersion(),
    });
    // The server validates arguments against these schemas (e.g. quantity is
    // string-typed); log them once so type mismatches are diagnosable from logs.
    const orderTools = list.tools.filter((t) => t.name.startsWith('place_'));
    if (orderTools.length > 0) {
      log.info('order tool input schemas', {
        schemas: Object.fromEntries(orderTools.map((t) => [t.name, t.inputSchema])),
      });
    }
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
    let result: CallToolResult;
    try {
      result = (await this.client.callTool({ name, arguments: args })) as CallToolResult;
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;

      // Mid-session token expiry where the SDK's silent refresh failed: reset
      // the connection and re-run connect() so its browser OAuth fallback can
      // execute, then retry the tool call once.
      log.info('unauthorized during tool call; reconnecting', { tool: name });
      this.client = undefined;
      this.connectPromise = undefined;
      await this.ensureConnected();
      result = (await this.client!.callTool({ name, arguments: args })) as CallToolResult;
    }
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
