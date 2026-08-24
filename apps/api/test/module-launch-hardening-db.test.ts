import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import {
  archiveModuleRecord,
  createModuleRecord,
  createModuleSavedView,
  humanModuleActor,
  installModuleFromManifest,
  updateModuleInstallation,
  updateModuleRecord,
  updateModuleSavedView,
} from '../src/lib/module-service.js';
import { closeDb } from '../src/lib/db.js';
import { auditRoutes } from '../src/routes/audit.js';
import { moduleRoutes } from '../src/routes/modules.js';
import {
  digestModuleManifest,
  parseDeftModuleManifest,
  type DeftModuleManifestV1,
} from '@deft/shared/modules';

const TEST_DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const canRun = Boolean(
  TEST_DATABASE_URL && /(?:test|ci|acceptance)/i.test(new URL(TEST_DATABASE_URL).pathname),
);

after(async () => {
  await closeDb();
});

type SeededWorkspace = {
  orgId: string;
  userId: string;
  membershipId: string;
};

function manifestFor(
  suffix: string,
  version = '1.0.0',
  options: { statusField?: boolean; identity?: string } = {},
): DeftModuleManifestV1 {
  const identity = options.identity ?? suffix;
  return parseDeftModuleManifest({
    schema_version: '1',
    id: `com.deft.launch-${identity}`,
    slug: `launch-${identity}`,
    version,
    name: `Launch ${identity}`,
    collections: [{
      key: 'entries',
      name: 'Entries',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        ...(options.statusField === false
          ? []
          : [{
            key: 'status',
            label: 'Status',
            type: 'single_select' as const,
            required: false,
            options: [
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
            ],
          }]),
      ],
      views: [{
        key: 'table',
        name: 'Table',
        type: 'table',
        fields: options.statusField === false ? ['name'] : ['name', 'status'],
      }],
    }],
    navigation: { default_collection: 'entries', default_view: 'table' },
  });
}

