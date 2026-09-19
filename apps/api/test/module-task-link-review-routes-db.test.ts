import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';
import { Hono } from 'hono';

import { closeDb } from '../src/lib/db.js';
import {
  createModuleRecord,
  getModuleInstallation,
  getModuleRecord,
  humanModuleActor,
  installModuleFromManifest,
  listModuleRecordReferences,
  updateModuleInstallation,
} from '../src/lib/module-service.js';
import { resolveTaskIdentifier } from '../src/lib/agent-actions.js';
import { agentRoutes } from '../src/routes/agent.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
const canRun = Boolean(databaseUrl);

after(closeDb);

test('pending task-link review resolves only current canonical targets for an eligible reviewer', { skip: !canRun }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const suffix = randomUUID().slice(0, 8);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const guestId = randomUUID();
  const employeeUserId = randomUUID();
  const employeeId = randomUUID();
  const otherOwnerId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const taskId = randomUUID();
  const restrictedTaskId = randomUUID();
  const otherTaskId = randomUUID();
  const moduleSlug = `review-equipment-${suffix}`;
  const canonicalRecordLabel = `Canonical equipment ${suffix}`;
  const canonicalTaskTitle = `CRM five task ${suffix}`;
  const hiddenTaskTitle = `HIDDEN OTHER ORG TASK ${suffix}`;
  let recordId = '';
  let resourceId = '';

  const appFor = (user: { id: string; org_id: string; role: string }) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('user', { ...user, email: `${user.id}@example.test` } as any);
      await next();
    });
    app.route('/api/agent', agentRoutes);
    return app;
  };
  const response = (user: { id: string; org_id: string; role: string }, actionId: string) => (
    appFor(user).request(`/api/agent/actions/${actionId}/task-link-review`)
  );
  const notFound = async (res: Response, forbidden: readonly string[] = []) => {
    assert.equal(res.status, 404);
    const body = await res.json() as Record<string, unknown>;
    assert.deepEqual(body, { error: 'Not found', code: 'NOT_FOUND' });
    for (const value of forbidden) assert.doesNotMatch(JSON.stringify(body), new RegExp(value));
  };
  const insertAction = async (taskIdentifier: string, status = 'pending') => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO agent_actions
        (id,org_id,user_id,agent_employee_id,source,action,params,approval_tier,approval_status)
       VALUES ($1,$2,$3,$4,'mcp','module_record_task_link',$5::jsonb,'quick',$6)`,
      [
        id, orgId, employeeUserId, employeeId,
        JSON.stringify({
          resource_id: resourceId,
          task_identifier: taskIdentifier,
          record_label: 'ATTACKER RECORD LABEL',
          task_title: 'ATTACKER TASK TITLE',
          project_prefix: 'ATTACKER',
        }),
        status,
      ],
    );
    return id;
  };

  try {
    await client.query('INSERT INTO orgs (id,name,slug) VALUES ($1,$2,$3),($4,$5,$6)', [
      orgId, 'Task-link review', `task-link-review-${suffix}`,
      otherOrgId, 'Other task-link review', `other-task-link-review-${suffix}`,
    ]);
    await client.query(
      `INSERT INTO users (id,name,email,kind,is_agent) VALUES
        ($1,'Owner',$2,'human',false),($3,'Member',$4,'human',false),
        ($5,'Guest',$6,'human',false),($7,'Employee',$8,'agent',true),
        ($9,'Other owner',$10,'human',false)`,
      [
        ownerId, `owner-${suffix}@example.test`, memberId, `member-${suffix}@example.test`,
        guestId, `guest-${suffix}@example.test`, employeeUserId, `employee-${suffix}@example.test`,
        otherOwnerId, `other-owner-${suffix}@example.test`,
      ],
    );
    await client.query(
      `INSERT INTO org_members (id,org_id,user_id,role,is_active) VALUES
        ($1,$2,$3,'owner',true),($4,$2,$5,'member',true),($6,$2,$7,'guest',true),
        ($8,$9,$10,'owner',true),($11,$2,$12,'member',true)`,
      [
        randomUUID(), orgId, ownerId, randomUUID(), memberId, randomUUID(), guestId,
        randomUUID(), otherOrgId, otherOwnerId, randomUUID(), employeeUserId,
      ],
    );
    await client.query(
      `INSERT INTO agent_employees
        (id,org_id,user_id,name,slug,role,system_prompt,trust_level,created_by)
       VALUES ($1,$2,$3,'Task-link review employee',$4,'custom','test','conservative',$5)`,
      [employeeId, orgId, employeeUserId, `task-link-review-${suffix}`, ownerId],
    );
    await client.query(
      `INSERT INTO projects (id,org_id,name,prefix,lead_id) VALUES
        ($1,$2,'CRM project','CRM',$3),($4,$5,'Other project','OTH',$6)`,
      [projectId, orgId, ownerId, otherProjectId, otherOrgId, otherOwnerId],
    );
    await client.query(
      `INSERT INTO tasks (id,org_id,project_id,number,title,created_by,metadata) VALUES
        ($1,$2,$3,5,$4,$5,'{}'),
        ($6,$2,$3,6,'RESTRICTED TASK',$5,$7::jsonb),
        ($8,$9,$10,1,$11,$12,'{}')`,
      [
        taskId, orgId, projectId, canonicalTaskTitle, ownerId,
        restrictedTaskId, JSON.stringify({ visibility: 'restricted', visible_user_ids: [ownerId] }),
        otherTaskId, otherOrgId, otherProjectId, hiddenTaskTitle, otherOwnerId,
      ],
    );

    const owner = humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
    const installation = await installModuleFromManifest(owner, {
      schema_version: '1', id: `test.deft.${moduleSlug}`, slug: moduleSlug, version: '1.0.0', name: 'Equipment register',
      collections: [{
        key: 'assets', name: 'Assets', singular_name: 'Asset',
        fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
        search: { title_field: 'name', fields: ['name'] },
        views: [{ key: 'all', name: 'All', type: 'table', fields: ['name'] }],
      }],
    }, { source: 'sideloaded' });
    const record = await createModuleRecord(owner, {
      module_id: installation.module_id,
      collection_key: 'assets',
      data: { name: canonicalRecordLabel },
      expected_manifest_digest: installation.manifest_digest,
      idempotency_key: `review-record-${suffix}`,
    });
    assert.ok(record.record);
    recordId = record.record!.id;
    resourceId = record.record!.resource_id;
    assert.equal(await resolveTaskIdentifier('CRM-5', orgId), taskId);
    const routeActor = humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'ui' });
    const routeRecord = await getModuleRecord(routeActor, recordId);
    const routeInstallation = await getModuleInstallation(routeActor, { moduleId: routeRecord.module_id });
    assert.equal(
      (await listModuleRecordReferences(routeActor, routeInstallation.slug, routeRecord.collection_key, [routeRecord.id]))[0]?.label,
      canonicalRecordLabel,
    );

    const prefixAction = await insertAction('CRM-5');
    const prefixResponse = await response({ id: ownerId, org_id: orgId, role: 'owner' }, prefixAction);
    const prefixBody = await prefixResponse.json() as any;
    assert.equal(prefixResponse.status, 200, JSON.stringify(prefixBody));
    assert.deepEqual(prefixBody, {
      record: {
        label: canonicalRecordLabel,
        href: `/modules/${moduleSlug}/assets/${recordId}`,
      },
      task: {
        identifier: 'CRM-5',
        title: canonicalTaskTitle,
        project_name: 'CRM project',
        href: `/tasks?task=${taskId}`,
      },
    });
    assert.doesNotMatch(JSON.stringify(prefixBody), /ATTACKER/);

    const uuidAction = await insertAction(taskId);
    const uuidResponse = await response({ id: ownerId, org_id: orgId, role: 'owner' }, uuidAction);
    assert.equal(uuidResponse.status, 200, 'the shared task identifier resolver accepts a raw UUID');
    assert.equal((await uuidResponse.json() as any).task.identifier, 'CRM-5');

    await notFound(await response({ id: memberId, org_id: orgId, role: 'member' }, prefixAction), [canonicalRecordLabel, canonicalTaskTitle]);

    const reviewerAction = await insertAction('CRM-5');
    await client.query(
      `INSERT INTO agent_action_approvers (id,org_id,action_id,user_id,decision)
       VALUES ($1,$2,$3,$4,'pending')`,
      [randomUUID(), orgId, reviewerAction, memberId],
    );
    const reviewerResponse = await response({ id: memberId, org_id: orgId, role: 'member' }, reviewerAction);
    assert.equal(reviewerResponse.status, 200, 'an explicitly assigned active reviewer can read canonical targets');
    assert.equal((await reviewerResponse.json() as any).record.label, canonicalRecordLabel);

    await client.query(
      `INSERT INTO agent_action_approvers (id,org_id,action_id,user_id,decision)
       VALUES ($1,$2,$3,$4,'pending')`,
      [randomUUID(), orgId, reviewerAction, guestId],
    );
    await notFound(await response({ id: guestId, org_id: orgId, role: 'guest' }, reviewerAction), [canonicalRecordLabel]);

    await client.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [orgId, memberId]);
    await notFound(await response({ id: memberId, org_id: orgId, role: 'member' }, reviewerAction), [canonicalRecordLabel]);
    await client.query('UPDATE org_members SET is_active = true WHERE org_id = $1 AND user_id = $2', [orgId, memberId]);

    await notFound(await response({ id: otherOwnerId, org_id: otherOrgId, role: 'owner' }, prefixAction), [canonicalRecordLabel, canonicalTaskTitle]);

    const staleAction = await insertAction('CRM-5', 'approved');
    await notFound(await response({ id: ownerId, org_id: orgId, role: 'owner' }, staleAction), [canonicalRecordLabel]);

    const restrictedAction = await insertAction('CRM-6');
    await client.query(
      `INSERT INTO agent_action_approvers (id,org_id,action_id,user_id,decision)
       VALUES ($1,$2,$3,$4,'pending')`,
      [randomUUID(), orgId, restrictedAction, memberId],
    );
    await notFound(await response({ id: memberId, org_id: orgId, role: 'member' }, restrictedAction), ['RESTRICTED TASK']);

    const crossOrgTargetAction = await insertAction('OTH-1');
    await notFound(await response({ id: ownerId, org_id: orgId, role: 'owner' }, crossOrgTargetAction), [hiddenTaskTitle]);

    await updateModuleInstallation(owner, moduleSlug, { enabled: false });
    await notFound(await response({ id: ownerId, org_id: orgId, role: 'owner' }, prefixAction), [canonicalRecordLabel]);
  } finally {
    for (const id of [orgId, otherOrgId]) {
      for (const table of [
        'agent_action_approvers', 'action_receipts', 'module_mutation_receipts', 'agent_actions',
        'cross_references', 'audit_log', 'module_record_relations', 'module_records',
        'module_versions', 'module_installations', 'task_activity', 'tasks', 'projects',
        'agent_employees', 'org_members',
      ]) await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [id]);
      await client.query('DELETE FROM orgs WHERE id = $1', [id]);
    }
    await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[ownerId, memberId, guestId, employeeUserId, otherOwnerId]]);
    await client.end();
  }
});
