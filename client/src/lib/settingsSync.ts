/**
 * Settings write path, isolated on purpose. Save goes straight to the
 * trader's PUT /api/settings, which persists to state/settings.json and is
 * hot-applied on the next message (resolution: file over env defaults).
 * The form initializes from GET /api/settings (fully resolved values), so
 * every save re-writes a complete snapshot — no field silently lost when
 * writeSettingsFile replaces the file.
 */
import { TRADER_URL, type TradeSettingsInput } from './api'

export async function saveSettings(
  settings: TradeSettingsInput,
): Promise<TradeSettingsInput> {
  const res = await fetch(`${TRADER_URL}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`PUT /api/settings failed: ${res.status} ${body}`)
  }
  const { settings: saved } = (await res.json()) as {
    settings: TradeSettingsInput
  }
  return saved
}
