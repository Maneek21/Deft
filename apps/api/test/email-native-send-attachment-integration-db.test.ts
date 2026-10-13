import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { emailAccounts, emailDrafts, emailSendOperations, emailAttachments, emailProviderDraftMirrors } from '@deft/db/schema';
import { EmailMailboxCrypto } from '../src/lib/email-mailbox-crypto.js';
import { EmailDraftStore } from '../src/lib/email-draft-store.js';
import { EmailSendStore } from '../src/lib/email-send-store.js';
import { EmailAttachmentCrypto } from '../src/lib/email-attachment-crypto.js';
import { EmailAttachmentStore } from '../src/lib/email-attachment-store.js';
import { EmailAttachmentService } from '../src/lib/email-attachment-service.js';
import { EmailNativeSendService } from '../src/lib/email-native-send-service.js';
import { RegisteredEmailNativeSendProvider } from '../src/lib/email-native-send-provider.js';
import { createEmailNativeOutgoingSnapshotBuilder } from '../src/lib/email-native-outgoing-snapshot.js';

const target = 'postgresql://gate_g_test@127.0.0.1:55435/email_stage34_fresh_65';
const safe = process.env.DATABASE_URL === target && process.env.DEFT_TEST_DATABASE_URL === target;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const dynamic = async (relative: string) => import(new URL(relative, import.meta.url).href) as any;

