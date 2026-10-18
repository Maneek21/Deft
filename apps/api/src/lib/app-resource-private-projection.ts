import { z } from 'zod';
import type { appResourceProjections } from '@deft/db/schema';
import { parseSyncPage } from '@deft/app-kit/experimental/resource-sync';
import type { AppResourceSyncSecretService } from './app-resource-sync-secrets.js';

/** Canonical projection decoding only. Callers hold live authority/checkpoint
 * locks and verify row scope before calling; this does not authorize delivery. */
export function decodePrivateProjection(secrets: AppResourceSyncSecretService,
  row: typeof appResourceProjections.$inferSelect, descriptor: Parameters<typeof parseSyncPage>[0]) {
  const body = z.strictObject({ revision: z.string(), data: z.unknown() }).parse(secrets.openJson({
    schema_version: row.body_envelope_version, algorithm: row.body_algorithm,
    key_version: row.body_key_version, nonce_b64: row.body_nonce_b64,
    ciphertext_b64: row.body_ciphertext_b64, auth_tag_b64: row.body_auth_tag_b64,
  }, { org_id: row.org_id, resource_binding_id: row.resource_binding_id,
    checkpoint_id: row.checkpoint_id, payload_kind: 'projection', generation: row.generation,
    projection_id: row.id, slot: 'record' }));
  // This minimal parser placeholder is never a decrypted provider identifier.
  return parseSyncPage(descriptor, { schema_version: 'deft.app_sync_request.v1', cursor: null, max_items: 1 },
    { schema_version: 'deft.app_sync_page.v1', upserts: [{ id: 'x', ...body }],
      tombstones: [], next_cursor: null, has_more: false }).upserts[0]!;
}
