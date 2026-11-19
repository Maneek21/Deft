import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { orgRoutes } from '../src/routes/org.js';
import { closeDb } from '../src/lib/db.js';
import { getReasonProviderReadiness, hasAnyAIProvider, resolveReasonProvider } from '../src/lib/org-ai-config.js';
import { embed, getEmbedConfigMasked } from '../src/lib/embed.js';

// run-api-tests only sets DATABASE_URL from DEFT_TEST_DATABASE_URL (a disposable database).
const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
after(closeDb);

async function withOrg(fn: (ctx: { orgId: string; client: pg.Client; put: (body: unknown) => Promise<Response> }) => Promise<void>) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const orgId = `hosted-ai-${randomUUID()}`;
  const ownerId = randomUUID();
  try {
    await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)', [orgId]);
    await client.query('INSERT INTO users (id, name, email) VALUES ($1, $1, $2)', [ownerId, `${ownerId}@example.test`]);
    await client.query('INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1,$2,$3,$4)', [randomUUID(), orgId, ownerId, 'owner']);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('user', { id: ownerId, org_id: orgId, role: 'owner', email: `${ownerId}@example.test`, name: ownerId });
      await next();
    });
    app.route('/api/org', orgRoutes);
    const put = (body: unknown) => Promise.resolve(app.request('/api/org/ai-config', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    await fn({ orgId, client, put });
  } finally {
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=$1', [ownerId]);
    await client.end();
  }
}

function setHosted(t: test.TestContext, on: boolean) {
  const old = process.env.DEFT_HOSTED;
  if (on) process.env.DEFT_HOSTED = 'true'; else delete process.env.DEFT_HOSTED;
  t.after(() => { if (old === undefined) delete process.env.DEFT_HOSTED; else process.env.DEFT_HOSTED = old; });
}

const customRoute = { provider: 'openai', model: 'gpt-4o', baseUrl: 'http://10.0.0.5/v1' };

test('hosted: saving a custom AI address or an Ollama address is refused and nothing is written', { skip: !databaseUrl }, async (t) => {
  setHosted(t, true);
  await withOrg(async ({ orgId, client, put }) => {
    for (const body of [
      { ollama_url: 'http://10.0.0.5:11434' },
      { ai_models: { reason: customRoute } },
      { ai_models: { extract: { provider: 'ollama', model: 'llama3.1' } } },
      { embed: { provider: 'openai', base_url: 'http://10.0.0.5/v1' } },
      // A refused address anywhere refuses the whole request, before any write.
      { api_keys: { openai: 'sk-test' }, ai_models: { classify: customRoute } },
    ]) {
      const res = await put(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      const json = await res.json();
      assert.equal(json.code, 'HOSTED_CUSTOM_AI_ADDRESS_REFUSED');
      assert.equal(typeof json.error, 'string');
    }
    const { rows } = await client.query('SELECT ai_config FROM orgs WHERE id=$1', [orgId]);
    assert.deepEqual(rows[0].ai_config ?? {}, {});

    // Standard providers and the standard embedding address still save.
    const ok = await put({ api_keys: { openai: 'sk-test' }, ai_models: { reason: { provider: 'openai', model: 'gpt-4o' } },
      embed: { provider: 'openai', base_url: 'https://api.openai.com/v1' }, ollama_url: null });
    assert.equal(ok.status, 200);
    const resolved = await resolveReasonProvider(orgId);
    assert.deepEqual([resolved.provider, resolved.baseUrl, resolved.apiKey], ['openai', 'https://api.openai.com/v1', 'sk-test']);
    assert.equal((await getReasonProviderReadiness(orgId)).ready, true);
  });
});

test('hosted: an address already stored (or restored) is never used', { skip: !databaseUrl }, async (t) => {
  setHosted(t, true);
  await withOrg(async ({ orgId, client }) => {
    await client.query('UPDATE orgs SET ai_config=$2 WHERE id=$1', [orgId, JSON.stringify({
      ai_models: { reason: { provider: 'ollama', model: 'llama3.1' } },
      ollama_url: 'http://10.0.0.5:11434',
      embed: { provider: 'openai', base_url: 'http://10.0.0.5/v1' },
    })]);
    const resolved = await resolveReasonProvider(orgId);
    assert.notEqual(resolved.provider, 'ollama');
    assert.equal(resolved.baseUrl, undefined);
    assert.equal(resolved.apiKey, '');
    const readiness = await getReasonProviderReadiness(orgId);
    assert.equal(readiness.ready, false);
    assert.match(readiness.reason ?? '', /hosted Deft/);
    assert.equal(await hasAnyAIProvider(orgId), Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY));
    assert.equal((await getEmbedConfigMasked(orgId)).provider, 'off');
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
    assert.equal(await embed('hello', orgId), null);
  });
});

