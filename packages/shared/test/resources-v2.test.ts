import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RESOURCE_CONTRACT_VERSIONS, ResourceRefV1Schema } from '../src/resources.js';
import {
  AnyResourceRefSchema,
  RESOURCE_V2_CONTRACT_VERSIONS,
  ResourceRefV2Schema,
  ResourceResolveResultV2Schema,
  ResourceSafeProjectionV2Schema,
} from '../src/resources-v2.js';

const corePairs = [
  ['messages', 'message'], ['wiki_pages', 'wiki_page'], ['notes', 'note'],
  ['files', 'file'], ['calendar_events', 'calendar_event'],
  ['people', 'person'], ['teams', 'team'],
] as const;
const coreRef = (instance: string, type: string) => ({
  schema_version: RESOURCE_V2_CONTRACT_VERSIONS.ref,
  provider: { kind: 'core', provider_instance_id: instance },
  resource_type: type, resource_id: 'item_1',
});
const runtimeRef = {
  schema_version: RESOURCE_V2_CONTRACT_VERSIONS.ref,
  provider: { kind: 'app_runtime', provider_instance_id: 'registered_runtime_1' },
  resource_type: 'mail_thread', resource_id: 'thread_1',
};
const v1Task = {
  schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
  provider: { kind: 'core', provider_instance_id: 'tasks' },
  resource_type: 'task', resource_id: 'task_1',
};

describe('ResourceRef v2', () => {
  test('accepts exactly seven native owner/type pairs and opaque runtime refs', () => {
    for (const [instance, type] of corePairs) {
      const ref = coreRef(instance, type);
      assert.deepEqual(ResourceRefV2Schema.parse(ref), ref);
      assert.deepEqual(AnyResourceRefSchema.parse(ref), ref);
    }
    assert.deepEqual(ResourceRefV2Schema.parse(runtimeRef), runtimeRef);
    assert.deepEqual(AnyResourceRefSchema.parse(v1Task), v1Task);
  });

  test('does not reinterpret v1 or widen its unsupported-provider behavior', () => {
    assert.equal(ResourceRefV1Schema.safeParse(coreRef('messages', 'message')).success, false);
    assert.equal(ResourceRefV1Schema.safeParse(runtimeRef).success, false);
    assert.equal(ResourceRefV2Schema.safeParse(v1Task).success, false);
    for (const value of [
      coreRef('tasks', 'task'), coreRef('messages', 'wiki_page'),
      coreRef('wiki_pages', 'message'), coreRef('other', 'message'),
      { ...runtimeRef, provider: { kind: 'runtime', provider_instance_id: 'registered_runtime_1' } },
    ]) assert.equal(AnyResourceRefSchema.safeParse(value).success, false);
  });

  test('rejects authority, URL, extra fields, and malformed identities in references', () => {
    for (const value of [
      { ...runtimeRef, org_id: 'other' },
      { ...runtimeRef, actor_id: 'user_1' },
      { ...runtimeRef, href: '/mail/thread_1' },
      { ...runtimeRef, provider: { ...runtimeRef.provider, credential: 'secret' } },
      { ...runtimeRef, provider: { ...runtimeRef.provider,
        provider_instance_id: 'https://provider.example' } },
      { ...runtimeRef, resource_type: 'MailThread' },
      { ...runtimeRef, resource_id: 'thread/1' },
      { ...runtimeRef, resource_id: ' thread_1' },
      { ...runtimeRef, resource_id: 'x'.repeat(257) },
    ]) assert.equal(ResourceRefV2Schema.safeParse(value).success, false);
  });
});

describe('ResourceResolveResult v2', () => {
  const projection = {
    schema_version: RESOURCE_V2_CONTRACT_VERSIONS.safe_projection,
    ref: runtimeRef,
    label: 'A private thread', href: '/apps/mail/thread_1',
    revision: 'rev:3', updated_at: '2026-09-24T13:00:00.000Z',
  };
  const available = { schema_version: RESOURCE_V2_CONTRACT_VERSIONS.resolve,
    state: 'available', ref: runtimeRef, resource: projection };

  test('accepts only a bounded host-safe projection matching the requested ref', () => {
    assert.deepEqual(ResourceSafeProjectionV2Schema.parse(projection), projection);
    assert.deepEqual(ResourceResolveResultV2Schema.parse(available), available);
    assert.equal(ResourceResolveResultV2Schema.safeParse({ ...available,
      resource: { ...projection, ref: { ...runtimeRef, resource_id: 'other' } } }).success, false);
    for (const resource of [
      { ...projection, body: 'private' },
      { ...projection, label: 'x'.repeat(201) },
      { ...projection, label: ' padded ' },
      { ...projection, href: 'https://provider.example/thread' },
      { ...projection, href: '//provider.example/thread' },
      { ...projection, href: '/\\provider.example/thread' },
      { ...projection, href: '/bad\npath' },
      { ...projection, updated_at: 'yesterday' },
      { ...projection, revision: 'rev/3' },
    ]) assert.equal(ResourceSafeProjectionV2Schema.safeParse(resource).success, false);
  });

  test('unavailable, tombstoned and stale states carry no private display data', () => {
    for (const state of ['unavailable', 'tombstoned', 'stale'] as const) {
      const result = { schema_version: RESOURCE_V2_CONTRACT_VERSIONS.resolve,
        state, ref: runtimeRef };
      assert.deepEqual(ResourceResolveResultV2Schema.parse(result), result);
      for (const extra of [{ label: 'old subject' }, { body: 'private' },
        { snippet: 'private' }, { resource: projection }, { href: '/apps/mail/thread_1' }]) {
        assert.equal(ResourceResolveResultV2Schema.safeParse({ ...result, ...extra }).success, false);
      }
    }
  });
});
