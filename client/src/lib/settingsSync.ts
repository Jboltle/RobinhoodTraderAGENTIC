/**
 * Settings write path, isolated on purpose. The form's state is per-request
 * input, not durable config: submit pushes it to this app's own server
 * (/api/settings-state, in-memory), where the trader pulls it per message via
 * CLIENT_SETTINGS_URL and merges it like a payload override. Nothing is
 * written to the trader's state/settings.json (its PUT /api/settings remains
 * available to curl/other callers).
 */
import type { TradeSettingsInput } from './api'

export async function saveSettings(
  settings: TradeSettingsInput,
): Promise<TradeSettingsInput> {
  const res = await fetch('/api/settings-state', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`PUT /api/settings-state failed: ${res.status} ${body}`)
  }
  return (await res.json()) as TradeSettingsInput
}

/** Session overrides previously pushed this session; {} when none (204). */
export async function fetchSessionSettings(): Promise<TradeSettingsInput> {
  const res = await fetch('/api/settings-state')
  if (res.status === 204) return {}
  if (!res.ok) throw new Error(`GET /api/settings-state failed: ${res.status}`)
  return (await res.json()) as TradeSettingsInput
}
