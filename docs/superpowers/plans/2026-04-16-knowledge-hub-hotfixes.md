# Knowledge-Hub Hotfixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two deployment-readiness bugs surfaced during the knowledge-hub Playwright audit on 2026-04-16:

1. **#80** — Chat decisions produce two near-identical wiki pages per message (classifier populates both `decision` and `memorable_facts` with the same content).
2. **#81** — After the 15-minute access-token TTL, `/api/auth/me` returns 401 and Socket.io drops with `Invalid token`, filling the browser console with errors even though refresh tokens are in localStorage.

**Architecture:** Two surgical patches on isolated surfaces.

- For #80: tighten the classifier prompt so Haiku no longer returns the decision in `memorable_facts`, AND add a defense-in-depth dedup guard in `memory-extract` that drops any `memorable_fact` whose substring overlap with `decision` exceeds 70%.
- For #81: add a 401-interceptor to the web `api` client that silently refreshes the access token and retries the original request once, AND wire the Socket.io client to listen for `connect_error` → refresh + reconnect.

**Tech Stack:** TypeScript strict, Anthropic Haiku (classifier), fetch-based `api` client on the web, Socket.io client, `node:test` harness.

**Scope boundaries:**
- No schema changes.
- No new workers, no new migrations.
- No API contract changes on the classifier output or the auth routes (the refresh endpoint already exists; we just use it earlier).
- Not in scope: proactive token refresh (e.g. a background timer that refreshes 60s before expiry). Reactive-on-401 is enough for this round; timer-based proactive refresh is a nice-to-have for later.

**Assumptions:**
- `POST /api/auth/refresh` already accepts the refresh token and returns a new access token (confirmed by existing proactive-refresh callsites in `apps/web/src/lib/api.ts:48-53, 127-132`).
- The refresh token lives in `localStorage` under key `deft-refresh-token` (per `apps/web/src/lib/api.ts:10`).
- The classifier prompt at `apps/api/src/lib/classifier.ts:31-52` is the canonical source — if any downstream code re-prompts the LLM it will need the same treatment (none known today).

---

## Task 1: classifier dedup (#80)

**Files:**
- Modify: `apps/api/src/lib/classifier.ts` — prompt fix (lines 40-41 and 50)
- Modify: `apps/api/src/workers/handlers/memory-extract.ts` — add dedup guard on the `facts` array before ingesting (before `executeWikiIngest` is called for each fact)
- Create: `apps/api/test/classifier-decision-dedup.test.ts` — two tests covering both fixes

### Step 1.1: Write the failing test

- [ ] **Write** `apps/api/test/classifier-decision-dedup.test.ts`:

```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeFactsAgainstDecision } from '../src/workers/handlers/memory-extract.js';

describe('dedupeFactsAgainstDecision', () => {
  test('drops a memorable_fact whose content matches the decision', () => {
    const decision = 'Move deployments to Cloudflare Workers for edge execution';
    const facts = [
      'Team decided to move deployments to Cloudflare Workers for edge execution',
      'Priya will draft the migration plan by Friday',
    ];
    const result = dedupeFactsAgainstDecision(facts, decision);
    assert.deepStrictEqual(result, ['Priya will draft the migration plan by Friday']);
  });

  test('keeps facts that are unrelated to the decision', () => {
    const decision = 'Standardize on Redis Streams for the event bus';
    const facts = [
      'Sprint retros move to Fridays',
      'New office coffee machine is a Breville Dual Boiler',
    ];
    const result = dedupeFactsAgainstDecision(facts, decision);
    assert.deepStrictEqual(result, facts);
  });

  test('returns facts unchanged when decision is null', () => {
    const facts = ['a', 'b'];
    const result = dedupeFactsAgainstDecision(facts, null);
    assert.deepStrictEqual(result, facts);
  });

  test('is case- and punctuation-insensitive', () => {
    const decision = 'Use DynamoDB for the session store';
    const facts = ['team chose DynamoDB for session store!'];
    const result = dedupeFactsAgainstDecision(facts, decision);
    assert.deepStrictEqual(result, []);
  });
});
```

- [ ] **Run** the failing test:

```bash
cd apps/api && pnpm test test/classifier-decision-dedup.test.ts
```

Expected: FAIL — `dedupeFactsAgainstDecision` is not exported (yet).

### Step 1.2: Implement `dedupeFactsAgainstDecision` in `memory-extract.ts`

- [ ] **Add** the helper at the top of `apps/api/src/workers/handlers/memory-extract.ts` (near other helpers like `isCommitmentFact`):

