// `pnpm db:push` invokes this with cwd = packages/db, so the bare
// `dotenv/config` import would miss the repo-root .env. Resolve it explicitly.
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'drizzle-kit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../../.env') });

// Self-hosters fill in POSTGRES_PASSWORD and leave DATABASE_URL on the
// .env.example default. Fall back to constructing the URL from POSTGRES_PASSWORD
// when DATABASE_URL is unset or still carries the placeholder.
function resolveDatabaseUrl(): string {
  const explicit = process.env.DATABASE_URL;
  if (explicit && !explicit.includes('CHANGE_ME')) return explicit;
  const pw = process.env.POSTGRES_PASSWORD || 'postgres';
  return `postgres://postgres:${pw}@localhost:5432/deft`;
}

export default defineConfig({
  out: './drizzle',
  schema: './src/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: resolveDatabaseUrl(),
  },
});
