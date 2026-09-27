import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test, { after } from 'node:test';
import { createReviewedResourceSyncFixture } from './fixtures/resource-sync-v5.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = (() => {
  try {
    if (!target || target !== process.env.DATABASE_URL) return false;
    const u = new URL(target);
    return ['postgres:', 'postgresql:'].includes(u.protocol) && u.username === 'gate_g_test' && !u.password
      && u.hostname === '127.0.0.1' && u.port === '55435'
      && /^\/gate_g_20260927_c23_private_defty_test(?:_v[0-9]+)?$/.test(u.pathname) && !u.search && !u.hash;
  } catch { return false; }
})();
Object.assign(process.env, { DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
  DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true', DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED: 'true',
  DEFT_APP_PRIVATE_DEFTY_ENABLED: 'true' });
const ring = (id: string) => ({ current: id, keys: { [id]: createHash('sha256').update(`c23-private-defty:${id}`).digest('base64') } });
process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
  run_encryption: ring('enc'), receipt_signing: ring('sign'), fingerprint: ring('fp') });
after(async () => {
  await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
  await (await import('../src/lib/db.js')).closeDb();
});

function sqlDenial(pattern: RegExp) {
  return (error: unknown) => pattern.test(String((error as { cause?: unknown })?.cause ?? error));
}