test('self-hosted: custom and Ollama addresses save and are used exactly as before', { skip: !databaseUrl }, async (t) => {
  setHosted(t, false);
  await withOrg(async ({ orgId, put }) => {
    const res = await put({ ai_models: { reason: customRoute }, ollama_url: 'http://10.0.0.5:11434',
      embed: { provider: 'openai', base_url: 'http://10.0.0.5/v1' } });
    assert.equal(res.status, 200);
    const resolved = await resolveReasonProvider(orgId);
    assert.equal(resolved.baseUrl, customRoute.baseUrl);
    assert.equal(await hasAnyAIProvider(orgId), true);
    const embedCfg = await getEmbedConfigMasked(orgId);
    assert.deepEqual([embedCfg.provider, embedCfg.base_url], ['openai', 'http://10.0.0.5/v1']);
    const urls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: unknown) => {
      urls.push(String(input));
      return Response.json({ data: [{ embedding: new Array(1536).fill(0) }] });
    });
    assert.equal((await embed('hello', orgId))?.length, 1536);
    assert.deepEqual(urls, ['http://10.0.0.5/v1/embeddings']);
  });
});

test('hosted: local transcription cannot be saved; an unknown stored provider does not break the settings page', { skip: !databaseUrl }, async (t) => {
  setHosted(t, true);
  await withOrg(async ({ orgId, client, put }) => {
    const refused = await put({ transcription: { provider: 'local' } });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).code, 'HOSTED_CUSTOM_AI_ADDRESS_REFUSED');
    assert.equal((await put({ transcription: { provider: 'deepgram' } })).status, 200);
    await client.query('UPDATE orgs SET ai_config=$2 WHERE id=$1', [orgId, JSON.stringify({
      ai_models: { reason: { provider: 'azure', model: 'x', baseUrl: 'http://10.0.0.5' } },
      transcription: { provider: 'local' },
    })]);
    // The settings page is read by someone who can change it (check 12.5.4).
    const { rows: [owner] } = await client.query("SELECT user_id FROM org_members WHERE org_id=$1 AND role='owner'", [orgId]);
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user', { id: owner.user_id, org_id: orgId } as never); await next(); });
    app.route('/api/org', orgRoutes);
    const res = await app.request('/api/org/ai-config');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.hosted, true);
    assert.equal(body.reason_provider.ready, false);
    assert.notEqual(body.transcription.effective, 'local');
    assert.equal((await resolveReasonProvider(orgId)).apiKey, '');
  });
});

test('self-hosted: local transcription still saves and is reported in use', { skip: !databaseUrl }, async (t) => {
  setHosted(t, false);
  await withOrg(async ({ put }) => {
    const res = await put({ transcription: { provider: 'local' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual([body.transcription.effective, body.hosted], ['local', false]);
  });
});

test('hosted: embeddings fetch the standard address the rule returns, not the stored spelling', { skip: !databaseUrl }, async (t) => {
  setHosted(t, true);
  await withOrg(async ({ orgId, client }) => {
    await client.query('UPDATE orgs SET ai_config=$2 WHERE id=$1', [orgId, JSON.stringify({
      embed: { provider: 'openai', base_url: 'HTTPS://API.OPENAI.COM/v1/' },
    })]);
    const { env } = await import('../src/lib/env.js');
    const target = env as unknown as Record<string, unknown>;
    const oldKey = target.OPENAI_API_KEY;
    target.OPENAI_API_KEY = 'k';
    t.after(() => { target.OPENAI_API_KEY = oldKey; });
    const urls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: unknown) => {
      urls.push(String(input));
      return Response.json({ data: [{ embedding: new Array(1536).fill(0) }] });
    });
    assert.equal((await embed('hello', orgId))?.length, 1536);
    assert.deepEqual(urls, ['https://api.openai.com/v1/embeddings']);
  });
});
