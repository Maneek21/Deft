import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateAppRunKeyringEnvironment } from './app-run-keyrings.js';

// Resolve .env from the repo root via the source file's location, NOT
// process.cwd() — when this module loads under tsx / pnpm --filter / docker /
// a heartbeat worker, cwd is unpredictable. Anchor to the file path instead so
// `pnpm db:seed`, `pnpm dev`, and the production runner all see the same .env.
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '..', '..', '..', '.env') });
// Fallback to CWD-relative .env (no-ops if absent).
dotenv.config();

// Same fallback the db package uses: if DATABASE_URL is unset or still carries
// the .env.example placeholder, construct it from POSTGRES_PASSWORD — the value
// docker-compose actually boots Postgres with.
function resolveDatabaseUrl(): string {
  const explicit = process.env.DATABASE_URL;
  if (explicit && !explicit.includes('CHANGE_ME')) return explicit;

  if (process.env.NODE_ENV !== 'production') {
    const dockerUrl = resolveDockerDatabaseUrl();
    if (dockerUrl) return dockerUrl;
  }

  const pw = process.env.POSTGRES_PASSWORD || 'postgres';
  const port = process.env.POSTGRES_PORT || '5432';
  return `postgres://postgres:${pw}@localhost:${port}/deft`;
}

function resolveDockerDatabaseUrl(): string | null {
  try {
    const portOutput = execFileSync('docker', ['port', 'deft-codex-pg', '5432/tcp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const portMatch = portOutput.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/);
    const hostPort = portMatch?.[1];
    if (!hostPort) return null;

    const password = execFileSync('docker', ['exec', 'deft-codex-pg', 'printenv', 'POSTGRES_PASSWORD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'postgres';
    const dbName = execFileSync('docker', ['exec', 'deft-codex-pg', 'printenv', 'POSTGRES_DB'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'deft';

    return `postgres://postgres:${encodeURIComponent(password)}@localhost:${hostPort}/${dbName}`;
  } catch {
    return null;
  }
}

export const DEVELOPMENT_ENCRYPTION_KEY = 'deft-dev-encryption-key-32ch';

export function resolveEncryptionKey(
  configured?: string,
  nodeEnv = process.env.NODE_ENV,
): string {
  // An explicit `undefined` must remain distinguishable from an omitted
  // argument so callers validating supplied production configuration cannot
  // accidentally fall back to a key inherited from the parent process.
  const resolved = arguments.length === 0 ? process.env.ENCRYPTION_KEY : configured;
  const value = resolved?.trim();
  const insecure = !value
    || value === DEVELOPMENT_ENCRYPTION_KEY
    || value.includes('CHANGE_ME')
    || value.length < 32;
  if (nodeEnv === 'production' && insecure) {
    throw new Error('ENCRYPTION_KEY must be a non-default secret of at least 32 characters in production');
  }
  return value || DEVELOPMENT_ENCRYPTION_KEY;
}

export const env = {
  DATABASE_URL: resolveDatabaseUrl(),
  JWT_SECRET: process.env.JWT_SECRET || 'dev-jwt-secret-change-me',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  API_PORT: parseInt(process.env.API_PORT || '3001'),
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.API_PORT || '3001'}`,
  DEFT_PUBLIC_URL: process.env.DEFT_PUBLIC_URL || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  // Empty by default so a copied .env.example does not make fresh installs
  // look AI-ready when no local Ollama server is actually running.
  OLLAMA_URL: process.env.OLLAMA_URL || '',
  ENCRYPTION_KEY: resolveEncryptionKey(),
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || '',
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || '',
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET || '',
  // Transcription. Default to local Whisper so self-hosted Deft never
  // pings a paid API for voice clips out of the box. Operators who want
  // OpenAI Whisper or Deepgram override via env or per-org config.
  TRANSCRIPTION_PROVIDER: (process.env.TRANSCRIPTION_PROVIDER || 'local') as 'local' | 'openai' | 'deepgram',
  WHISPER_URL: process.env.WHISPER_URL || 'http://localhost:9000', // local whisper container
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY || '',
  // Phase 10 — Prometheus scraper bearer token. Unset = /api/metrics returns 503.
  METRICS_SCRAPE_TOKEN: process.env.METRICS_SCRAPE_TOKEN || '',
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || '',
};

// App Protocol v0 is opt-in while the first vertical slice is certified.
// Absence and every value except the exact string "true" fail closed.
export const APPS_ENABLED = process.env.DEFT_APPS_ENABLED === 'true';
export const APP_DEVELOPER_PAIRING_ENABLED =
  APPS_ENABLED && process.env.DEFT_APP_DEVELOPER_PAIRING_ENABLED === 'true';

// Governed App Runs remain a disabled-by-default, independent opt-in.
// Exact "true" plus valid purpose-separated keyrings is required. A normal
// legacy self-host boot never needs or parses the new secret document.
export const APP_RUNS_ENABLED = process.env.DEFT_APP_RUNS_ENABLED === 'true';
export const APP_RUN_LEGACY_MCP_CUTOVER_ENABLED =
  process.env.DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED === 'true';
export const APP_RUN_APP_ORIGIN_ENABLED =
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED === 'true';

export function validateAppRunRolloutConfiguration(
  appRunsEnabled: boolean,
  legacyMcpCutoverEnabled: boolean,
  appOriginEnabled = false,
  appsEnabled = false,
): void {
  if (legacyMcpCutoverEnabled && !appRunsEnabled) {
    throw new Error(
      'DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=true requires DEFT_APP_RUNS_ENABLED=true',
    );
  }
  if (appOriginEnabled && (!appRunsEnabled || !appsEnabled)) {
    throw new Error(
      'DEFT_APP_RUN_APP_ORIGIN_ENABLED=true requires DEFT_APP_RUNS_ENABLED=true and DEFT_APPS_ENABLED=true',
    );
  }
}

validateAppRunRolloutConfiguration(
  APP_RUNS_ENABLED,
  APP_RUN_LEGACY_MCP_CUTOVER_ENABLED,
  APP_RUN_APP_ORIGIN_ENABLED,
  APPS_ENABLED,
);
validateAppRunKeyringEnvironment(APP_RUNS_ENABLED, process.env.DEFT_APP_RUN_KEYRINGS);
