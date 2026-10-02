import { randomUUID } from 'node:crypto';
import { db } from '../../src/lib/db.js';
import { orgs, users, orgMembers, spaces, spaceMembers, projects, tasks, wikiPages, agentEmployees } from '@deft/db/schema';
export async function createNativeMentionFixture() {
  const orgId = randomUUID(), otherOrgId = randomUUID();
  const ownerId = randomUUID(), samId = randomUUID(), agentId = randomUUID(), agent2Id = randomUUID(), outsiderId = randomUUID();
  const employeeId = randomUUID(), employee2Id = randomUUID(), publicSpaceId = randomUUID(), privateSpaceId = randomUUID();
  const projectId = randomUUID(), taskId = randomUUID(), restrictedId = randomUUID(), wikiId = randomUUID(), privateWikiId = randomUUID();
  await db.insert(orgs).values([{ id: orgId, name: 'Native mention lab', slug: 'mention-lab-' + orgId },
    { id: otherOrgId, name: 'Other workspace', slug: 'other-' + otherOrgId }]);
  await db.insert(users).values([
    { id: ownerId, name: 'Jordan', email: 'jordan-' + ownerId + '@example.test', kind: 'human' },
    { id: samId, name: 'Sam', email: 'sam-' + samId + '@example.test', kind: 'human' },
    { id: agentId, name: 'Rita Research', email: 'rita-' + agentId + '@example.test', kind: 'agent', is_agent: true },
    { id: agent2Id, name: 'Avery Review', email: 'avery-' + agent2Id + '@example.test', kind: 'agent', is_agent: true },
    { id: outsiderId, name: 'Other workspace user', email: 'other-' + outsiderId + '@example.test', kind: 'human' },
  ]);
  await db.insert(orgMembers).values([
    { org_id: orgId, user_id: ownerId, role: 'owner' }, { org_id: orgId, user_id: samId, role: 'member' },
    { org_id: orgId, user_id: agentId, role: 'member' }, { org_id: orgId, user_id: agent2Id, role: 'member' },
    { org_id: otherOrgId, user_id: outsiderId, role: 'owner' },
  ]);
  await db.insert(agentEmployees).values([
    { id: employeeId, org_id: orgId, user_id: agentId, name: 'Rita Research', slug: 'rita-' + employeeId,
      role: 'custom', system_prompt: 'Synthetic offline agent for mention validation.', created_by: ownerId, is_byoa: true, runtime_kind: 'custom_mcp' },
    { id: employee2Id, org_id: orgId, user_id: agent2Id, name: 'Avery Review', slug: 'avery-' + employee2Id,
      role: 'custom', system_prompt: 'Synthetic offline agent for mention validation.', created_by: ownerId, is_byoa: true, runtime_kind: 'custom_mcp' },
  ]);
  await db.insert(spaces).values([{ id: publicSpaceId, org_id: orgId, name: 'Launch room', type: 'public', created_by: ownerId },
    { id: privateSpaceId, org_id: orgId, name: 'Private planning', type: 'private', created_by: ownerId }]);
  await db.insert(spaceMembers).values([ownerId, samId, agentId, agent2Id].map(user_id => ({ space_id: publicSpaceId, user_id }))
    .concat([{ space_id: privateSpaceId, user_id: ownerId }]));
  await db.insert(projects).values({ id: projectId, org_id: orgId, name: 'Launch', prefix: 'DEFT', lead_id: ownerId, task_counter: 43 });
  await db.insert(tasks).values([
    { id: taskId, org_id: orgId, project_id: projectId, number: 42, title: 'Review release', created_by: ownerId },
    { id: restrictedId, org_id: orgId, project_id: projectId, number: 43, title: 'Private budget', created_by: ownerId, metadata: { visibility: 'restricted' } },
  ]);
  await db.insert(wikiPages).values([
    { id: wikiId, org_id: orgId, title: 'Launch checklist', slug: 'launch-checklist-' + wikiId, content: 'Launch checklist', type: 'procedure', scope: 'org', user_id: ownerId },
    { id: privateWikiId, org_id: orgId, title: 'Private procedure', slug: 'private-' + privateWikiId, content: 'Private', type: 'procedure', scope: 'user', user_id: ownerId },
  ]);
  return { orgId, otherOrgId, ownerId, samId, agentId, agent2Id, outsiderId, employeeId, employee2Id,
    publicSpaceId, privateSpaceId, projectId, taskId, restrictedId, wikiId, privateWikiId };
}