```typescript
/**
 * Compute Jaccard-like token overlap between two strings after stripping
 * non-alphanumerics and lowercasing. Returns a fraction in [0, 1].
 */
function tokenOverlap(a: string, b: string): number {
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 3),
    );
  const A = norm(a);
  const B = norm(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const t of A) if (B.has(t)) intersection += 1;
  const union = A.size + B.size - intersection;
  return intersection / union;
}

/**
 * Classifier defense-in-depth: Haiku sometimes returns the decision verbatim
 * in `memorable_facts` too, which causes two near-identical wiki pages to be
 * ingested per chat message. Drop any fact whose token overlap with the
 * decision exceeds the threshold.
 */
export function dedupeFactsAgainstDecision(
  facts: string[],
  decision: string | null,
): string[] {
  if (!decision) return facts;
  const threshold = 0.5; // 50% Jaccard — catches "Team decided to X" vs "X" pairs
  return facts.filter((f) => tokenOverlap(f, decision) < threshold);
}
```

- [ ] **Wire** the helper into the handler. Find the place where `facts` is iterated (look for `for (const fact of facts)` or `facts.forEach`). Before that loop, filter:

```typescript
const dedupedFacts = dedupeFactsAgainstDecision(facts, decision);
// ... use dedupedFacts in the loop instead of facts
```

If the handler already has an early `facts = facts ?? []` line, replace with `const dedupedFacts = dedupeFactsAgainstDecision(facts ?? [], decision ?? null);` and use `dedupedFacts` thereafter.

- [ ] **Run** the test — confirm PASS.

### Step 1.3: Tighten the classifier prompt

- [ ] **Modify** `apps/api/src/lib/classifier.ts` lines 40-41 and 50. Current:

```typescript
- memorable_facts: array of strings — extract any memorable facts worth remembering (team preferences, tool choices, process decisions, personal preferences, workflow conventions). Examples: "Rahul prefers async standups", "team uses Stripe for payments". Return empty array if nothing memorable.
- decision: string or null — if the message contains a clear team decision (e.g., "Let's go with Postgres instead of MongoDB"), extract it as a concise statement. Return null if no decision.
```

Replace with:

```typescript
- memorable_facts: array of strings — extract any memorable NON-DECISION facts worth remembering (team preferences, tool choices, personal preferences, workflow conventions, org/process details). Examples: "Rahul prefers async standups", "team uses Stripe for payments". Return empty array if nothing memorable. CRITICAL: If a clear team decision is present and you are setting the `decision` field, DO NOT also duplicate that same statement in `memorable_facts`. The `decision` field and `memorable_facts` must describe DIFFERENT underlying content.
- decision: string or null — if the message contains a clear team decision (e.g., "Let's go with Postgres instead of MongoDB"), extract it as a concise statement. Return null if no decision. When set, exclude this content from `memorable_facts`.
```

And line 50 (the "Also extract" sentence) — replace with:

```
Also extract any memorable facts (team preferences, tool choices, personal preferences) as an array. If the message contains a clear team decision, extract it separately into `decision` and do NOT repeat it inside `memorable_facts`.
```

- [ ] **Run** the test again — still PASS (prompt change is orthogonal to the dedup helper, but the helper is our safety net if Haiku ignores the prompt).

### Step 1.4: Full suite + typecheck

- [ ] `cd apps/api && pnpm test` — expect 210 + 4 = 214 passing, 0 fail, 1 skip.
- [ ] `cd .. && pnpm -r typecheck` — both workspaces clean.

### Step 1.5: Commit

- [ ] Commit:

```bash
git add apps/api/src/lib/classifier.ts apps/api/src/workers/handlers/memory-extract.ts apps/api/test/classifier-decision-dedup.test.ts
git commit -m "fix(classifier): drop decision-duplicated memorable_facts to prevent 2-pages-per-chat bug"
```

---

## Task 2: silent token refresh + socket reconnect (#81)

**Files:**
- Modify: `apps/web/src/lib/api.ts` — add a 401 interceptor that silently refreshes on expired-access-token + retries the original request once
- Modify: `apps/web/src/lib/socket.ts` — listen for `connect_error` with an auth-shaped reason → refresh token → reconnect
- Create: `apps/api/test/auth-refresh-contract.test.ts` — verify the `/api/auth/refresh` server contract is stable (no regression)

### Step 2.1: Write the failing contract test for the refresh endpoint

The server side (`/api/auth/refresh`) already works — we're just locking down the contract so a future refactor doesn't silently break the web client's new reliance on it.

- [ ] **Write** `apps/api/test/auth-refresh-contract.test.ts`:

```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { authRoutes } from '../src/routes/auth.js';
// ... plus the test harness that the existing auth tests use — match their pattern

describe('/api/auth/refresh contract', () => {
  test('accepts a refresh token and returns a new access token', async () => {
    // Seed a user + issue a valid refresh token (reuse the existing auth test helpers)
    // POST /api/auth/refresh with { refresh_token: <seeded> }
    // Assert 200 + response.access_token is a non-empty string
    // Assert response.refresh_token is also returned (rotation)
  });

  test('rejects a revoked refresh token with 401', async () => {
    // Seed + refresh + logout (revokes), then try refresh again
    // Assert 401, { error, code: 'TOKEN_REVOKED' } (or whatever the current code is)
  });

  test('rejects a malformed refresh token with 400', async () => {
    // POST with { refresh_token: 'garbage' }
    // Assert 400 or 401
  });
});
```

