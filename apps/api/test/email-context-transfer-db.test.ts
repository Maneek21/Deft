import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import * as schema from '@deft/db/schema';
import { emailContextTransfers } from '../../../packages/db/src/email-context-transfer-schema.js';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { PostgresEmailMailboxStore } from '../src/lib/email-mailbox-store.js';
import { PostgresEmailAccountConsentStore } from '../src/lib/email-account-consent-store.js';
import { PostgresEmailAccountAuthority } from '../src/lib/email-account-authority.js';
import { planEmailAccountAdoption } from '../src/lib/email-account-lifecycle.js';
import { EmailMessageContentService } from '../src/lib/email-message-content.js';
import { EmailContextTransferService, createPostgresEmailTransferSource } from '../src/lib/email-context-transfer.js';
import { createEmailContextTransferRoutes } from '../src/routes/email-context-transfer.js';
import type { NativeEmailPresentation } from '../src/lib/app-connection-contract.js';

const target = 'postgresql://gate_g_test@127.0.0.1:55435/email_stage34_transfers_89';
const safe = process.env.DATABASE_URL === target && process.env.DEFT_TEST_DATABASE_URL === target;

test('Email context transfer uses real PG, native SID/consent source authorization and shared Notes/Knowledge creation',
  { skip: !safe, timeout: 60000 }, async t => {
    const admin = new pg.Pool({ connectionString: target });
    const namespace = 'email_transfer_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    const pool = new pg.Pool({ connectionString: target, options: `-c search_path=${namespace},public`, max: 8 });
    t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${namespace}" CASCADE`); await admin.end(); });
    // LIKE retains real columns, defaults, checks and unique indexes. Foreign
    // App registry graphs and provider HTTP custody are not this fixture's proof.
    for (const table of ['orgs', 'users', 'org_members', 'web_sessions', 'email_accounts', 'email_account_consents',
      'email_messages', 'email_memberships', 'email_checkpoints', 'spaces', 'space_members', 'notes', 'wiki_pages', 'messages', 'app_private_defty_seals']) {
      await pool.query(`CREATE TABLE ${table}(LIKE public.${table} INCLUDING ALL)`);
    }
    const migration = readFileSync(new URL('../../../packages/db/upgrades/0.3.0-preview.89-email-context-transfers.sql', import.meta.url), 'utf8');
    await pool.query(migration); await pool.query(migration);
    const chatMigration = readFileSync(new URL('../../../packages/db/upgrades/0.3.0-preview.90-email-context-transfer-chat.sql', import.meta.url), 'utf8');
    await pool.query(chatMigration); await pool.query(chatMigration);
    const database = drizzle(pool, { schema: { ...schema, emailContextTransfers } });
    const org = randomUUID(), owner = randomUUID(), peer = randomUUID(), outsider = randomUUID(), spaceId = randomUUID(), bindingId = randomUUID();
    const scope = { org_id: org, owner_user_id: owner, account_id: 'synthetic-transfer-account' };
    const actor = { user_id: owner, web_session_id: randomUUID(), access_expires_at: Date.now() + 3600000 };
    const logicalId = `mail_${'a'.repeat(64)}`, principal = 'b'.repeat(64);
    await database.insert(schema.orgs).values({ id: org, name: 'Transfer fixture', slug: `transfer-${org}` });
    await database.insert(schema.users).values([{ id: owner, name: 'Mailbox owner' }, { id: peer, name: 'Space peer' }, { id: outsider, name: 'Other member' }]);
    await database.insert(schema.orgMembers).values([owner, peer, outsider].map(user_id => ({ org_id: org, user_id })));
    await database.insert(schema.webSessions).values({ id: actor.web_session_id, org_id: org, user_id: owner,
      refresh_token_hash: 'synthetic-only', expires_at: new Date(actor.access_expires_at) });
    await database.insert(schema.spaces).values({ id: spaceId, org_id: org, name: 'Chosen team', created_by: owner });
    await database.insert(schema.spaceMembers).values([owner, peer].map(user_id => ({ space_id: spaceId, user_id })));
    await database.insert(schema.emailAccounts).values({ ...scope, provider: 'gmail', resource_binding_id: bindingId,
      principal_digest: principal, state: 'active', authority_revision: 1, consented_at: new Date() });
    const cipher = new EmailMailboxCrypto({ current: () => ({ key_id: 'transfer-fixture', key: Buffer.alloc(32, 71) }),
      read: (_purpose, key) => key === 'transfer-fixture' ? { key_id: key, key: Buffer.alloc(32, 71) } : null, keyIds: () => ['transfer-fixture'] });
    const consent = new PostgresEmailAccountConsentStore(database as never, cipher);
    await consent.commit(planEmailAccountAdoption({ scope, provider: 'gmail', principal_digest: principal, native_revision: 1,
      consent_revision: 0, credential_revision: 1, health: 'connected', available_capabilities: ['read'],
      bridge: { kind: 'retained_registry_v1', module_sha256: 'c'.repeat(64), pins: { org_id: org, owner_user_id: owner,
        installation_id: randomUUID(), app_version_id: randomUUID(), grant_snapshot_id: randomUUID(), target_key: 'email', resource_key: 'inbox',
        resource_binding_id: bindingId, action_key: 'read', action_binding_id: randomUUID() } } }, ['read'], Date.now()), async () => undefined);
    const context = (kind: 'summary' | 'provider_source') => ({ ...scope, kind, record_id: logicalId, revision: 1 });
    await database.insert(schema.emailMessages).values({ ...scope, logical_message_id: logicalId, revision: 'source-v1', storage_revision: 1,
      sort_at: new Date(), summary_envelope: cipher.seal({ subject: 'Synthetic subject' }, context('summary')),
      source_envelope: cipher.seal({ schema_version: 'deft.email_provider_source.v1', account_id: scope.account_id, logical_message_id: logicalId,
        provider: 'gmail', private_locator: 'synthetic-private-locator' }, context('provider_source')) });
    const authority = new PostgresEmailAccountAuthority(database as never, consent);
    const store = new PostgresEmailMailboxStore(database as never, cipher);
    let providerCalls = 0, providerDigest = createHash('sha256').update('synthetic-MIME-v1').digest('hex');
    const plain = 'Selected sentence <script>alert(1)</script>.\nQuoted @agent <@fixture-agent|Defty> [[file:private-id:secret]] text.\nHidden remainder and private details.';
    const presentation = (): NativeEmailPresentation => ({ schema_version: 'deft.email_presentation.v1', account_id: scope.account_id,
      logical_message_id: logicalId, provider: 'gmail', source_digest: providerDigest, content_trust: 'unsanitized', files: [], presentation: {
        format: 'plain', content: plain, plain_text: plain, truncated: false, images: [], headers: [], metadata: {
          account_id: scope.account_id, primary_address: 'owner@example.test', verified_sender_identities: '[]', reply_from: '', reply_to: '', reply_to_list: '', reply_cc: '',
          subject: 'Synthetic subject', message_id: '', references: '', conversation_id: 'fixture-conversation', conversation_coverage_state: 'unknown',
          conversation_indexed_count: '0', conversation_exact_count: '', conversation_observed_at: '', conversation_drained: 'false', mailbox_reset_required: 'false',
        } } });
    const content = new EmailMessageContentService(authority, store, { readSource: async () => { throw Error('Unexpected MIME source read'); },
      readPresentation: async (_scope, _input, _cap, recheck) => { providerCalls++; await recheck(); return presentation(); } });
    const source = createPostgresEmailTransferSource(database, authority, (a, s, id, signal) => content.readPresentation(a, s, id, signal),
      (s, id, signal) => store.readMessage(s, id, signal), (s, row) => cipher.open(row.source_envelope,
        { ...s, kind: 'provider_source', record_id: row.logical_message_id, revision: row.storage_revision }) as Record<string, import('@deft/shared').CapabilityJsonValue>);
    const service = new EmailContextTransferService(database as never, source);
    const app = createEmailContextTransferRoutes({ verify: async token => {
      if (token !== 'synthetic-session') throw Error('unauthorized');
      return { id: owner, org_id: org, sid: actor.web_session_id, exp: Math.floor(actor.access_expires_at / 1000) };
    }, service: async () => service });
    const path = `/accounts/${scope.account_id}/messages/${logicalId}/context-transfer`;
    const request = (suffix: string, body: unknown, key?: string) => app.request(path + suffix, { method: 'POST',
      headers: { Authorization: 'Bearer synthetic-session', 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
    const noteInput = { title: 'Reviewed source', destination: { kind: 'note', visibility: 'private' }, mode: 'source_link' };
    let privateResult: { destination_id: string; destination_url: string };
    await t.test('private link-only review and lost-response/concurrent replay create one note and receipt without body copies', async () => {
      const reviewResponse = await request('/review', noteInput); assert.equal(reviewResponse.status, 200);
      const review = await reviewResponse.json(); assert.deepEqual(review.audience, { visibility: 'private', label: 'Only you', member_count: 1 });
      const body = { ...noteInput, source_digest: review.source_digest, review_digest: review.review_digest }, key = randomUUID();
      const responses = await Promise.all([request('', body, key), request('', body, key)]);
      assert.deepEqual(responses.map(r => r.status).sort(), [200, 201]);
      const results = await Promise.all(responses.map(r => r.json())); privateResult = results[0];
      assert.equal(results[0].destination_id, results[1].destination_id); assert.ok(privateResult.destination_url.startsWith('/notes?id='));
      const beforeReplay = providerCalls, repeat = await request('', body, key); assert.equal(repeat.status, 200);
      assert.equal((await repeat.json()).destination_id, privateResult.destination_id); assert.equal(providerCalls, beforeReplay);
      assert.equal((await request('', { ...body, title: 'Changed request' }, key)).status, 409);
      const [note] = await database.select().from(schema.notes).where(eq(schema.notes.id, privateResult.destination_id));
      assert.equal(note?.visibility, 'private'); assert.equal(note?.user_id, owner); assert.ok(note?.content?.includes('Open source email'));
      assert.equal(note?.content?.includes('Hidden remainder'), false); assert.equal(note?.content?.includes('Synthetic subject'), false);
      const receipts = await database.select().from(emailContextTransfers); assert.equal(receipts.length, 1);
      assert.equal(receipts[0]?.account_id, scope.account_id); assert.equal(receipts[0]?.logical_message_id, logicalId);
      assert.equal(receipts[0]?.source_digest, review.source_digest); assert.equal(receipts[0]?.mode, 'source_link');
      assert.equal(receipts[0]?.review_digest, review.review_digest);
      const raw = JSON.stringify(receipts); assert.equal(raw.includes(plain), false);
      assert.equal(raw.includes('synthetic-private-locator'), false);
      assert.equal(providerCalls, 0, 'source-link review, commit and replay fetch no provider content');
    });
    await t.test('selected excerpt is exact plain text, escaped safely and Knowledge retains existing space/provenance semantics', async () => {
      const input = { title: 'Team capture', destination: { kind: 'knowledge', space_id: spaceId, type: 'fact' }, mode: 'excerpt', excerpt: plain.split('\n')[0] };
      const response = await request('/review', input); assert.equal(response.status, 200); const review = await response.json();
      assert.deepEqual(review.audience, { visibility: 'space', label: 'Chosen team members', member_count: 2 });
      const resultResponse = await request('', { ...input, source_digest: review.source_digest, review_digest: review.review_digest }, randomUUID());
      assert.equal(resultResponse.status, 201); const result = await resultResponse.json();
      assert.ok(result.destination_url.startsWith('/knowledge?slug='));
      const [entry] = await database.select().from(schema.wikiPages).where(eq(schema.wikiPages.id, result.destination_id));
      assert.equal(entry?.scope, 'space'); assert.equal(entry?.space_id, spaceId); assert.equal(entry?.origin_message_id, null);
      assert.equal(entry?.created_via, 'email_context_transfer'); assert.equal(entry?.metadata, null);
      assert.equal(entry?.content.includes('Hidden remainder'), false); assert.equal(entry?.content.includes('<script>'), false);
      assert.equal((await request('/review', { ...input, excerpt: 'Invented source excerpt' })).status, 400);
    });
    await t.test('Chat link-only transfer retains the exact audience and concurrent replay creates one quoted message', async () => {
      const input = { title: 'Chosen source link', destination: { kind: 'chat', space_id: spaceId }, mode: 'source_link' };
      const calls = providerCalls, review = await (await request('/review', input)).json();
      assert.deepEqual(review.audience, { visibility: 'space', label: 'Chosen team members', member_count: 2 });
      const body = { ...input, source_digest: review.source_digest, review_digest: review.review_digest }, key = randomUUID();
      const responses = await Promise.all([request('', body, key), request('', body, key)]);
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
      const results = await Promise.all(responses.map(response => response.json()));
      assert.equal(results[0].destination_kind, 'chat'); assert.equal(results[0].destination_id, results[1].destination_id);
      const url = new URL(results[0].destination_url, 'https://fixture.test');
      assert.equal(url.pathname, '/chat'); assert.equal(url.searchParams.get('space'), spaceId); assert.equal(url.searchParams.get('message'), results[0].destination_id);
      const rows = await database.select().from(schema.messages); assert.equal(rows.length, 1);
      assert.equal(rows[0]?.parent_id, null); assert.equal(rows[0]?.org_id, org); assert.equal(rows[0]?.user_id, owner);
      assert.equal(rows[0]?.content.includes('Hidden remainder'), false); assert.equal(rows[0]?.content.includes('Synthetic subject'), false);
      assert.deepEqual(rows[0]?.metadata, { email_context_transfer: { mode: 'source_link' } });
      assert.equal((await request('', body, key)).status, 200); assert.equal(providerCalls, calls);
      assert.equal((await request('', { ...body, title: 'Changed Chat intent' }, key)).status, 409);
      assert.equal((await request('', { ...body, destination: { kind: 'chat', space_id: randomUUID() } }, key)).status, 403);
    });
    await t.test('Chat excerpt is a literal quote; copied agent mentions and legacy file markers create no commands or file grants', async () => {
      const input = { title: 'Quoted context', destination: { kind: 'chat', space_id: spaceId }, mode: 'excerpt', excerpt: plain.split('\n')[1] };
      const review = await (await request('/review', input)).json();
      const response = await request('', { ...input, source_digest: review.source_digest, review_digest: review.review_digest }, randomUUID());
      assert.equal(response.status, 201); const result = await response.json();
      const [row] = await database.select().from(schema.messages).where(eq(schema.messages.id, result.destination_id));
      assert.ok(row?.content.includes('<blockquote>Quoted @agent &lt;@fixture-agent|Defty&gt;'));
      assert.equal(row?.content.includes('<@fixture-agent|Defty>'), false); assert.equal(row?.content.includes('Hidden remainder'), false);
      assert.equal(row?.content.includes('[[file:'), false); assert.ok(row?.content.includes('&#91;&#91;file:private-id:secret&#93;&#93;'));
      assert.deepEqual(row?.metadata, { email_context_transfer: { mode: 'excerpt' } });
      assert.equal(row?.parent_id, null);
    });
    await t.test('Chat member replacement, actor removal, changed destination and private Defty seal invalidate held review', async () => {
      const input = { title: 'Held Chat transfer', destination: { kind: 'chat', space_id: spaceId }, mode: 'source_link' };
      const review = await (await request('/review', input)).json();
      const body = { ...input, source_digest: review.source_digest, review_digest: review.review_digest }, key = randomUUID();
      await pool.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [spaceId, peer]);
      await database.insert(schema.spaceMembers).values({ space_id: spaceId, user_id: outsider });
      const before = (await database.select().from(schema.messages)).length;
      assert.equal((await request('', body, key)).status, 409);
      await pool.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [spaceId, outsider]);
      await database.insert(schema.spaceMembers).values({ space_id: spaceId, user_id: peer });
      const fresh = await (await request('/review', input)).json();
      await pool.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [spaceId, owner]);
      assert.equal((await request('', { ...input, source_digest: fresh.source_digest, review_digest: fresh.review_digest }, key)).status, 403);
      await database.insert(schema.spaceMembers).values({ space_id: spaceId, user_id: owner });
      const otherSpace = randomUUID();
      await database.insert(schema.spaces).values({ id: otherSpace, org_id: org, name: 'Other team', created_by: owner });
      await database.insert(schema.spaceMembers).values({ space_id: otherSpace, user_id: owner });
      assert.equal((await request('', { ...body, destination: { kind: 'chat', space_id: otherSpace } }, key)).status, 409);
      const otherInput = { ...input, destination: { kind: 'chat', space_id: otherSpace } };
      const beforeSeal = await (await request('/review', otherInput)).json();
      await database.insert(schema.appPrivateDeftySeals).values({ org_id: org, space_id: otherSpace, owner_user_id: owner, defty_user_id: peer });
      assert.equal((await request('', { ...otherInput, source_digest: beforeSeal.source_digest, review_digest: beforeSeal.review_digest }, key)).status, 403);
      assert.equal((await request('/review', { ...input, destination: { kind: 'chat', space_id: otherSpace } })).status, 403);
      assert.equal((await database.select().from(schema.messages)).length, before);
      assert.equal((await database.select().from(emailContextTransfers).where(eq(emailContextTransfers.request_id, key))).length, 0);
    });
    await t.test('same-source re-index, envelope re-encryption, flags and checkpoint advancement preserve reviewed source identity', async () => {
      const input = { ...noteInput, title: 'Survives ordinary refresh' };
      const review = await (await request('/review', input)).json();
      const [row] = await database.select().from(schema.emailMessages).where(eq(schema.emailMessages.logical_message_id, logicalId));
      assert.ok(row);
      const providerSource = cipher.open(row!.source_envelope, { ...scope, kind: 'provider_source', record_id: logicalId, revision: row!.storage_revision });
      const summary = cipher.open(row!.summary_envelope, { ...scope, kind: 'summary', record_id: logicalId, revision: row!.storage_revision });
      const revision = row!.storage_revision + 1;
      const nextSource = cipher.seal(providerSource, { ...scope, kind: 'provider_source', record_id: logicalId, revision });
      assert.notDeepEqual(nextSource, row!.source_envelope);
      await database.update(schema.emailMessages).set({ storage_revision: revision, seen: true, source_envelope: nextSource,
        summary_envelope: cipher.seal(summary, { ...scope, kind: 'summary', record_id: logicalId, revision }) }).where(eq(schema.emailMessages.logical_message_id, logicalId));
      await database.insert(schema.emailCheckpoints).values({ ...scope, revision: 4, sync_state: 'idle' });
      const refreshed = await (await request('/review', input)).json();
      assert.equal(refreshed.source_digest, review.source_digest); assert.equal(refreshed.review_digest, review.review_digest);
      assert.equal((await request('', { ...input, source_digest: review.source_digest, review_digest: review.review_digest }, randomUUID())).status, 201);
    });
    await t.test('same-count audience membership replacement requires renewed review', async () => {
      const input = { ...noteInput, destination: { kind: 'note', visibility: 'space', space_id: spaceId } };
      const review = await (await request('/review', input)).json();
      await pool.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [spaceId, peer]);
      await database.insert(schema.spaceMembers).values({ space_id: spaceId, user_id: outsider });
      assert.equal((await request('', { ...input, source_digest: review.source_digest, review_digest: review.review_digest }, randomUUID())).status, 409);
    });
    await t.test('distinct concurrent creates with the same non-Latin title have unique nonempty Knowledge links', async () => {
      const input = { title: 'ज्ञान', destination: { kind: 'knowledge', space_id: spaceId, type: 'fact' }, mode: 'source_link' };
      const review = await (await request('/review', input)).json();
      const body = { ...input, source_digest: review.source_digest, review_digest: review.review_digest };
      const results = await Promise.all([request('', body, randomUUID()), request('', body, randomUUID())]);
      assert.deepEqual(results.map(r => r.status), [201, 201]);
      const entries = await Promise.all(results.map(r => r.json()));
      assert.notEqual(entries[0].destination_id, entries[1].destination_id);
      assert.notEqual(entries[0].destination_url, entries[1].destination_url);
      assert.ok(entries.every(entry => /^\/knowledge\?slug=knowledge(?:-|$)/u.test(entry.destination_url)));
    });
    await t.test('changed provider bytes, stale source version, foreign space and wrong account cannot write', async () => {
      const excerptInput = { ...noteInput, mode: 'excerpt', excerpt: plain.split('\n')[0] };
      const review = await (await request('/review', excerptInput)).json();
      providerDigest = createHash('sha256').update('synthetic-MIME-v2').digest('hex');
      assert.equal((await request('', { ...excerptInput, source_digest: review.source_digest, review_digest: review.review_digest }, randomUUID())).status, 409);
      const changed = await (await request('/review', noteInput)).json();
      await database.update(schema.emailMessages).set({ revision: 'source-v2' }).where(eq(schema.emailMessages.logical_message_id, logicalId));
      assert.equal((await request('', { ...noteInput, source_digest: changed.source_digest, review_digest: changed.review_digest }, randomUUID())).status, 409);
      assert.equal((await request('/review', { ...noteInput, destination: { kind: 'knowledge', space_id: randomUUID(), type: 'fact' } })).status, 403);
      await assert.rejects(service.review(actor, { ...scope, account_id: 'another-account' }, logicalId, noteInput), /EMAIL_ACCESS_DENIED/);
    });
    await t.test('receipt and destination creation roll back atomically after a write failure', async () => {
      const input = { ...noteInput, title: 'Force rollback' }, review = await (await request('/review', input)).json(), requestId = randomUUID();
      await pool.query("ALTER TABLE notes ADD CONSTRAINT fixture_reject_note CHECK (title <> 'Force rollback')");
      assert.equal((await request('', { ...input, source_digest: review.source_digest, review_digest: review.review_digest }, requestId)).status, 503);
      assert.equal((await database.select().from(emailContextTransfers).where(eq(emailContextTransfers.request_id, requestId))).length, 0);
      await pool.query('ALTER TABLE notes DROP CONSTRAINT fixture_reject_note');
      assert.equal((await request('', { ...input, source_digest: review.source_digest, review_digest: review.review_digest }, requestId)).status, 201);
    });
    await t.test('route bounds body before parsing, rejects extra hidden fields and unauthenticated creates', async () => {
      assert.equal((await request('/review', { ...noteInput, bcc: ['hidden@example.test'] })).status, 400);
      assert.equal((await request('/review', { ...noteInput, title: 'x'.repeat(150000) })).status, 413);
      assert.equal((await app.request(path + '/review', { method: 'POST', headers: { Authorization: 'Bearer synthetic-session' }, body: '{}' })).status, 400);
      assert.equal((await app.request(path, { method: 'POST', body: '{}' })).status, 401);
      const mounted = new Hono(); mounted.route('/api/email', app);
      mounted.post('/api/email/unrelated-send-proof', c => c.json({ accepted: true }));
      const unrelated = await mounted.request('/api/email/unrelated-send-proof', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x'.repeat(150000) }) });
      assert.equal(unrelated.status, 200, 'transfer body middleware must not cap unrelated native Email endpoints');
    });
    await t.test('revoked exact SID denies fresh review, commit and replay with no extra effect', async () => {
      const review = await (await request('/review', noteInput)).json(), key = randomUUID();
      const body = { ...noteInput, source_digest: review.source_digest, review_digest: review.review_digest };
      assert.equal((await request('', body, key)).status, 201);
      const count = (await database.select().from(schema.notes)).length;
      await database.update(schema.webSessions).set({ revoked_at: new Date() }).where(eq(schema.webSessions.id, actor.web_session_id));
      assert.equal((await request('/review', noteInput)).status, 403);
      assert.equal((await request('', body, key)).status, 403);
      assert.equal((await request('', body, randomUUID())).status, 403);
      assert.equal((await database.select().from(schema.notes)).length, count);
    });
    await t.test('migration FK enforces exact source owner/account and account cleanup preserves copied destinations', async () => {
      const [receipt] = await database.select().from(emailContextTransfers);
      assert.ok(receipt);
      const fkViolation = (error: unknown) => error instanceof Error && 'cause' in error && (error.cause as { code?: string })?.code === '23503';
      await assert.rejects(database.insert(emailContextTransfers).values({ ...receipt!, request_id: randomUUID(), account_id: 'foreign-account' }), fkViolation);
      await assert.rejects(database.insert(emailContextTransfers).values({ ...receipt!, request_id: randomUUID(), owner_user_id: peer }), fkViolation);
      const notesBefore = (await database.select().from(schema.notes)).length, knowledgeBefore = (await database.select().from(schema.wikiPages)).length;
      assert.ok(notesBefore > 0 && knowledgeBefore > 0);
      await database.delete(schema.emailAccounts).where(eq(schema.emailAccounts.account_id, scope.account_id));
      assert.equal((await database.select().from(emailContextTransfers)).length, 0);
      assert.equal((await database.select().from(schema.notes)).length, notesBefore);
      assert.equal((await database.select().from(schema.wikiPages)).length, knowledgeBefore);
    });
  });
