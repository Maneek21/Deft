/**
 * The install ping, through the real signup and invite routes (telemetry
 * contract, section 3): sent once, at the moment it describes, and never
 * twice for one event.
 *
 * - The first owner's signup sends `installed`, once. A second signup (refused:
 *   one workspace per install) and a sign-in send nothing.
 * - Each accepted invite sends `person_added`, once, guests included. The same
 *   invite accepted again (refused) sends nothing; creating an invite sends
 *   nothing until it is accepted.
 * - Both carry the same install_id, made from the install's workspace.
 * - With DEFT_TELEMETRY=off, or in hosted mode, the same steps send nothing.
 *
 * Like signup-first-workspace-db.test.ts, this process gets empty copies of
 * the tables these routes write, in a throwaway schema first on its search
 * path, because signup only creates a workspace on an install with none.
 *
 * Run: pnpm --filter @deft/api test test/install-ping-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';
import { ensureTwoStepTables } from './fixtures/two-step-tables.js';
import { SELF_HOSTED_ENV, recordingFetch } from './fixtures/telemetry.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  if (!target || target !== process.env.DATABASE_URL) return false;
  try {
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.search && !url.hash;
  } catch { return false; }
})();

const TABLES = [
  'users', 'orgs', 'org_members', 'spaces', 'space_members', 'onboarding_state', 'invites', 'web_sessions',
  'revoked_tokens', 'user_two_step', 'two_step_challenges', 'org_member_privilege_history',
];

test('install ping: once per event through signup and invite acceptance', { skip: !safe, timeout: 180_000 }, async (t) => {
  const schema = `install_ping_${randomUUID().replaceAll('-', '')}`;
  await ensureTwoStepTables(target!);
  const admin = new pg.Pool({ connectionString: target, max: 1 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  for (const table of TABLES) {
    await admin.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  const savedOptions = process.env.PGOPTIONS;
  process.env.PGOPTIONS = `-c search_path=${schema},public`;

  const { authRoutes } = await import('../src/routes/auth.js');
  const { inviteRoutes } = await import('../src/routes/invites.js');
  const { memberRoutes } = await import('../src/routes/members.js');
  const { authMiddleware } = await import('../src/middleware/auth.js');
  const { closeDb } = await import('../src/lib/db.js');
  const { installIdFromWorkspaceId, installPingDeps } = await import('../src/lib/telemetry/install-ping.js');
  const savedDeps = { ...installPingDeps };

  const app = new Hono();
  app.route('/api/auth', authRoutes);
  app.route('/api/invites', inviteRoutes);
  app.use('/api/*', authMiddleware);
  app.route('/api/members', memberRoutes);

  t.after(async () => {
    Object.assign(installPingDeps, savedDeps);
    await closeDb();
    if (savedOptions === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = savedOptions;
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  async function freshInstall(env: NodeJS.ProcessEnv) {
    await admin.query(`TRUNCATE ${TABLES.map((table) => `"${schema}".${table}`).join(', ')}`);
    const network = recordingFetch(202);
    Object.assign(installPingDeps, { env, fetch: network.fetch, version: async () => '0.3.0-preview.152', isPaused: () => false });
    return network;
  }
  /** The pings are not awaited by the routes: let the one in flight finish. */
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 10)); };
  const json = (body: unknown, token?: string) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const owner = { name: 'Owner', email: `owner-${schema}@ping.test`, password: 'correct-horse-battery-staple', org_name: 'Ping Workspace' };
  async function signup(body = owner) {
    const res = await app.request('/api/auth/signup', json(body));
    return { status: res.status, body: await res.json() as Record<string, any> };
  }
  async function invite(token: string, email: string, role: 'member' | 'guest') {
    const res = await app.request('/api/members/invite', json({ email, role }, token));
    const body = await res.json() as { invite_url?: string; error?: string };
    assert.equal(res.status, 201, JSON.stringify(body));
    return new URLSearchParams(new URL(body.invite_url!).hash.slice(1)).get('token')!;
  }
  const accept = (token: string) => app.request('/api/invites/accept', json({ token, password: 'another-long-password-2026', name: 'Joiner' }));
  const events = (network: ReturnType<typeof recordingFetch>) => network.sent.map((request) => (request.body as { event: string }).event);

  await t.test('self-hosted: installed once, person_added once per accepted invite, nothing else', async () => {
    const network = await freshInstall(SELF_HOSTED_ENV);
    const first = await signup();
    assert.equal(first.status, 201, JSON.stringify(first.body));
    await settle();
    assert.deepEqual(events(network), ['installed']);

    // One workspace per install: a second signup is refused and sends nothing.
    assert.equal((await signup({ ...owner, email: `second-${schema}@ping.test` })).status, 403);
    // Signing in sends nothing.
    const login = await app.request('/api/auth/login', json({ email: owner.email, password: owner.password }));
    assert.equal(login.status, 200);
    await settle();
    assert.deepEqual(events(network), ['installed']);

    const session = first.body.accessToken as string;
    assert.ok(session, 'signup issued a session');
    const memberToken = await invite(session, `member-${schema}@ping.test`, 'member');
    const guestToken = await invite(session, `guest-${schema}@ping.test`, 'guest');
    await settle();
    assert.deepEqual(events(network), ['installed'], 'an invite counts only once accepted');

    assert.equal((await accept(memberToken)).status, 200);
    await settle();
    assert.deepEqual(events(network), ['installed', 'person_added']);
    // The same invite again is refused: no second ping.
    assert.equal((await accept(memberToken)).status, 400);
    // A guest is a person too.
    assert.equal((await accept(guestToken)).status, 200);
    await settle();
    assert.deepEqual(events(network), ['installed', 'person_added', 'person_added']);

    const workspaceId = first.body.org.id as string;
    const ids = new Set(network.sent.map((request) => (request.body as { install_id: string }).install_id));
    assert.deepEqual([...ids], [installIdFromWorkspaceId(workspaceId)], 'one install, one install_id');
    for (const request of network.sent) {
      assert.deepEqual(Object.keys(request.body as object).sort(), ['event', 'install_id', 'sent_at', 'version']);
      const wire = String(request.init.body);
      for (const secret of [owner.email, owner.name, owner.org_name, workspaceId, 'member-', 'guest-']) {
        assert.ok(!wire.includes(secret), `${secret} is not in the ping`);
      }
    }
  });

  await t.test('DEFT_TELEMETRY=off: the same steps send nothing', async () => {
    const network = await freshInstall({ ...SELF_HOSTED_ENV, DEFT_TELEMETRY: 'off' });
    const first = await signup();
    assert.equal(first.status, 201);
    const memberToken = await invite(first.body.accessToken as string, `member-${schema}@ping.test`, 'member');
    assert.equal((await accept(memberToken)).status, 200);
    await settle();
    assert.equal(network.sent.length, 0);
  });

  await t.test('has-workspace tells the setup screen whether the ping is on', async () => {
    await freshInstall(SELF_HOSTED_ENV);
    assert.deepEqual(await (await app.request('/api/auth/has-workspace')).json(), { hasWorkspace: false, install_ping: true });
    await freshInstall({ ...SELF_HOSTED_ENV, DEFT_TELEMETRY: 'off' });
    assert.deepEqual(await (await app.request('/api/auth/has-workspace')).json(), { hasWorkspace: false });
  });
});