async function seedWorkspace(client: pg.Client, label: string): Promise<SeededWorkspace> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const orgId = `launch-${label}-org-${suffix}`;
  const userId = `launch-${label}-user-${suffix}`;
  const membershipId = `launch-${label}-member-${suffix}`;
  await client.query(
    'INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)',
    [orgId, `Launch ${label} ${suffix}`, `launch-${label}-${suffix}`],
  );
  await client.query(
    'INSERT INTO users (id, email, name) VALUES ($1, $2, $3)',
    [userId, `${label}-${suffix}@example.test`, `Launch ${label}`],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES ($1, $2, $3, 'owner', true)`,
    [membershipId, orgId, userId],
  );
  return { orgId, userId, membershipId };
}

async function cleanupWorkspace(client: pg.Client, workspace: SeededWorkspace): Promise<void> {
  await client.query('DELETE FROM module_saved_views WHERE org_id = $1', [workspace.orgId]);
  await client.query('DELETE FROM module_record_relations WHERE org_id = $1', [workspace.orgId]);
  await client.query('DELETE FROM module_mutation_receipts WHERE org_id = $1', [workspace.orgId]);
  await client.query('DELETE FROM module_records WHERE org_id = $1', [workspace.orgId]);
  await client.query('DELETE FROM module_versions WHERE org_id = $1', [workspace.orgId]);
  await client.query('DELETE FROM module_installations WHERE org_id = $1', [workspace.orgId]);
  await client.query('DELETE FROM audit_log WHERE org_id = $1', [workspace.orgId]);
  await client.query('DELETE FROM org_members WHERE org_id = $1', [workspace.orgId]);
  await client.query('DELETE FROM orgs WHERE id = $1', [workspace.orgId]);
  await client.query('DELETE FROM users WHERE id = $1', [workspace.userId]);
}

async function backendPid(client: pg.Client): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return result.rows[0]!.pid;
}

async function waitUntilBlockedBy(
  observer: pg.Client,
  blockerPid: number,
  isSettled: () => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await observer.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity activity
         WHERE activity.pid <> pg_backend_pid()
           AND $1::int = ANY(pg_blocking_pids(activity.pid))
       ) AS blocked`,
      [blockerPid],
    );
    if (result.rows[0]?.blocked) return;
    if (isSettled()) {
      assert.fail(`${label} settled before reaching the expected database barrier`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${label} did not reach the expected database barrier`);
}

function observe<T>(promise: Promise<T>): { promise: Promise<T>; isSettled: () => boolean } {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  return { promise, isSettled: () => settled };
}

function actorFor(workspace: SeededWorkspace) {
  return humanModuleActor({
    orgId: workspace.orgId,
    userId: workspace.userId,
    role: 'owner',
    source: 'rest',
  });
}

test('record update and archive lock installation before the record row', { skip: !canRun }, async () => {
  assert.ok(TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await blocker.connect();
  const workspace = await seedWorkspace(client, 'lock-order');
  const actor = actorFor(workspace);
  const manifest = manifestFor(randomUUID().replaceAll('-', '').slice(0, 10));
  try {
    const installation = await installModuleFromManifest(actor, manifest, { source: 'sideloaded' });
    const created = await createModuleRecord(actor, {
      module_id: manifest.id,
      collection_key: 'entries',
      data: { name: 'Lock target', status: 'active' },
      expected_manifest_digest: installation.manifest_digest,
      idempotency_key: `lock-create-${randomUUID()}`,
    });
    assert.ok(created.record);
    const blockerPid = await backendPid(blocker);

    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM module_installations WHERE org_id = $1 AND id = $2 FOR UPDATE',
      [workspace.orgId, installation.id],
    );
    const updating = observe(updateModuleRecord(actor, {
      record_id: created.record.id,
      patch: { name: 'Updated after barrier' },
      unset_fields: [],
      relations: {},
      expected_revision: 1,
      expected_manifest_digest: installation.manifest_digest,
      idempotency_key: `lock-update-${randomUUID()}`,
    }));
    await waitUntilBlockedBy(blocker, blockerPid, updating.isSettled, 'module record update');
    // NOWAIT is the assertion: the service must not hold the record while it
    // waits for our installation row, otherwise this query fails/deadlocks.
    await blocker.query(
      'SELECT id FROM module_records WHERE org_id = $1 AND id = $2 FOR UPDATE NOWAIT',
      [workspace.orgId, created.record.id],
    );
    await blocker.query('ROLLBACK');
    const updated = await updating.promise;
    assert.equal(updated.record?.revision, 2);

    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM module_installations WHERE org_id = $1 AND id = $2 FOR UPDATE',
      [workspace.orgId, installation.id],
    );
    const archiving = observe(archiveModuleRecord(actor, {
      record_id: created.record.id,
      expected_revision: 2,
      expected_manifest_digest: installation.manifest_digest,
      idempotency_key: `lock-archive-${randomUUID()}`,
    }));
    await waitUntilBlockedBy(blocker, blockerPid, archiving.isSettled, 'module record archive');
    await blocker.query(
      'SELECT id FROM module_records WHERE org_id = $1 AND id = $2 FOR UPDATE NOWAIT',
      [workspace.orgId, created.record.id],
    );
    await blocker.query('ROLLBACK');
    const archived = await archiving.promise;
    assert.equal(archived.record?.archived_at === null, false);
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    await cleanupWorkspace(client, workspace);
    await blocker.end();
    await client.end();
  }
});

test('saved-view create and update serialize with manifest changes and revalidate after the barrier', { skip: !canRun }, async () => {
  assert.ok(TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await blocker.connect();
  const workspaces: SeededWorkspace[] = [];
  try {
    for (const operation of ['create', 'update'] as const) {
      const workspace = await seedWorkspace(client, `view-${operation}`);
      workspaces.push(workspace);
      const actor = actorFor(workspace);
      const identity = randomUUID().replaceAll('-', '').slice(0, 10);
      const oldManifest = manifestFor(identity, '1.0.0');
      const incompatibleManifest = manifestFor(identity, '1.1.0', {
        identity,
        statusField: false,
      });
      const incompatibleDigest = await digestModuleManifest(incompatibleManifest);
      const installation = await installModuleFromManifest(actor, oldManifest, { source: 'sideloaded' });
      const existing = operation === 'update'
        ? await createModuleSavedView(actor, oldManifest.slug, {
          collection_key: 'entries',
          name: 'Before barrier',
          config: {
            type: 'table',
            fields: ['name', 'status'],
            filters: [{ field: 'status', operator: 'eq', value: 'active' }],
          },
        })
        : null;

      const blockerPid = await backendPid(blocker);
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM module_installations WHERE org_id = $1 AND id = $2 FOR UPDATE',
        [workspace.orgId, installation.id],
      );
      const mutation = observe(operation === 'create'
        ? createModuleSavedView(actor, oldManifest.slug, {
          collection_key: 'entries',
          name: 'Created at barrier',
          config: {
            type: 'table',
            fields: ['name', 'status'],
            filters: [{ field: 'status', operator: 'eq', value: 'active' }],
          },
        })
        : updateModuleSavedView(actor, oldManifest.slug, existing!.id, {
          name: 'After barrier',
        }));
      await waitUntilBlockedBy(
        blocker,
        blockerPid,
        mutation.isSettled,
        `saved-view ${operation}`,
      );
      await blocker.query(
        `UPDATE module_versions
         SET is_active = false, activated_at = NULL, updated_at = now()
         WHERE org_id = $1 AND installation_id = $2 AND is_active = true`,
        [workspace.orgId, installation.id],
      );
      await blocker.query(
        `INSERT INTO module_versions
          (id, org_id, installation_id, version, manifest, manifest_digest,
           is_active, activated_at, created_by_actor_type, created_by_actor_id)
         VALUES
          (gen_random_uuid()::text, $1, $2, $3, $4::jsonb, $5,
           true, now(), 'human', $6)`,
        [
          workspace.orgId,
          installation.id,
          incompatibleManifest.version,
          JSON.stringify(incompatibleManifest),
          incompatibleDigest,
          workspace.userId,
        ],
      );
      await blocker.query('COMMIT');
      await assert.rejects(
        mutation.promise,
        (error: any) => error?.code === 'MODULE_VALIDATION_ERROR',
      );
      const views = await client.query<{ name: string }>(
        `SELECT name FROM module_saved_views
         WHERE org_id = $1 AND installation_id = $2 AND is_deleted = false
         ORDER BY name`,
        [workspace.orgId, installation.id],
      );
      assert.deepEqual(
        views.rows.map((row) => row.name),
        operation === 'create' ? [] : ['Before barrier'],
      );
    }
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    for (const workspace of workspaces) await cleanupWorkspace(client, workspace);
    await blocker.end();
    await client.end();
  }
});

test('lifecycle mutations lock and recheck current active owner/admin membership', { skip: !canRun }, async () => {
  assert.ok(TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const blocker = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await blocker.connect();
  const workspace = await seedWorkspace(client, 'lifecycle');
  const actor = actorFor(workspace);
  const identity = randomUUID().replaceAll('-', '').slice(0, 10);
  const manifest = manifestFor(identity, '1.0.0');
  try {
    const installation = await installModuleFromManifest(actor, manifest, { source: 'sideloaded' });
    const blockerPid = await backendPid(blocker);
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM org_members WHERE org_id = $1 AND user_id = $2 FOR UPDATE',
      [workspace.orgId, workspace.userId],
    );
    const configuring = observe(updateModuleInstallation(actor, manifest.slug, {
      agent_access: 'read',
    }));
    await waitUntilBlockedBy(
      blocker,
      blockerPid,
      configuring.isSettled,
      'module configure membership recheck',
    );
    await blocker.query(
      `UPDATE org_members SET role = 'member'
       WHERE org_id = $1 AND user_id = $2`,
      [workspace.orgId, workspace.userId],
    );
    await blocker.query('COMMIT');
    await assert.rejects(
      configuring.promise,
      (error: any) => error?.code === 'MODULE_ACCESS_DENIED',
    );
    const state = await client.query<{ agent_access: string }>(
      'SELECT agent_access FROM module_installations WHERE id = $1',
      [installation.id],
    );
    assert.equal(state.rows[0]?.agent_access, 'none');

    const app = new Hono();
    app.use('*', async (c, next) => {
      // Deliberately stale authenticated role: ModuleService must use the DB
      // membership row at the execution point, not this copied claim.
      c.set('user', {
        id: workspace.userId,
        org_id: workspace.orgId,
        email: 'stale-owner@example.test',
        role: 'owner',
      });
      await next();
    });
    app.route('/api/modules', moduleRoutes);

    const otherManifest = manifestFor(randomUUID().replaceAll('-', '').slice(0, 10));
    const installResponse = await app.request('/api/modules/sideload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(otherManifest),
    });
    assert.equal(installResponse.status, 403);
    assert.equal((await installResponse.json() as { code: string }).code, 'MODULE_ACCESS_DENIED');

    const nextManifest = manifestFor(identity, '1.1.0');
    const upgradeResponse = await app.request(`/api/modules/${manifest.slug}/upgrade`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'if-match': installation.manifest_digest,
      },
      body: JSON.stringify(nextManifest),
    });
    assert.equal(upgradeResponse.status, 403);
    assert.equal((await upgradeResponse.json() as { code: string }).code, 'MODULE_ACCESS_DENIED');
    const versions = await client.query<{ version: string }>(
      'SELECT version FROM module_versions WHERE installation_id = $1 ORDER BY version',
      [installation.id],
    );
    assert.deepEqual(versions.rows.map((row) => row.version), ['1.0.0']);
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    await cleanupWorkspace(client, workspace);
    await blocker.end();
    await client.end();
  }
});

test('audit route gates module entities and returns a safe record-activity projection', { skip: !canRun }, async () => {
  assert.ok(TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  const workspace = await seedWorkspace(client, 'audit');
  const owner = actorFor(workspace);
  const manifest = manifestFor(randomUUID().replaceAll('-', '').slice(0, 10));
  try {
    const installation = await installModuleFromManifest(owner, manifest, { source: 'sideloaded' });
    const created = await createModuleRecord(owner, {
      module_id: manifest.id,
      collection_key: 'entries',
      data: { name: 'Audited record', status: 'active' },
      expected_manifest_digest: installation.manifest_digest,
      idempotency_key: `audit-create-${randomUUID()}`,
    });
    assert.ok(created.record);
    await client.query(
      `INSERT INTO audit_log
         (id, org_id, actor_type, actor_id, action, entity_type, entity_id,
          before_state, after_state, metadata)
       VALUES
         (gen_random_uuid()::text, $1, 'human', $2, 'module_record.task_linked', 'module_record', $3,
          NULL, '{"task_id":"private-task"}'::jsonb,
          '{"edge_id":"private-edge","changed_fields":["name"]}'::jsonb),
         (gen_random_uuid()::text, $1, 'human', $2, 'workspace.other', 'workspace', 'workspace-entity',
          NULL, '{"visible":true}'::jsonb, '{}'::jsonb)`,
      [workspace.orgId, workspace.userId, created.record.resource_id],
    );

    function auditApp(role: 'owner' | 'member' | 'guest') {
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('user', {
          id: workspace.userId,
          org_id: workspace.orgId,
          email: `${role}@example.test`,
          role,
        });
        await next();
      });
      app.route('/api/audit', auditRoutes);
      return app;
    }

    const targeted = await auditApp('member').request(
      `/api/audit?entity_type=module_record&entity_id=${encodeURIComponent(created.record.resource_id)}`,
    );
    assert.equal(targeted.status, 200);
    const recordEvents = await targeted.json() as Array<Record<string, unknown>>;
    const linked = recordEvents.find((event) => event.action === 'module_record.task_linked');
    assert.ok(linked);
    assert.equal(linked.actor_name, 'Launch audit');
    assert.equal(Object.hasOwn(linked, 'before_state'), false);
    assert.equal(Object.hasOwn(linked, 'after_state'), false);
    assert.deepEqual(linked.metadata, { changed_fields: ['name'] });

    const broad = await auditApp('member').request('/api/audit?limit=200');
    assert.equal(broad.status, 200);
    const broadEvents = await broad.json() as Array<{ entity_type: string }>;
    assert.equal(broadEvents.some((event) => event.entity_type.startsWith('module_')), false);
    assert.equal(broadEvents.some((event) => event.entity_type === 'workspace'), true);

    const untargeted = await auditApp('owner').request('/api/audit?entity_type=module_record');
    assert.equal(untargeted.status, 400);
    assert.equal((await untargeted.json() as { code: string }).code, 'MODULE_VALIDATION_ERROR');

    const guest = await auditApp('guest').request(
      `/api/audit?entity_type=module_record&entity_id=${encodeURIComponent(created.record.resource_id)}`,
    );
    assert.equal(guest.status, 403);

    await updateModuleInstallation(owner, manifest.slug, { enabled: false });
    const disabledRecord = await auditApp('owner').request(
      `/api/audit?entity_type=module_record&entity_id=${encodeURIComponent(created.record.resource_id)}`,
    );
    assert.equal(disabledRecord.status, 409);
    assert.equal((await disabledRecord.json() as { code: string }).code, 'MODULE_DISABLED');

    const memberInstallation = await auditApp('member').request(
      `/api/audit?entity_type=module_installation&entity_id=${encodeURIComponent(installation.id)}`,
    );
    assert.equal(memberInstallation.status, 409);
    const ownerInstallation = await auditApp('owner').request(
      `/api/audit?entity_type=module_installation&entity_id=${encodeURIComponent(installation.id)}`,
    );
    assert.equal(ownerInstallation.status, 200);
    const installationEvents = await ownerInstallation.json() as Array<{ entity_type: string }>;
    assert.equal(installationEvents.length >= 2, true);
    assert.equal(installationEvents.every((event) => event.entity_type === 'module_installation'), true);
  } finally {
    await cleanupWorkspace(client, workspace);
    await client.end();
  }
});
