import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { db } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import {
  agentEmployees,
  invites,
  orgMembers,
  orgs,
  projects,
  spaceMembers,
  spaces,
  tasks,
  users,
} from '@deft/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

let testApp: Hono | null = null;
let testOrgId: string;
let ownerUserId: string;
let memberUserId: string;
let pendingUserId: string;
let inactiveUserId: string;
let agentUserId: string;
let projectId: string;
let pendingInviteId: string;
let requesterUserId: string;
let requesterEmail: string;
let runSuffix: string;

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

function inviteToken(input: { userId: string; email: string; role?: string }) {
  return jwt.sign(
    {
      purpose: 'invite-accept',
      user_id: input.userId,
      org_id: testOrgId,
      email: input.email,
      inviter_id: ownerUserId,
      role: input.role ?? 'member',
    },
    env.JWT_SECRET,
    { expiresIn: '7d' },
  );
}

before(async () => {
  const ts = Date.now();
  runSuffix = `members-dir-${ts}`;

  const [org] = await db.insert(orgs).values({
    name: 'Members Directory Test',
    slug: runSuffix,
  }).returning();
  testOrgId = org!.id;

  const [owner] = await db.insert(users).values({
    email: `${runSuffix}-owner@test.local`,
    name: 'Owner Admin',
    kind: 'human',
    email_verified: true,
    password_hash: 'hash',
  }).returning();
  ownerUserId = owner!.id;
  requesterUserId = ownerUserId;
  requesterEmail = owner!.email!;

  const [member] = await db.insert(users).values({
    email: `${runSuffix}-active@test.local`,
    name: 'Active Member',
    kind: 'human',
    title: 'Operations Lead',
    profile_summary: 'Owns market prep and field operations.',
    expertise_tags: ['ops', 'field'],
    email_verified: true,
    password_hash: 'hash',
  }).returning();
  memberUserId = member!.id;

  const [pending] = await db.insert(users).values({
    email: `${runSuffix}-pending@test.local`,
    name: 'Pending Person',
    kind: 'human',
    email_verified: false,
    password_hash: null,
  }).returning();
  pendingUserId = pending!.id;

  const [inactive] = await db.insert(users).values({
    email: `${runSuffix}-inactive@test.local`,
    name: 'Inactive Person',
    kind: 'human',
    email_verified: true,
    password_hash: 'hash',
  }).returning();
  inactiveUserId = inactive!.id;

  const [agentUser] = await db.insert(users).values({
    name: 'Directory Agent',
    kind: 'agent',
    is_agent: true,
    email_verified: true,
  }).returning();
  agentUserId = agentUser!.id;

  await db.insert(orgMembers).values([
    { org_id: testOrgId, user_id: ownerUserId, role: 'owner' },
    { org_id: testOrgId, user_id: memberUserId, role: 'member' },
    { org_id: testOrgId, user_id: pendingUserId, role: 'guest' },
    { org_id: testOrgId, user_id: inactiveUserId, role: 'member', is_active: false },
    { org_id: testOrgId, user_id: agentUserId, role: 'member' },
  ]);

  const [generalSpace, launchSpace] = await db.insert(spaces).values([
    { org_id: testOrgId, name: `${runSuffix}-general`, type: 'public', is_default: true, created_by: ownerUserId },
    { org_id: testOrgId, name: `${runSuffix}-launch`, type: 'public', created_by: ownerUserId },
  ]).returning();

  await db.insert(spaceMembers).values([
    { space_id: generalSpace!.id, user_id: ownerUserId },
    { space_id: generalSpace!.id, user_id: memberUserId },
    { space_id: launchSpace!.id, user_id: memberUserId },
    { space_id: generalSpace!.id, user_id: pendingUserId },
  ]);

  const [project] = await db.insert(projects).values({
    org_id: testOrgId,
    name: 'Market Launch',
    prefix: `MD${String(ts).slice(-4)}`,
    lead_id: memberUserId,
  }).returning();
  projectId = project!.id;

  await db.insert(tasks).values([
    {
      org_id: testOrgId,
      project_id: projectId,
      number: 1,
      title: 'Open task for member',
      status: 'todo',
      priority: 'p1',
      assignee_id: memberUserId,
      created_by: ownerUserId,
    },
    {
      org_id: testOrgId,
      project_id: projectId,
      number: 2,
      title: 'Done task for member',
      status: 'done',
      priority: 'p2',
      assignee_id: memberUserId,
      created_by: ownerUserId,
    },
  ]);

  await db.insert(agentEmployees).values({
    org_id: testOrgId,
    user_id: agentUserId,
    slug: `${runSuffix}-agent`,
    name: 'Directory Agent',
    system_prompt: 'test',
    is_byoa: true,
    trust_level: 'standard',
    runtime_kind: 'custom_mcp',
    role: 'custom',
    created_by: ownerUserId,
    last_mcp_call_at: new Date(),
  });

  const token = inviteToken({ userId: pendingUserId, email: pending.email!, role: 'guest' });
  const decoded = jwt.decode(token) as { exp?: number } | null;
  const [invite] = await db.insert(invites).values({
    org_id: testOrgId,
    email: pending.email,
    token,
    type: 'email',
    invited_by: ownerUserId,
    expires_at: decoded?.exp ? new Date(decoded.exp * 1000) : undefined,
  }).returning();
  pendingInviteId = invite!.id;

  const { memberRoutes } = await import('../src/routes/members.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', {
      id: requesterUserId,
      email: requesterEmail,
      org_id: testOrgId,
    } as any);
    await next();
  });
  testApp.route('/api/members', memberRoutes);
});

