import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  // Expose the plain API_URL / SUPABASE_* env vars to import.meta.env.
  // API_URL is optional at build (same-origin /api + server.ts proxy).
  // SUPABASE_SERVICE_ROLE_KEY is deliberately not matched — never in this env.
  envPrefix: ['VITE_', 'API_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY'],
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    // Every route is already `ssr: false` and the shell renders nothing but a
    // loading state until Supabase resolves the session in the browser, so SSR
    // buys nothing. SPA mode prerenders the shell to dist/client/index.html,
    // which is what lets the dashboard deploy as a free Render static site.
    // outputPath overrides the default /_shell.html: a static host serves
    // index.html for the root and for the SPA rewrite fallback.
    tanstackStart({ spa: { enabled: true, prerender: { outputPath: '/index.html' } } }),
    viteReact(),
  ],
})

export default config
