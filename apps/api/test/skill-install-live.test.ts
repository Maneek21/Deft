/**
 * Block 1.3 — live skill install/remove tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/skill-install-live.test.ts
 *
 * Exercises the new live-gateway side effects added to ensureSkillInstalled
 * and the new removeSkillFromEmployee helper. Mock gateway captures
 * install/remove calls; real DB for junction inserts/deletes.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, and, inArray } from 'drizzle-orm';
import {
  db, agentEmployees, agentEmployeeSkills, skills, orgs, users, orgMembers,
} from '@deft/db';
import {
  ensureSkillInstalled,
  removeSkillFromEmployee,
  _setSkillInstallGatewayResolver,
  _resetSkillInstallGatewayResolver,
} from '../src/lib/skill-install.js';
import { encrypt } from '../src/lib/encryption.js';
import type { OpenClawGateway } from '../src/lib/openclaw-gateway.js';

let testOrgId: string;
let testUserId: string;
let employeeId: string;
let orgSkillId: string;
const seededSkillIds: string[] = [];

before(async () => {
  const existingOrg = await db.query.orgs.findFirst();
  testOrgId = existingOrg?.id ?? crypto.randomUUID();
  if (!existingOrg) {
    await db.insert(orgs).values({ id: testOrgId, name: 'b13-org', slug: 'b13-org' });
  }
  const existingUser = await db.query.users.findFirst();
  testUserId = existingUser?.id ?? crypto.randomUUID();
  if (!existingUser) {
    await db.insert(users).values({ id: testUserId, email: `b13-${Date.now()}@t.local`, name: 'b13' });
  }
  const member = await db.query.orgMembers.findFirst({
    where: (m, { and, eq }) => and(eq(m.user_id, testUserId), eq(m.org_id, testOrgId)),
  });
  if (!member) {
    await db.insert(orgMembers).values({
      id: crypto.randomUUID(), org_id: testOrgId, user_id: testUserId, role: 'admin',
    });
  }

  employeeId = crypto.randomUUID();
  await db.insert(agentEmployees).values({
    id: employeeId,
    org_id: testOrgId,
    user_id: testUserId,
    slug: `b13-emp-${Date.now()}`,
    name: 'b13 employee',
    system_prompt: 'test',
    kind: 'openclaw',
    trust_level: 'standard',
    connection_url: 'ws://mock.live',
    gateway_token_encrypted: encrypt('live-token'),
    connection_status: 'connected',
    created_by: testUserId,
    role: 'project_manager',
  });

  // Seed one org-kind skill.
  orgSkillId = crypto.randomUUID();
  seededSkillIds.push(orgSkillId);
  await db.insert(skills).values({
    id: orgSkillId,
    org_id: testOrgId,
    name: 'b13-live-skill',
    slug: `b13-live-slug-${Date.now()}`,
    source: 'org',
    version: '2.0.0',
    agent_config: {} as any,
  });
});

afterEach(async () => {
  _resetSkillInstallGatewayResolver();
});

after(async () => {
  await db.delete(agentEmployeeSkills).where(eq(agentEmployeeSkills.agent_employee_id, employeeId));
  if (seededSkillIds.length > 0) {
    await db.delete(skills).where(inArray(skills.id, seededSkillIds));
  }
  await db.delete(agentEmployees).where(eq(agentEmployees.id, employeeId));
});

function mockGateway(captured: { install: any[]; remove: any[] }): OpenClawGateway {
  return {
    skills: {
      install: (slug: string, version?: string) => {
        captured.install.push({ slug, version });
        return Promise.resolve({ installed: true, slug });
      },
      remove: (slug: string) => {
        captured.remove.push({ slug });
        return Promise.resolve({ removed: true });
      },
    },
  } as unknown as OpenClawGateway;
}

// ─── install ─────────────────────────────────────────────────────────────────
test('ensureSkillInstalled fires gateway.skills.install for connected openclaw', async () => {
  // Clean slate: ensure not installed
  await db.delete(agentEmployeeSkills).where(eq(agentEmployeeSkills.agent_employee_id, employeeId));

  const captured = { install: [] as any[], remove: [] as any[] };
  _setSkillInstallGatewayResolver(() => mockGateway(captured));

  const result = await ensureSkillInstalled(employeeId, orgSkillId);
  assert.equal((result as any).status, 'installed');

  // Wait one tick so the fire-and-forget gateway call completes
  await new Promise((r) => setImmediate(r));

  assert.equal(captured.install.length, 1, `expected 1 install call, got ${captured.install.length}`);
  assert.equal(captured.install[0].version, '2.0.0');

  // Junction row exists
  const [junction] = await db
    .select()
    .from(agentEmployeeSkills)
    .where(and(eq(agentEmployeeSkills.agent_employee_id, employeeId), eq(agentEmployeeSkills.skill_id, orgSkillId)));
  assert.ok(junction);
});

test('ensureSkillInstalled does NOT fire gateway for already_installed case', async () => {
  // Second call after above test — junction already present
  const captured = { install: [] as any[], remove: [] as any[] };
  _setSkillInstallGatewayResolver(() => mockGateway(captured));

  const result = await ensureSkillInstalled(employeeId, orgSkillId);
  assert.equal((result as any).status, 'already_installed');

  await new Promise((r) => setImmediate(r));
  assert.equal(captured.install.length, 0, 'no gateway call for already_installed');
});

// ─── remove ──────────────────────────────────────────────────────────────────
test('removeSkillFromEmployee deletes junction + fires gateway.skills.remove', async () => {
  // Ensure junction present first
  await db
    .insert(agentEmployeeSkills)
    .values({ agent_employee_id: employeeId, skill_id: orgSkillId, installed_version: '2.0.0' })
    .onConflictDoNothing();

  const captured = { install: [] as any[], remove: [] as any[] };
  _setSkillInstallGatewayResolver(() => mockGateway(captured));

  const r = await removeSkillFromEmployee(employeeId, orgSkillId);
  assert.equal(r.removed, true);

  await new Promise((r) => setImmediate(r));
  assert.equal(captured.remove.length, 1);

  // Junction removed
  const rows = await db
    .select()
    .from(agentEmployeeSkills)
    .where(and(eq(agentEmployeeSkills.agent_employee_id, employeeId), eq(agentEmployeeSkills.skill_id, orgSkillId)));
  assert.equal(rows.length, 0);
});

test('removeSkillFromEmployee returns not_installed when junction is absent', async () => {
  const r = await removeSkillFromEmployee(employeeId, orgSkillId);
  assert.equal(r.removed, false);
  assert.equal(r.reason, 'not_installed');
});

test('gateway failure does NOT roll back DB install (best-effort forward)', async () => {
  await db.delete(agentEmployeeSkills).where(eq(agentEmployeeSkills.agent_employee_id, employeeId));

  _setSkillInstallGatewayResolver(() => ({
    skills: {
      install: () => Promise.reject(new Error('WS closed')),
      remove: () => Promise.reject(new Error('WS closed')),
    },
  } as unknown as OpenClawGateway));

  const r = await ensureSkillInstalled(employeeId, orgSkillId);
  assert.equal((r as any).status, 'installed', 'DB install still succeeds despite gateway error');

  const [junction] = await db
    .select()
    .from(agentEmployeeSkills)
    .where(and(eq(agentEmployeeSkills.agent_employee_id, employeeId), eq(agentEmployeeSkills.skill_id, orgSkillId)));
  assert.ok(junction, 'junction row committed regardless of gateway error');
});
