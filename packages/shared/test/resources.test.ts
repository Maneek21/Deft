import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  RESOURCE_CONTRACT_VERSIONS,
  RESOURCE_LIMITS,
  ResourceRefV1Schema,
  ResourceSafeProjectionV1Schema,
} from '../src/resources.js';

const moduleRef = {
  schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
  provider: {
    kind: 'module' as const,
    provider_instance_id: '5b942f6e-13cd-4681-95f2-279fb2a37f78',
  },
  resource_type: 'contacts',
  resource_id: '6b0dc79f-0586-4106-a119-cd42d744f5dd',
};

const taskRef = {
  schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
  provider: { kind: 'core' as const, provider_instance_id: 'tasks' as const },
  resource_type: 'task' as const,
  resource_id: 'task_ada',
};

describe('ResourceRef v1', () => {
  test('accepts only the frozen Module and core Task provider combinations', () => {
    assert.deepEqual(ResourceRefV1Schema.parse(moduleRef), moduleRef);
    assert.deepEqual(ResourceRefV1Schema.parse(taskRef), taskRef);

    for (const ref of [
      { ...taskRef, provider: { kind: 'core', provider_instance_id: 'messages' } },
      { ...taskRef, resource_type: 'message' },
      { ...moduleRef, provider: { kind: 'runtime', provider_instance_id: 'third-party' } },
      { ...moduleRef, schema_version: 'deft.resource_ref.v2' },
    ]) {
      assert.equal(ResourceRefV1Schema.safeParse(ref).success, false);
    }
  });

  test('never accepts tenant authority or unbounded identities from the client', () => {
    assert.equal(ResourceRefV1Schema.safeParse({ ...moduleRef, org_id: 'org_other' }).success, false);
    assert.equal(ResourceRefV1Schema.safeParse({
      ...moduleRef,
      provider: { ...moduleRef.provider, org_id: 'org_other' },
    }).success, false);

    for (const resource_id of [
      ' padded',
      'contains/slash',
      'contains\u0000control',
      'x'.repeat(RESOURCE_LIMITS.resource_id_chars + 1),
    ]) {
      assert.equal(ResourceRefV1Schema.safeParse({ ...moduleRef, resource_id }).success, false);
    }
  });
});

describe('safe resource projection v1', () => {
  test('contains only a bounded label, host-relative href, revision, and freshness', () => {
    const projection = {
      schema_version: RESOURCE_CONTRACT_VERSIONS.safe_projection,
      ref: moduleRef,
      label: 'Ada Lovelace',
      href: '/modules/reference-contacts/contacts/6b0dc79f-0586-4106-a119-cd42d744f5dd',
      revision: '7',
      updated_at: '2026-08-31T05:00:00.000Z',
    };
    assert.deepEqual(ResourceSafeProjectionV1Schema.parse(projection), projection);
    assert.equal(ResourceSafeProjectionV1Schema.safeParse({ ...projection, secret: 'no' }).success, false);
    assert.equal(ResourceSafeProjectionV1Schema.safeParse({
      ...projection,
      href: 'https://provider.example/private',
    }).success, false);
    assert.equal(ResourceSafeProjectionV1Schema.safeParse({ ...projection, href: '//evil.example' }).success, false);
  });
});
