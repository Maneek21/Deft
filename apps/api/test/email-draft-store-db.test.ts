import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emailAccounts, emailDrafts, emailProviderDraftMirrors } from '@deft/db/schema';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { EmailDraftError, EmailDraftService, type EmailDraftContent } from '../src/lib/email-draft-service.js';
import { EmailDraftStore } from '../src/lib/email-draft-store.js';
import { signatureIdentityKey } from '../src/lib/email-signature-types.js';

const target = 'postgresql://gate_g_test@127.0.0.1:55435/email_stage34_upgrade';
const safe = process.env.DATABASE_URL === target && process.env.DEFT_TEST_DATABASE_URL === target;
const draftId = () => randomUUID();
const content = (body = 'Synthetic owner draft only'): EmailDraftContent => ({ mode: 'reply', to: 'person@example.test', cc: '', bcc: '',
  subject: 'Synthetic reply', body, body_html: '', reply_record_id: 'mail_' + 'a'.repeat(64), attachments: [
    { file_id: 'fixture-file-1', filename: 'notes.txt', media_type: 'text/plain', size_bytes: 12, sha256: 'b'.repeat(64) },
  ] });

test('durable native drafts use encrypted scope/revision CAS and owner authority inside PostgreSQL', { skip: !safe, timeout: 45000 }, async t => {
  const admin = new pg.Pool({ connectionString: target, max: 1 });
  const fixtureSchema = 'email_draft_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA ${fixtureSchema}`);
  const pool = new pg.Pool({ connectionString: target, max: 8, options: `-c search_path=${fixtureSchema},public` });
  const db = drizzle(pool, { schema: { emailAccounts, emailDrafts, emailProviderDraftMirrors } });
  await pool.query(`CREATE TABLE email_accounts(org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,provider text NOT NULL DEFAULT 'gmail',
      PRIMARY KEY(org_id,owner_user_id,account_id))`);
  const migration = readFileSync(resolve(process.cwd(), 'packages/db/upgrades/0.3.0-preview.66-email-native-drafts.sql'), 'utf8');
  await pool.query(migration); await pool.query(migration);
  const mirrorMigration = readFileSync(resolve(process.cwd(), 'packages/db/upgrades/0.3.0-preview.70-email-provider-draft-mirrors.sql'), 'utf8');
  await pool.query(mirrorMigration); await pool.query(mirrorMigration);
  const org = 'draft-fixture-' + randomUUID(), owner = 'owner-' + randomUUID(), binding = 'binding-' + randomUUID();
  const scope = { org_id: org, owner_user_id: owner, account_id: 'account-' + randomUUID() };
  const actor = { user_id: owner, web_session_id: 'sid-' + randomUUID(), access_expires_at: Date.now() + 120000 };
  await pool.query('INSERT INTO email_accounts(org_id,owner_user_id,account_id) VALUES($1,$2,$3)', [org, owner, scope.account_id]);
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${fixtureSchema} CASCADE`); await admin.end(); });
  const keys = { current: () => ({ key_id: 'email-draft-db-test', key: Buffer.alloc(32, 29) }),
    read: (_purpose: unknown, key: string) => key === 'email-draft-db-test' ? { key_id: key, key: Buffer.alloc(32, 29) } : null,
    keyIds: () => ['email-draft-db-test'] };
  const cipher = new EmailMailboxCrypto(keys), store = new EmailDraftStore(db, cipher);
  let calls = 0, denyAt = -1;
  const authority = { async current(actual: typeof actor, selected: typeof scope, operation: string, tx?: unknown) {
    assert.deepEqual(actual, actor); assert.deepEqual(selected, scope); assert.equal(operation, 'human_draft');
    calls++;
    if (calls === denyAt) throw new Error('revoked session');
    return { scope: { ...scope }, resource_binding_id: binding, authority_version: 'account-revision-1', expires_at: actor.access_expires_at };
  } };
  const service = new EmailDraftService(authority as any, store);

  await t.test('encrypted create/reopen preserves reply and attachment nominations without exposing plaintext', async () => {
    const id = draftId(), created = await service.create(actor, scope, id, content());
    assert.equal(created.revision, 1); assert.equal(created.origin.kind, 'human'); assert.equal(created.origin.created_by_user_id, owner);
    assert.equal(created.last_edited_by_user_id, owner);
    assert.equal((await service.create(actor, scope, id, content())).revision, 1, 'lost create acknowledgement can be retried safely');
    await assert.rejects(service.create(actor, scope, id, content('different retry payload')),
      error => error instanceof EmailDraftError && error.code === 'EMAIL_DRAFT_CONFLICT');
    assert.deepEqual(created.content.attachments, content().attachments); assert.equal(created.content.reply_record_id, content().reply_record_id);
    const row = await pool.query('SELECT content_envelope FROM email_drafts WHERE org_id=$1 AND owner_user_id=$2 AND draft_id=$3', [org, owner, id]);
    assert.equal(JSON.stringify(row.rows).includes('Synthetic reply'), false); assert.equal(JSON.stringify(row.rows).includes('fixture-file-1'), false);
    const reopened = new EmailDraftService(authority as any, new EmailDraftStore(db, cipher));
    assert.deepEqual((await reopened.read(actor, scope, id)).content, content());
    await assert.rejects(reopened.read({ ...actor, user_id: 'other-owner' }, scope, id),
      error => error instanceof EmailDraftError && error.code === 'EMAIL_DRAFT_ACCESS_DENIED');
    await assert.rejects(reopened.read(actor, { ...scope, account_id: 'foreign-account' }, id),
      error => error instanceof EmailDraftError && error.code === 'EMAIL_DRAFT_ACCESS_DENIED');
  });

  await t.test('PostgreSQL encrypted drafts preserve sender/signature provenance and detach edited suffix without changing body', async () => {
    const address='owner@example.test',suffix='\n\nBest,\nOwner',id=draftId();
    const marked:EmailDraftContent={...content('Hello'+suffix),from_identity:{address},managed_signature:{schema_version:'deft.email_signature_region.v1',
      identity_key:signatureIdentityKey(address),preference_revision:2,plain:{start:5,text:suffix},rich:null}};
    const created=await service.create(actor,scope,id,marked),reopened=await service.read(actor,scope,id);
    assert.deepEqual(reopened.content.from_identity,{address});assert.deepEqual(reopened.content.managed_signature,marked.managed_signature);
    assert.equal(reopened.content.body,'Hello'+suffix);
    const edited=await service.update(actor,scope,id,created.revision,{...marked,body:'Hello\n\nManual signature edit'});
    assert.equal(edited.content.body,'Hello\n\nManual signature edit');assert.equal('managed_signature'in edited.content,false);
    assert.deepEqual(edited.content.from_identity,{address});
  });

  await t.test('provider mirror is opt-in and desired revisions commit with local CAS', async () => {
    const disabledId = draftId();
    await service.create(actor, scope, disabledId, content());
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM email_provider_draft_mirrors WHERE draft_id=$1', [disabledId])).rows[0].n, 0);
    await pool.query('UPDATE email_accounts SET provider_draft_sync_enabled=true WHERE org_id=$1 AND owner_user_id=$2 AND account_id=$3', [org, owner, scope.account_id]);
    const id = draftId();
    await service.create(actor, scope, id, content());
    let mirror = (await pool.query('SELECT desired_revision,generation,state,provider_envelope FROM email_provider_draft_mirrors WHERE draft_id=$1', [id])).rows[0];
    assert.deepEqual(mirror, { desired_revision: 1, generation: 1, state: 'queued', provider_envelope: null });
    await service.update(actor, scope, id, 1, content('Revision 2'));
    mirror = (await pool.query('SELECT desired_revision,generation,state FROM email_provider_draft_mirrors WHERE draft_id=$1', [id])).rows[0];
    assert.deepEqual(mirror, { desired_revision: 2, generation: 2, state: 'queued' });
    await pool.query("UPDATE email_provider_draft_mirrors SET state='unknown' WHERE draft_id=$1", [id]);
    await service.update(actor, scope, id, 2, content('Revision 3'));
    mirror = (await pool.query('SELECT desired_revision,generation,state FROM email_provider_draft_mirrors WHERE draft_id=$1', [id])).rows[0];
    assert.deepEqual(mirror, { desired_revision: 3, generation: 3, state: 'unknown' }, 'unknown remote effects are never blindly retried');
  });

  await t.test('CAS conflict preserves edits, archive is soft, and archived content remains reopenable', async () => {
    const id = draftId(); await service.create(actor, scope, id, content());
    const changed = await service.update(actor, scope, id, 1, content('Updated but unsent'));
    assert.equal(changed.revision, 2); assert.equal(changed.content.body, 'Updated but unsent');
    await assert.rejects(service.update(actor, scope, id, 1, content('stale local buffer')),
      error => error instanceof EmailDraftError && error.code === 'EMAIL_DRAFT_CONFLICT');
    const archived = await service.archive(actor, scope, id, 2);
    assert.equal(archived.status, 'archived'); assert.equal(archived.revision, 3);
    assert.equal((await service.list(actor, scope)).some(item => item.draft_id === id), false);
    assert.equal((await service.read(actor, scope, id)).content.body, 'Updated but unsent');
    const row = await pool.query('SELECT count(*)::int AS n FROM email_drafts WHERE org_id=$1 AND owner_user_id=$2 AND draft_id=$3', [org, owner, id]);
    assert.equal(row.rows[0].n, 1);
  });

  await t.test('agent-origin drafts retain immutable run provenance while human edits are tracked separately', async () => {
    const id = draftId();
    await store.create(scope, id, content(), { kind: 'agent', created_by_user_id: 'agent-fixture', originating_run_id: 'run-fixture' }, async () => {});
    const edited = await store.update(scope, id, 1, content('Human reviewed edit'), owner, async () => {});
    assert.deepEqual(edited.origin, { kind: 'agent', created_by_user_id: 'agent-fixture', originating_run_id: 'run-fixture' });
    assert.equal(edited.last_edited_by_user_id, owner); assert.equal(edited.content.body, 'Human reviewed edit');
  });

  await t.test('authority loss at final transaction fence rolls back an edit', async () => {
    const id = draftId(); const created = await service.create(actor, scope, id, content());
    calls = 0; denyAt = 3; // outer authority, transaction entry, final pre-commit fence
    await assert.rejects(service.update(actor, scope, id, created.revision, content('must roll back')),
      error => error instanceof EmailDraftError && error.code === 'EMAIL_DRAFT_ACCESS_DENIED');
    denyAt = -1;
    assert.equal((await service.read(actor, scope, id)).content.body, content().body);
  });

  await t.test('route content cannot forge provenance, state, headers, or malformed attachment nomination', async () => {
    for (const invalid of [
      { ...content(), origin: 'agent', originating_run_id: 'forged-run' },
      { ...content(), status: 'submitted' },
      { ...content(), subject: 'header\r\nBcc: forged@example.test' },
      { ...content(), attachments: [{ ...content().attachments[0], sha256: 'not-a-digest' }] },
    ]) await assert.rejects(service.create(actor, scope, draftId(), invalid),
      error => error instanceof EmailDraftError && error.code === 'EMAIL_DRAFT_INVALID');
  });
});
