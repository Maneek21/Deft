import 'dotenv/config';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { URL } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';
import { buildWindowsPnpmCommandArgs } from './windows-pnpm-command.js';

const execFileAsync = promisify(execFile);

type Check = {
  name: string;
  ok: boolean;
  detail: string;
  warn?: boolean;
  stale?: boolean;
};

const args = new Set(process.argv.slice(2));
const shouldStart = args.has('--start');
const strict = args.has('--strict') || process.env.DEFT_PREFLIGHT_STRICT === '1';
const API_URL = (process.env.DEFT_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const WEB_URL = (process.env.DEFT_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');
const CONFIGURED_APP_URL = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');
const SEED_EMAIL = process.env.DEFT_TEST_EMAIL || 'diego@testers-tomatoes.com';
const SEED_PASSWORD = process.env.DEFT_TEST_PASSWORD || 'tomato123';
const LIKELY_API_PORTS = [3001, 3301];
const LIKELY_WEB_PORTS = [3000, 3300];

function mark(check: Check) {
  const icon = check.ok ? (check.warn ? 'WARN' : 'OK') : 'FAIL';
  console.log(`[${icon}] ${check.name}: ${check.detail}`);
}

function checkWebPushConfig(): Check {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? '';
  const subject = process.env.VAPID_SUBJECT?.trim() ?? '';
  if (!publicKey && !privateKey) {
    return { name: 'Browser notifications', ok: true, warn: true, detail: 'VAPID keys are not configured; Inbox remains available but Web Push is disabled' };
  }
  if (!publicKey || !privateKey || !subject) {
    return { name: 'Browser notifications', ok: false, detail: 'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must be configured together' };
  }
  if (!/^(mailto:|https:\/\/)/i.test(subject)) {
    return { name: 'Browser notifications', ok: false, detail: 'VAPID_SUBJECT must start with mailto: or https://' };
  }
  return { name: 'Browser notifications', ok: true, detail: 'VAPID keys and subject are configured' };
}

async function fetchStatus(url: string): Promise<{ status: number; text: string }> {
  let lastMessage = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      return { status: res.status, text: await res.text().catch(() => '') };
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return { status: 0, text: lastMessage };
}

function localhostPort(rawUrl: string): number | null {
  try {
    const url = new URL(rawUrl);
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return null;
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  } catch {
    return null;
  }
}

function localhostUrlWithPort(rawUrl: string, port: number, path = ''): string {
  const url = new URL(rawUrl);
  url.hostname = 'localhost';
  url.port = String(port);
  url.pathname = path || '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function pidsForPort(port: number): Promise<string[]> {
  if (process.platform === 'win32') {
    const script = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script]).catch(() => ({ stdout: '' }));
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  const { stdout } = await execFileAsync('sh', ['-lc', `lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true`]).catch(() => ({ stdout: '' }));
  return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function databaseUrlCandidates(): string[] {
  if (process.env.DATABASE_URL) return [process.env.DATABASE_URL];
  const password = process.env.POSTGRES_PASSWORD || 'postgres';
  const port = process.env.POSTGRES_PORT || '5432';
  const candidates = [
    `postgres://postgres:${encodeURIComponent(password)}@localhost:${port}/deft`,
    'postgres://postgres:postgres@localhost:55432/deft',
  ];
  return Array.from(new Set(candidates));
}

async function checkApi(): Promise<Check> {
  const res = await fetchStatus(`${API_URL}/health`);
  return {
    name: 'API /health',
    ok: res.status === 200,
    detail: res.status === 200 ? `${API_URL}/health returned 200` : `${API_URL}/health returned ${res.status}: ${res.text.slice(0, 120)}`,
  };
}

async function checkWeb(): Promise<Check> {
  const res = await fetchStatus(WEB_URL);
  return {
    name: 'Web root',
    ok: res.status >= 200 && res.status < 500,
    detail: res.status ? `${WEB_URL} returned ${res.status}` : `${WEB_URL} unreachable: ${res.text.slice(0, 120)}`,
  };
}

async function checkDb(): Promise<Check> {
  const candidates = databaseUrlCandidates();
  const errors: string[] = [];
  let lastUrl = '';

  for (const url of candidates) {
    lastUrl = url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      const res = await client.query('select current_database() as db, current_user as user');
      return {
        name: 'Postgres',
        ok: true,
        detail: `connected to ${res.rows[0].db} as ${res.rows[0].user} (${lastUrl})`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${lastUrl}: ${message}`);
    } finally {
      await client.end().catch(() => {});
    }
  }

  return { name: 'Postgres', ok: false, detail: errors.join(' | ') || `no database URL candidates found; last ${lastUrl}` };
}

async function checkRedis(): Promise<Check> {
  if (!process.env.REDIS_URL) {
    return { name: 'Redis', ok: true, warn: true, detail: 'REDIS_URL not configured; skipped' };
  }

  const redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
  });
  try {
    await redis.connect();
    const pong = await redis.ping();
    return { name: 'Redis', ok: pong === 'PONG', detail: `PING ${pong}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: 'Redis', ok: false, detail: message };
  } finally {
    redis.disconnect();
  }
}

async function checkSeedLogin(): Promise<Check> {
  const res = await fetchStatus(`${API_URL}/api/auth/login`);
  if (res.status === 0) {
    return { name: 'Seed login', ok: false, detail: `API unreachable: ${res.text.slice(0, 120)}` };
  }

  try {
    const login = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.DEFT_AUDIT_BYPASS_TOKEN ? { 'x-deft-audit-token': process.env.DEFT_AUDIT_BYPASS_TOKEN } : {}),
      },
      body: JSON.stringify({ email: SEED_EMAIL, password: SEED_PASSWORD }),
      signal: AbortSignal.timeout(5_000),
    });
    return {
      name: 'Seed login',
      ok: login.ok,
      detail: login.ok
        ? `${SEED_EMAIL} login succeeded`
        : `${SEED_EMAIL} login returned ${login.status}: ${(await login.text()).slice(0, 160)}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: 'Seed login', ok: false, detail: message };
  }
}

async function checkLikelyApiPorts(): Promise<Check[]> {
  const intendedApiPort = localhostPort(API_URL);
  const checks: Check[] = [];

  if (intendedApiPort) {
    const intended = await fetchStatus(`${API_URL}/health`);
    const pids = await pidsForPort(intendedApiPort);
    if (pids.length > 0 && intended.status !== 200) {
      checks.push({
        name: `Intended API port ${intendedApiPort}`,
        ok: false,
        detail: `port is occupied by PID(s) ${pids.join(', ')} but ${API_URL}/health is not healthy. Stop that process or set DEFT_API_URL to the live API URL.`,
      });
    }
  }

  for (const port of LIKELY_API_PORTS) {
    if (port === intendedApiPort) continue;
    const res = await fetchStatus(`http://localhost:${port}/health`);
    if (res.status === 200) {
      const pids = await pidsForPort(port);
      checks.push({
        name: `Possible stale API on ${port}`,
        ok: !strict || process.env.DEFT_ALLOW_STALE_API === '1',
        warn: true,
        stale: true,
        detail: `http://localhost:${port}/health is alive${pids.length ? ` (PID ${pids.join(', ')})` : ''}; intended API is ${API_URL}. If this is the right API, set DEFT_API_URL=http://localhost:${port}.`,
      });
    }
  }

  return checks;
}

