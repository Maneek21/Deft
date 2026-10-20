import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';

let row: any, audits: any[], currentManager = true, guards = 0, transactions = 0;
const queries: string[] = [], dialect = new PgDialect();
const database = { transaction: async (use: (tx: any) => Promise<unknown>) => {
  transactions++; const saved = structuredClone(row), savedAudits = structuredClone(audits);
  const tx = { select: (selection: any) => {
    const rows = () => selection ? audits.length ? [{ after_state: audits.at(-1).after_state }] : [] : row ? [row] : [];
    const chain = { from: () => chain, where: (sql: any) => { queries.push(dialect.sqlToQuery(sql).sql); return chain; },
      orderBy: () => chain, limit: () => chain, for: async () => rows(), then: (resolve: any) => Promise.resolve(rows()).then(resolve) }; return chain;
  }, insert: () => ({ values: async (value: any) => { audits.push(value); } }) };
  try { return await use(tx); } catch (error) { row = saved; audits = savedAudits; throw error; }
} };
mock.module(new URL('../src/lib/db.ts', import.meta.url).href, { namedExports: { db: database } });
mock.module(new URL('../src/lib/module-service.ts', import.meta.url).href, { namedExports: {
  assertCurrentModuleManagerWithExecutor: async () => { if (!currentManager) throw new Error('CURRENT_MANAGER_REQUIRED'); },
} });
const { installationUpgradeTrust, upgradeContinuityDecision, UpgradeTrustUpdateSchema } = await import('../src/lib/app-upgrade-trust-policy.js');
const actor: any = { kind: 'human', actor_id: 'admin', org_id: 'org', role: 'admin', source: 'rest' };
const guard: any = Object.assign(async () => { guards++; }, { current_web_session_expires_at: () => new Date(Date.now() + 60000) });
const reset = () => { row = { id: 'installation', org_id: 'org' };
  audits = []; guards = 0; transactions = 0; queries.length = 0; currentManager = true; };

test('admin opts in explicitly, audit records provenance, and revision fences stale writers and ABA', async () => {
  reset();
  assert.deepEqual(await installationUpgradeTrust(actor, 'installation', guard), { trusted: false, revision: 0 });
  assert.deepEqual(await installationUpgradeTrust(actor, 'installation', guard, { trusted: true, expected_revision: 0 }), { trusted: true, revision: 1 });
  assert.deepEqual(audits[0].before_state, { trusted: false, revision: 0 });
  assert.deepEqual(audits[0].after_state, { trusted: true, revision: 1 });
  assert.equal(audits[0].actor_id, 'admin');
  assert.ok(queries.every(query => query.includes('"org_id"')));
  await assert.rejects(installationUpgradeTrust(actor, 'installation', guard, { trusted: false, expected_revision: 0 }), { code: 'APP_STALE' });
  assert.deepEqual(await installationUpgradeTrust(actor, 'installation', guard, { trusted: false, expected_revision: 1 }), { trusted: false, revision: 2 });
  assert.deepEqual(await installationUpgradeTrust(actor, 'installation', guard, { trusted: true, expected_revision: 2 }), { trusted: true, revision: 3 });
  await assert.rejects(installationUpgradeTrust(actor, 'installation', guard, { trusted: false, expected_revision: 1 }), { code: 'APP_STALE' });
});
test('current membership and interactive administrator authority are required', async () => {
  for (const patch of [{ role: 'member' }, { role: 'guest' }, { kind: 'agent' }, { source: 'mcp' }]) {
    reset(); await assert.rejects(installationUpgradeTrust({ ...actor, ...patch }, 'installation', guard, { trusted: true, expected_revision: 0 }), { code: 'APP_ACCESS_DENIED' });
    assert.equal(transactions, 0); assert.equal(audits.length, 0);
  }
  reset(); currentManager = false;
  await assert.rejects(installationUpgradeTrust(actor, 'installation', guard, { trusted: true, expected_revision: 0 }), /CURRENT_MANAGER_REQUIRED/);
  assert.equal(audits.length, 0);
});
test('expired or revoked web authority never changes trust; failed final recheck rolls back the audit too', async () => {
  reset();
  await assert.rejects(installationUpgradeTrust(actor, 'installation', Object.assign(async () => {},
    { current_web_session_expires_at: () => new Date(0) }) as any, { trusted: true, expected_revision: 0 }), { code: 'APP_ACCESS_DENIED' });
  assert.equal(audits.length, 0);
  let calls = 0;
  const revoked = Object.assign(async () => { if (++calls === 2) throw new Error('WEB_REVOKED'); },
    { current_web_session_expires_at: () => new Date(Date.now() + 60000) });
  await assert.rejects(installationUpgradeTrust(actor, 'installation', revoked as any, { trusted: true, expected_revision: 0 }), /WEB_REVOKED/);
  assert.equal(audits.length, 0);
});
test('same setting is idempotent and missing installations are not created', async () => {
  reset(); assert.deepEqual(await installationUpgradeTrust(actor, 'installation', guard, { trusted: false, expected_revision: 0 }), { trusted: false, revision: 0 });
  assert.equal(audits.length, 0); row = undefined;
  await assert.rejects(installationUpgradeTrust(actor, 'installation', guard), { code: 'APP_NOT_FOUND' });
});
test('strict change request rejects missing revision, coercion, overflow and unknown fields', () => {
  for (const value of [{ trusted: true }, { trusted: 'true', expected_revision: 0 }, { trusted: true, expected_revision: -1 },
    { trusted: true, expected_revision: 2147483647 }, { trusted: true, expected_revision: 0, owner: 'other' }])
    assert.equal(UpgradeTrustUpdateSchema.safeParse(value).success, false);
});
test('only a trusted installation and an empty diff are eligible', () => {
  const before = { schema_version: '7', id: 'community.example.app', compatibility: { app_protocol: '7' }, version: '1.0.0' };
  const after = { ...before, version: '1.0.1' };
  assert.equal(upgradeContinuityDecision(false, before, after).eligible, false);
  assert.equal(upgradeContinuityDecision(true, before, after).eligible, true);
  assert.equal(upgradeContinuityDecision(true, before, { ...after, future_authority: true }).eligible, false);
});

test('malformed or future trust records fail closed', async () => {
  for (const after_state of [{ trusted: 'true', revision: 1 }, { trusted: true, revision: -1 },
    { trusted: true, revision: 1, future_authority: true }, null]) {
    reset(); audits.push({ after_state });
    await assert.rejects(installationUpgradeTrust(actor, 'installation', guard));
  }
});
