import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export type Phase4ResourceParityIds = Readonly<{
  org_id: string;
  other_org_id: string;
  owner_user_id: string;
  other_owner_user_id: string;
  employee_user_id: string;
  employee_id: string;
  allowed_project_id: string;
  denied_project_id: string;
  allowed_task_id: string;
  restricted_task_id: string;
  denied_task_id: string;
  deleted_task_id: string;
  other_org_task_id: string;
}>;

export async function seedPhase4ResourceParity(
  client: pg.Client,
): Promise<Phase4ResourceParityIds> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const ids: Phase4ResourceParityIds = {
    org_id: `phase4-resource-org-${suffix}`,
    other_org_id: `phase4-resource-other-${suffix}`,
    owner_user_id: `phase4-resource-owner-${suffix}`,
    other_owner_user_id: `phase4-resource-other-user-${suffix}`,
    employee_user_id: `phase4-resource-employee-user-${suffix}`,
    employee_id: `phase4-resource-employee-${suffix}`,
    allowed_project_id: `phase4-resource-project-allowed-${suffix}`,
    denied_project_id: `phase4-resource-project-denied-${suffix}`,
    allowed_task_id: `phase4-resource-task-allowed-${suffix}`,
    restricted_task_id: `phase4-resource-task-restricted-${suffix}`,
    denied_task_id: `phase4-resource-task-denied-${suffix}`,
    deleted_task_id: `phase4-resource-task-deleted-${suffix}`,
    other_org_task_id: `phase4-resource-task-other-${suffix}`,
  };
  const otherUserId = ids.other_owner_user_id;
  const otherProjectId = `phase4-resource-other-project-${suffix}`;

  await client.query(
    `INSERT INTO orgs (id, name, slug) VALUES
       ($1, 'Phase 4 Resource Parity', $2),
       ($3, 'Phase 4 Resource Other', $4)`,
    [ids.org_id, `phase4-resource-${suffix}`, ids.other_org_id, `phase4-resource-other-${suffix}`],
  );
  await client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES
       ($1, $2, 'Phase 4 Owner', 'human', false, true),
       ($3, NULL, 'Phase 4 Employee', 'agent', true, true),
       ($4, $5, 'Phase 4 Other', 'human', false, true)`,
    [
      ids.owner_user_id,
      `phase4-owner-${suffix}@test.local`,
      ids.employee_user_id,
      otherUserId,
      `phase4-other-${suffix}@test.local`,
    ],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES
       ($1, $2, $3, 'owner', true),
       ($4, $2, $5, 'member', true),
       ($6, $7, $8, 'owner', true)`,
    [
      randomUUID(), ids.org_id, ids.owner_user_id,
      randomUUID(), ids.employee_user_id,
      randomUUID(), ids.other_org_id, otherUserId,
    ],
  );
  await client.query(
    `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES
       ($1, $2, 'Allowed project', $3, $4, 2),
       ($5, $2, 'Denied project', $6, $4, 2),
       ($7, $8, 'Other project', $9, $10, 1)`,
    [
      ids.allowed_project_id, ids.org_id, `P4A${suffix.slice(0, 4).toUpperCase()}`, ids.owner_user_id,
      ids.denied_project_id, `P4D${suffix.slice(0, 4).toUpperCase()}`,
      otherProjectId, ids.other_org_id, `P4O${suffix.slice(0, 4).toUpperCase()}`, otherUserId,
    ],
  );
  await client.query(
    `INSERT INTO tasks
      (id, org_id, project_id, number, title, status, priority, assignee_id,
       created_by, metadata, is_deleted) VALUES
       ($1, $2, $3, 1, 'Allowed Phase 4 task', 'todo', 'p2', $4, $5, '{}'::jsonb, false),
       ($6, $2, $3, 2, 'Restricted Phase 4 task', 'todo', 'p2', NULL, $5,
        jsonb_build_object('visibility', 'restricted', 'visible_user_ids', jsonb_build_array($5::text)), false),
       ($7, $2, $8, 1, 'Out of scope Phase 4 task', 'todo', 'p2', NULL, $5, '{}'::jsonb, false),
       ($9, $2, $3, 3, 'Deleted Phase 4 task', 'todo', 'p2', NULL, $5, '{}'::jsonb, true),
       ($10, $11, $12, 1, 'Other organization task', 'todo', 'p2', NULL, $13, '{}'::jsonb, false)`,
    [
      ids.allowed_task_id, ids.org_id, ids.allowed_project_id, ids.employee_user_id, ids.owner_user_id,
      ids.restricted_task_id,
      ids.denied_task_id, ids.denied_project_id,
      ids.deleted_task_id,
      ids.other_org_task_id, ids.other_org_id, otherProjectId, otherUserId,
    ],
  );
  await client.query(
    `INSERT INTO agent_employees
      (id, org_id, user_id, name, slug, role, system_prompt, project_ids,
       trust_level, max_daily_actions, daily_action_count, created_by,
       is_active, is_deleted, is_byoa) VALUES
      ($1, $2, $3, 'Phase 4 Employee', $4, 'project_manager', 'Phase 4 parity', ARRAY[$5]::text[],
       'standard', 100, 0, $6, true, false, true)`,
    [
      ids.employee_id,
      ids.org_id,
      ids.employee_user_id,
      `phase4-employee-${suffix}`,
      ids.allowed_project_id,
      ids.owner_user_id,
    ],
  );
  return ids;
}
