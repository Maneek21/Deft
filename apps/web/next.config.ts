import type { NextConfig } from 'next';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load the repo-root .env into process.env so NEXT_PUBLIC_* vars defined
// there are visible to Next.js. Without this, Next only sees
// apps/web/.env.local which most contributors don't have. Next then
// inlines NEXT_PUBLIC_* values at build / dev-reload time. Uses a minimal
// inline parser so we don't add a new dependency.
try {
  const raw = readFileSync(resolve(__dirname, '..', '..', '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch {
  // fall through — root .env is optional
}

const nextConfig: NextConfig = {
  transpilePackages: ['@deft/shared'],
  // Hide the floating Next.js dev-tools indicator — it overlapped composer/FAB
  // on mobile audits. The badge is dev-only either way; this also hides the
  // build-activity spinner during dev.
  devIndicators: false,
};

export default nextConfig;
