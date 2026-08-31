import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModuleActor, ModuleRecord } from '@deft/shared/modules';
import {
  RESOURCE_CONTRACT_VERSIONS,
  type ModuleResourceRefV1,
  type TaskResourceRefV1,
} from '@deft/shared/resources';
import { ModuleError } from '../src/lib/module-errors.js';
import {
  ModuleResourceProviderAdapter,
  TaskResourceProviderAdapter,
  projectModuleV1Relations,
} from '../src/lib/resource-provider-adapters.js';
import {
  ResourceAuthorizationError,
  ResourceAuthorizationService,
} from '../src/lib/resource-authorization.js';

const human: ModuleActor = {
  kind: 'human',
  org_id: 'org_phase4',
  actor_id: 'user_phase4',
  role: 'owner',
  source: 'rest',
  scopes: [],
};

const employee: ModuleActor = {
  kind: 'agent_employee',
  org_id: 'org_phase4',
  actor_id: 'employee_phase4',
  trust_level: 'standard',
  source: 'runtime',
  scopes: [],
};

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

const record: ModuleRecord = {
  resource_id: 'module_record:contact_ada',
  id: 'contact_ada',
  installation_id: 'installation_contacts',
  module_id: 'org.deft.reference.resource-contacts',
  collection_key: 'contacts',
  manifest_digest: `sha256:${'a'.repeat(64)}`,
  data: { name: 'Ada Lovelace' },
  relations: [],
  members: [],
  revision: 7,
  created_at: '2026-08-31T01:00:00.000Z',
  updated_at: '2026-08-31T02:00:00.000Z',
  archived_at: null,
};

function moduleOwner(overrides: Record<string, unknown> = {}) {
  return {
    async getRecord() { return record; },
    async getInstallation() {
      return {
        id: 'installation_contacts',
        slug: 'resource-contacts',
        module_id: 'org.deft.reference.resource-contacts',
        source: 'sideload',
        enabled: true,
        agent_access: 'read' as const,
        active_version_id: 'version_contacts',
        manifest_digest: `sha256:${'a'.repeat(64)}`,
        manifest: {} as never,
        created_at: '2026-08-31T01:00:00.000Z',
        updated_at: '2026-08-31T01:00:00.000Z',
      };
    },
    async listReferences() {
      return [{ id: 'contact_ada', collection_key: 'contacts', label: 'Ada Lovelace' }];
    },
    ...overrides,
  };
}

function assertResourceCode(code: ResourceAuthorizationError['code']) {
  return (error: unknown) => error instanceof ResourceAuthorizationError && error.code === code;
}

test('Module adapter preserves owner identity and returns only the safe projection', async () => {
  const calls: string[] = [];
  const owner = moduleOwner({
    async getRecord() { calls.push('record'); return record; },
    async getInstallation() { calls.push('installation'); return moduleOwner().getInstallation(); },
    async listReferences() { calls.push('references'); return moduleOwner().listReferences(); },
  });
  const service = new ResourceAuthorizationService<ModuleActor>({
    module: new ModuleResourceProviderAdapter(owner),
  });
  assert.deepEqual(await service.resolve({ org_id: human.org_id, actor: human }, moduleRef), {
    schema_version: RESOURCE_CONTRACT_VERSIONS.safe_projection,
    ref: moduleRef,
    label: 'Ada Lovelace',
    href: '/modules/resource-contacts/contacts/contact_ada',
    revision: '7',
    updated_at: '2026-08-31T02:00:00.000Z',
  });
  assert.deepEqual(calls, ['record', 'installation', 'references']);
});

test('Module adapter rejects host/actor mismatch and substituted provider identity', async () => {
  let calls = 0;
  const owner = moduleOwner({ async getRecord() { calls++; return record; } });
  const adapter = new ModuleResourceProviderAdapter(owner);
  const service = new ResourceAuthorizationService<ModuleActor>({ module: adapter });
  await assert.rejects(
    service.resolve({ org_id: 'org_other', actor: human }, moduleRef),
    assertResourceCode('RESOURCE_CONTEXT_INVALID'),
  );
  assert.equal(calls, 0);
  await assert.rejects(
    service.resolve({ org_id: human.org_id, actor: human }, {
      ...moduleRef,
      provider: { ...moduleRef.provider, provider_instance_id: 'installation_other' },
    }),
    assertResourceCode('RESOURCE_NOT_FOUND'),
  );
  assert.equal(calls, 1);
});