Use the existing auth test pattern (check `apps/api/test/` for how auth tests wire the Hono app). If no auth test file exists, inspect `apps/api/src/routes/auth.ts` for the exported app shape and use the `app.fetch()` direct-invoke pattern.

- [ ] **Run** the test to confirm it passes against today's server (we're not fixing the server — just pinning the contract):

```bash
cd apps/api && pnpm test test/auth-refresh-contract.test.ts
```

Expected: PASS (it's testing current behavior).

### Step 2.2: Add a 401 interceptor to the web `api` client

The existing client (`apps/web/src/lib/api.ts`) has proactive refresh when no access token is present. What's missing is reactive refresh when the access token is present but expired (the server responds 401 mid-session).

- [ ] **Read** `apps/web/src/lib/api.ts` in full to find where fetch is called and where the access token is attached. Look for the `api.get` / `api.post` / `api.patch` helpers.

- [ ] **Add** a private helper `refreshAccessToken()` that:

```typescript
async function refreshAccessToken(): Promise<string | null> {
  const refresh = localStorage.getItem('deft-refresh-token');
  if (!refresh) return null;
  try {
    const r = await fetch(`${API_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.access_token) {
      // Update the in-memory + storage copy (match whatever the existing code does in the proactive path)
      this.accessToken = j.access_token;
      localStorage.setItem('deft-access-token', j.access_token);
      if (j.refresh_token) {
        this.refreshToken = j.refresh_token;
        localStorage.setItem('deft-refresh-token', j.refresh_token);
      }
      return j.access_token;
    }
    return null;
  } catch {
    return null;
  }
}
```

(Match the existing token storage convention — the proactive path at `api.ts:48-53` shows it; this helper should be consistent.)

- [ ] **Wrap** the core request function with a 401 retry. Something like:

```typescript
async function requestWithAuth(url: string, init: RequestInit, isRetry = false): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 401 && !isRetry) {
    const fresh = await refreshAccessToken();
    if (fresh) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${fresh}`);
      return requestWithAuth(url, { ...init, headers }, true); // retry once
    }
    // If refresh failed, clear tokens + let the 401 propagate so the UI can redirect to /login
    this.clear(); // or equivalent token clear
  }
  return res;
}
```

Plug `requestWithAuth` into `api.get` / `api.post` / `api.patch` / `api.delete` in place of the bare `fetch`.

- [ ] **Guard** against refresh storms: if two concurrent requests both 401, only ONE refresh call should fire and both should get the same new token. Add a module-level `_refreshPromise: Promise<string | null> | null` that concurrent callers await:

```typescript
let _refreshPromise: Promise<string | null> | null = null;
async function refreshAccessToken(): Promise<string | null> {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = doRefresh();
  try {
    return await _refreshPromise;
  } finally {
    _refreshPromise = null;
  }
}
```

### Step 2.3: Socket.io reconnect on auth failure

- [ ] **Read** `apps/web/src/lib/socket.ts` in full. Find where the socket is created (`io(URL, { auth: { token } })` or similar).

- [ ] **Add** a `connect_error` listener that checks for auth-shaped errors and refreshes:

```typescript
socket.on('connect_error', async (err) => {
  const msg = err?.message ?? '';
  if (/invalid token|expired|unauthori[sz]ed/i.test(msg)) {
    const fresh = await refreshAccessToken(); // import from lib/api.ts
    if (fresh) {
      socket.auth = { token: fresh };
      socket.connect();
      return;
    }
    // Refresh failed — don't retry in a loop; let the user re-login
    console.warn('[socket] auth refresh failed; stopping reconnect attempts');
    socket.disconnect();
    return;
  }
  // Non-auth errors use the default reconnection
});
```

- [ ] **Verify** the socket's initial `auth` shape. If the server expects a different key (e.g. `accessToken` vs `token`), match it.

### Step 2.4: Playwright smoke

Hard to test the real 15-min-expiry path in CI — but we can FAKE it by directly corrupting the access token in localStorage mid-session and asserting the next API call still succeeds via silent refresh.

- [ ] **Add** a targeted audit check in `docs/superpowers/audits/gap-fixes.audit.ts` (or a new small Playwright file under the audits folder):

```typescript
test('silent token refresh on expired access token', async ({ page }) => {
  await page.goto(`${WEB_URL}/login`);
  // fill email + password, submit
  await page.waitForURL(/\/(chat|dashboard)/);

  // Corrupt the access token so the next API call 401s
  await page.evaluate(() => {
    localStorage.setItem('deft-access-token', 'corrupted.jwt.here');
  });

  // Trigger an API call that would normally work
  const res = await page.request.get(`${API_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer corrupted.jwt.here` },
  });
  // Direct fetch still 401s (no interceptor) — that's expected for a raw call
  // Now navigate within the app — the app's api client SHOULD silently refresh
  await page.goto(`${WEB_URL}/knowledge`);
  await expect(page.getByRole('heading', { name: 'Knowledge Wiki' })).toBeVisible({ timeout: 10000 });
  // No redirect to /login means silent refresh worked
  expect(page.url()).not.toContain('/login');
});
```

- [ ] **Run** the audit: `cd apps/api && pnpm exec tsx ../../docs/superpowers/audits/gap-fixes.audit.ts` (or whatever the project invocation is — check the file's header). Expected: new test passes.

### Step 2.5: Full suite + typecheck

- [ ] `cd apps/api && pnpm test` — expected: 214 + 3 (from 2.1) = 217 passing, 0 fail.
- [ ] `cd .. && pnpm -r typecheck` — both workspaces clean.

### Step 2.6: Commit

- [ ] Commit:

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/socket.ts apps/api/test/auth-refresh-contract.test.ts docs/superpowers/audits/gap-fixes.audit.ts
git commit -m "fix(auth): silent token refresh on 401 + socket reconnect on auth-error"
```

---

## Deploy both fixes

Both tasks require a deploy to take effect for trusted testers.

- [ ] **Both** services need the railway up (api for #80, web for #81):

```bash
(set -a; source .deploy-tokens; set +a; \
  RAILWAY_TOKEN="$RAILWAY_CLI_TOKEN" npx -y @railway/cli@latest up --service "$RAILWAY_SERVICE_ID" --ci && \
  RAILWAY_TOKEN="$RAILWAY_CLI_TOKEN" npx -y @railway/cli@latest up --service "$RAILWAY_WEB_SERVICE_ID" --ci)
```

- [ ] **Smoke test on prod:**
  1. Log in as vishesh@deft.test
  2. Send a chat message: *"The team decided to migrate logging from CloudWatch to Grafana Loki. Arjun will own the cutover."* — verify `/knowledge` shows **exactly ONE** new wiki decision titled "Migrate logging from CloudWatch to Grafana Loki" (not two) plus one separate fact about Arjun.
  3. Leave the browser tab open for 16 minutes (or corrupt the access token in DevTools → Application → localStorage as the shortcut). Do an action (click a different space). Console should be clean — no 401 errors, no `[socket] Invalid token`. If DevTools shows anything, it should be a single 401 on `/api/auth/me` followed immediately by `/api/auth/refresh` 200 and the original retry 200.

---

## Self-review

**Spec coverage check:**
- ✅ #80 duplicate decisions — Task 1 (prompt tightening + memory-extract dedup guard)
- ✅ #81 JWT expiry console noise — Task 2 (api 401 interceptor + socket reconnect)

**Placeholder scan:** all code blocks are complete — no "TBD" or "handle this later" markers.

**Type consistency:**
- `dedupeFactsAgainstDecision(facts: string[], decision: string | null): string[]` — consistent between test, implementation, and call site
- `refreshAccessToken(): Promise<string | null>` — imported into both `api.ts` and `socket.ts`, same shape
- `tokenOverlap` is a pure helper; no external dep

**Risks worth flagging:**
- The Jaccard threshold of 0.5 is a guess. If testers report decisions STILL duplicating, loosen to 0.4; if they report legitimate facts being dropped, raise to 0.6. The test suite pins the current behavior — tests need updating if the threshold moves.
- The 401-interceptor retry guards against an infinite loop with `isRetry`. If the refresh endpoint ALSO 401s (e.g., refresh token revoked too), `refreshAccessToken` returns null and the original 401 propagates to the UI — which should detect it and redirect to `/login`. Verify the UI already has that behavior (or add it if not; probably lives in the app-shell layout).
- Socket reconnect could loop if auth-refresh succeeds but the server still rejects (stale session). The current plan disconnects after a single failed refresh — that's the right failure mode. Worth confirming with the existing backoff config on the socket.
- The contract test for `/api/auth/refresh` touches real DB in test harness (per the existing test pattern). No new schema or fixtures needed.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-16-knowledge-hub-hotfixes.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a single implementer for each of the two tasks (they touch zero overlapping files, so they could run in parallel). Two-stage review on each. Both land in ~20-30 minutes.

**2. Inline Execution** — Execute the two tasks sequentially in this session using `superpowers:executing-plans`.

**Recommended order:** Task 1 first — it's lower-risk (server-side only, no client coupling) and the duplicate-decisions bug is the more visible one to trusted testers. Task 2 can follow immediately after.

Which approach?