async function checkLikelyWebPorts(): Promise<Check[]> {
  const intendedWebPort = localhostPort(WEB_URL);
  const checks: Check[] = [];

  if (intendedWebPort) {
    const intended = await fetchStatus(WEB_URL);
    const pids = await pidsForPort(intendedWebPort);
    if (pids.length > 0 && !(intended.status >= 200 && intended.status < 500)) {
      checks.push({
        name: `Intended web port ${intendedWebPort}`,
        ok: false,
        detail: `port is occupied by PID(s) ${pids.join(', ')} but ${WEB_URL} is not serving a web root. Stop that process or set DEFT_WEB_URL to the live web URL.`,
      });
    }
  }

  for (const port of LIKELY_WEB_PORTS) {
    if (port === intendedWebPort) continue;
    const candidateUrl = localhostUrlWithPort(WEB_URL, port);
    const res = await fetchStatus(candidateUrl);
    if (res.status >= 200 && res.status < 500) {
      const pids = await pidsForPort(port);
      checks.push({
        name: `Possible web app on ${port}`,
        ok: !strict || process.env.DEFT_ALLOW_STALE_API === '1',
        warn: true,
        stale: true,
        detail: `${candidateUrl} returned ${res.status}${pids.length ? ` (PID ${pids.join(', ')})` : ''}; intended web is ${WEB_URL}. If this is the right app, set DEFT_WEB_URL=${candidateUrl}.`,
      });
    }
  }

  return checks;
}

