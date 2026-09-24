import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { orgMembers, orgs, teams, users, webSessions, wikiPages } from '@deft/db/schema';
import { ResourceResolveResultV2Schema } from '@deft/shared/resources-v2';
import { db } from '../src/lib/db.js';
import { NativeResourceService } from '../src/lib/native-resource-service.js';
import { createWebSession } from '../src/lib/web-sessions.js';
import { authMiddleware } from '../src/middleware/auth.js';
import { resourceRoutes } from '../src/routes/resources.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const safe = Boolean(safeTestDatabaseUrl());
const service = new NativeResourceService();
const ref = (provider: string, type: string, id: string) => ({
  schema_version: 'deft.resource_ref.v2',
  provider: { kind: 'core', provider_instance_id: provider }, resource_type: type, resource_id: id,
});
const sid = (token: string): string => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sid;

test('native resource web resolver binds current session and owner without widening v1 or Runtime access',
  { skip: !safe }, async () => {
    const orgId = randomUUID(); const foreignOrg = randomUUID();
    const ownerId = randomUUID(); const peerId = randomUUID();
    const pageId = randomUUID(); const teamId = randomUUID();
    const ownerEmail = `${ownerId}@example.test`; const peerEmail = `${peerId}@example.test`;
    const pageRef = ref('wiki_pages', 'wiki_page', pageId);
    const app = new Hono();
    app.use('/api/*', authMiddleware); app.route('/api/resources', resourceRoutes);
    try {
      await db.insert(orgs).values([orgId, foreignOrg].map(id => ({ id, name: 'Native resource fixture', slug: id })));
      await db.insert(users).values([
        { id: ownerId, name: 'Owner', email: ownerEmail },
        { id: peerId, name: 'Peer', email: peerEmail },
      ]);
      await db.insert(orgMembers).values([ownerId, peerId].map(userId => ({
        id: randomUUID(), org_id: orgId, user_id: userId, role: 'member' as const,
      })));
      await db.insert(wikiPages).values({ id: pageId, org_id: orgId, user_id: ownerId,
        scope: 'user', type: 'fact', slug: pageId, title: ` \n${'😀'.repeat(130)}\t `,
        content: 'PRIVATE BODY MUST NEVER BE PROJECTED' });
      await db.insert(teams).values({ id: teamId, org_id: orgId, name: 'Private team',
        handle: teamId, visibility: 'private', lead_user_id: ownerId });
      const ownerToken = (await createWebSession({ id: ownerId, org_id: orgId, email: ownerEmail })).accessToken;
      const peerToken = (await createWebSession({ id: peerId, org_id: orgId, email: peerEmail })).accessToken;
      const caller = { org_id: orgId, user_id: ownerId, sid: sid(ownerToken) };
      const peer = { org_id: orgId, user_id: peerId, sid: sid(peerToken) };
      const request = (value: unknown, token: string | undefined = ownerToken, suffix = '') => app.request(
        `/api/resources/resolve?ref=${encodeURIComponent(JSON.stringify(value))}${suffix}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} });

      const response = await request(pageRef);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const available = ResourceResolveResultV2Schema.parse(await response.json());
      assert.equal(available.state, 'available');
      if (available.state !== 'available') throw new Error('Expected authorized projection');
      assert.equal(available.resource.label, '😀'.repeat(100));
      assert.equal(JSON.stringify(available).includes('PRIVATE BODY'), false);
      assert.equal('href' in available.resource, false);
      const unavailable = await service.resolve(peer, pageRef);
      assert.deepEqual(unavailable, { schema_version: 'deft.resource_resolve.v2', ref: pageRef, state: 'unavailable' });
      assert.equal((await service.resolve(caller, ref('wiki_pages', 'wiki_page', randomUUID()))).state, 'unavailable');
      await assert.rejects(service.resolve({ ...caller, user_id: peerId }, pageRef), { code: 'RESOURCE_ACCESS_DENIED' });
      await assert.rejects(service.resolve({ ...caller, org_id: foreignOrg }, pageRef), { code: 'RESOURCE_ACCESS_DENIED' });
      await assert.rejects(service.resolve({ ...caller, sid: randomUUID() }, pageRef), { code: 'RESOURCE_ACCESS_DENIED' });
      assert.equal((await request({ ...pageRef, org_id: orgId })).status, 400);
      assert.equal((await request(ref('wiki_pages', 'message', pageId))).status, 400);
      assert.equal((await request({ ...pageRef, schema_version: 'deft.resource_ref.v1' })).status, 400);
      assert.equal((await request(pageRef, ownerToken, '&actor_id=forged')).status, 400);
      assert.equal((await request(pageRef, ownerToken, '&ref={}')).status, 400);
      assert.equal((await request('x'.repeat(2_049))).status, 400);
      const anonymous = await app.request(`/api/resources/resolve?ref=${encodeURIComponent(JSON.stringify(pageRef))}`);
      assert.equal(anonymous.status, 401);

      const runtimeRef = { ...pageRef, provider: { kind: 'app_runtime', provider_instance_id: 'operator_binding' },
        resource_type: 'mail_thread' };
      assert.deepEqual(await service.resolve(caller, runtimeRef), {
        schema_version: 'deft.resource_resolve.v2', ref: runtimeRef, state: 'unavailable',
      });

      // Current DB role, rather than a cached caller/token role, controls private teams.
      const teamRef = ref('teams', 'team', teamId);
      assert.equal((await service.resolve(peer, teamRef)).state, 'unavailable');
      await db.update(orgMembers).set({ role: 'admin' }).where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, peerId)));
      assert.equal((await service.resolve(peer, teamRef)).state, 'available');
      await db.update(orgMembers).set({ role: 'member' }).where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, peerId)));
      assert.equal((await service.resolve(peer, teamRef)).state, 'unavailable');

      // Exercise the real production mount in separate processes for both feature states.
      const script = `import { app } from './src/index.ts';
        import { serve } from '@hono/node-server';
        import { closeDb } from './src/lib/db.ts';
        const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
        await new Promise(resolve => server.on('listening', resolve));
        const url = 'http://127.0.0.1:' + server.address().port + process.env.NATIVE_TEST_PATH;
        const anonymous = await fetch(url);
        await anonymous.arrayBuffer();
        const response = await fetch(url, {
          headers: { Authorization: 'Bearer ' + process.env.NATIVE_TEST_TOKEN }
        });
        const body = await response.text();
        console.log('NATIVE_RESULT:' + JSON.stringify({ status: response.status,
          anonymous: anonymous.status, leakedBody: body.includes('PRIVATE BODY'),
          cache: response.headers.get('cache-control') }));
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await closeDb();`;
      for (const enabled of [false, true]) {
        const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
          cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 60_000,
          env: { ...process.env, DEFT_APPS_ENABLED: String(enabled), DEFT_APP_RUNS_ENABLED: 'false',
            DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'false', DEFT_APP_AUTOMATIONS_ENABLED: 'false',
            DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED: 'false', DEFT_APP_RUNTIME_CHANNEL_ENABLED: 'false',
            DEFT_APP_PUBLIC_INGRESS_ENABLED: 'false', NATIVE_TEST_TOKEN: ownerToken,
            NATIVE_TEST_PATH: `/api/resources/resolve?ref=${encodeURIComponent(JSON.stringify(pageRef))}` },
        });
        const line = output.split(/\r?\n/).find(value => value.startsWith('NATIVE_RESULT:'));
        assert.ok(line);
        const result = JSON.parse(line.slice('NATIVE_RESULT:'.length));
        assert.equal(result.status, enabled ? 200 : 404);
        assert.equal(result.anonymous, 401);
        assert.equal(result.leakedBody, false);
        if (enabled) assert.equal(result.cache, 'no-store');
      }

      await db.update(orgMembers).set({ is_active: false }).where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, ownerId)));
      await assert.rejects(service.resolve(caller, pageRef), { code: 'RESOURCE_ACCESS_DENIED' });
      await db.update(orgMembers).set({ is_active: true }).where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, ownerId)));
      await db.update(webSessions).set({ expires_at: new Date(0) }).where(eq(webSessions.id, caller.sid));
      await assert.rejects(service.resolve(caller, pageRef), { code: 'RESOURCE_ACCESS_DENIED' });
      await db.update(webSessions).set({ expires_at: new Date(Date.now() + 60_000), revoked_at: new Date() })
        .where(eq(webSessions.id, caller.sid));
      await assert.rejects(service.resolve(caller, pageRef), { code: 'RESOURCE_ACCESS_DENIED' });
      assert.equal((await request(pageRef)).status, 401);
    } finally {
      await db.delete(webSessions).where(eq(webSessions.org_id, orgId));
      await db.delete(wikiPages).where(eq(wikiPages.org_id, orgId));
      await db.delete(teams).where(eq(teams.org_id, orgId));
      await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
      await db.delete(users).where(inArray(users.id, [ownerId, peerId]));
      await db.delete(orgs).where(inArray(orgs.id, [orgId, foreignOrg]));
    }
  });
