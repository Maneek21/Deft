import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ModuleActor } from '@deft/shared/modules';

test('Runtime discovery rejects unsupported identity and missing MCP read scope before database access', async () => {
  const { listRuntimeActions, getRuntimeAction } = await import('../src/lib/app-runtime-action-discovery.js');
  const base = { org_id: randomUUID(), actor_id: randomUUID() };
  const actors: ModuleActor[] = [
    { ...base, kind: 'system', source: 'system' },
    { ...base, kind: 'human', source: 'mcp', role: 'owner', scopes: ['write:apps'] },
    { ...base, kind: 'human', source: 'rest', role: 'guest', scopes: [] },
    { ...base, kind: 'agent_employee', source: 'mcp', trust_level: 'autonomous', scopes: ['write:apps'] },
  ];
  for (const actor of actors) {
    await assert.rejects(listRuntimeActions(actor), { code: 'APP_RUN_ACCESS_DENIED' });
    await assert.rejects(getRuntimeAction(actor, { runtime_binding_id: randomUUID() }), { code: 'APP_RUN_ACCESS_DENIED' });
  }
});

test('Runtime discovery accepts only bounded opaque locators and rejects caller supplied authority', async () => {
  const { RuntimeActionListSchema, RuntimeActionGetSchema } = await import('../src/lib/app-runtime-action-discovery.js');
  for (const limit of [0, 17, 1.5]) assert.equal(RuntimeActionListSchema.safeParse({ limit }).success, false);
  assert.equal(RuntimeActionListSchema.safeParse({ installation_id: '../other-tenant' }).success, false);
  assert.equal(RuntimeActionGetSchema.safeParse({ runtime_binding_id: randomUUID(), user_id: randomUUID() }).success, false);
  assert.equal(RuntimeActionGetSchema.safeParse({ runtime_binding_id: randomUUID(), input: { subject: 'send' } }).success, false);
});
