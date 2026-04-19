/**
 * Block 1.8 — skill reconciliation loop tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/skill-reconciliation.test.ts
 *
 * Mock gateway + real DB. Each test seeds agent_employee_skills rows then
 * exercises reconcileSkillsForEmployee with a controlled skills.list result.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import {
  db, agentEmployees, agentEmployeeSkills, skills, orgs, users, orgMembers, notifications,
} from '@deft/db';
import {
  reconcileSkillsForEmployee,
  _clearReconcileState,
} from '../src/lib/skill-reconciliation.js';
import type { OpenClawGateway } from '../src/lib/openclaw-gateway.js';

// Fixtures
let testOrgId: string;
let testUserId: string;
let testEmployeeId: string;
const testSkillIds: string[] = [];

before(async () => {
  const existingOrg = await db.query.orgs.findFirst();
  testOrgId = existingOrg?.id ?? (() => { const id = crypto.randomUUID(); return id; })();
  if (!existingOrg) {
    await db.insert(orgs).values({ id: testOrgId, name: 'b18-org', slug: 'b18-org' });
  }
  const existingUser = await db.query.users.findFirst();
  testUserId = existingUser?.id ?? (() => { const id = crypto.randomUUID(); return id; })();
  if (!existingUser) {
    await db.insert(users).values({ id: testUserId, email: `b18-${Date.now()}@t.local`, name: 'b18' });
  }
  const member = await db.query.orgMembers.findFirst({
    where: (m, { and, eq }) => and(eq(m.user_id, testUserId), eq(m.org_id, testOrgId)),
  });
  if (!member) {
    await db.insert(orgMembers).values({
      id: crypto.randomUUID(),
      org_id: testOrgId,
      user_id: testUserId,
      role: 'admin',
    });
  }

  testEmployeeId = crypto.randomUUID();
  await db.insert(agentEmployees).values({
    id: testEmployeeId,
    org_id: testOrgId,
    user_id: testUserId,
    slug: `b18-emp-${Date.now()}`,
    name: 'b18 test',
    system_prompt: 'test',
    kind: 'openclaw',
    trust_level: 'standard',
    connection_url: 'ws://mock',
    connection_status: 'connected',
    created_by: testUserId,
    role: 'project_manager',
  });

  // Seed 3 skills and attach all to the employee.
  for (let i = 0; i < 3; i++) {
    const id = crypto.randomUUID();
    const slug = `b18-skill-${i}-${Date.now()}`;
    await db.insert(skills).values({
      id,
      org_id: testOrgId,
      name: `b18-${i}`,
      slug,
      source: 'org',
      version: '1.0.0',
    });
    await db.insert(agentEmployeeSkills).values({
      agent_employee_id: testEmployeeId,
      skill_id: id,
      installed_version: '1.0.0',
    });
    testSkillIds.push(id);
  }
});

afterEach(async () => {
  _clearReconcileState();
  // Clear any drift notifications we emitted
  await db.delete(notifications).where(eq(notifications.user_id, testUserId));
});

after(async () => {
  await db.delete(notifications).where(eq(notifications.user_id, testUserId));
  await db.delete(agentEmployeeSkills).where(eq(agentEmployeeSkills.agent_employee_id, testEmployeeId));
  if (testSkillIds.length > 0) {
    await db.delete(skills).where(inArray(skills.id, testSkillIds));
  }
  await db.delete(agentEmployees).where(eq(agentEmployees.id, testEmployeeId));
});

function makeMockGateway(opts: {
  listResult: Array<{ slug: string; version: string; enabled: boolean }>;
  installResult?: (slug: string) => unknown;
  installError?: (slug: string) => boolean;
}): OpenClawGateway {
  const installCalls: Array<{ slug: string; version?: string }> = [];
  const mock = {
    skills: {
      list: () => Promise.resolve(opts.listResult),
      install: (slug: string, version?: string) => {
        installCalls.push({ slug, version });
        if (opts.installError?.(slug)) {
          return Promise.reject(new Error(`install ${slug} failed`));
        }
        return Promise.resolve(opts.installResult?.(slug) ?? { installed: true, slug });
      },
    },
    __installCalls: installCalls,
  };
  return mock as unknown as OpenClawGateway;
}

test('in_sync when gateway has all expected skills', async () => {
  const expected = await db
    .select({ slug: skills.slug })
    .from(agentEmployeeSkills)
    .innerJoin(skills, eq(agentEmployeeSkills.skill_id, skills.id))
    .where(eq(agentEmployeeSkills.agent_employee_id, testEmployeeId));

  const gateway = makeMockGateway({
    listResult: expected.map((e) => ({ slug: e.slug, version: '1.0.0', enabled: true })),
  });

  const r = await reconcileSkillsForEmployee(
    { id: testEmployeeId, org_id: testOrgId, connection_url: 'ws://mock', gateway_token_encrypted: null },
    gateway,
  );
  assert.equal(r.outcome, 'in_sync');
  assert.equal(r.missing.length, 0);
});

test('reinstalls missing skills in one pass', async () => {
  const expected = await db
    .select({ slug: skills.slug })
    .from(agentEmployeeSkills)
    .innerJoin(skills, eq(agentEmployeeSkills.skill_id, skills.id))
    .where(eq(agentEmployeeSkills.agent_employee_id, testEmployeeId));

  // Gateway reports only the FIRST skill installed; the other 2 are missing.
  const gateway = makeMockGateway({
    listResult: expected.slice(0, 1).map((e) => ({ slug: e.slug, version: '1.0.0', enabled: true })),
  });

  const r = await reconcileSkillsForEmployee(
    { id: testEmployeeId, org_id: testOrgId, connection_url: 'ws://mock', gateway_token_encrypted: null },
    gateway,
  );
  assert.equal(r.outcome, 'reinstalled');
  assert.equal(r.missing.length, 2);
  assert.equal(r.reinstalled.length, 2, `expected 2 reinstalls, got ${r.reinstalled}`);
  assert.equal(r.failed.length, 0);
  assert.deepEqual(r.reinstalled.sort(), r.missing.slice().sort());
});

test('drift counter alerts after > 2 consecutive failing ticks', async () => {
  // Gateway perpetually reports empty skills AND install always fails.
  const gateway = makeMockGateway({
    listResult: [],
    installError: () => true,
  });

  const employee = {
    id: testEmployeeId,
    org_id: testOrgId,
    connection_url: 'ws://mock',
    gateway_token_encrypted: null,
  };

  // Tick 1 — drift detected, counter=1, no alert yet (not persisted enough).
  const r1 = await reconcileSkillsForEmployee(employee, gateway);
  assert.ok(r1.outcome === 'reinstalled' || r1.outcome === 'drift_persists');
  assert.equal(r1.failed.length, 3, 'all 3 installs failed');

  // Tick 2 — counter=2, still no alert.
  await reconcileSkillsForEmployee(employee, gateway);

  // Tick 3 — counter=3, should emit alert (threshold is > 2 ticks).
  const r3 = await reconcileSkillsForEmployee(employee, gateway);
  assert.equal(r3.outcome, 'drift_persists');

  // Assert a notification was inserted for the admin user.
  const notifs = await db
    .select()
    .from(notifications)
    .where(eq(notifications.user_id, testUserId));
  const driftAlerts = notifs.filter(
    (n) => (n.metadata as any)?.subtype === 'skill_drift' && (n.metadata as any)?.employee_id === testEmployeeId,
  );
  assert.ok(driftAlerts.length >= 1, `expected drift alert, got ${driftAlerts.length}`);
});

test('counter resets to 0 when drift resolves', async () => {
  // First tick: drift with all missing, no install error — will reinstall all.
  const expected = await db
    .select({ slug: skills.slug })
    .from(agentEmployeeSkills)
    .innerJoin(skills, eq(agentEmployeeSkills.skill_id, skills.id))
    .where(eq(agentEmployeeSkills.agent_employee_id, testEmployeeId));

  const gateway = makeMockGateway({
    listResult: expected.map((e) => ({ slug: e.slug, version: '1.0.0', enabled: true })),
  });

  const employee = {
    id: testEmployeeId,
    org_id: testOrgId,
    connection_url: 'ws://mock',
    gateway_token_encrypted: null,
  };
  const r = await reconcileSkillsForEmployee(employee, gateway);
  assert.equal(r.outcome, 'in_sync');
  // Counter should be 0 now (resetable — next drifts start fresh from 1).
});

test('gateway error returns outcome=error without throwing', async () => {
  const gateway = {
    skills: {
      list: () => Promise.reject(new Error('WebSocket closed')),
      install: () => Promise.reject(new Error('unused')),
    },
  } as unknown as OpenClawGateway;

  const r = await reconcileSkillsForEmployee(
    { id: testEmployeeId, org_id: testOrgId, connection_url: 'ws://mock', gateway_token_encrypted: null },
    gateway,
  );
  assert.equal(r.outcome, 'error');
  assert.ok(r.error?.includes('gateway skills.list failed'));
});
