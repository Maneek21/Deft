import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESOURCE_CONTRACT_VERSIONS,
  type ModuleResourceRefV1,
  type ResourceProviderAdapter,
  type TaskResourceRefV1,
} from '@deft/shared/resources';
import {
  ResourceAuthorizationError,
  ResourceAuthorizationService,
} from '../src/lib/resource-authorization.js';

type TestActor = Readonly<{ kind: 'human'; id: string }>;

const actor: TestActor = { kind: 'human', id: 'user_ada' };
const context = { org_id: 'org_ada', actor };
const moduleRef: ModuleResourceRefV1 = {
  schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
  provider: { kind: 'module', provider_instance_id: 'installation_contacts' },
  resource_type: 'contacts',
  resource_id: 'contact_ada',
};
const taskRef: TaskResourceRefV1 = {
  schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
  provider: { kind: 'core', provider_instance_id: 'tasks' },
  resource_type: 'task',
  resource_id: 'task_ada',
};

function assertResourceError(
  expectedCode: ResourceAuthorizationError['code'],
): (error: unknown) => boolean {
  return (error) => (
    error instanceof ResourceAuthorizationError
    && error.code === expectedCode
  );
}

test('closed provider slots route host-bound context and have no dynamic register surface', async () => {
  const received: unknown[] = [];
  const moduleAdapter: ResourceProviderAdapter<TestActor, ModuleResourceRefV1> = {
    adapter_id: 'module',
    async resolve(input) {
      received.push(input);
      return {
        schema_version: RESOURCE_CONTRACT_VERSIONS.safe_projection,
        ref: input.ref,
        label: 'Ada Lovelace',
        href: '/modules/reference-contacts/contacts/contact_ada',
        revision: '3',
      };
    },
  };
  const service = new ResourceAuthorizationService({ module: moduleAdapter });

  assert.equal('register' in service, false);
  assert.equal('adapters' in service, true);
  assert.equal((await service.resolve(context, moduleRef)).label, 'Ada Lovelace');
  assert.deepEqual(received, [{ context, ref: moduleRef }]);
});

test('malformed and unsupported refs fail before any adapter call', async () => {
  let calls = 0;
  const moduleAdapter: ResourceProviderAdapter<TestActor, ModuleResourceRefV1> = {
    adapter_id: 'module',
    async resolve(input) {
      calls++;
      return {
        schema_version: RESOURCE_CONTRACT_VERSIONS.safe_projection,
        ref: input.ref,
        label: 'must not be returned',
      };
    },
  };
  const service = new ResourceAuthorizationService({ module: moduleAdapter });

  await assert.rejects(
    service.resolve(context, { ...moduleRef, org_id: 'org_other' }),
    assertResourceError('RESOURCE_REF_INVALID'),
  );
  await assert.rejects(
    service.resolve(context, {
      ...moduleRef,
      provider: { kind: 'runtime', provider_instance_id: 'untrusted' },
    }),
    assertResourceError('RESOURCE_PROVIDER_UNSUPPORTED'),
  );
  await assert.rejects(
    service.resolve(context, {
      ...taskRef,
      provider: { kind: 'core', provider_instance_id: 'messages' },
    }),
    assertResourceError('RESOURCE_PROVIDER_UNSUPPORTED'),
  );
  assert.equal(calls, 0);
});

test('missing adapters and invalid host context fail closed', async () => {
  const service = new ResourceAuthorizationService<TestActor>();
  await assert.rejects(
    service.resolve(context, moduleRef),
    assertResourceError('RESOURCE_PROVIDER_UNAVAILABLE'),
  );
  await assert.rejects(
    service.resolve({ org_id: ' org_ada', actor }, moduleRef),
    assertResourceError('RESOURCE_CONTEXT_INVALID'),
  );
  await assert.rejects(
    service.resolve({ org_id: 'org_ada', actor: null as never }, moduleRef),
    assertResourceError('RESOURCE_CONTEXT_INVALID'),
  );
});

test('adapter denial and unexpected failures disclose no projection or raw provider error', async () => {
  const privateLabel = 'Private acquisition target';
  const denied: ResourceProviderAdapter<TestActor, ModuleResourceRefV1> = {
    adapter_id: 'module',
    async resolve() {
      throw new ResourceAuthorizationError('Resource access denied', 'RESOURCE_ACCESS_DENIED', 403);
    },
  };
  await assert.rejects(
    new ResourceAuthorizationService({ module: denied }).resolve(context, moduleRef),
    (error) => (
      assertResourceError('RESOURCE_ACCESS_DENIED')(error)
      && !(error as Error).message.includes(privateLabel)
    ),
  );

  const failed: ResourceProviderAdapter<TestActor, ModuleResourceRefV1> = {
    adapter_id: 'module',
    async resolve() {
      throw new Error(`database failure containing ${privateLabel}`);
    },
  };
  await assert.rejects(
    new ResourceAuthorizationService({ module: failed }).resolve(context, moduleRef),
    (error) => (
      assertResourceError('RESOURCE_PROVIDER_FAILURE')(error)
      && !(error as Error).message.includes(privateLabel)
    ),
  );
});

test('safe projection validation rejects extra fields and ref substitution', async () => {
  const extraField: ResourceProviderAdapter<TestActor, ModuleResourceRefV1> = {
    adapter_id: 'module',
    async resolve(input) {
      return {
        schema_version: RESOURCE_CONTRACT_VERSIONS.safe_projection,
        ref: input.ref,
        label: 'Ada Lovelace',
        secret: 'must not cross the service',
      } as never;
    },
  };
  await assert.rejects(
    new ResourceAuthorizationService({ module: extraField }).resolve(context, moduleRef),
    assertResourceError('RESOURCE_PROVIDER_FAILURE'),
  );

  const substituted: ResourceProviderAdapter<TestActor, ModuleResourceRefV1> = {
    adapter_id: 'module',
    async resolve() {
      return {
        schema_version: RESOURCE_CONTRACT_VERSIONS.safe_projection,
        ref: { ...moduleRef, resource_id: 'contact_other' },
        label: 'Different contact',
      };
    },
  };
  await assert.rejects(
    new ResourceAuthorizationService({ module: substituted }).resolve(context, moduleRef),
    assertResourceError('RESOURCE_PROVIDER_FAILURE'),
  );
});

test('constructor rejects mismatched or dynamically named adapter slots', () => {
  const taskAdapter: ResourceProviderAdapter<TestActor, TaskResourceRefV1> = {
    adapter_id: 'core/tasks',
    async resolve(input) {
      return {
        schema_version: RESOURCE_CONTRACT_VERSIONS.safe_projection,
        ref: input.ref,
        label: 'Task',
      };
    },
  };
  assert.throws(() => new ResourceAuthorizationService({ module: taskAdapter as never }));
  assert.throws(() => new ResourceAuthorizationService({ runtime: taskAdapter } as never));
});
