import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP_RESOURCE_SYNC_AUDIENCE, APP_RESOURCE_SYNC_CHANNEL_VERSION,
  ResourceSyncClaimRequestSchema, ResourceSyncResultRequestSchema,
  parseSyncPage,
} from '@deft/app-kit/experimental/resource-sync';
import {
  AppResourceSyncClaimRequestSchema, AppResourceSyncResultRequestSchema,
  parseAppResourceSyncResult,
} from '../src/lib/app-resource-sync-contract.js';

const v2 = { schema_version: APP_RESOURCE_SYNC_CHANNEL_VERSION,
  audience: APP_RESOURCE_SYNC_AUDIENCE };
const session = { session_id: '00000000-0000-4000-8000-000000000001',
  session_token: 's'.repeat(43) };
const attempt = { ...v2, ...session,
  run_id: '00000000-0000-4000-8000-000000000002',
  attempt_id: '00000000-0000-4000-8000-000000000003',
  claim_token: '00000000-0000-4000-8000-000000000004', sequence: 1 };
const descriptor = { schema_version: 'deft.app_sync_descriptor.v1' as const,
  key: 'inbox', runtime_requirement_key: 'mail', resource_type: 'email_message',
  requested_visibility: 'user_private' as const,
  record_schema: { type: 'object' as const, properties: {
    subject: { type: 'string' as const, maxLength: 200 },
    body: { type: 'string' as const, maxLength: 16_384 },
  }, required: ['subject'], additionalProperties: false as const },
  label_field: 'subject' };
const starting_request = { schema_version: 'deft.app_sync_request.v1' as const,
  cursor: 'start', max_items: 2 };
const page = { schema_version: 'deft.app_sync_page.v1' as const,
  upserts: [{ id: 'msg-1', revision: 'r1', data: { subject: 'Hello', body: 'private' } }],
  tombstones: [], next_cursor: 'next', has_more: true };
const pin = { descriptor, starting_request };

test('API and Kit use the same closed v2 claim and result request schemas', () => {
  const claim = { ...v2, ...session, max_claims: 1 };
  assert.deepEqual(AppResourceSyncClaimRequestSchema.parse(claim),
    ResourceSyncClaimRequestSchema.parse(claim));
  const result = { ...attempt, status: 'returned', provider_succeeded: true, page };
  assert.deepEqual(AppResourceSyncResultRequestSchema.parse(result),
    ResourceSyncResultRequestSchema.parse(result));
  for (const changed of [
    { ...result, schema_version: 'deft.app_runtime_channel.v1' },
    { ...result, audience: 'app_runtime' },
    { ...result, resource_binding_id: '00000000-0000-4000-8000-000000000005' },
    { ...result, descriptor },
    { ...result, starting_request },
    { ...result, page: { ...page, owner_id: 'attacker' } },
  ]) {
    assert.equal(AppResourceSyncResultRequestSchema.safeParse(changed).success,
      ResourceSyncResultRequestSchema.safeParse(changed).success);
    assert.equal(AppResourceSyncResultRequestSchema.safeParse(changed).success, false);
  }
});

test('API success parses page against host-reviewed descriptor and starting request', () => {
  const result = { ...attempt, status: 'returned', provider_succeeded: true, page };
  assert.deepEqual(parseAppResourceSyncResult(result, pin), result);
  assert.deepEqual(parseSyncPage(descriptor, starting_request, page), page);
  assert.throws(() => parseAppResourceSyncResult(result, {
    ...pin, starting_request: { ...starting_request, cursor: 'next' },
  }));
  assert.throws(() => parseAppResourceSyncResult(result, {
    ...pin, descriptor: { ...descriptor,
      record_schema: { ...descriptor.record_schema,
        properties: { subject: { type: 'string' as const, maxLength: 200 } } } },
  }));
  assert.throws(() => parseAppResourceSyncResult({ ...result,
    page: { ...page, upserts: [{ id: 'msg-1', revision: 'r1',
      data: { subject: 'Hello', unknown: true } }] } }, pin));
});

test('closed failure and indeterminate outcomes never carry a page', () => {
  for (const result of [
    { ...attempt, status: 'returned', provider_succeeded: false,
      error_code: 'APP_RUN_PROVIDER_ERROR' },
    { ...attempt, status: 'not_attempted', error_code: 'APP_RUN_PROVIDER_TIMEOUT' },
    { ...attempt, status: 'indeterminate' },
  ]) assert.deepEqual(parseAppResourceSyncResult(result, pin), result);
  for (const result of [
    { ...attempt, status: 'returned', provider_succeeded: false,
      error_code: 'APP_RUN_PROVIDER_ERROR', page },
    { ...attempt, status: 'not_attempted', error_code: 'APP_RUN_PROVIDER_TIMEOUT', page },
    { ...attempt, status: 'indeterminate', page },
    { ...attempt, status: 'returned', provider_succeeded: true,
      page: { ...page, next_cursor: 'start' } },
  ]) assert.throws(() => parseAppResourceSyncResult(result, pin));
});
