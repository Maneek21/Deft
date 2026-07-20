import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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

export const env = {
  DATABASE_URL: resolveDatabaseUrl(),
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
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
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || 'deft-dev-encryption-key-32ch',
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
