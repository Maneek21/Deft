import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';

/** SQL ancestry fixture only. The envelopes have valid stored shape but are
 * intentionally not host-decryptable; use AppResourceSyncSecretService for
 * live channel or crypto tests. The caller supplies a real installed App,
 * effective grant, org and owner from its disposable fixture. */
export async function insertAppResourceSyncSchemaFixture(client: Client, lineage: {
  org_id: string;
  app_installation_id: string;
  app_version_id: string;
  grant_snapshot_id: string;
  owner_user_id: string;
}, options: { with_run_intent?: boolean; with_projections?: boolean;
  projection_states?: readonly ('live' | 'tombstone')[];
  key_suffix?: string;
  /** Adversarial SQL-shape tests only; the fixture transaction must reject. */
  run_actor_id?: string; intent_descriptor_digest?: string } = {}) {
  const suffix = options.key_suffix ?? 'v1';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(suffix)) {
    throw new TypeError('Invalid synthetic key suffix');
  }
  const fingerprintKeyVersion = `fixture-fp-${suffix}`;
  const encryptionKeyVersion = `fixture-enc-${suffix}`;
  const ids = {
    registration_id: randomUUID(),
    provider_snapshot_id: randomUUID(),
    binding_id: randomUUID(),
    checkpoint_id: randomUUID(),
    run_id: randomUUID(),
    live_projection_id: randomUUID(),
    tombstone_projection_id: randomUUID(),
  };
  const digest = (value: string) =>
    'sha256:' + createHash('sha256').update(value).digest('hex');
  const hmac = (value: string) =>
    'hmac-sha256:' + createHash('sha256').update(value).digest('hex');
  const now = new Date();
  const descriptor = {
    schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox',
    runtime_requirement_key: 'provider', resource_type: 'message',
    requested_visibility: 'user_private',
    record_schema: { type: 'object', properties: {
      label: { type: 'string', maxLength: 120 },
    }, required: ['label'], additionalProperties: false },
    label_field: 'label',
  };
  const descriptorDigest = digest(JSON.stringify(descriptor));
  const ciphertext = Buffer.from('schema-fixture', 'utf8').toString('base64');
  const nonce = Buffer.alloc(12, 1).toString('base64');
  const tag = Buffer.alloc(16, 2).toString('base64');
  const cursorHmac = hmac('synthetic-null-cursor');
  await client.query('BEGIN');
  try {
    await client.query(`
      INSERT INTO app_runtime_registrations
        (id,org_id,app_installation_id,app_version_id,grant_snapshot_id,
         operator_user_id,contract_version)
      VALUES ($1,$2,$3,$4,$5,$6,'deft.app_runtime_channel.v2')`,
    [ids.registration_id, lineage.org_id, lineage.app_installation_id,
      lineage.app_version_id, lineage.grant_snapshot_id, lineage.owner_user_id]);
    await client.query(`
      UPDATE app_runtime_registrations SET state='active',runtime_epoch=1,
        reviewed_by_user_id=$3,reviewed_at=$4,updated_at=$4
      WHERE org_id=$1 AND id=$2`,
    [lineage.org_id, ids.registration_id, lineage.owner_user_id, now]);
    await client.query(`
      INSERT INTO capability_provider_snapshots
        (id,org_id,provider_kind,provider_instance_id,adapter_contract_version,
         snapshot_digest,safe_snapshot,captured_at)
      VALUES ($1,$2,'app_runtime',$3,'deft.app_runtime_channel.v2',$4,'{}'::jsonb,$5)`,
    [ids.provider_snapshot_id, lineage.org_id, ids.registration_id,
      digest(ids.registration_id), now]);
    await client.query(`
      INSERT INTO app_resource_bindings
        (id,org_id,app_installation_id,app_version_id,grant_snapshot_id,
         runtime_registration_id,provider_instance_id,provider_snapshot_id,
         resource_key,resource_family,operation_name,interface_identity,
         reviewed_descriptor,descriptor_digest,owner_user_id,
         max_records_per_page,max_page_bytes,max_retained_records,
         max_retained_bytes,min_interval_seconds)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'inbox','message','sync_inbox',$8,
        $9::jsonb,$10,$11,100,524288,100000,1073741824,60)`,
    [ids.binding_id, lineage.org_id, lineage.app_installation_id,
      lineage.app_version_id, lineage.grant_snapshot_id, ids.registration_id,
      ids.provider_snapshot_id,
      `deft.resource_sync.v2:${lineage.org_id.toLowerCase()}:${lineage.app_installation_id.toLowerCase()}:inbox`,
      JSON.stringify(descriptor), descriptorDigest, lineage.owner_user_id]);
    await client.query(`
      UPDATE app_resource_bindings SET state='active',reviewed_by_user_id=$3,
        reviewed_at=$4,consent_expires_at=$5,updated_at=$4
      WHERE org_id=$1 AND id=$2`,
    [lineage.org_id, ids.binding_id, lineage.owner_user_id, now,
      new Date(now.getTime() + 24 * 60 * 60 * 1000)]);
    await client.query(`
      INSERT INTO app_sync_checkpoints
        (id,org_id,resource_binding_id,cursor_hmac_key_version,cursor_hmac)
      VALUES ($1,$2,$3,$4,$5)`,
    [ids.checkpoint_id, lineage.org_id, ids.binding_id,
      fingerprintKeyVersion, cursorHmac]);
    if (options.with_run_intent !== false) {
      await client.query(`
        INSERT INTO app_runs
          (id,org_id,contract_version,origin_kind,initiating_actor_type,
           initiating_actor_id,execution_actor_type,execution_actor_id,
           provider_kind,provider_instance_id,operation_name,provider_snapshot_id,
           origin_app_installation_id,origin_app_version_id,
           origin_app_grant_snapshot_id,origin_resource_binding_id,
           risk_class,review_requirement,review_scope,retry_class,retention_class,
           idempotency_key_version,idempotency_fingerprint,
           input_fingerprint_key_version,input_fingerprint,
           authorization_snapshot,safe_preview,root_run_id,
           input_expires_at,result_expires_at,idempotency_expires_at,attempt_limit)
        VALUES
          ($1,$2,'deft.app_run.v1','app','system',$15,'system',$15,
           'app_runtime',$4,'sync_inbox',$5,$6,$7,$8,$3,
           'internal_write','policy','reviewed_resource_sync','unsafe_or_unknown','standard',
           $14,$9,$14,$10,'{}'::jsonb,'{}'::jsonb,$1,
           $11,$12,$13,1)`,
      [ids.run_id, lineage.org_id, ids.binding_id, ids.registration_id,
        ids.provider_snapshot_id, lineage.app_installation_id,
        lineage.app_version_id, lineage.grant_snapshot_id,
        hmac(ids.run_id + ':idempotency'), hmac(ids.run_id + ':input'),
        new Date(now.getTime() + 60_000), new Date(now.getTime() + 120_000),
        new Date(now.getTime() + 180_000), fingerprintKeyVersion,
        options.run_actor_id ?? ids.binding_id]);
      await client.query(`
        INSERT INTO app_sync_intents
          (id,org_id,run_id,resource_binding_id,checkpoint_id,
           app_installation_id,app_version_id,grant_snapshot_id,
           provider_snapshot_id,owner_user_id,descriptor_digest,
           generation,expected_cursor_sequence,expected_cursor_hmac_key_version,
           expected_cursor_hmac)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,0,$13,$12)`,
      [randomUUID(), lineage.org_id, ids.run_id, ids.binding_id,
        ids.checkpoint_id, lineage.app_installation_id, lineage.app_version_id,
        lineage.grant_snapshot_id, ids.provider_snapshot_id,
        lineage.owner_user_id, options.intent_descriptor_digest ?? descriptorDigest,
        cursorHmac, fingerprintKeyVersion]);
    }
    if (options.with_projections) {
      const base = [lineage.org_id, ids.binding_id, ids.checkpoint_id,
        fingerprintKeyVersion, encryptionKeyVersion, nonce, ciphertext, tag, 14, now];
      for (const item of [
        { id: ids.live_projection_id, locator: hmac('live'), state: 'live',
          body: ['deft.secret.v1','aes-256-gcm',encryptionKeyVersion,nonce,ciphertext,tag,14],
          tombstoned: null },
        { id: ids.tombstone_projection_id, locator: hmac('tombstone'),
          state: 'tombstone', body: [null,null,null,null,null,null,0], tombstoned: now },
      ].filter((candidate) => (options.projection_states ?? ['live', 'tombstone'])
        .includes(candidate.state as 'live' | 'tombstone'))) {
        await client.query(`
          INSERT INTO app_resource_projections
            (id,org_id,resource_binding_id,checkpoint_id,generation,
             resource_id_hmac_key_version,resource_id_hmac,
             provider_id_envelope_version,provider_id_algorithm,provider_id_key_version,
             provider_id_nonce_b64,provider_id_ciphertext_b64,provider_id_auth_tag_b64,
             provider_id_bytes,body_envelope_version,body_algorithm,body_key_version,
             body_nonce_b64,body_ciphertext_b64,body_auth_tag_b64,body_bytes,
             state,applied_sequence,first_seen_at,last_seen_at,tombstoned_at)
          VALUES ($1,$2,$3,$4,1,$5,$6,'deft.secret.v1','aes-256-gcm',$7,
            $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,1,$20,$20,$21)`,
        [item.id, ...base.slice(0, 3), base[3], item.locator,
          ...base.slice(4, 9), ...item.body, item.state, now, item.tombstoned]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return { ...ids, descriptor, descriptor_digest: descriptorDigest,
    cursor_hmac: cursorHmac };
}
