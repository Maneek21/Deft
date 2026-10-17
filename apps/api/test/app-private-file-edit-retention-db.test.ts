import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import { PrivateStateDeclarationSchema } from '@deft/app-kit';
import { securityTestDatabaseIsSafe } from './fixtures/security-test-database.js';

test('ordinary draft revisions retain only the current unconfirmed payload across 65 edits',
  { skip: !securityTestDatabaseIsSafe(), timeout: 30000 }, async t => {
  const [{ db, closeDb }, s, { eq, sql }, { AppPrivateFileCustody }, { AppPrivateStateSecrets }, { exposureDigest }] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'), import('../src/lib/app-private-file-custody.js'),
    import('../src/lib/app-private-state-secrets.js'), import('../src/lib/app-experience-exposure-contract.js')]);
  t.after(closeDb);
  const key = () => ({ key_id: 'edit-retention-test', key: Buffer.alloc(32, 9) });
  const keys = { current: key, read: key, keyIds: () => ['edit-retention-test'] };
  const custody = new AppPrivateFileCustody(keys), secrets = new AppPrivateStateSecrets(keys);
  const org = randomUUID(), owner = randomUUID(), install = randomUUID(), version = randomUUID(), draftId = randomUUID();
  const declaration = PrivateStateDeclarationSchema.parse({ key: 'drafts', label: 'Drafts', schema: { type: 'object',
    properties: { body: { type: 'string', maxLength: 256 } }, required: ['body'], additionalProperties: false },
    max_record_bytes: 4096, max_records: 2, max_total_bytes: 8192, retention_days: 1,
    files: { max_file_bytes: 2097152, max_files_per_record: 1, max_total_bytes_per_record: 2097152, allowed_media_types: ['application/pdf'] },
    action_payloads: [{ action_key: 'send', max_payload_bytes: 4194304 }] });
  const scope = { org_id: org, owner_user_id: owner, installation_id: install, resource_target_key: 'personal', state_key: 'drafts',
    record_id: draftId, artifact_digest: `sha256:${'a'.repeat(64)}`, declaration_digest: exposureDigest(declaration) };
  const now = new Date(), expires = new Date(now.getTime() + 3600000), rollback = new Error('rollback owned edit-retention fixture');
  await assert.rejects(db.transaction(async tx => {
    await tx.insert(s.orgs).values({ id: org, name: 'Edit retention fixture', slug: `edit-retention-${randomUUID()}` });
    await tx.insert(s.users).values({ id: owner, name: 'Owner', email: `edit-retention-${randomUUID()}@example.test` });
    await tx.insert(s.appInstallations).values({ id: install, org_id: org, app_id: `edit-${randomUUID()}`, lineage_key: `edit-${randomUUID()}`,
      lineage_authority_type: 'local_user', lineage_authority_id: owner, installed_by_actor_type: 'human', installed_by_actor_id: owner,
      updated_by_actor_type: 'human', updated_by_actor_id: owner });
    await tx.insert(s.appVersions).values({ id: version, org_id: org, installation_id: install, version: '1.0.0', protocol_version: '0',
      manifest: { private_state: [declaration] }, package: {}, manifest_digest: `sha256:${'b'.repeat(64)}`, package_digest: `sha256:${'c'.repeat(64)}`,
      created_by_actor_type: 'human', created_by_actor_id: owner });
    const context = (revision: number) => ({ ...scope, revision });
    const initial = secrets.seal(context(1), { body: 'draft edit 1' });
    await tx.insert(s.appPrivateStateRecords).values({ ...scope, revision: 1, body: initial, key_version: initial.key_version,
      byte_length: 28, created_at: now, updated_at: now, expires_at: expires });
    const bindingBase = { org_id: org, owner_user_id: owner, installation_id: install, app_version_id: version,
      grant_snapshot_id: randomUUID(), resource_target_key: 'personal', state_key: 'drafts', draft_id: draftId,
      artifact_digest: scope.artifact_digest, declaration_digest: scope.declaration_digest,
      runtime_binding_id: randomUUID(), action_key: 'send', action_contract_digest: `sha256:${'d'.repeat(64)}` };
    let admitted = 0, firstRef: { snapshot_id: string; digest: string } | undefined, firstBinding: any;
    for (let revision = 1; revision <= 65; revision++) {
      const value = { body: `draft edit ${revision}` }, body = secrets.seal(context(revision), value);
      await tx.update(s.appPrivateStateRecords).set({ revision, body, byte_length: Buffer.byteLength(JSON.stringify(value)) })
        .where(eq(s.appPrivateStateRecords.record_id, draftId));
      const binding = { ...bindingBase, draft_revision: revision,
        input_digest: `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}` };
      const ref = await custody.retainPayload(tx, binding,
        { metadata: { revision }, bytes: Buffer.alloc(100, revision), file_refs: [], expires_at: expires },
        { now: () => new Date(), guard: async () => {} });
      if (revision === 1) { firstRef = ref; firstBinding = binding; }
      admitted++;
    }
    assert.equal(admitted, 65);
    const retained = await tx.execute(sql<{ count: number }>`SELECT count(*)::int AS count FROM app_action_payloads
      WHERE org_id=${org} AND owner_user_id=${owner} AND installation_id=${install} AND purged_at IS NULL`);
    assert.equal(retained.rows[0]!.count, 1);
    await assert.rejects(custody.loadPayload(tx, firstBinding, firstRef!, new Date()), 'old unconfirmed metadata is unavailable');
    const nominated = await custody.locatePayloadBinding(tx, scope, firstRef!);
    assert.equal(nominated.draft_revision, 1, 'retired snapshot identity remains an immutable tombstone');
    const tombstones = await tx.execute(sql<{ count: number }>`SELECT count(*)::int AS count FROM app_action_payloads
      WHERE org_id=${org} AND owner_user_id=${owner} AND installation_id=${install}`);
    assert.equal(tombstones.rows[0]!.count, 65);
    throw rollback;
  }), error => error === rollback);
});