async function checkConfiguredAppUrl(): Promise<Check[]> {
  if (!CONFIGURED_APP_URL || CONFIGURED_APP_URL === WEB_URL) return [];

  const res = await fetchStatus(CONFIGURED_APP_URL);
  const detail = res.status
    ? `NEXT_PUBLIC_APP_URL is ${CONFIGURED_APP_URL} and returned ${res.status}; pilot web target is ${WEB_URL}. Keep this only if generated links should use that URL.`
    : `NEXT_PUBLIC_APP_URL is ${CONFIGURED_APP_URL} but it is unreachable; pilot web target is ${WEB_URL}. Update NEXT_PUBLIC_APP_URL or set DEFT_WEB_URL when testing that URL intentionally.`;

  return [{
    name: 'Configured app URL drift',
    ok: true,
    warn: true,
    detail,
  }];
}

async function runChecks(): Promise<{ ok: boolean; blockingFailure: boolean }> {
  console.log(`Deft pilot preflight`);
  console.log(`  web: ${WEB_URL}`);
  console.log(`  api: ${API_URL}`);
  console.log(`  NEXT_PUBLIC_APP_URL: ${process.env.NEXT_PUBLIC_APP_URL || '(unset)'}`);
  console.log(`  NEXT_PUBLIC_API_URL: ${process.env.NEXT_PUBLIC_API_URL || '(unset)'}`);
  console.log(`  NEXT_PUBLIC_WS_URL: ${process.env.NEXT_PUBLIC_WS_URL || '(unset)'}`);
  console.log(`  strict stale-port gate: ${strict ? 'on' : 'off'}`);
  console.log('');

  const checks = [
    ...(await checkLikelyApiPorts()),
    ...(await checkLikelyWebPorts()),
    ...(await checkConfiguredAppUrl()),
    checkWebPushConfig(),
    await checkApi(),
    await checkWeb(),
    await checkDb(),
    await checkRedis(),
    await checkSeedLogin(),
  ];

  for (const check of checks) mark(check);
  if (strict && checks.some((check) => check.stale && !check.ok)) {
    console.log('');
    console.log('[INFO] Strict mode treats likely stale local web/API services as failures. Stop the extra process, point DEFT_API_URL/DEFT_WEB_URL at it, or set DEFT_ALLOW_STALE_API=1 for exploratory local work only.');
  }
  return {
    ok: checks.every((check) => check.ok),
    blockingFailure: checks.some((check) => !check.ok && (check.name.startsWith('Intended API port') || check.name.startsWith('Intended web port'))),
  };
}

async function waitForHealthy(timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const api = await checkApi();
    const web = await checkWeb();
    if (api.ok && web.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

function startDevStack(): ReturnType<typeof spawn>[] {
  const apiPort = localhostPort(API_URL) || 3001;
  const webPort = localhostPort(WEB_URL) || 3000;
  const baseEnv = {
    ...process.env,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || API_URL,
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL || API_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || WEB_URL,
  };
  const spawnPnpm = (args: string[], env: NodeJS.ProcessEnv) => {
    const childOptions = {
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
      env,
    };
    if (process.platform !== 'win32') return spawn('pnpm', args, childOptions);

    return spawn('cmd.exe', buildWindowsPnpmCommandArgs(args), childOptions);
  };
  const api = spawnPnpm(['--filter', '@deft/api', 'dev'], {
    ...baseEnv,
    API_PORT: String(apiPort),
    PORT: String(apiPort),
  });
  const web = spawnPnpm(['--filter', '@deft/web', 'exec', 'next', 'dev', '--port', String(webPort)], {
    ...baseEnv,
    PORT: String(webPort),
  });
  for (const child of [api, web]) {
    child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  }
  return [api, web];
}

async function main() {
  const result = await runChecks();
  if (result.ok || !shouldStart || result.blockingFailure) {
    process.exit(result.ok ? 0 : 1);
  }

  console.log('');
  console.log('[INFO] Starting local dev stack. Press Ctrl+C to stop.');
  const children = startDevStack();
  let shuttingDown = false;
  const stopChildren = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) child.kill();
  };
  process.on('SIGINT', stopChildren);
  process.on('SIGTERM', stopChildren);

  const healthy = await waitForHealthy(90_000);
  if (!healthy) {
    console.error('[FAIL] Dev stack did not become healthy within 90s. Check the output above.');
    stopChildren();
    process.exit(1);
  }

  console.log('[OK] Local pilot stack is healthy.');
  for (const child of children) child.on('exit', (code) => {
    if (!shuttingDown) process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.message : err);
  process.exit(1);
});
