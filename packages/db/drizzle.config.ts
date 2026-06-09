import { defineConfig } from 'drizzle-kit';
import { loadRootEnv, resolveDatabaseUrl } from './scripts/db-url.ts';

// `pnpm db:push` invokes this with cwd = packages/db, so load repo-root .env
// explicitly and share the same fallback as the follow-up scripts.
loadRootEnv(import.meta.url);

export default defineConfig({
  out: './drizzle',
  schema: './src/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: resolveDatabaseUrl(),
  },
});
