/**
 * Production host for the dashboard SPA. This process does not run the trader.
 *
 * - GET /health          — this container is up (Railway / compose)
 * - /api/*               — proxied to the trader at API_URL (runtime)
 * - everything else      — Vite build in dist/client, SPA fallback to index.html
 *
 * The browser uses same-origin /api when API_URL is not baked into the bundle.
 * Set API_URL on this process to the trader's reachable base URL
 * (Railway private: http://<server-service>.railway.internal:3000).
 */
import { join, normalize } from 'node:path'

const PORT = Number(process.env.PORT ?? 3001)
const TRADER_URL = (process.env.API_URL ?? '').replace(/\/$/, '')
const CLIENT_DIR = join(import.meta.dir, 'dist/client')
const INDEX_HTML = join(CLIENT_DIR, 'index.html')
// Browser cannot reach Railway private DNS; leave those on same-origin + proxy.
const BROWSER_API_URL =
  TRADER_URL && !TRADER_URL.includes('.railway.internal') ? TRADER_URL : ''

function indexHtml(html: string): string {
  if (!BROWSER_API_URL) return html
  const tag = `<script>window.__API_URL__=${JSON.stringify(BROWSER_API_URL)}</script>`
  return html.includes('<head>') ? html.replace('<head>', `<head>${tag}`) : tag + html
}

const PROXY_REQUEST_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  // Conditional revalidation: the trader answers 304 + empty body when the
  // payload hash still matches, which is most polls.
  'if-none-match',
] as const

/** gzip a response body when the browser accepts it. Egress is billed on this hop. */
function acceptsGzip(req: Request): boolean {
  return req.headers.get('accept-encoding')?.includes('gzip') ?? false
}

async function proxyToTrader(req: Request, url: URL): Promise<Response> {
  if (!TRADER_URL) {
    return Response.json(
      { error: 'API_URL is not set — cannot proxy /api to the trader' },
      { status: 503 },
    )
  }

  const headers = new Headers()
  for (const name of PROXY_REQUEST_HEADERS) {
    const value = req.headers.get(name)
    if (value) headers.set(name, value)
  }

  const method = req.method
  const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
  let upstream: Response
  try {
    upstream = await fetch(`${TRADER_URL}${url.pathname}${url.search}`, {
      method,
      headers,
      body: hasBody ? req.body : undefined,
      // Bun/Node: stream the request body without buffering it first.
      duplex: 'half',
    } as RequestInit)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'trader unreachable'
    return Response.json({ error: message }, { status: 502 })
  }

  // Rebuild headers so we never forward content-encoding for a body fetch()
  // already decoded (that pair would make the browser try to inflate twice).
  const out = new Headers()
  const contentType = upstream.headers.get('content-type')
  if (contentType) out.set('content-type', contentType)
  for (const name of ['etag', 'cache-control'] as const) {
    const value = upstream.headers.get(name)
    if (value) out.set(name, value)
  }
  if (contentType?.includes('text/event-stream')) {
    out.set('cache-control', 'no-cache')
    out.set('connection', 'keep-alive')
    return new Response(upstream.body, { status: upstream.status, headers: out })
  }

  // JSON compresses ~85-90%; SSE above keeps its streaming path and 304/204
  // bodies are already empty.
  if (upstream.status === 200 && acceptsGzip(req) && contentType?.includes('application/json')) {
    out.set('content-encoding', 'gzip')
    out.set('vary', 'accept-encoding')
    const body = Bun.gzipSync(new Uint8Array(await upstream.arrayBuffer()))
    return new Response(body, { status: 200, headers: out })
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

const COMPRESSIBLE_ASSET_RE = /\.(js|css|svg|json|txt|map|html)$/

async function serveStatic(req: Request, pathname: string): Promise<Response | null> {
  if (pathname === '/') return null
  const filePath = join(CLIENT_DIR, normalize(pathname))
  if (!filePath.startsWith(CLIENT_DIR)) return null
  const file = Bun.file(filePath)
  if (!(await file.exists())) return null

  const headers = new Headers({ 'content-type': file.type })
  // Vite content-hashes everything under /assets, so those never change in
  // place — cache forever instead of re-shipping the bundle every visit.
  headers.set(
    'cache-control',
    pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  )
  if (acceptsGzip(req) && COMPRESSIBLE_ASSET_RE.test(pathname)) {
    // ponytail: gzip per request; upgrade path is precompressing at build if
    // CPU ever matters more than the immutable cache already saves.
    headers.set('content-encoding', 'gzip')
    headers.set('vary', 'accept-encoding')
    return new Response(Bun.gzipSync(new Uint8Array(await file.arrayBuffer())), { headers })
  }
  return new Response(file, { headers })
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const { pathname } = url

    if (pathname === '/health') {
      return Response.json({ ok: true })
    }

    if (pathname.startsWith('/api/')) {
      return proxyToTrader(req, url)
    }

    const file = await serveStatic(req, pathname)
    if (file) return file

    const index = Bun.file(INDEX_HTML)
    if (await index.exists()) {
      return new Response(indexHtml(await index.text()), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        },
      })
    }
    return new Response('client build missing — run bun run build', { status: 500 })
  },
})

console.log(
  TRADER_URL
    ? `client listening on http://0.0.0.0:${PORT} → trader ${TRADER_URL}`
    : `client listening on http://0.0.0.0:${PORT} — API_URL unset, /api returns 503`,
)
