import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

let loaded = false;

export function loadRootEnv(importMetaUrl: string) {
  if (loaded) return;
  let here = dirname(fileURLToPath(importMetaUrl));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolve(here, 'pnpm-workspace.yaml'))) {
      loadEnv({ path: resolve(here, '.env') });
      loaded = true;
      return;
    }
    const next = resolve(here, '..');
    if (next === here) break;
    here = next;
  }

  loadEnv();
  loaded = true;
}

export function resolveDatabaseUrl(): string {
  const explicit = process.env.DATABASE_URL;
  if (explicit && !explicit.includes('CHANGE_ME')) return explicit;

  const password = process.env.POSTGRES_PASSWORD || 'postgres';
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.POSTGRES_PORT || '5432';
  const database = process.env.POSTGRES_DB || 'deft';

  return `postgres://postgres:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

export function maskDatabaseUrl(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}
