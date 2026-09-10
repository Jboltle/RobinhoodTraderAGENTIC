/**
 * drizzle-kit config, for verification only.
 *
 * supabase/migrations/ owns the schema. Never run `drizzle-kit generate` or
 * `drizzle-kit push` here — the one supported use is `drizzle-kit pull` to
 * diff src/trader/db/schema.ts against a live database.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/trader/db/schema.ts',
  dbCredentials: { url: process.env.SUPABASE_DB_URL ?? '' },
});
