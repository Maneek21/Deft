import 'dotenv/config';
import pg from 'pg';
import Redis from 'ioredis';

const { Client } = pg;

type Check = {
  name: string;
  ok: boolean;
  detail: string;
  warn?: boolean;
};

const API_URL = (process.env.DEFT_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const WEB_URL = (process.env.DEFT_WEB_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || WEB_URL).replace(/\/$/, '');

function maskDatabaseUrl(url: string): string {
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

function resolveDatabaseUrl(): string {
  const explicit = process.env.DATABASE_URL;
  if (explicit && !explicit.includes('CHANGE_ME')) return explicit;
  const password = process.env.POSTGRES_PASSWORD || 'postgres';
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.POSTGRES_PORT || '5432';
  const database = process.env.POSTGRES_DB || 'deft';
  return `postgres://postgres:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

async function fetchStatus(
  url: string,
  init?: RequestInit,
  attempts = 8,
): Promise<{ status: number; text: string; headers: Headers | null }> {
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
      return { status: res.status, text: await res.text().catch(() => ''), headers: res.headers };
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  return { status: 0, text: last || 'fetch failed', headers: null };
}

function mark(check: Check) {
  const icon = check.ok ? (check.warn ? 'WARN' : 'OK') : 'FAIL';
  console.log(`[${icon}] ${check.name}: ${check.detail}`);
}

async function checkApi(): Promise<Check> {
  const res = await fetchStatus(`${API_URL}/health`);
  return {
    name: 'API /health',
    ok: res.status === 200,
    detail: res.status === 200 ? `${API_URL}/health returned 200` : `${API_URL}/health returned ${res.status}: ${res.text.slice(0, 160)}`,
  };
}

async function checkWeb(): Promise<Check> {
  const res = await fetchStatus(WEB_URL);
  return {
    name: 'Web root',
    ok: res.status >= 200 && res.status < 500,
    detail: res.status ? `${WEB_URL} returned ${res.status}` : `${WEB_URL} unreachable: ${res.text.slice(0, 160)}`,
  };
}

async function checkCors(): Promise<Check> {
  const res = await fetchStatus(`${API_URL}/api/auth/login`, {
    method: 'OPTIONS',
    headers: {
      Origin: APP_URL,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type',
    },
  });
  const allowOrigin = res.headers?.get('access-control-allow-origin') ?? '';
  return {
    name: 'Browser API origin',
    ok: res.status === 204 && allowOrigin === APP_URL,
    detail: res.status === 204
      ? `CORS allows ${allowOrigin || '(empty)'}; expected ${APP_URL}`
      : `OPTIONS returned ${res.status}: ${res.text.slice(0, 160)}`,
  };
}

async function checkDb(): Promise<Check> {
  const databaseUrl = resolveDatabaseUrl();
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const res = await client.query(`
      select
        current_database() as db,
        current_user as user,
        exists(select 1 from pg_extension where extname = 'vector') as has_vector,
        exists(select 1 from information_schema.tables where table_schema = 'public' and table_name = 'users') as has_users,
        exists(select 1 from information_schema.tables where table_schema = 'public' and table_name = 'skills') as has_skills
    `);
    const row = res.rows[0];
    const ok = Boolean(row.has_vector && row.has_users && row.has_skills);
    const missing = [
      row.has_vector ? null : 'pgvector extension',
      row.has_users ? null : 'users table',
      row.has_skills ? null : 'skills table',
    ].filter(Boolean);
    return {
      name: 'Postgres schema',
      ok,
      detail: ok
        ? `connected to ${row.db} as ${row.user}; schema and pgvector present (${maskDatabaseUrl(databaseUrl)})`
        : `connected, but missing ${missing.join(', ')} (${maskDatabaseUrl(databaseUrl)}). Run docker compose run --rm init.`,
    };
  } catch (err) {
    return {
      name: 'Postgres schema',
      ok: false,
      detail: `${maskDatabaseUrl(databaseUrl)}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkPlatformSeed(): Promise<Check> {
  const databaseUrl = resolveDatabaseUrl();
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const res = await client.query(`
      select
        exists(select 1 from users where email = 'deft-agent@system.local') as has_defty,
        (select count(*)::int from skills where source = 'bundled') as bundled_skills
    `);
    const row = res.rows[0];
    const ok = Boolean(row.has_defty && row.bundled_skills > 0);
    return {
      name: 'Platform seed',
      ok,
      detail: ok
        ? `Defty user and ${row.bundled_skills} bundled skill(s) present`
        : 'Defty user or bundled skills missing. Run docker compose run --rm init.',
    };
  } catch (err) {
    return {
      name: 'Platform seed',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkRedis(): Promise<Check> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return { name: 'Redis', ok: true, warn: true, detail: 'REDIS_URL not configured; skipped' };
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
  });
  try {
    await redis.connect();
    const pong = await redis.ping();
    return { name: 'Redis', ok: pong === 'PONG', detail: `PING ${pong}` };
  } catch (err) {
    return { name: 'Redis', ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    redis.disconnect();
  }
}

async function checkUrlAgreement(): Promise<Check> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || '';
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || '';
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || '';
  const missing = [
    apiUrl ? null : 'NEXT_PUBLIC_API_URL',
    wsUrl ? null : 'NEXT_PUBLIC_WS_URL',
    appUrl ? null : 'NEXT_PUBLIC_APP_URL',
  ].filter(Boolean);
  return {
    name: 'Public URL config',
    ok: missing.length === 0,
    warn: missing.length > 0,
    detail: missing.length === 0
      ? `app=${appUrl}, api=${apiUrl}, ws=${wsUrl}`
      : `${missing.join(', ')} unset; defaults may be okay for localhost only`,
  };
}

async function main() {
  console.log('Deft self-host doctor');
  console.log(`  web: ${WEB_URL}`);
  console.log(`  api: ${API_URL}`);
  console.log(`  app origin: ${APP_URL}`);
  console.log('');

  const checks = [
    await checkUrlAgreement(),
    await checkApi(),
    await checkWeb(),
    await checkCors(),
    await checkDb(),
    await checkRedis(),
    await checkPlatformSeed(),
  ];

  for (const check of checks) mark(check);
  process.exit(checks.every((check) => check.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.message : err);
  process.exit(1);
});
