/**
 * The browser's Supabase client, used for authentication only.
 *
 * It holds the anon key, which ships in this bundle and is therefore public.
 * Application data is never read through it — every trade, setting and broker
 * connection goes through the trader API, which verifies the access token and
 * queries with the service role. RLS is default-deny so this key can't reach
 * those tables even if someone tries.
 */
import { createClient } from '@supabase/supabase-js'

const url: string = import.meta.env.SUPABASE_URL ?? ''
const anonKey: string = import.meta.env.SUPABASE_ANON_KEY ?? ''

if (!url || !anonKey) {
  throw new Error(
    'SUPABASE_URL and SUPABASE_ANON_KEY must be set at build time (see client/.env.example)',
  )
}

export const supabase = createClient(url, anonKey)
