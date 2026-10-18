import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { agentEmployees, orgMembers, orgs, teamMembers, teams, users } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import {
  resolveNativePersonDisplay,
  resolveNativeTeamDisplay,
} from '../src/lib/native-directory-projections.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const parsed = target ? new URL(target) : null;
const safe = target === process.env.DATABASE_URL && parsed !== null
  && (parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:')
  && parsed.hostname === '127.0.0.1' && parsed.port === '55435'
  && ['/gate_g_phase5_test_c04_directory', '/gate_g_phase5_test_c03b_root_v2'].includes(parsed.pathname)
  && !parsed.search && !parsed.hash;

test('native person and team displays follow live directory and private-team visibility',
  { skip: !safe }, async () => {
    const marker = randomUUID();
    const orgId = randomUUID();
    const foreignOrgId = randomUUID();
    const viewerId = randomUUID();
    const leadId = randomUUID();
    const personId = randomUUID();
    const foreignId = randomUUID();
    const hiddenAgentId = randomUUID();
    const employeeId = randomUUID();
    const privateTeamId = randomUUID();
    const orgTeamId = randomUUID();
    const viewer = { org_id: orgId, user_id: viewerId, role: 'member' as const };
    const staleAdmin = { ...viewer, role: 'admin' as const };
    const foreignViewer = { org_id: foreignOrgId, user_id: foreignId, role: 'member' as const };
    const usersToRemove = [viewerId, leadId, personId, foreignId, hiddenAgentId];
    try {
      await db.insert(orgs).values([
        { id: orgId, name: 'Directory projection fixture', slug: `${marker}-directory` },
        { id: foreignOrgId, name: 'Foreign directory fixture', slug: `${marker}-foreign` },
      ]);
      await db.insert(users).values([
        { id: viewerId, name: 'Viewer', email: `${marker}-viewer@example.test` },
        { id: leadId, name: 'Team Lead', email: `${marker}-lead@example.test` },
        { id: personId, name: 'Visible Person', email: `${marker}-person@example.test` },
        { id: foreignId, name: 'Foreign Person', email: `${marker}-foreign@example.test` },
        { id: hiddenAgentId, name: 'Retired Agent', kind: 'agent',
          email: `${marker}-agent@example.test` },
      ]);
      await db.insert(orgMembers).values([
        { id: randomUUID(), org_id: orgId, user_id: viewerId, role: 'member' },
        { id: randomUUID(), org_id: orgId, user_id: leadId, role: 'member' },
        { id: randomUUID(), org_id: orgId, user_id: personId, role: 'member' },
        { id: randomUUID(), org_id: orgId, user_id: hiddenAgentId, role: 'member' },
        { id: randomUUID(), org_id: foreignOrgId, user_id: foreignId, role: 'member' },
      ]);
      await db.insert(teams).values([
        { id: privateTeamId, org_id: orgId, name: 'Private Team',
          handle: `${marker}-private`, visibility: 'private', lead_user_id: leadId },
        { id: orgTeamId, org_id: orgId, name: 'Org Team',
          handle: `${marker}-org`, visibility: 'org' },
      ]);

      const person = await resolveNativePersonDisplay(viewer, personId);
      assert.equal(person?.label, 'Visible Person');
      assert.deepEqual(Object.keys(person ?? {}).sort(), ['label', 'updated_at']);
      assert.match(person?.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(JSON.stringify(person).includes('@example.test'), false);
      assert.equal(await resolveNativePersonDisplay(viewer, foreignId), null);
      assert.equal(await resolveNativePersonDisplay(foreignViewer, personId), null);
      assert.equal(await resolveNativePersonDisplay(viewer, hiddenAgentId), null);
      await db.insert(agentEmployees).values({ id: employeeId, org_id: orgId,
        user_id: hiddenAgentId, name: 'Directory Agent', slug: `${marker}-agent`,
        role: 'custom', system_prompt: 'synthetic test only', created_by: viewerId });
      assert.equal((await resolveNativePersonDisplay(viewer, hiddenAgentId))?.label, 'Retired Agent');
      await db.update(agentEmployees).set({ is_active: false }).where(eq(agentEmployees.id, employeeId));
      assert.equal(await resolveNativePersonDisplay(viewer, hiddenAgentId), null);
      assert.equal((await resolveNativePersonDisplay(viewer, viewerId))?.label, 'Viewer');
      assert.equal((await resolveNativeTeamDisplay(viewer, orgTeamId))?.label, 'Org Team');
      assert.equal(await resolveNativeTeamDisplay(viewer, privateTeamId), null);
      assert.equal(await resolveNativeTeamDisplay(foreignViewer, privateTeamId), null);

      const lead = { ...viewer, user_id: leadId };
      assert.equal((await resolveNativeTeamDisplay(lead, privateTeamId))?.label, 'Private Team');
      await db.insert(teamMembers).values({ id: randomUUID(), org_id: orgId,
        team_id: privateTeamId, user_id: viewerId, role: 'member' });
      const memberDisplay = await resolveNativeTeamDisplay(viewer, privateTeamId);
      assert.equal(memberDisplay?.label, 'Private Team');
      assert.deepEqual(Object.keys(memberDisplay ?? {}).sort(), ['label', 'updated_at']);
      await db.delete(teamMembers).where(and(
        eq(teamMembers.team_id, privateTeamId), eq(teamMembers.user_id, viewerId)));
      assert.equal(await resolveNativeTeamDisplay(viewer, privateTeamId), null);

      await db.update(teams).set({ lead_user_id: viewerId }).where(eq(teams.id, privateTeamId));
      assert.equal((await resolveNativeTeamDisplay(viewer, privateTeamId))?.label, 'Private Team');
      await db.update(teams).set({ lead_user_id: leadId }).where(eq(teams.id, privateTeamId));
      assert.equal(await resolveNativeTeamDisplay(viewer, privateTeamId), null);

      await db.update(orgMembers).set({ role: 'admin' }).where(and(
        eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, viewerId)));
      assert.equal((await resolveNativeTeamDisplay(viewer, privateTeamId))?.label, 'Private Team');
      await db.update(orgMembers).set({ role: 'member' }).where(and(
        eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, viewerId)));
      assert.equal(await resolveNativeTeamDisplay(staleAdmin, privateTeamId), null);

      await db.update(orgMembers).set({ is_active: false }).where(and(
        eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, personId)));
      assert.equal(await resolveNativePersonDisplay(viewer, personId), null);
      await db.update(orgMembers).set({ is_active: false }).where(and(
        eq(orgMembers.org_id, orgId), eq(orgMembers.user_id, viewerId)));
      assert.equal(await resolveNativePersonDisplay(viewer, leadId), null);
      assert.equal(await resolveNativeTeamDisplay(viewer, orgTeamId), null);
    } finally {
      await db.delete(agentEmployees).where(eq(agentEmployees.id, employeeId));
      await db.delete(teamMembers).where(eq(teamMembers.org_id, orgId));
      await db.delete(teams).where(eq(teams.org_id, orgId));
      await db.delete(orgMembers).where(inArray(orgMembers.org_id, [orgId, foreignOrgId]));
      await db.delete(users).where(inArray(users.id, usersToRemove));
      await db.delete(orgs).where(inArray(orgs.id, [orgId, foreignOrgId]));
    }
  });
