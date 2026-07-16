import { createServer, type Server } from 'node:http';

import { createLogger } from '../../shared/logger.js';

const log = createLogger('trader:rh:oauth-callback');

interface CallbackResult {
  readonly code: string;
  readonly state: string | null;
}



const HTML_OK = `<!doctype html><html><head><meta charset="utf-8"><title>Authorized</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;margin:4rem;text-align:center}</style></head>
<body><h1>Robinhood authorization complete</h1>
<p>You can close this tab and return to the trader.</p></body></html>`;

const HTML_ERR = `<!doctype html><html><head><meta charset="utf-8"><title>Authorization failed</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;margin:4rem;text-align:center}</style></head>
<body><h1>Authorization failed</h1>
<p>Check the trader logs for details.</p></body></html>`;

const HTML_WAITING = `<!doctype html><html><head><meta charset="utf-8"><title>Waiting for Robinhood</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;margin:4rem;text-align:center;color:#555}</style></head>
<body><h1>Waiting for Robinhood&hellip;</h1>
<p>This page didn't include an authorization code. Finish the Robinhood flow in your other tab and the redirect will arrive here automatically.</p></body></html>`;

/**
 * Spins up a one-shot HTTP listener that captures the OAuth `code` from the
 * Robinhood redirect, then shuts itself down. The promise resolves with the
 * authorization code, or rejects on timeout / OAuth error.
 */
export function awaitAuthorizationCode(
  host: string,
  port: number,
  pathname: string,
  timeoutMs: number = 5 * 60 * 1000
): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    let server: Server | undefined;
    const timer = setTimeout(() => {
      log.error('OAuth callback timed out');
      server?.close();
      reject(new Error('OAuth callback timed out'));
    }, timeoutMs);

    server = createServer((req, res) => {
      log.info('OAuth callback request received', {
        method: req.method,
        url: req.url,
        remoteAddress: req.socket.remoteAddress,
      });
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);

      // Anything other than the callback path is a stray probe (favicon,
      // /, browser prefetch, etc.). Reply 404 and keep listening.
      if (url.pathname !== pathname) {
        res.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      // Real OAuth error: terminate.
      if (error) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(HTML_ERR);
        clearTimeout(timer);
        server?.close();
        reject(new Error(`OAuth error: ${error}${url.searchParams.get('error_description') ? ` - ${url.searchParams.get('error_description')}` : ''}`));
        return;
      }

      // Stray request to the callback path with neither `code` nor `error`
      // (browser prefetch, manual navigation, double-tap, the user hitting
      // refresh during onboarding, etc.). Respond politely and keep waiting
      // for the real redirect.
      if (!code) {
        log.warn('stray request to callback path; ignoring and continuing to wait', {
          method: req.method,
          query: url.search,
        });
        res
          .writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
          .end(HTML_WAITING);
        return;
      }

      // Real success.
      log.info('OAuth callback code received', { statePresent: state !== null });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HTML_OK);
      clearTimeout(timer);
      server?.close();
      resolve({ code, state });
    });

    server.listen(port, host, () => {
      log.info('OAuth callback listener up', { host, port, pathname });
    });
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
