/**
 * "Report a problem" (telemetry contract, section 2): POST /api/support/report.
 *
 * - Any signed-in person may send one, guests included; the report carries
 *   their role as the session states it.
 * - The reporter's address goes along only when they tick the box, and it is
 *   read from their account, never from the form.
 * - Limited per person and per client address.
 * - A hosted cell forwards it to the control plane with its seat fetch token
 *   and answers with a short reference; if the control plane does not take
 *   it, the person is told. Self-hosted Deft never sends one.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/support-report-route.test.ts
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { Hono } from 'hono';
import { createSupportRoutes, supportDeps } from '../src/routes/support.js';
import { problemReportDeps } from '../src/lib/telemetry/problem-report.js';
import { CELL_ID, CONTROL_PLANE, FETCH_TOKEN, HOSTED_ENV, SELF_HOSTED_ENV, recordingFetch } from './fixtures/telemetry.js';

const savedSupport = { ...supportDeps };
const savedReport = { ...problemReportDeps };
afterEach(() => {
  Object.assign(supportDeps, savedSupport);
  Object.assign(problemReportDeps, savedReport);
});

type Role = 'owner' | 'admin' | 'member' | 'guest';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36';

function setup(options: { env?: NodeJS.ProcessEnv; status?: number | 'throw'; limits?: Parameters<typeof createSupportRoutes>[0] } = {}) {
  const network = recordingFetch(options.status ?? 202);
  Object.assign(supportDeps, {
    env: options.env ?? HOSTED_ENV,
    isPaused: () => false,
    accountEmail: async (userId: string) => `${userId}@account.example`,
  });
  Object.assign(problemReportDeps, {
    fetch: network.fetch,
    release: async () => '0.3.0-preview.152',
    newId: () => '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    now: () => Date.parse('2026-11-25T10:00:00.000Z'),
  });
  const routes = createSupportRoutes(options.limits);
  // Stands in for the session middleware: the signed-in person, as the session states them.
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    const id = c.req.header('x-test-user');
    const role = c.req.header('x-test-role') as Role | undefined;
    if (!id) return c.json({ error: 'Unauthorized', code: 'NO_TOKEN' }, 401);
    c.set('user', { id, email: `${id}@token.example`, org_id: 'org-1', sid: `sid-${id}`, role });
    return next();
  });
  app.route('/api/support', routes);
  const send = (user: { id: string; role?: Role } | null, body: Record<string, unknown> = {}) => app.request('/api/support/report', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': CHROME_UA,
      ...(user ? { 'x-test-user': user.id, ...(user.role ? { 'x-test-role': user.role } : {}) } : {}),
    },
    body: JSON.stringify({ category: 'bug', text: 'The board will not load.', email_me: true, page: '/tasks/abc123', ...body }),
  });
  return { app, network, send };
}

test('every signed-in role can report, and the report carries that role', async () => {
  const { network, send } = setup();
  for (const role of ['owner', 'admin', 'member', 'guest'] as const) {
    const res = await send({ id: `user-${role}`, role });
    assert.equal(res.status, 201, role);
    assert.deepEqual(await res.json(), { reference: '3F2B1C4D' });
  }
  assert.deepEqual(network.sent.map((request) => (request.body as { role: string }).role), ['owner', 'admin', 'member', 'guest']);
});

test('the report is exactly the contract: the control plane, the seat token, and only these fields', async () => {
  const { network, send } = setup();
  const res = await send({ id: 'user-1', role: 'member' }, {
    category: 'confusing',
    text: '  I cannot find where to change my status.\u0000  ',
    request_ids: ['7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', 'not-an-id', '7F1C2A3B-4D5E-4F60-8A7B-9C0D1E2F3A4B'],
    page: '/settings/profile?tab=status#x',
    reply_email: 'someone-else@example.com',
  });
  assert.equal(res.status, 201);
  const [request] = network.sent;
  assert.equal(request!.url, `${CONTROL_PLANE}/v1/cells/telemetry/reports`);
  assert.equal(new Headers(request!.init.headers).get('authorization'), `Bearer ${FETCH_TOKEN}`);
  assert.deepEqual(request!.body, {
    cell_id: CELL_ID,
    release: '0.3.0-preview.152',
    report_id: '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    role: 'member',
    category: 'confusing',
    text: 'I cannot find where to change my status.',
    route: '/settings/profile',
    client: 'Chrome 131',
    request_ids: ['7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'],
    // From the account, not the form's reply_email.
    reply_email: 'user-1@account.example',
    created_at: '2026-11-25T10:00:00.000Z',
  });
});

test('no reply address unless the person ticks the box', async () => {
  const { network, send } = setup();
  assert.equal((await send({ id: 'user-1', role: 'guest' }, { email_me: false })).status, 201);
  assert.equal((network.sent[0]!.body as { reply_email: unknown }).reply_email, null);
});

test('no session, no report; a session without a role, no report', async () => {
  const { network, send } = setup();
  assert.equal((await send(null)).status, 401);
  assert.equal((await send({ id: 'user-1' })).status, 403);
  assert.equal(network.sent.length, 0);
});

test('reports are limited per person and per client address', async () => {
  const { send } = setup({ limits: { perPerson: 2, perAddress: 3 } });
  const statuses = async (id: string, n: number) => {
    const out: number[] = [];
    for (let i = 0; i < n; i += 1) out.push((await send({ id, role: 'member' })).status);
    return out;
  };
  assert.deepEqual(await statuses('person-a', 3), [201, 201, 429]);
  // A second person from the same address gets what is left of the address's three.
  assert.deepEqual(await statuses('person-b', 2), [201, 429]);
  const refused = await send({ id: 'person-c', role: 'guest' });
  assert.equal(refused.status, 429);
  assert.equal((await refused.json() as { code: string }).code, 'RATE_LIMITED');
});

test('the person is told when the control plane does not take the report', async () => {
  for (const status of [500, 429, 'throw'] as const) {
    const { send } = setup({ status });
    const res = await send({ id: 'user-1', role: 'member' });
    assert.equal(res.status, 503, String(status));
    assert.equal((await res.json() as { code: string }).code, 'REPORT_NOT_SENT');
  }
});

test('bad input is refused before anything is sent', async () => {
  const { network, send } = setup();
  assert.equal((await send({ id: 'u', role: 'member' }, { category: 'feature-request' })).status, 400);
  assert.equal((await send({ id: 'u', role: 'member' }, { text: '   ' })).status, 400);
  assert.equal((await send({ id: 'u', role: 'member' }, { text: 'x'.repeat(4_500) })).status, 400);
  assert.equal(network.sent.length, 0);
});

test('self-hosted Deft never sends a report; its menu shows the administrator\'s own address when set', async () => {
  const selfHosted = setup({ env: { ...SELF_HOSTED_ENV, DEFT_SUPPORT_EMAIL: 'it-help@example.test' } });
  const res = await selfHosted.send({ id: 'user-1', role: 'owner' });
  assert.equal(res.status, 404);
  assert.equal((await res.json() as { code: string }).code, 'NOT_AVAILABLE');
  assert.equal(selfHosted.network.sent.length, 0);
  const config = await selfHosted.app.request('/api/support/config', { headers: { 'x-test-user': 'user-1', 'x-test-role': 'guest' } });
  assert.deepEqual(await config.json(), { report: false, contact_email: 'it-help@example.test' });

  const plain = setup({ env: SELF_HOSTED_ENV });
  const none = await plain.app.request('/api/support/config', { headers: { 'x-test-user': 'user-1', 'x-test-role': 'member' } });
  assert.deepEqual(await none.json(), { report: false, contact_email: null });

  const hosted = setup();
  const offered = await hosted.app.request('/api/support/config', { headers: { 'x-test-user': 'user-1', 'x-test-role': 'guest' } });
  assert.deepEqual(await offered.json(), { report: true, contact_email: null });
});

test('a paused start sends no report', async () => {
  const { network, send } = setup();
  supportDeps.isPaused = () => true;
  assert.equal((await send({ id: 'user-1', role: 'owner' })).status, 404);
  assert.equal(network.sent.length, 0);
});
