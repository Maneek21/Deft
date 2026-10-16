import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { z } from 'zod';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  try {
    if (!target || target !== process.env.DATABASE_URL) return false;
    const url = new URL(target);
    return ['postgres:', 'postgresql:'].includes(url.protocol) && url.username === 'gate_g_test' && !url.password
      && url.hostname === '127.0.0.1' && url.port === '55435'
      && url.pathname === '/gate_g_20260927_c22_email7_test_v24' && !url.search && !url.hash;
  } catch { return false; }
})();
const privateFixture = 'C:/Users/Osheen Pradhan/Documents/Codex/2026-09-26/deft-gate-g/checkpoint24/email7/fixture-private.json';
const ownerCache = 'C:/Users/Osheen Pradhan/Documents/Codex/2026-09-26/deft-gate-g/checkpoint23/private-defty/email7-owner-private.json';

test('Retained packed Email7 parent reaches separately reviewed sealed Defty context without custody or action authority',
  { skip: !safe, timeout: 30_000 }, async t => {
    Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
      DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
      DEFT_APP_ATTACHMENT_BROKER_ENABLED: 'true', DEFT_APP_PRIVATE_DEFTY_ENABLED: 'true',
      DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED: 'false' });
    const key = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`email7:${id}`).digest('base64') } });
    process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
      run_encryption: key('email7-enc'), receipt_signing: key('email7-sign'), fingerprint: key('email7-fp') });
    // Private credentials stay in memory; never log/hash/export this file.
    const fixture = z.object({ org_id: z.string().uuid(), owner_user_id: z.string().uuid(),
      installation_id: z.string().uuid(), app_version_id: z.string().uuid(), sync_binding_id: z.string().uuid(),
      owner: z.object({ accessToken: z.string(), refreshToken: z.string() }),
      parent_ref: z.object({ schema_version: z.literal('deft.resource_ref.v2'), resource_type: z.string(),
        resource_id: z.string().uuid(), provider: z.object({ kind: z.literal('app_runtime'), provider_instance_id: z.string().uuid() }) }),
    }).parse(JSON.parse(await readFile(privateFixture, 'utf8')));
    let owner = fixture.owner;
    try {
      const cached = z.strictObject({ org_id: z.string().uuid(), owner_user_id: z.string().uuid(),
        owner: z.object({ accessToken: z.string(), refreshToken: z.string() }) }).parse(JSON.parse(await readFile(ownerCache, 'utf8')));
      assert.equal(cached.org_id, fixture.org_id); assert.equal(cached.owner_user_id, fixture.owner_user_id);
      owner = cached.owner;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let count = 0;
    const captured: unknown[] = [];
    let hold: (() => Promise<void>) | undefined;
    const model = createServer(async (req, res) => {
      count++;
      assert.equal(req.url, '/v1/chat/completions');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (hold) await hold();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Reviewed Email context answer' } }] }));
    });
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
    const address = model.address(); assert.ok(address && typeof address !== 'string');
    const [{ app }, { serve }, { db, closeDb }, { sql }, runtimeModule, identity] = await Promise.all([
      import('../src/index.js'), import('@hono/node-server'), import('../src/lib/db.js'), import('drizzle-orm'),
      import('../src/lib/app-run-runtime.js'), import('../src/lib/ensure-defty-membership.js'),
    ]);
    let server!: ReturnType<typeof serve>;
    const base = await new Promise<string>(resolve => {
      server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => resolve(`http://127.0.0.1:${info.port}`));
    });
    t.after(async () => {
      process.env.DEFT_APP_ATTACHMENT_BROKER_ENABLED = 'true';
      process.env.DEFT_APP_V5_RUNTIME_ACTIONS_ENABLED = 'true';
      model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      await runtimeModule.shutdownAppRunRuntime(); await closeDb();
    });
    async function call(path: string, method = 'GET', body?: unknown) {
      const response = await fetch(base + path, { method,
        headers: { authorization: `Bearer ${owner.accessToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as any };
    }
    const priorSid = z.string().uuid().parse(JSON.parse(Buffer.from(owner.accessToken.split('.')[1]!, 'base64url').toString()).sid);
    const refreshed = await call('/api/auth/refresh', 'POST', { refreshToken: owner.refreshToken });
    assert.equal(refreshed.status, 200, refreshed.body.code);
    owner = z.object({ accessToken: z.string(), refreshToken: z.string() }).parse(refreshed.body);
    const refreshedClaims = await (await import('../src/lib/web-sessions.js')).verifyWebAccess(owner.accessToken);
    assert.equal(refreshedClaims.sid === priorSid, true, 'Normal refresh retains the same exact WebSID');
    assert.equal(refreshedClaims.id === fixture.owner_user_id && refreshedClaims.org_id === fixture.org_id, true);
    await writeFile(ownerCache, JSON.stringify({ org_id: fixture.org_id, owner_user_id: fixture.owner_user_id, owner }), { mode: 0o600 });
    const originalRuns = await db.execute(sql`SELECT id,state FROM app_runs WHERE org_id=${fixture.org_id} ORDER BY id`);
    await identity.ensureDeftyEmployee(fixture.org_id);
    assert.equal((await call('/api/org/ai-config', 'PUT', { api_keys: { openai: 'synthetic-reviewed-model-key' },
      ai_models: { reason: { provider: 'openai', model: 'gpt-4o-mini', baseUrl: `http://127.0.0.1:${address.port}/v1` } } })).status, 200);
    const space = await call('/api/agent/conversations', 'POST', { title: 'Reviewed private Email context' });
    assert.equal(space.status, 201);
    const review = await call('/api/apps/private-defty/review', 'POST', {
      schema_version: 'deft.app_private_defty_review.v1', space_id: space.body.id, ref: fixture.parent_ref,
      field_keys: ['body', 'subject'], expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    assert.equal(review.status, 200, review.body.code);
    assert.deepEqual(review.body.selected_data, { body: 'Private synthetic mail body', subject: 'Saved hostile <script>literal</script> Email' });
    const binding = await db.execute(sql`SELECT descriptor_digest FROM app_resource_bindings WHERE org_id=${fixture.org_id} AND id=${fixture.sync_binding_id}`);
    assert.equal(review.body.snapshot.descriptor_digest, binding.rows[0]!.descriptor_digest);
    const accepted = await call('/api/apps/private-defty/accept', 'POST', {
      review_token: review.body.review_token, review_digest: review.body.review_digest, accept_access: true,
    });
    assert.equal(accepted.status, 201, accepted.body.code);
    const turns = `/api/apps/private-defty/spaces/${space.body.id}/turns`;
    const answer = await call(turns, 'POST', { schema_version: 'deft.app_private_defty_turn.v1', request_id: randomUUID(), prompt: 'Summarize the reviewed Email' });
    assert.equal(answer.status, 200, answer.body.code);
    assert.equal(answer.body.text, 'Reviewed Email context answer');
    const encoded = JSON.stringify(captured);
    assert.ok(encoded.includes('Private synthetic mail body'));
    for (const excluded of ['synthetic-1@example.test', 'text/csv', 'bytes_b64', 'staging_id', 'attachments']) assert.equal(encoded.includes(excluded), false);
    assert.equal((captured[0] as any).tools, undefined); assert.equal(count, 1);
    let release!: () => void; let entered!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const observed = new Promise<void>(resolve => { entered = resolve; });
    hold = async () => { entered(); await wait; };
    const pending = call(turns, 'POST', { schema_version: 'deft.app_private_defty_turn.v1', request_id: randomUUID(), prompt: 'Held Email question' });
    await Promise.race([observed, pending.then(result => {
      throw new Error(`Expected held model request, received HTTP ${result.status}`);
    })]);
    process.env.DEFT_APP_ATTACHMENT_BROKER_ENABLED = 'false'; release();
    const ended = await pending;
    assert.equal(ended.status, 503);
    assert.deepEqual(ended.body, { error: 'Attachment broker unavailable', code: 'APP_FEATURE_DISABLED' });
    const retained = await db.execute(sql`SELECT metadata->>'role' AS role FROM messages WHERE org_id=${fixture.org_id} AND space_id=${space.body.id}`);
    assert.equal(retained.rows.filter(row => row.role === 'user').length, 2);
    assert.equal(retained.rows.filter(row => row.role === 'assistant').length, 1);
    assert.equal(count, 2);
    assert.deepEqual((await db.execute(sql`SELECT id,state FROM app_runs WHERE org_id=${fixture.org_id} ORDER BY id`)).rows, originalRuns.rows);
  });
