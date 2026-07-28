/**
 * Settings write path, isolated on purpose. Save goes to the trader's
 * PUT /api/settings, which upserts the caller's single settings row and is
 * picked up by the next callout. The form initializes from GET /api/settings
 * (fully resolved values), so every save writes a complete snapshot.
 */
import { TRADER_URL, authHeaders, type TradeSettings, type TradeSettingsInput } from './api'

export async function saveSettings(
  settings: TradeSettingsInput,
): Promise<TradeSettings> {
  const res = await fetch(`${TRADER_URL}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(settings),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`PUT /api/settings failed: ${res.status} ${body}`)
  }
  const { settings: saved } = (await res.json()) as { settings: TradeSettings }
  return saved
}
