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

const apiOrigin = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const nextConfig: NextConfig = {
  transpilePackages: ['@deft/shared'],
  // Hide the floating Next.js dev-tools indicator — it overlapped composer/FAB
  // on mobile audits. The badge is dev-only either way; this also hides the
  // build-activity spinner during dev.
  devIndicators: false,
  // Task 4 (private-alpha): security headers. `unsafe-inline` + `unsafe-eval`
  // on script-src are temporary — Next.js 16 + Tailwind v4 + TipTap need them
  // today. Tightening to nonce-based CSP is post-alpha. `microphone=(self)`
  // keeps the voice-clip recorder working. `connect-src` includes the dev API
  // URL; production operators can widen via env-driven config later.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              `connect-src 'self' ws: wss: ${apiOrigin} https:`,
              "media-src 'self' blob:",
              "frame-ancestors 'none'",
            ].join('; '),
          },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
};

export default nextConfig;