test('Module owner denials and lifecycle errors map without leaking owner messages', async () => {
  for (const [ownerError, resourceCode] of [
    [new ModuleError('private scope detail', 'MODULE_ACCESS_DENIED', 403), 'RESOURCE_ACCESS_DENIED'],
    [new ModuleError('disabled private module', 'MODULE_DISABLED', 409), 'RESOURCE_UNAVAILABLE'],
    [new ModuleError('private missing id', 'MODULE_RECORD_NOT_FOUND', 404), 'RESOURCE_NOT_FOUND'],
  ] as const) {
    const adapter = new ModuleResourceProviderAdapter(moduleOwner({
      async getRecord() { throw ownerError; },
    }));
    await assert.rejects(
      new ResourceAuthorizationService<ModuleActor>({ module: adapter }).resolve(
        { org_id: human.org_id, actor: human },
        moduleRef,
      ),
      (error) => (
        assertResourceCode(resourceCode)(error)
        && !(error as Error).message.includes('private')
      ),
    );
  }
});

test('Task adapter delegates human visibility and emits a bounded safe projection', async () => {
  const calls: unknown[] = [];
  const adapter = new TaskResourceProviderAdapter({
    async getEmployeeAccess() { throw new Error('human path must not load employee access'); },
    async findVisible(input) {
      calls.push(input);
      return {
        id: 'task_ada',
        project_id: 'project_public',
        title: 'Ada task\nwith control spacing',
        updated_at: new Date('2026-08-31T03:00:00.000Z'),
      };
    },
  });
  const service = new ResourceAuthorizationService<ModuleActor>({ tasks: adapter });
  assert.deepEqual(await service.resolve({ org_id: human.org_id, actor: human }, taskRef), {
    schema_version: RESOURCE_CONTRACT_VERSIONS.safe_projection,
    ref: taskRef,
    label: 'Ada task with control spacing',
    href: '/tasks?task=task_ada',
    updated_at: '2026-08-31T03:00:00.000Z',
  });
  assert.deepEqual(calls, [{
    org_id: human.org_id,
    task_id: 'task_ada',
    user_id: human.actor_id,
    project_ids: null,
  }]);
});

test('Task adapter re-reads employee project scope and fails closed', async () => {
  const calls: unknown[] = [];
  const allowed = new TaskResourceProviderAdapter({
    async getEmployeeAccess() {
      return {
        resolved: true as const,
        userId: 'employee_user_phase4',
        unrestricted: false as const,
        projectIds: ['project_allowed'],
      };
    },
    async findVisible(input) {
      calls.push(input);
      return {
        id: 'task_ada',
        project_id: 'project_allowed',
        title: 'Allowed task',
        updated_at: new Date('2026-08-31T04:00:00.000Z'),
      };
    },
  });
  assert.equal((await new ResourceAuthorizationService<ModuleActor>({ tasks: allowed }).resolve(
    { org_id: employee.org_id, actor: employee },
    taskRef,
  )).label, 'Allowed task');
  assert.deepEqual(calls, [{
    org_id: employee.org_id,
    task_id: 'task_ada',
    user_id: 'employee_user_phase4',
    project_ids: ['project_allowed'],
  }]);

  const denied = new TaskResourceProviderAdapter({
    async getEmployeeAccess() {
      return { resolved: false as const, userId: null, unrestricted: false as const, projectIds: [] };
    },
    async findVisible() { throw new Error('must not query tasks'); },
  });
  await assert.rejects(
    new ResourceAuthorizationService<ModuleActor>({ tasks: denied }).resolve(
      { org_id: employee.org_id, actor: employee },
      taskRef,
    ),
    assertResourceCode('RESOURCE_ACCESS_DENIED'),
  );
});

test('Module v1 relations project as ResourceRefs without changing source groups', () => {
  const source = [{
    field_key: 'company',
    records: [{ id: 'company_ada', collection_key: 'companies', label: 'Analytical Engines' }],
  }];
  assert.deepEqual(projectModuleV1Relations('installation_contacts', source), [{
    field_key: 'company',
    refs: [{
      schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
      provider: { kind: 'module', provider_instance_id: 'installation_contacts' },
      resource_type: 'companies',
      resource_id: 'company_ada',
    }],
  }]);
  assert.deepEqual(source[0]!.records[0], {
    id: 'company_ada',
    collection_key: 'companies',
    label: 'Analytical Engines',
  });
});
