import dotenv from 'dotenv';
import { resolve } from 'node:path';

// Load .env from project root (../../.env from apps/api/src/lib/)
dotenv.config({ path: resolve(process.cwd(), '..', '..', '.env') });
// Also try CWD
dotenv.config();

export const env = {
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  JWT_SECRET: process.env.JWT_SECRET || 'dev-jwt-secret-change-me',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  API_PORT: parseInt(process.env.API_PORT || '3001'),
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  OLLAMA_URL: process.env.OLLAMA_URL || 'http://localhost:11434',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || 'deft-dev-encryption-key-32ch',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
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
};
