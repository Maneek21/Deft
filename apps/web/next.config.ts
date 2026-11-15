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

// connect-src: fetch, XHR, WebSocket, EventSource and beacon requests may go
// only to the page itself and to the configured API and live-connection
// addresses (the defaults match lib/api.ts and lib/socket.ts). Each address
// is listed as its http(s) origin plus its WebSocket form, because a CSP
// source `https://host` does not match `wss://host`; either form may be
// configured (NEXT_PUBLIC_WS_URL=wss://host is accepted). The prebuilt image
// is built with placeholders (`__DEFT_API_URL__`); for those the policy names
// `__DEFT_API_ORIGIN__` / `__DEFT_API_WS_ORIGIN__`, which
// scripts/inject-public-env.mjs fills with the real origins at start.
function connectSources(url: string): string[] {
  const placeholder = /^__DEFT_([A-Z]+)_URL__$/.exec(url);
  if (placeholder) return [`__DEFT_${placeholder[1]}_ORIGIN__`, `__DEFT_${placeholder[1]}_WS_ORIGIN__`];
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid public URL for the content security policy: ${url}`); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error(`Public URL must be http(s) or ws(s) for the content security policy: ${url}`);
  }
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  return [`${secure ? 'https' : 'http'}://${parsed.host}`, `${secure ? 'wss' : 'ws'}://${parsed.host}`];
}

const connectSrc = [...new Set([
  "'self'",
  ...connectSources(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'),
  ...connectSources(process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001'),
])].join(' ');

const nextConfig: NextConfig = {
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
  transpilePackages: ['@deft/shared'],
  // App Kit keeps .js specifiers for its emitted Node ESM package. The host
  // imports these reviewed TypeScript sources directly, so resolve only those
  // source-to-source requests to their existing .ts files for Turbopack.
  turbopack: {
    resolveAlias: {
      './structured-address.js': '../../packages/app-kit/src/structured-address.ts',
      './resource-record-list.js': '../../packages/app-kit/src/resource-record-list.ts',
      './runtime-authoring.js': '../../packages/app-kit/src/runtime-authoring.ts',
      './safe-rich-text.js': '../../packages/app-kit/src/safe-rich-text.ts',
      './safe-uri.js': '../../packages/app-kit/src/safe-uri.ts',
      './safe-raster.js': '../../packages/app-kit/src/safe-raster.ts',
    },
  },
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  // Hide the floating Next.js dev-tools indicator — it overlapped composer/FAB
  // on mobile audits. The badge is dev-only either way; this also hides the
  // build-activity spinner during dev.
  devIndicators: false,
  // Task 4 (private-alpha): security headers. `unsafe-inline` + `unsafe-eval`
  // on script-src are temporary — Next.js 16 + Tailwind v4 + TipTap need them
  // today. Tightening to nonce-based CSP is post-alpha. `microphone=(self)`
  // keeps the voice-clip recorder working. `connect-src` is narrowed to the
  // page itself and the configured API and live-connection addresses: that
  // stops fetch, XHR, WebSocket and beacon connections to other addresses.
  // It does NOT by itself stop a script already running on the page from
  // leaking data another way: `img-src` still allows any https address
  // (external avatars and link-preview images need it), and navigation is
  // not restricted. `form-action 'self'` and `base-uri 'self'` close two
  // cheap routes (every form in the app submits through script to the page
  // itself; nothing uses <base>). `object-src` is left to `default-src
  // 'self'`: PDF previews open as blob documents that inherit this policy,
  // and 'none' could block the browser's PDF viewer there.
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
              // Next SPA navigation retains the original document policy.
              // Trusted Host pages may create Blob Workers; opaque srcdoc children
              // apply an additional hash-only/connect-none policy.
              "worker-src 'self' blob:",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data: https://fonts.gstatic.com",
              `connect-src ${connectSrc}`,
              "media-src 'self' blob:",
              "frame-ancestors 'none'",
              "form-action 'self'",
              "base-uri 'self'",
            ].join('; '),
          },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
      {
        // The only frameable page is the trusted, opaque Experience bootstrap.
        // Author bytes arrive only by checked parent-to-frame message.
        source: '/app-experience-bootstrap',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "default-src 'none'; script-src 'self'; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'" },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