after(async () => {
  try {
    await db.delete(tasks).where(eq(tasks.org_id, testOrgId));
    await db.delete(projects).where(eq(projects.org_id, testOrgId));
    await db.delete(spaceMembers).where(inArray(spaceMembers.user_id, [ownerUserId, memberUserId, pendingUserId, inactiveUserId, agentUserId]));
    await db.delete(spaces).where(eq(spaces.org_id, testOrgId));
    await db.delete(agentEmployees).where(eq(agentEmployees.org_id, testOrgId));
    await db.delete(invites).where(eq(invites.org_id, testOrgId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, testOrgId));
    await db.delete(users).where(inArray(users.id, [ownerUserId, memberUserId, pendingUserId, inactiveUserId, agentUserId]));
    await db.delete(orgs).where(eq(orgs.id, testOrgId));
  } catch (err) {
    console.error('cleanup error', err);
  }
});

test('GET /api/members/directory returns lifecycle, stats, and agent metadata for admins', async () => {
  requesterUserId = ownerUserId;
  const res = await app().request('/api/members/directory');
  assert.equal(res.status, 200);
  const body = await res.json() as any;

  const active = body.members.find((m: any) => m.id === memberUserId);
  assert.ok(active);
  assert.equal(active.lifecycle_status, 'active');
  assert.equal(active.stats.spaces, 2);
  assert.equal(active.stats.assigned_tasks_open, 1);
  assert.equal(active.stats.assigned_tasks_total, 2);
  assert.equal(active.stats.led_projects, 1);

  const pending = body.members.find((m: any) => m.id === pendingUserId);
  assert.ok(pending);
  assert.equal(pending.lifecycle_status, 'pending');
  assert.equal(pending.pending_invite_id, pendingInviteId);

  const inactive = body.members.find((m: any) => m.id === inactiveUserId);
  assert.ok(inactive);
  assert.equal(inactive.lifecycle_status, 'inactive');

  const agent = body.members.find((m: any) => m.id === agentUserId);
  assert.ok(agent);
  assert.equal(agent.kind, 'agent');
  assert.equal(agent.lifecycle_status, 'active');
  assert.equal(agent.agent.runtime_kind, 'custom_mcp');
  assert.equal(agent.agent.trust_level, 'standard');

  assert.equal(body.invites.some((invite: any) => invite.id === pendingInviteId), true);
});

test('GET /api/members/directory hides inactive members and invite ledger from non-admins', async () => {
  requesterUserId = memberUserId;
  requesterEmail = `${runSuffix}-active@test.local`;
  const res = await app().request('/api/members/directory');
  assert.equal(res.status, 200);
  const body = await res.json() as any;

  assert.equal(body.members.some((m: any) => m.id === inactiveUserId), false);
  assert.deepEqual(body.invites, []);
});

test('GET /api/members/:id/detail returns work context for a member', async () => {
  requesterUserId = ownerUserId;
  requesterEmail = `${runSuffix}-owner@test.local`;
  const res = await app().request(`/api/members/${memberUserId}/detail`);
  assert.equal(res.status, 200);
  const body = await res.json() as any;

  assert.equal(body.member.id, memberUserId);
  assert.equal(body.member.stats.assigned_tasks_open, 1);
  assert.equal(body.spaces.length, 2);
  assert.equal(body.open_tasks.length, 1);
  assert.equal(body.led_projects.length, 1);
});

test('pending invite reissue refreshes link and revoke deactivates never-accepted member shell', async () => {
  requesterUserId = ownerUserId;
  requesterEmail = `${runSuffix}-owner@test.local`;

  const reissue = await app().request(`/api/members/invites/${pendingInviteId}/reissue`, { method: 'POST' });
  assert.equal(reissue.status, 200);
  const reissueBody = await reissue.json() as any;
  assert.match(reissueBody.invite_url, /\/invite\//);

  const revoke = await app().request(`/api/members/invites/${pendingInviteId}`, { method: 'DELETE' });
  assert.equal(revoke.status, 200);

  const [membership] = await db.select({ is_active: orgMembers.is_active })
    .from(orgMembers)
    .where(and(eq(orgMembers.org_id, testOrgId), eq(orgMembers.user_id, pendingUserId)))
    .limit(1);
  assert.equal(membership?.is_active, false);

  const [invite] = await db.select({ id: invites.id }).from(invites).where(eq(invites.id, pendingInviteId)).limit(1);
  assert.equal(invite, undefined);
});
