import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { orgRoutes } from '../src/routes/org.js';
import { closeDb } from '../src/lib/db.js';
import { resolveReasonProvider } from '../src/lib/org-ai-config.js';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const canRun = Boolean(databaseUrl && /(?:test|ci|acceptance)/i.test(new URL(databaseUrl).pathname));
after(closeDb);

test('AI settings preserve reasoning effort through PUT, GET and runtime resolution', { skip: !canRun }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const orgId = `ai-settings-${randomUUID()}`;
  const ownerId = randomUUID();
  const memberId = randomUUID();
  try {
    await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)', [orgId]);
    for (const [id, role] of [[ownerId, 'owner'], [memberId, 'member']]) {
      await client.query('INSERT INTO users (id, name, email) VALUES ($1, $1, $2)', [id, `${id}@example.test`]);
      await client.query('INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1,$2,$3,$4)', [randomUUID(), orgId, id, role]);
    }
    const appFor = (id: string) => {
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('user', { id, org_id: orgId, role: 'owner', email: `${id}@example.test`, name: id });
        await next();
      });
      app.route('/api/org', orgRoutes);
      return app;
    };
    const app = appFor(ownerId);
    const put = (body: unknown, target = app) => target.request('/api/org/ai-config', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const route = { provider: 'openai', model: 'gpt-5.6-sol', reasoning_effort: 'medium', baseUrl: 'https://example.test/v1' };
    const response = await put({ ai_models: { reason: route } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).ai_models.reason, route);
    assert.deepEqual((await (await app.request('/api/org/ai-config')).json()).ai_models.reason, route);
    const resolved = await resolveReasonProvider(orgId);
    assert.equal(resolved.reasoningEffort, 'medium');
    assert.equal(resolved.baseUrl, route.baseUrl);
    for (const task of ['classify', 'summarize', 'extract']) {
      assert.equal((await put({ ai_models: { [task]: route } })).status, 200);
    }
    assert.deepEqual((await (await put({ ai_models: { classify: null } })).json()).ai_models.reason, route,
      'editing another route preserves the reason route');
    for (const reasoning_effort of ['', ' ', 'bad effort', 'x'.repeat(33), 123]) {
      const invalid = await put({ ai_models: { reason: { ...route, reasoning_effort } } });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).code, 'VALIDATION_ERROR');
    }
    const denied = await put({ ai_models: { reason: null } }, appFor(memberId));
    assert.equal(denied.status, 403, 'stored membership, not the supplied role, controls changes');
    assert.deepEqual((await (await app.request('/api/org/ai-config')).json()).ai_models.reason, route);
    const defaultEffort = { provider: 'openai', model: 'gpt-5.6-sol' };
    assert.deepEqual((await (await put({ ai_models: { reason: defaultEffort } })).json()).ai_models.reason, defaultEffort);
    assert.equal((await resolveReasonProvider(orgId)).reasoningEffort, undefined);
    assert.equal((await (await put({ ai_models: { reason: null } })).json()).ai_models.reason, undefined);
  } finally {
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [[ownerId, memberId]]);
    await client.end();
  }
});

test('12.5.4: only people who can change AI settings see any part of a stored key', { skip: !canRun }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const orgId = `ai-key-view-${randomUUID()}`;
  const people = { owner: randomUUID(), admin: randomUUID(), member: randomUUID(), guest: randomUUID() };
  const key = `sk-ant-test-${randomUUID()}-Z9q4`;
  try {
    await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)', [orgId]);
    for (const [role, id] of Object.entries(people)) {
      await client.query('INSERT INTO users (id, name, email) VALUES ($1, $1, $2)', [id, `${id}@example.test`]);
      await client.query('INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1,$2,$3,$4)', [randomUUID(), orgId, id, role]);
    }
    // Every caller claims to be an owner: only the stored membership counts.
    const appFor = (id: string) => {
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('user', { id, org_id: orgId, role: 'owner', email: `${id}@example.test`, name: id });
        await next();
      });
      app.route('/api/org', orgRoutes);
      return app;
    };
    const saved = await appFor(people.owner).request('/api/org/ai-config', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_keys: { anthropic: key } }),
    });
    assert.equal(saved.status, 200);

    for (const id of [people.member, people.guest]) {
      const response = await appFor(id).request('/api/org/ai-config');
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(!text.includes('Z9q4'), 'no part of the key reaches a member or guest');
      assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['can_manage', 'has_provider', 'has_reason_provider', 'hosted'],
        'a member or guest learns whether AI is usable, and nothing about providers or keys');
      assert.equal(JSON.parse(text).has_provider, true);
      assert.equal(JSON.parse(text).can_manage, false);
    }
    for (const id of [people.owner, people.admin]) {
      const body = await (await appFor(id).request('/api/org/ai-config')).json();
      assert.equal(body.can_manage, true);
      assert.deepEqual(body.api_keys.anthropic, { configured: true, mask: '…Z9q4' }, 'people who can change the key still see its mask');
    }
  } finally {
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(people)]);
    await client.end();
  }
});
