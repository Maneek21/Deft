import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrivateStateDeclarationSchema } from '@deft/app-kit';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';
import type { AppRunKeyProvider } from '../src/lib/app-run-keyrings.js';

test('real private file custody atomically reseals CAS, recovers uploads and retains immutable dispatch bytes',
  { skip: !securityTestDatabaseIsSafe(), timeout: 30000 }, async t => {
  const [{ db, closeDb }, s, { and, eq, sql }, { AppPrivateFileCustody, listAppPrivateFileKeyReferences, purgeExpiredPrivateAppCustody },
    { AppPrivateStateSecrets }, { exposureDigest }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('../src/lib/app-private-file-custody.js'),
    import('../src/lib/app-private-state-secrets.js'), import('../src/lib/app-experience-exposure-contract.js')]);
  t.after(closeDb);
  const keys: AppRunKeyProvider = { current: () => ({ key_id: 'custody-db', key: Buffer.alloc(32, 7) }),
    read: (_purpose, id) => id === 'custody-db' ? { key_id: id, key: Buffer.alloc(32, 7) } : null, keyIds: () => ['custody-db'] };
  const custody = new AppPrivateFileCustody(keys), state = new AppPrivateStateSecrets(keys);
  const declaration = PrivateStateDeclarationSchema.parse({ key: 'drafts', label: 'Drafts', schema: { type: 'object',
    properties: { body: { type: 'string', maxLength: 4096 } }, required: ['body'], additionalProperties: false },
    max_record_bytes: 8192, max_records: 2, max_total_bytes: 16384, retention_days: 1,
    files: { max_file_bytes: 4096, max_files_per_record: 1, max_total_bytes_per_record: 4096, allowed_media_types: ['application/pdf'] },
    action_payloads: [{ action_key: 'send', max_payload_bytes: 8192 }] });
  const scope = { org_id: randomUUID(), owner_user_id: randomUUID(), installation_id: randomUUID(), resource_target_key: 'account_one',
    state_key: 'drafts', record_id: randomUUID(), artifact_digest: `sha256:${'a'.repeat(64)}`, declaration_digest: exposureDigest(declaration) };
  const appVersionId = randomUUID(), original = { body: 'Private scalar draft' }, now = new Date(), expires = new Date(now.getTime() + 3600000);
  const context = (revision: number) => ({ ...scope, revision });
  const pdf = Buffer.from('%PDF-1.7\nsynthetic-private-pdf\nstartxref\n9\n%%EOF\n');
  const request = { expected_revision: 1, upload_operation_id: randomUUID(), filename: 'Synthetic Private.pdf', media_type: 'application/pdf' as const };
  const rollback = new Error('rollback owned test fixture');
  await assert.rejects(db.transaction(async tx => {
    await tx.insert(s.orgs).values({ id: scope.org_id, name: 'Private custody fixture', slug: `custody-${randomUUID()}` });
    await tx.insert(s.users).values({ id: scope.owner_user_id, name: 'Owner', email: `custody-${randomUUID()}@example.test` });
    await tx.insert(s.appInstallations).values({ id: scope.installation_id, org_id: scope.org_id, app_id: `custody-${randomUUID()}`,
      lineage_key: `custody-${randomUUID()}`, lineage_authority_type: 'local_user', lineage_authority_id: scope.owner_user_id,
      installed_by_actor_type: 'human', installed_by_actor_id: scope.owner_user_id, updated_by_actor_type: 'human', updated_by_actor_id: scope.owner_user_id });
    await tx.insert(s.appVersions).values({ id: appVersionId, org_id: scope.org_id, installation_id: scope.installation_id,
      version: '1.0.0', protocol_version: '0', manifest: { private_state: [declaration] }, package: {},
      manifest_digest: `sha256:${'b'.repeat(64)}`, package_digest: `sha256:${'c'.repeat(64)}`,
      created_by_actor_type: 'human', created_by_actor_id: scope.owner_user_id });
    const initial = state.seal(context(1), original);
    await tx.insert(s.appPrivateStateRecords).values({ ...scope, revision: 1, body: initial, key_version: initial.key_version,
      byte_length: Buffer.byteLength(JSON.stringify(original)), created_at: now, updated_at: now, expires_at: expires });
    let checks = 0, deadline = Infinity;
    const guards = { now: () => new Date(), guard: async () => { checks++; }, bindDeadline: (date: Date) => { deadline = Math.min(deadline, date.getTime()); } };
    const empty = await custody.list(tx, scope, declaration, guards);
    assert.deepEqual(empty.files, []); assert.equal(deadline, expires.getTime(), 'empty list preserves draft deadline');
    const uploaded = await custody.upload(tx, scope, declaration, request, pdf, guards);
    assert.equal(uploaded.draft.revision, 2); assert.equal(uploaded.files.length, 1);
    assert.equal(uploaded.files[0]!.upload_operation_id, request.upload_operation_id);
    const replay = await custody.upload(tx, scope, declaration, request, pdf, guards);
    assert.deepEqual(replay, uploaded);
    const [saved] = await tx.select().from(s.appPrivateStateRecords).where(eq(s.appPrivateStateRecords.record_id, scope.record_id));
    assert.deepEqual(state.open(context(2), saved!.body), original);
    assert.throws(() => state.open(context(1), saved!.body));
    const [fileRow] = await tx.select().from(s.appPrivateFiles).where(eq(s.appPrivateFiles.id, uploaded.files[0]!.file_id));
    assert.ok(fileRow?.ciphertext); assert.notDeepEqual(fileRow.ciphertext, pdf);
    assert.equal(JSON.stringify(fileRow.metadata_envelope).includes(request.filename), false);
    await tx.update(s.appPrivateFiles).set({ ciphertext: Buffer.alloc(fileRow.byte_length) }).where(eq(s.appPrivateFiles.id, fileRow.id));
    await assert.rejects(custody.list(tx, scope, declaration, guards), 'unreadable attached binary is never advertised ready');
    await tx.update(s.appPrivateFiles).set({ ciphertext: fileRow.ciphertext }).where(eq(s.appPrivateFiles.id, fileRow.id));
    await assert.rejects(custody.upload(tx, scope, declaration, { ...request, filename: 'changed.pdf' }, pdf, guards));
    await assert.rejects(custody.upload(tx, scope, declaration, { ...request, upload_operation_id: randomUUID() }, pdf, guards));
    await assert.rejects(custody.upload(tx, scope, declaration, { ...request, expected_revision: 2, upload_operation_id: randomUUID() }, pdf, guards),
      'reviewed one-file quota is enforced independently of CAS');
    await assert.rejects(custody.list(tx, { ...scope, resource_target_key: 'account_two' }, declaration, guards));
    await assert.rejects(custody.list(tx, { ...scope, owner_user_id: randomUUID() }, declaration, guards));
    await assert.rejects(custody.upload(tx, scope, declaration, { ...request, expected_revision: 2, upload_operation_id: randomUUID() }, Buffer.from('not a PDF'), guards));
    const adoptedScope = { ...scope, artifact_digest: `sha256:${'f'.repeat(64)}` };
    const adoptedBody = state.seal({ ...context(2), artifact_digest: adoptedScope.artifact_digest }, original);
    await tx.update(s.appPrivateStateRecords).set({ artifact_digest: adoptedScope.artifact_digest, body: adoptedBody })
      .where(eq(s.appPrivateStateRecords.record_id, scope.record_id));
    await assert.rejects(custody.list(tx, adoptedScope, declaration, guards), 'scalar artifact adoption cannot hide older attached file custody');
    await tx.update(s.appPrivateStateRecords).set({ artifact_digest: scope.artifact_digest, body: saved!.body })
      .where(eq(s.appPrivateStateRecords.record_id, scope.record_id));
    const currentFile = await custody.readCurrentDraftFile(tx, scope, declaration, 2, uploaded.files[0]!.file_id, guards);
    assert.deepEqual(currentFile, pdf); currentFile.fill(0);
    const binding = { org_id: scope.org_id, owner_user_id: scope.owner_user_id, installation_id: scope.installation_id,
      app_version_id: appVersionId, grant_snapshot_id: randomUUID(), resource_target_key: scope.resource_target_key,
      state_key: scope.state_key, draft_id: scope.record_id, draft_revision: 2, artifact_digest: scope.artifact_digest,
      declaration_digest: scope.declaration_digest, runtime_binding_id: randomUUID(), action_key: 'send',
      action_contract_digest: `sha256:${'d'.repeat(64)}`, input_digest: `sha256:${'e'.repeat(64)}` };
    const mime = Buffer.from('synthetic MIME with exact PDF'), payloadInput = { metadata: { preview: 'trusted host preview' }, bytes: mime,
      file_refs: uploaded.files, expires_at: expires };
    const ref = await custody.retainPayload(tx, binding, payloadInput, guards);
    assert.deepEqual(await custody.retainPayload(tx, binding, payloadInput, guards), ref);
    assert.deepEqual(await custody.locatePayloadBinding(tx, scope, ref), binding);
    const retained = await custody.loadPayload(tx, binding, ref, guards.now());
    assert.equal(retained.file_refs.length, 1); assert.equal(retained.byte_count, mime.length);
    await assert.rejects(custody.loadPayload(tx, { ...binding, draft_revision: 3 }, ref, guards.now()));
    await assert.rejects(custody.readDraftFile(tx, binding, ref, randomUUID(), guards));
    let releaseGuards = 0;
    await assert.rejects(custody.readPayload(tx, binding, ref, { now: () => new Date(), guard: async () => {
      if (++releaseGuards === 2) throw new Error('authority withdrawn after secret I/O');
    } }));
    assert.equal(releaseGuards, 2, 'both guards run before any complete buffer is released');
    const mutable = { metadata: { preview: 'captured exact metadata' }, bytes: Buffer.from(mime), file_refs: uploaded.files, expires_at: expires };
    let mutated = false;
    const stableRef = await custody.retainPayload(tx, binding, mutable, { ...guards, guard: async () => {
      if (!mutated) { mutable.metadata.preview = 'late substituted metadata'; mutable.bytes.fill(0); mutated = true; }
    } });
    assert.equal((await custody.loadPayload(tx, binding, stableRef, guards.now())).metadata.preview, 'captured exact metadata');
    const stableBytes = await custody.readPayload(tx, binding, stableRef, guards);
    assert.deepEqual(stableBytes, mime); stableBytes.fill(0);
    const removed = await custody.remove(tx, scope, declaration, { expected_revision: 2, file_id: uploaded.files[0]!.file_id }, guards);
    assert.equal(removed.draft.revision, 3); assert.deepEqual(removed.files, []);
    await assert.rejects(custody.upload(tx, scope, declaration, request, pdf, guards), 'retired upload cannot resurrect bytes');
    const retainedBytes = await custody.readPayload(tx, binding, ref, guards);
    assert.deepEqual(retainedBytes, mime); retainedBytes.fill(0);
    const retainedFile = await custody.readDraftFile(tx, binding, ref, uploaded.files[0]!.file_id, guards);
    assert.deepEqual(retainedFile, pdf); retainedFile.fill(0);
    const revoked = { now: () => new Date(), guard: async () => { throw new Error('revoked'); } };
    await assert.rejects(custody.readPayload(tx, binding, ref, revoked));
    const abort = new AbortController(); abort.abort();
    await assert.rejects(custody.readPayload(tx, binding, ref, { ...guards, signal: abort.signal }));
    const refs = await listAppPrivateFileKeyReferences(tx);
    assert.ok(refs.some(ref => ref.purpose === 'run_encryption' && ref.key_id === 'custody-db'));
    await tx.update(s.appPrivateFiles).set({ created_at: new Date(now.getTime() - 10000), expires_at: new Date(now.getTime() - 5000) })
      .where(eq(s.appPrivateFiles.id, uploaded.files[0]!.file_id));
    await assert.rejects(custody.readDraftFile(tx, binding, ref, uploaded.files[0]!.file_id, guards));
    await tx.update(s.appActionPayloads).set({ created_at: new Date(now.getTime() - 10000), expires_at: new Date(now.getTime() - 5000) })
      .where(and(eq(s.appActionPayloads.org_id, scope.org_id), eq(s.appActionPayloads.installation_id, scope.installation_id)));
    assert.ok(await purgeExpiredPrivateAppCustody(tx) >= 3);
    assert.equal((await listAppPrivateFileKeyReferences(tx)).some(ref => ref.key_id === 'custody-db'), false);
    assert.deepEqual(await custody.locatePayloadBinding(tx, scope, ref), binding, 'identity tombstone remains');
    await assert.rejects(custody.loadPayload(tx, binding, ref, guards.now()));
    assert.ok(checks > 10);
    throw rollback;
  }), error => error === rollback);
});
