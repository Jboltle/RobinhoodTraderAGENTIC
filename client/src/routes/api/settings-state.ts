/**
 * In-memory holder for the user's session trade settings. The form PUTs its
 * state here; the trader (CLIENT_SETTINGS_URL) GETs it per message and merges
 * it like a payload override. Nothing is persisted — restart clears it and
 * the trader falls through to state/settings.json / env defaults.
 *
 * ponytail: module-level variable, single-process only. Upgrade path: move to
 * a store if the client ever runs multiple server instances.
 */
import { createFileRoute } from '@tanstack/react-router'

let sessionSettings: Record<string, unknown> | null = null

export const Route = createFileRoute('/api/settings-state')({
  server: {
    handlers: {
      GET: async () =>
        sessionSettings === null
          ? new Response(null, { status: 204 })
          : Response.json(sessionSettings),
      PUT: async ({ request }) => {
        // Shape validation happens at the trader (TradeSettingsSchema); this
        // endpoint just holds whatever the form pushed.
        sessionSettings = (await request.json()) as Record<string, unknown>
        return Response.json(sessionSettings)
      },
    },
  },
})
