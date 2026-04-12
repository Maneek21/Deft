/**
 * Login helper that POSTs to /api/auth/login, retrieves an access
 * token, then saves a Playwright storageState file so audit scripts
 * can reuse the session.
 *
 * Env vars:
 *   DEFT_TEST_EMAIL       — seed user email (required)
 *   DEFT_TEST_PASSWORD    — seed user password (required)
 *   DEFT_API_URL          — default http://localhost:3001
 *   DEFT_WEB_URL          — default http://localhost:3000
 *   DEFT_AUTH_STATE_PATH  — default playwright-auth.json at repo root
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const STATE_PATH = process.env.DEFT_AUTH_STATE_PATH || 'playwright-auth.json';

export async function loginAndSaveState(): Promise<void> {
  const email = process.env.DEFT_TEST_EMAIL;
  const password = process.env.DEFT_TEST_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'DEFT_TEST_EMAIL and DEFT_TEST_PASSWORD must be set. Create a test user first or pass env vars from your shell.',
    );
  }

  // 1. Login via API to get tokens.
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;
  // API may return camelCase (accessToken) or snake_case (access_token)
  const accessToken = (raw.access_token ?? raw.accessToken) as string | undefined;
  const refreshToken = (raw.refresh_token ?? raw.refreshToken) as string | undefined;
  if (!accessToken) {
    throw new Error(`Login response missing access_token: ${JSON.stringify(raw)}`);
  }
  const data = { access_token: accessToken, refresh_token: refreshToken };

  // 2. Spin up a browser, inject the token into localStorage, navigate
  //    to /dashboard so the session is fully established, save state.
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Inject the token BEFORE navigation so Deft's auth context picks it
  // up on first render.
  await page.addInitScript(
    ({ at, rt }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: data.access_token, rt: data.refresh_token ?? null },
  );
  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'networkidle' });

  const state = await ctx.storageState();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`Saved storage state to ${STATE_PATH}`);

  await browser.close();
}

export function getStatePath(): string {
  return STATE_PATH;
}