test('native saved attachment reaches registered provider once after durable reservation; status and unknown recovery never resend',
  { skip: !safe, timeout: 60000 }, async t => {
    const admin = new pg.Pool({ connectionString: target, max: 1 });
    const namespace = 'email_send_join_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    const pool = new pg.Pool({ connectionString: target, max: 8, options: `-c search_path=${namespace},public` });
    const database = drizzle(pool, { schema: { emailAccounts, emailDrafts, emailSendOperations, emailAttachments, emailProviderDraftMirrors } });
    t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${namespace}" CASCADE`); await admin.end(); });
    await pool.query('CREATE TABLE email_accounts(org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,PRIMARY KEY(org_id,owner_user_id,account_id))');
    for (const migration of ['66-email-native-drafts', '68-email-native-send', '69-email-native-attachments', '70-email-provider-draft-mirrors']) {
      const text = readFileSync(new URL(`../../../packages/db/upgrades/0.3.0-preview.${migration}.sql`, import.meta.url), 'utf8');
      await pool.query(text);
    }

    const scope = { org_id: 'org_' + randomUUID(), owner_user_id: 'owner_' + randomUUID(), account_id: 'mail_' + randomUUID() };
    const actor = { user_id: scope.owner_user_id, web_session_id: 'sid_' + randomUUID(), access_expires_at: Date.now() + 120_000 };
    const resourceBinding = 'resource_' + randomUUID(), installation = 'install_' + randomUUID(), actionBinding = 'action_' + randomUUID();
    await pool.query('INSERT INTO email_accounts(org_id,owner_user_id,account_id) VALUES($1,$2,$3)', [scope.org_id, scope.owner_user_id, scope.account_id]);
    const guard = async (transaction?: any) => {
      const run = async (tx: any) => { await tx.execute(sql`SELECT 1 FROM email_accounts WHERE org_id=${scope.org_id} AND owner_user_id=${scope.owner_user_id} AND account_id=${scope.account_id} FOR SHARE`); };
      if (transaction) await run(transaction); else await database.transaction(run);
    };
    const capability = { scope, resource_binding_id: resourceBinding, authority_version: 'authority_' + randomUUID(), expires_at: actor.access_expires_at - 1_000 };
    const authority = { async current(_actor: any, actualScope: any, operation: string, transaction?: any, signal?: AbortSignal) {
      signal?.throwIfAborted(); assert.deepEqual(actualScope, scope);
      assert.ok(['human_send', 'human_draft'].includes(operation)); await guard(transaction); return capability;
    } } as any;
    const keys = { current: () => ({ key_id: 'fixture-email-send', key: Buffer.alloc(32, 31) }),
      read: (_purpose: unknown, id: string) => id === 'fixture-email-send' ? { key_id: id, key: Buffer.alloc(32, 31) } : null,
      keyIds: () => ['fixture-email-send'] };
    const crypto = new EmailMailboxCrypto(keys), draftStore = new EmailDraftStore(database, crypto), sendStore = new EmailSendStore(database, crypto);
    const attachmentStore = new EmailAttachmentStore(database, crypto, new EmailAttachmentCrypto(keys));
    const attachments = new EmailAttachmentService(authority, attachmentStore);
    const content = { mode: 'compose', to: 'reader@example.test', cc: '', bcc: '', subject: 'One synthetic attachment', body: 'Exact saved body', body_html: '', reply_record_id: '', attachments: [] };
    const draftId = randomUUID(), fileId = randomUUID();
    await draftStore.create(scope, draftId, content, { kind: 'human', created_by_user_id: scope.owner_user_id, originating_run_id: null }, guard);
    const fileBytes = Buffer.from('encrypted durable attachment payload');
    const uploaded = await attachments.upload(actor, scope, draftId, 1, fileId, { filename: 'notes.txt', media_type: 'text/plain' }, fileBytes);
    assert.equal(uploaded.revision, 2);

    const client = { client_id: 'fixture-client', client_secret: 'fixture-secret', redirect_uri: 'https://fixture.invalid/callback' };
    const fetchCalls: Array<{ url: string; body: Buffer }> = [];
    let providerResponse: Response = new Response(JSON.stringify({ id: 'private-provider-id' }), { status: 200, headers: { 'content-type': 'application/json' } });
    let loseNextResponse = false;
    const fetch = async (url: string, init: any) => {
      assert.equal(init.method, 'POST');
      const rows = await pool.query('SELECT state FROM email_send_operations WHERE org_id=$1 AND owner_user_id=$2 AND state=$3 ORDER BY created_at DESC LIMIT 1',
        [scope.org_id, scope.owner_user_id, 'reserved']);
      assert.equal(rows.rows.length, 1, 'reservation must be committed before provider I/O');
      assert.equal(rows.rows[0].state, 'reserved');
      const body = Buffer.from(init.body);
      fetchCalls.push({ url, body });
      if (loseNextResponse) throw Error('synthetic response loss after request dispatch');
      return providerResponse;
    };
    const { createEncryptedEmailCustody } = await dynamic('../../../examples/apps/email/providers/custody-encrypted.mjs');
    const { createAppConnectionAdapter } = await dynamic('../../../examples/apps/email/providers/connection-http.mjs');
    const { createOAuthProvider } = await dynamic('../../../examples/apps/email/providers/oauth-provider.mjs');
    const custodyRows = new Map<string, any>();
    const custody = createEncryptedEmailCustody({ encryption_key: new Uint8Array(32).fill(19), key_id: 'synthetic-send', store: {
      async withLock({ key }: { key: string }, work: (tx: any) => Promise<unknown>) {
        const tx = { async read() { return structuredClone(custodyRows.get(key) ?? null); }, async compareAndSwap({ expected_revision, value }: any) {
          const old = custodyRows.get(key); if ((old?.revision ?? null) !== expected_revision) return false;
          custodyRows.set(key, { revision: (old?.revision ?? 0) + 1, value: structuredClone(value) }); return true;
        } };
        return work(tx);
      },
    } });
    const binding = { scope: { org_id: scope.org_id, owner_id: scope.owner_user_id, installation_id: installation }, account_id: scope.account_id,
      provider: 'gmail', connection_target: 'google_connection', resource_binding_id: resourceBinding, action_binding_id: actionBinding,
      authority_epoch: 1, capabilities: ['read', 'send'] };
    const oauth = createOAuthProvider({ provider: 'gmail', client, fetch });
    await custody.withAccount(binding, async (tx: any) => tx.write({ health: 'connected', secret: { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token',
      expires_at: Date.now() + 3_600_000, scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
      client_fingerprint: oauth.client_fingerprint, identity: { provider_subject: 'synthetic-subject', primary_address: 'owner@example.test', display_label: 'Fixture',
        verified_sender_identities: ['owner@example.test'] } } }));
    const adapter = await createAppConnectionAdapter({ options: { origin: 'https://fixture.invalid', account_id: binding.account_id, provider: binding.provider,
      authority_epoch: binding.authority_epoch, connection_target: binding.connection_target, resource_binding_id: binding.resource_binding_id,
      action_binding_id: binding.action_binding_id, capabilities: binding.capabilities, clients: { gmail: client } }, custody, fetch,
      host: { async resolveContext() { assert.fail('Native send must not use an Experience projection'); }, async assertCurrent() { assert.fail('Native send must use SQL/native context'); } } });
    const nativeContext = { org_id: scope.org_id, owner_user_id: scope.owner_user_id, installation_id: installation, account_id: scope.account_id,
      resource_binding_id: resourceBinding, authority_version: capability.authority_version, expires_at: capability.expires_at,
      recheck: async () => { await guard(); } };
    const resolver = async (_scope: any, _cap: any, _recheck: any, _signal: any, purpose: string) => {
      assert.equal(purpose, 'send'); return { adapter, context: nativeContext };
    };
    const provider = new RegisteredEmailNativeSendProvider(resolver as any);
    const snapshots = createEmailNativeOutgoingSnapshotBuilder({ accounts: provider, attachments,
      replies: async () => { throw Error('no reply source is expected'); },
      createOutgoingSnapshotService: adapter.nativeEmailSnapshotFactory.bind(adapter) as any });
    const service = new EmailNativeSendService(authority, draftStore, sendStore, snapshots, provider);

    const accepted = await service.send(actor, scope, draftId, uploaded.revision);
    assert.equal(accepted.state, 'accepted'); assert.equal(fetchCalls.length, 1);
    const firstRequest = fetchCalls[0]; assert.ok(firstRequest);
    assert.equal(firstRequest.url, 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media');
    assert.ok(firstRequest.body.toString('latin1').includes('Subject: ' + content.subject));
    assert.ok(firstRequest.body.toString('latin1').includes('notes.txt'));
    assert.ok(firstRequest.body.includes(Buffer.from(fileBytes.toString('base64'))), 'provider MIME contains exact saved attachment bytes');
    assert.equal(JSON.stringify(accepted).includes('private-provider-id'), false);
    assert.equal((await service.status(actor, scope, draftId, uploaded.revision))?.state, 'accepted');
    assert.deepEqual(await service.send(actor, scope, draftId, uploaded.revision), accepted);
    assert.equal(fetchCalls.length, 1, 'accepted status and retries do not repeat provider effect');

    const lostDraft = randomUUID();
    await draftStore.create(scope, lostDraft, content, { kind: 'human', created_by_user_id: scope.owner_user_id, originating_run_id: null }, guard);
    loseNextResponse = true;
    await assert.rejects(service.send(actor, scope, lostDraft, 1), { code: 'EMAIL_SEND_UNKNOWN' });
    assert.equal(fetchCalls.length, 2);
    assert.equal((await service.status(actor, scope, lostDraft, 1))?.state, 'unknown');
    const recoveredUnknown = await service.send(actor, scope, lostDraft, 1);
    assert.equal(recoveredUnknown.state, 'unknown');
    assert.equal(fetchCalls.length, 2, 'a repeated submitted revision never triggers a second send');
  });
