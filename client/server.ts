/**
 * Production server: static assets from dist/client, everything else to the
 * TanStack Start SSR handler. Run `bun run build` first, then `bun server.ts`.
 *
 * ponytail: minimal take on TanStack's start-bun template — no asset
 * preloading or cache headers. Upgrade path: copy the full template from
 * https://github.com/TanStack/router/tree/main/examples/react/start-bun
 *
 * Excluded from tsconfig (needs bun-types + imports untyped build output);
 * it is executed directly by Bun, never compiled.
 */
import { join, normalize } from 'node:path'

// @ts-ignore untyped build artifact
import serverEntry from './dist/server/server.js'

const PORT = Number(process.env.PORT ?? 3001)
const CLIENT_DIR = join(import.meta.dir, 'dist/client')

Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url)
    if (pathname !== '/') {
      // normalize() collapses ".." so a crafted path cannot escape CLIENT_DIR.
      const filePath = join(CLIENT_DIR, normalize(pathname))
      if (filePath.startsWith(CLIENT_DIR)) {
        const file = Bun.file(filePath)
        if (await file.exists()) return new Response(file)
      }
    }
    return serverEntry.fetch(req)
  },
})

console.log(`client listening on http://localhost:${PORT}`)
