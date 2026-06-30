import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { createLogger } from '../../shared/logger.js';

const log = createLogger('trader:rh:oauth');

export interface FileOAuthProviderOptions {
  readonly path: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly onAuthorizationUrl: (url: URL) => void | Promise<void>;
}

interface PersistedState {
  client?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}


/**
 * OAuthClientProvider that persists DCR client info, PKCE verifier, and tokens
 * to a single JSON file (chmod 0600). Suitable for a single-user, single-process
 * agentic-trading setup.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private cachedState: PersistedState | undefined;
  private loadPromise: Promise<PersistedState> | undefined;

  constructor(private readonly opts: FileOAuthProviderOptions) {}

  get redirectUrl(): string {
    return this.opts.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.opts.redirectUri],
      client_name: this.opts.clientName,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const state = await this.load();
    return state.client;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const state = await this.load();
    state.client = info as OAuthClientInformationFull;
    await this.persist();
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const state = await this.load();
    return state.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const state = await this.load();
    state.tokens = tokens;
    await this.persist();
    log.info('saved Robinhood OAuth tokens');
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.opts.onAuthorizationUrl(url);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    const state = await this.load();
    state.codeVerifier = verifier;
    await this.persist();
  }

  async codeVerifier(): Promise<string> {
    const state = await this.load();
    if (!state.codeVerifier) {
      throw new Error('No PKCE code verifier saved');
    }
    return state.codeVerifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const state = await this.load();
    if (scope === 'all' || scope === 'client') state.client = undefined;
    if (scope === 'all' || scope === 'tokens') state.tokens = undefined;
    if (scope === 'all' || scope === 'verifier') state.codeVerifier = undefined;
    await this.persist();
    log.warn('invalidated credentials', { scope });
  }

  private async load(): Promise<PersistedState> {
    if (this.cachedState) return this.cachedState;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = await readFile(this.opts.path, 'utf8');
          const parsed = JSON.parse(raw) as PersistedState;
          return parsed ?? {};
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
          log.warn('could not read tokens file, starting fresh', {
            error: (err as Error).message,
          });
          return {};
        }
      })();
    }
    this.cachedState = await this.loadPromise;
    return this.cachedState;
  }

  private async persist(): Promise<void> {
    if (!this.cachedState) return;
    await mkdir(dirname(this.opts.path), { recursive: true });
    await writeFile(this.opts.path, JSON.stringify(this.cachedState, null, 2), 'utf8');
    try {
      await chmod(this.opts.path, 0o600);
    } catch (err) {
      log.warn('failed to chmod tokens file', { error: (err as Error).message });
    }
  }
}
