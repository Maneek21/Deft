import pg from 'pg';
import { loadRootEnv, maskDatabaseUrl, resolveDatabaseUrl } from './db-url.ts';

const { Client } = pg;

loadRootEnv(import.meta.url);

const databaseUrl = resolveDatabaseUrl();

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    console.log(`[ensure-pgvector] vector extension ready (${maskDatabaseUrl(databaseUrl)})`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[ensure-pgvector] failed against ${maskDatabaseUrl(databaseUrl)}:`, err);
  console.error('[ensure-pgvector] Deft needs the pgvector extension before schema push. Use the bundled pgvector/pgvector:pg16 image, or grant this database role permission to CREATE EXTENSION vector.');
  process.exit(1);
});
