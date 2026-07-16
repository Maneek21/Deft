import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadRootEnv, maskDatabaseUrl, resolveDatabaseUrl } from './db-url.ts';

const { Client } = pg;

export async function main() {
  loadRootEnv(import.meta.url);
  const databaseUrl = resolveDatabaseUrl();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const tableCount = Number(result.rows[0]?.count || 0);
    if (tableCount > 0) {
      throw new Error(
        `Refusing fresh initialization: ${tableCount} application table(s) already exist at ${maskDatabaseUrl(databaseUrl)}. ` +
        'Use pnpm db:upgrade for a supported existing deployment.',
      );
    }
    console.log(`[OK] Fresh database confirmed at ${maskDatabaseUrl(databaseUrl)}.`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('[FAIL]', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
