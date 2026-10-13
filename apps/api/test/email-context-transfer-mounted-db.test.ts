import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';

const target = 'postgresql://gate_g_test@127.0.0.1:55435/email_stage34_chat_90_fresh';
const safe = process.env.DATABASE_URL === target && process.env.DEFT_TEST_DATABASE_URL === target;

test('actual API index mounts native runtime source-link transfer with real JWT/SID/consent and no provider network',
  { skip: !safe, timeout: 90000 }, async t => {
    Object.assign(process.env, { NODE_ENV: 'test', DEFT_NATIVE_EMAIL_ENABLED: 'true', DEFT_APPS_ENABLED: 'true', DEFT_APP_RUNS_ENABLED: 'true',
      JWT_SECRET: 'synthetic-mounted-access-secret-for-fixture-only', JWT_REFRESH_SECRET: 'synthetic-mounted-refresh-secret-for-fixture-only' });
    process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
      ...Object.fromEntries(['run_encryption', 'receipt_signing', 'fingerprint'].map(purpose => [purpose,
        { current: `mounted-${purpose}`, keys: { [`mounted-${purpose}`]: createHash('sha256').update(`mounted-transfer-fixture-only:${purpose}`).digest('base64') } }])) });
    const [{ db, closeDb }, schema, sessions, runtime, crypto, accounts, orm] = await Promise.all([
      import('../src/lib/db.js'), import('@deft/db/schema'), import('../src/lib/web-sessions.js'),
      import('../src/lib/app-run-runtime.js'), import('../src/lib/email-mailbox-crypto.js'),
      import('../src/lib/email-native-connection-account-store.js'), import('drizzle-orm'),
    ]);
    t.after(closeDb);
    // Use the supported, fully initialized schema90 proof database unchanged.
    const org = randomUUID(), owner = randomUUID(), accountId = `mounted-${randomUUID()}`, logicalId = `mail_${'d'.repeat(64)}`;
    const scope = { org_id: org, owner_user_id: owner, account_id: accountId };
    await db.insert(schema.orgs).values({ id: org, name: 'Mounted M23 synthetic fixture', slug: `mounted-${org}` });
    await db.insert(schema.users).values({ id: owner, name: 'Synthetic mailbox owner', email: `${owner}@example.test` });
    await db.insert(schema.orgMembers).values({ org_id: org, user_id: owner, role: 'owner' });
    const pair = await sessions.createWebSession({ id: owner, org_id: org, email: `${owner}@example.test` });
    const claims = await sessions.verifyWebAccess(pair.accessToken), { keys } = await runtime.getAppRunRuntime();
    const cipher = new crypto.EmailMailboxCrypto(keys);
    const publisher = new accounts.NativeEmailConnectionAccountStore(db, cipher);
    // Trusted fixture enrollment goes through the real native account publisher.
    // OAuth/provider HTTP verification is deliberately outside this mount proof.
    const binding = { scope: { org_id: org, owner_user_id: owner }, account_id: accountId, provider: 'gmail' as const,
      source: 'native_owner_provider_v1' as const, profile_id: 'synthetic-google', profile_revision: 1, module_sha256: 'e'.repeat(64),
      credential_namespace_id: randomUUID(), credential_binding_id: randomUUID(), credential_action_id: null,
      connection_target: 'native-owner-mail', authority_epoch: 1, capabilities: ['read'] as const,
      expected_principal_digest: null, expected_native_revision: null };
    await db.transaction(tx => publisher.publish(tx, { scope: binding.scope, request_id: randomUUID(), request_digest: 'f'.repeat(64),
      session_id: claims.sid, owner_authority_version: 'synthetic-owner', state: 'exchanging', revision: 1, expires_at: Date.now() + 60000, binding },
    { account_id: accountId, provider: 'gmail', principal_digest: 'a'.repeat(64), credential_revision: 1, authority_epoch: 1,
      capabilities: ['read'], primary_address: 'owner@example.test', display_label: 'Synthetic account', verified_sender_identities: [] }, ['read']));
    const context = (kind: 'summary' | 'provider_source') => ({ ...scope, kind, record_id: logicalId, revision: 1 });
    await db.insert(schema.emailMessages).values({ ...scope, logical_message_id: logicalId, revision: 'stable-provider-source', storage_revision: 1,
      sort_at: new Date(), summary_envelope: cipher.seal({ account_id: accountId, logical_message_id: logicalId, provider: 'gmail', subject: 'Private source subject' }, context('summary')),
      source_envelope: cipher.seal({ schema_version: 'deft.email_provider_source.v1', account_id: accountId, logical_message_id: logicalId,
        provider: 'gmail', private_locator: 'synthetic-private-provider-locator' }, context('provider_source')) });
    let providerCalls = 0;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = (async () => { providerCalls++; throw Error('Unexpected provider network in source-link path'); }) as typeof fetch;
    t.after(() => { globalThis.fetch = priorFetch; });
    const { app } = await import('../src/index.js');
    const base = `/api/email/accounts/${accountId}/messages/${logicalId}/context-transfer`;
    const input = { destination: { kind: 'note', visibility: 'private' }, title: 'Mounted source link', mode: 'source_link' };
    const send = (path: string, body: unknown, requestId?: string, token = pair.accessToken) => app.request(path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(requestId ? { 'Idempotency-Key': requestId } : {}) }, body: JSON.stringify(body) });
    const reviewResponse = await send(base + '/review', input); assert.equal(reviewResponse.status, 200, await reviewResponse.clone().text());
    const review = await reviewResponse.json(); assert.equal(review.audience.label, 'Only you');
    const payload = { ...input, source_digest: review.source_digest, review_digest: review.review_digest }, requestId = randomUUID();
    const created = await send(base, payload, requestId); assert.equal(created.status, 201, await created.clone().text());
    const result = await created.json(); assert.ok(result.destination_url.startsWith('/notes?id='));
    assert.equal((await send(base, payload, requestId)).status, 200);
    assert.equal((await send(base, { ...payload, title: 'Different intent' }, requestId)).status, 409);
    const note = await app.request(`/api/daily-notes/${result.destination_id}`, { headers: { Authorization: `Bearer ${pair.accessToken}` } });
    assert.equal(note.status, 200); assert.equal((await note.json()).visibility, 'private');
    const [receipt] = await db.select().from(schema.emailContextTransfers).where(orm.eq(schema.emailContextTransfers.request_id, requestId));
    assert.equal(receipt?.logical_message_id, logicalId); assert.equal(receipt?.destination_id, result.destination_id);
    const spaceId = randomUUID(), sourceSpace = randomUUID();
    await db.insert(schema.spaces).values([{ id: spaceId, org_id: org, name: 'Mounted chosen Chat', created_by: owner },
      { id: sourceSpace, org_id: org, name: 'Existing source Chat', created_by: owner }]);
    await db.insert(schema.spaceMembers).values([spaceId, sourceSpace].map(space_id => ({ space_id, user_id: owner })));
    const chatInput = { destination: { kind: 'chat', space_id: spaceId }, title: 'Mounted source reference', mode: 'source_link' };
    const chatReviewResponse = await send(base + '/review', chatInput); assert.equal(chatReviewResponse.status, 200);
    const chatReview = await chatReviewResponse.json(); assert.equal(chatReview.audience.label, 'Mounted chosen Chat members');
    const chatPayload = { ...chatInput, source_digest: chatReview.source_digest, review_digest: chatReview.review_digest }, chatRequest = randomUUID();
    const chatCreated = await send(base, chatPayload, chatRequest); assert.equal(chatCreated.status, 201, await chatCreated.clone().text());
    const chatResult = await chatCreated.json(), chatUrl = new URL(chatResult.destination_url, 'https://fixture.test');
    assert.equal(chatUrl.pathname, '/chat'); assert.equal(chatUrl.searchParams.get('space'), spaceId);
    assert.equal(chatUrl.searchParams.get('message'), chatResult.destination_id); assert.equal((await send(base, chatPayload, chatRequest)).status, 200);
    const visibleChat = await app.request(`/api/messages/${spaceId}?around=${encodeURIComponent(chatResult.destination_id)}`,
      { headers: { Authorization: `Bearer ${pair.accessToken}` } });
    assert.equal(visibleChat.status, 200);
    assert.ok((await visibleChat.json()).messages.some((message: { id: string }) => message.id === chatResult.destination_id));
    const [original] = await db.insert(schema.messages).values({ org_id: org, space_id: sourceSpace, user_id: owner, content: '<p>Original forwarded context</p>' }).returning();
    const ordinaryForward = await send('/api/messages/forward', { message_id: original!.id, target_space_id: spaceId });
    assert.equal(ordinaryForward.status, 201, await ordinaryForward.clone().text()); const forwarded = await ordinaryForward.json();
    assert.equal(forwarded.space_id, spaceId); assert.ok(forwarded.content.startsWith('<blockquote><p>Original forwarded context</p></blockquote>'));
    assert.equal(forwarded.metadata.forwarded_from.message_id, original!.id);
    await db.delete(schema.spaceMembers).where(orm.and(orm.eq(schema.spaceMembers.space_id, spaceId), orm.eq(schema.spaceMembers.user_id, owner)));
    assert.equal((await send(base, chatPayload, chatRequest)).status, 403, 'receipt replay preserves current Chat destination permissions');
    assert.equal((await send('/api/messages/forward', { message_id: original!.id, target_space_id: spaceId })).status, 403);
    assert.equal(providerCalls, 0);
    await db.update(schema.webSessions).set({ revoked_at: new Date() }).where(orm.eq(schema.webSessions.id, claims.sid));
    assert.equal((await send(base, payload, requestId)).status, 401, 'actual index rejects revoked JWT session before native route');
    const health = await app.request('/health'); assert.equal(health.status, 200); assert.equal((await health.json()).schema_head, '0.3.0-preview.90');
    // Account/consent provenance is retained by native tombstone triggers. Keep
    // the synthetic full-schema fixture for audit in this disposable database.
  });