async function fixture() {
  const [{ db }, s, { eq, and, sql }, runtimeModule, web, routes, { Hono }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('../src/lib/app-run-runtime.js'), import('../src/lib/web-sessions.js'),
    import('../src/routes/app-private-defty.js'), import('hono'),
  ]);
  const runtime = await runtimeModule.getAppRunRuntime();
  const owned = await createReviewedResourceSyncFixture({ keys: runtime.keys, clock: () => new Date(), descriptor: {
    schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox', runtime_requirement_key: 'provider',
    resource_type: 'email_message', requested_visibility: 'user_private', label_field: 'subject',
    record_schema: { type: 'object', properties: {
      subject: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 10000 },
    }, required: ['subject', 'body'], additionalProperties: false },
  } });
  const [u] = await db.select().from(s.users).where(eq(s.users.id, owned.owner_user_id));
  const owner = await web.createWebSession({ id: u!.id, email: u!.email, org_id: owned.org_id });
  const defty = (await (await import('../src/lib/ensure-defty-membership.js')).ensureDeftyEmployee(owned.org_id)).userId;
  const spaceId = randomUUID();
  await (await import('../src/lib/ensure-agent-conversation-space.js')).ensureAgentConversationSpace({
    orgId: owned.org_id, userId: owned.owner_user_id, agentUserId: defty, conversationId: spaceId, title: 'Private context fixture',
  });
  assert.equal((await runtime.resourceSyncAdmission.admitDue({ org_id: owned.org_id, resource_binding_id: owned.binding_id })).state, 'created');
  const credential = await owned.management.issueOperatorSession(owned.operator_actor, owned.binding_id);
  const identity = { schema_version: 'deft.app_runtime_channel.v2' as const, audience: 'app_resource_sync' as const,
    session_id: credential.session_id, session_token: credential.session_token };
  const claim = await runtime.resourceSyncChannel.claim({ ...identity, max_claims: 1 }); assert.ok(claim);
  const attempt = { ...identity, run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence };
  assert.ok(await runtime.resourceSyncChannel.start(attempt));
  assert.ok(await runtime.resourceSyncChannel.complete({ ...attempt, status: 'returned', provider_succeeded: true,
    page: { schema_version: 'deft.app_sync_page.v1', upserts: [{ id: 'record-1', revision: 'r1',
      data: { subject: 'unselected-private-sentinel', body: 'selected-private-context' } }],
    tombstones: [], next_cursor: null, has_more: false } }));
  const [projection] = await db.select().from(s.appResourceProjections).where(and(eq(s.appResourceProjections.org_id, owned.org_id),
    eq(s.appResourceProjections.resource_binding_id, owned.binding_id))).limit(1);
  let requests = 0;
  let held: (() => Promise<void>) | undefined;
  const captured: unknown[] = [];
  const provider = createServer(async (req, res) => {
    requests++;
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (held) await held();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'private-derived-answer' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert.ok(address && typeof address !== 'string');
  const apiKey = (await import('../src/lib/encryption.js')).encrypt('synthetic-model-key');
  await db.update(s.orgs).set({ ai_config: { api_keys: { openai: apiKey }, ai_models: {
    reason: { provider: 'openai', model: 'gpt-4o-mini', baseUrl: `http://127.0.0.1:${address.port}/v1` },
  } } }).where(eq(s.orgs.id, owned.org_id));
  const app = new Hono(); app.route('/api/apps/private-defty', routes.appPrivateDeftyRoutes);
  const call = async (path: string, method = 'GET', body?: unknown, token = owner.accessToken) => {
    const response = await app.request('http://local.test/api/apps/private-defty' + path, {
      method, headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const reviewInput = { schema_version: 'deft.app_private_defty_review.v1', space_id: spaceId,
    ref: { schema_version: 'deft.resource_ref.v2', provider: { kind: 'app_runtime', provider_instance_id: owned.registration_id },
      resource_type: 'email_message', resource_id: projection!.id }, field_keys: ['body'],
    expires_at: new Date(Date.now() + 600000).toISOString() };
  const accept = async () => {
    const review = await call('/review', 'POST', reviewInput); assert.equal(review.status, 200, JSON.stringify(review.body));
    const accepted = await call('/accept', 'POST', { review_token: review.body.review_token,
      review_digest: review.body.review_digest, accept_access: true }); assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    return accepted.body as { grant_id: string; seal_id: string };
  };
  return { db, s, eq, sql, owned, owner, defty, spaceId, call, accept, reviewInput, captured,
    requests: () => requests, hold: (value: () => Promise<void>) => { held = value; },
    close: () => new Promise<void>(resolve => { provider.closeAllConnections(); provider.close(() => resolve()); }) };
}

test('Actual owner review and Defty model dispatch retain only encrypted canonical messages and replay once', { skip: !safe }, async t => {
  const h = await fixture(); t.after(h.close);
  await h.accept();
  const input = { schema_version: 'deft.app_private_defty_turn.v1', request_id: randomUUID(), prompt: 'Private question' };
  const result = await h.call(`/spaces/${h.spaceId}/turns`, 'POST', input);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.text, 'private-derived-answer'); assert.equal(h.requests(), 1);
  const captured = JSON.stringify(h.captured);
  assert.ok(captured.includes('selected-private-context')); assert.equal(captured.includes('unselected-private-sentinel'), false);
  assert.equal((h.captured[0] as any).tools, undefined);
  const rows = await h.db.execute(h.sql`SELECT content,metadata FROM messages WHERE org_id=${h.owned.org_id} AND space_id=${h.spaceId}`);
  assert.equal(rows.rows.length, 2);
  assert.equal(JSON.stringify(rows.rows).includes('Private question'), false);
  assert.equal(JSON.stringify(rows.rows).includes('private-derived-answer'), false);
  assert.deepEqual(rows.rows.map(row => row.content).sort(), ['[Private context answer]', '[Private context prompt]']);
  const replay = await h.call(`/spaces/${h.spaceId}/turns`, 'POST', input);
  assert.equal(replay.status, 200); assert.equal(replay.body.message_id, result.body.message_id); assert.equal(h.requests(), 1);
  const changed = await h.call(`/spaces/${h.spaceId}/turns`, 'POST', { ...input, prompt: 'Changed question' });
  assert.equal(changed.status, 409); assert.equal(changed.body.code, 'APP_PRIVATE_DEFTY_REQUEST_CONFLICT'); assert.equal(h.requests(), 1);
  const history = await h.call(`/spaces/${h.spaceId}/history`);
  assert.equal(history.status, 200); assert.equal(history.body.turn_requires_reauthorization, true);
  assert.equal(history.body.messages[1].text, 'private-derived-answer');
});

test('Held actual Defty response after owner revocation retains prompt but no assistant or model replay', { skip: !safe }, async t => {
  const h = await fixture(); t.after(h.close);
  const grant = await h.accept();
  let release!: () => void; let observed!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { observed = resolve; });
  h.hold(async () => { observed(); await wait; });
  const input = { schema_version: 'deft.app_private_defty_turn.v1', request_id: randomUUID(), prompt: 'Held private question' };
  const pending = h.call(`/spaces/${h.spaceId}/turns`, 'POST', input);
  await entered;
  assert.equal((await h.call('/grants/' + grant.grant_id, 'DELETE')).status, 200);
  release();
  assert.equal((await pending).status, 404);
  const rows = await h.db.execute(h.sql`SELECT metadata->>'role' AS role FROM messages WHERE org_id=${h.owned.org_id} AND space_id=${h.spaceId}`);
  assert.deepEqual(rows.rows.map(row => row.role), ['user']);
  assert.equal((await h.call(`/spaces/${h.spaceId}/turns`, 'POST', input)).status, 404);
  assert.equal(h.requests(), 1);
  const history = await h.call(`/spaces/${h.spaceId}/history`);
  assert.equal(history.status, 200); assert.equal(history.body.grant_state, 'ended');
  assert.equal(history.body.messages[0].text, input.prompt);
});

test('Private sealed message move/metadata forgery and audience widening deny while safe removal retains key inventory', { skip: !safe }, async t => {
  const h = await fixture(); t.after(h.close);
  await h.accept();
  const input = { schema_version: 'deft.app_private_defty_turn.v1', request_id: randomUUID(), prompt: 'Retained question' };
  const answer = await h.call(`/spaces/${h.spaceId}/turns`, 'POST', input);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const elsewhere = randomUUID();
  await h.db.insert(h.s.spaces).values({ id: elsewhere, org_id: h.owned.org_id, created_by: h.owned.owner_user_id,
    name: 'Unsealed target', type: 'private' });
  await assert.rejects(h.db.execute(h.sql`UPDATE messages SET space_id=${elsewhere},metadata=NULL
    WHERE org_id=${h.owned.org_id} AND id=${answer.body.message_id}`), sqlDenial(/immutable/));
  await assert.rejects(h.db.execute(h.sql`UPDATE messages SET metadata=NULL
    WHERE org_id=${h.owned.org_id} AND id=${answer.body.message_id}`), sqlDenial(/immutable/));
  await assert.rejects(h.db.execute(h.sql`DELETE FROM messages WHERE org_id=${h.owned.org_id}
    AND id=${answer.body.message_id}`), sqlDenial(/cannot be deleted/));
  await assert.rejects(h.db.insert(h.s.spaceMembers).values({ space_id: h.spaceId, user_id: h.owned.operator_user_id }), sqlDenial(/cannot widen/));
  await assert.rejects(h.db.insert(h.s.messages).values({ org_id: h.owned.org_id, space_id: elsewhere,
    user_id: h.owned.owner_user_id, content: 'Forged private message', metadata: { schema_version: 'deft.private_defty_message.v1' } }), sqlDenial(/requires exact sealed Space/));
  await h.db.execute(h.sql`UPDATE messages SET is_deleted=true WHERE org_id=${h.owned.org_id} AND id=${answer.body.message_id}`);
  const refs = await (await import('../src/lib/app-private-defty-key-references.js')).listPrivateDeftyKeyReferences(h.db, h.owned.org_id);
  assert.deepEqual(refs, [{ purpose: 'fingerprint', key_id: 'fp' }, { purpose: 'run_encryption', key_id: 'enc' }]);
  await h.db.execute(h.sql`DELETE FROM space_members WHERE space_id=${h.spaceId} AND user_id=${h.defty}`);
  assert.equal((await h.call(`/spaces/${h.spaceId}/turns`, 'POST', { ...input, request_id: randomUUID() })).status, 404);
  assert.equal(h.requests(), 1);
  assert.equal((await h.call(`/spaces/${h.spaceId}/history`)).status, 200);
});

test('Inactive unhealthy and substituted canonical Defty identities deny before model dispatch', { skip: !safe }, async t => {
  const h = await fixture(); t.after(h.close);
  for (const change of ["is_active=false", "unhealthy=true", "runtime_kind='external'"]) {
    await h.db.execute(h.sql.raw(`UPDATE agent_employees SET ${change} WHERE org_id='${h.owned.org_id}' AND user_id='${h.defty}'`));
    assert.equal((await h.call('/review', 'POST', h.reviewInput)).status, 404);
    assert.equal(h.requests(), 0);
    await h.db.execute(h.sql`UPDATE agent_employees SET is_active=true,unhealthy=false,runtime_kind='defty_system'
      WHERE org_id=${h.owned.org_id} AND user_id=${h.defty}`);
  }
  assert.equal((await h.call('/review', 'POST', h.reviewInput)).status, 200);
});