import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { moduleRoutes } from '../src/routes/modules.js';
import { moduleTaskLinkRoutes } from '../src/routes/module-task-links.js';
import { closeDb } from '../src/lib/db.js';
import { executeModuleOperationForActor } from '../src/lib/mcp-tools/modules.js';
import { executeToolCall } from '../src/lib/agent-context.js';
import { getBundledModule } from '../src/lib/bundled-modules.js';
import { humanModuleActor, installModuleFromManifest, upgradeModuleInstallationToManifest } from '../src/lib/module-service.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const databaseUrl = safeTestDatabaseUrl();
const canRun = Boolean(databaseUrl);
after(closeDb);

test('CRM routes atomically create relationships and page live inverse records within owner boundaries', { skip: !canRun }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const suffix = randomUUID();
  const orgId = `crm-${suffix}`;
  const userId = `crm-user-${suffix}`;
  const otherOrg = `crm-other-${suffix}`;
  const otherUser = `crm-other-user-${suffix}`;
  try {
    for (const [org, user] of [[orgId, userId], [otherOrg, otherUser]]) {
      await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1)', [org]);
      await client.query('INSERT INTO users (id, name, email) VALUES ($1, $1, $2)', [user, `${user}@example.test`]);
      await client.query("INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'owner', true)", [randomUUID(), org, user]);
    }
    const manifest = getBundledModule('contacts')!;
    const installation = await installModuleFromManifest(humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' }), manifest, { source: 'bundled' });
    const legacyManifest = structuredClone(manifest);
    legacyManifest.version = '1.1.0';
    for (const collection of legacyManifest.collections) delete collection.latest_related;
    const legacyActivities = legacyManifest.collections.find((collection) => collection.key === 'activities')!;
    legacyActivities.fields = legacyActivities.fields.filter((field) => field.key !== 'outcome');
    for (const view of legacyActivities.views ?? []) view.fields = view.fields.filter((key) => key !== 'outcome');
    legacyActivities.search!.fields = legacyActivities.search!.fields.filter((key) => key !== 'outcome');
    legacyActivities.search!.subtitle_fields = legacyActivities.search!.subtitle_fields!.filter((key) => key !== 'outcome');

    const legacyDeals = legacyManifest.collections.find((collection) => collection.key === 'deals')!;
    legacyDeals.fields = legacyDeals.fields.filter((field) => field.key !== 'currency');
    for (const view of legacyDeals.views ?? []) {
      view.fields = view.fields.filter((key) => key !== 'currency');
      if (view.type === 'board') delete view.summary;
    }
    const otherActor = humanModuleActor({ orgId: otherOrg, userId: otherUser, role: 'owner', source: 'rest' });
    let otherInstallation = await installModuleFromManifest(otherActor, legacyManifest, { source: 'bundled' });
    const appFor = (org: string, user: string, role = 'owner') => {
      const app = new Hono();
      app.use('*', async (c, next) => { c.set('user', { id: user, org_id: org, role, email: `${user}@example.test`, name: user }); await next(); });
      app.route('/api/modules', moduleRoutes);
      app.route('/api', moduleTaskLinkRoutes);
      return app;
    };
    const app = appFor(orgId, userId);
    for (const endpoint of ['import/preview', 'import/commit', 'merge/preview', 'merge/commit', 'records/missing/restore']) {
      const response = await app.request(`/api/modules/contacts/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
      });
      assert.equal(response.status, 400, `${endpoint} rejects malformed JSON as an invalid request`);
      assert.equal((await response.json()).code, 'VALIDATION_ERROR');
    }
    const legacyApp = appFor(otherOrg, otherUser);
    const legacyDigest = otherInstallation.manifest_digest;
    const legacyCreate = async (collection: string, data: Record<string, unknown>, relations = {}) => {
      const response = await legacyApp.request('/api/modules/contacts/records', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collection_key: collection, data, relations, expected_manifest_digest: legacyDigest, idempotency_key: randomUUID() }),
      });
      assert.equal(response.status, 201);
      return (await response.json()).record;
    };
    const legacyCompany = await legacyCreate('companies', { name: 'Legacy company' });
    const legacyDeal = await legacyCreate('deals', { name: 'Legacy deal', value: 12500.25, stage: 'proposal' }, { company_id: [legacyCompany.id] });
    const legacyContact = await legacyCreate('contacts', { name: 'Legacy contact', last_contacted_at: '1990-01-01T12:00:00Z' });
    const legacyActivity = await legacyCreate('activities', { subject: 'Historical call', kind: 'call', occurred_at: '2000-01-01T12:00:00Z' }, { contact_id: [legacyContact.id] });
    otherInstallation = await upgradeModuleInstallationToManifest(otherActor, 'contacts', manifest, {
      source: 'bundled', expected_active_manifest_digest: legacyDigest,
    });
    const upgradedActivity = (await (await legacyApp.request(`/api/modules/contacts/records/${legacyActivity.id}`)).json()).record;
    assert.deepEqual(upgradedActivity.data, legacyActivity.data, 'upgrade does not infer a historical completion outcome');
    assert.equal(upgradedActivity.revision, legacyActivity.revision);
    const upgradedContact = (await (await legacyApp.request(`/api/modules/contacts/records/${legacyContact.id}`)).json()).record;
    assert.equal(upgradedContact.data.last_contacted_at, '1990-01-01T12:00:00Z', 'manual contact date is preserved');
    const historicalLatest = await legacyApp.request(`/api/modules/contacts/records/${legacyContact.id}/latest-related`);
    assert.equal(historicalLatest.status, 200);
    assert.equal((await historicalLatest.json()).summaries[0].latest, null);
    const preservedResponse = await legacyApp.request(`/api/modules/contacts/records/${legacyDeal.id}`);
    assert.equal(preservedResponse.status, 200);
    const preservedDeal = (await preservedResponse.json()).record;
    assert.equal(preservedDeal.data.value, 12500.25);
    assert.equal(preservedDeal.data.currency, undefined, 'upgrade never assigns a currency to existing amounts');
    assert.equal(preservedDeal.revision, legacyDeal.revision);
    const relationRows = await client.query('SELECT target_record_id FROM module_record_relations WHERE source_record_id=$1 AND is_deleted=false', [legacyDeal.id]);
    assert.deepEqual(relationRows.rows.map((row) => row.target_record_id), [legacyCompany.id]);
    const setCurrency = (currency: string, digest = otherInstallation.manifest_digest) => legacyApp.request(`/api/modules/contacts/records/${legacyDeal.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { currency }, expected_revision: legacyDeal.revision, expected_manifest_digest: digest, idempotency_key: randomUUID() }),
    });
    assert.equal((await setCurrency('usd', legacyDigest)).status, 409);
    assert.equal((await setCurrency('invented')).status, 400);
    const currencyResponse = await setCurrency('inr');
    assert.equal(currencyResponse.status, 200);
    assert.equal((await currencyResponse.json()).record.data.currency, 'inr');
    for (let index = 0; index < 31; index++) {
      const response = await app.request('/api/modules/contacts/records', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collection_key: 'deals', data: { name: `Summary fixture ${index}`, stage: index < 28 ? 'lead' : 'won', ...(index < 30 ? { value: 0.1 } : {}), ...(index !== 29 ? { currency: index < 27 ? 'usd' : 'inr' } : {}) }, expected_manifest_digest: installation.manifest_digest, idempotency_key: randomUUID() }),
      });
      assert.equal(response.status, 201);
    }
    const summary = (target = app, extra = {}) => target.request('/api/modules/contacts/records/summary', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collection_key: 'deals', value_field: 'value', group_field: 'stage', unit_field: 'currency', ...extra }),
    });
    const summaryResponse = await summary();
    assert.equal(summaryResponse.status, 200);
    const pipelinePresets = manifest.collections.find((collection) => collection.key === 'deals')!.views!.find((view) => view.key === 'pipeline')!.quick_filters!;
    for (const preset of pipelinePresets) {
      const presetResult = await summary(app, { filters: preset.filters, today: '2026-09-09' });
      assert.equal(presetResult.status, 200);
      const count = (await presetResult.json()).groups.reduce((total: number, group: { record_count: string }) => total + Number(group.record_count), 0);
      assert.equal(count, preset.filters.some((filter) => filter.operator === 'date_relative') ? 0 : preset.key === 'closed' ? 3 : 28, `${preset.key} covers all matching records`);
    }
    const savedSummaryConfig = { type: 'board', group_by: 'stage', fields: ['name', 'value', 'currency'], filters: [{ field: 'stage', operator: 'eq', value: 'lead' }], summary: { value_field: 'value', unit_field: 'currency' } };
    const saveSummary = (config: unknown, name = 'My pipeline summary') => app.request('/api/modules/contacts/saved-views', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, collection_key: 'deals', config }),
    });
    const savedSummaryResponse = await saveSummary(savedSummaryConfig);
    assert.equal(savedSummaryResponse.status, 201);
    assert.deepEqual((await savedSummaryResponse.json()).view.config.summary, savedSummaryConfig.summary);
    const savedSummaryList = await app.request('/api/modules/contacts/saved-views?collection_key=deals');
    assert.deepEqual((await savedSummaryList.json()).views[0].config.summary, savedSummaryConfig.summary);
    const duplicateView = await saveSummary({ ...savedSummaryConfig, filters: [] });
    assert.equal(duplicateView.status, 409, 'duplicate view creation returns a recoverable conflict');
    assert.equal((await duplicateView.json()).code, 'MODULE_SAVED_VIEW_CONFLICT');
    const secondView = await saveSummary({ ...savedSummaryConfig, filters: [] }, 'Another pipeline');
    assert.equal(secondView.status, 201);
    const secondViewId = (await secondView.json()).view.id;
    const renameView = (name: string) => app.request(`/api/modules/contacts/saved-views/${secondViewId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    const duplicateRename = await renameView('My pipeline summary');
    assert.equal(duplicateRename.status, 409, 'duplicate rename returns the same conflict');
    assert.equal((await duplicateRename.json()).code, 'MODULE_SAVED_VIEW_CONFLICT');
    const afterConflict = (await (await app.request('/api/modules/contacts/saved-views?collection_key=deals')).json()).views;
    assert.equal(afterConflict.length, 2);
    assert.deepEqual(afterConflict.find((view: { name: string }) => view.name === 'My pipeline summary').config.filters, savedSummaryConfig.filters);
    assert.equal(afterConflict.find((view: { id: string }) => view.id === secondViewId).name, 'Another pipeline');
    assert.equal((await renameView('Recovered pipeline')).status, 200);

    assert.equal((await saveSummary({ ...savedSummaryConfig, summary: { value_field: 'name', unit_field: 'currency' } })).status, 400);
    const summaryGroups = (await summaryResponse.json()).groups;
    const usd = summaryGroups.find((group: { unit: string }) => group.unit === 'usd');
    assert.equal(usd.record_count, '27', 'summary includes records beyond the first list page');
    assert.equal(Number(usd.total), 2.7, 'decimal values are summed in PostgreSQL numeric');
    const unknown = summaryGroups.find((group: { unit: string | null }) => group.unit === null);
    assert.equal(unknown.valued_count, '1');
    assert.equal(unknown.total, null, 'unknown units cannot produce a monetary total');
    const filtered = await summary(app, { filters: [{ field: 'stage', operator: 'eq', value: 'lead' }] });
    assert.ok((await filtered.json()).groups.every((group: { group: string }) => group.group === 'lead'));
    assert.equal((await summary(app, { value_field: 'name' })).status, 400);
    assert.equal((await summary(appFor(orgId, userId, 'guest'))).status, 403);
    const otherSummary = await summary(legacyApp);
    assert.deepEqual((await otherSummary.json()).groups.map((group: { record_count: string }) => group.record_count), ['1'], 'summary is tenant-scoped');
    const noMatches = await summary(app, { search: 'NothingMatchesThisSummarySearch' });
    assert.deepEqual((await noMatches.json()).groups, []);
    const missingValue = summaryGroups.find((group: { group: string; unit: string }) => group.group === 'won' && group.unit === 'inr');
    assert.equal(missingValue.record_count, '2');
    assert.equal(missingValue.valued_count, '1', 'missing values are counted separately from zero');
    const emptyFilter = [{ field: 'currency', operator: 'is_empty', value: true }];
    const emptySummary = await summary(app, { filters: emptyFilter });
    assert.deepEqual((await emptySummary.json()).groups.map((group: { record_count: string }) => group.record_count), ['1']);
    const emptyList = await app.request('/api/modules/contacts/records/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collection_key: 'deals', filters: emptyFilter }) });
    assert.equal(emptyList.status, 200);
    assert.equal((await emptyList.json()).records.length, 1);
    // Relative attention is calendar-based, excludes missing dates and closed stages,
    // and uses the same predicate for paginated lists and all-page summaries.
    for (const [index, date] of [[0, '2026-09-08'], [1, '2026-09-09'], [2, '2026-09-15'], [3, '2026-09-16'], [28, '2026-09-08']] as const) {
      await client.query("UPDATE module_records SET data = data || jsonb_build_object('close_date', $1::text) WHERE org_id = $2 AND search_title = $3", [date, orgId, `Summary fixture ${index}`]);
    }
    for (const [period, expected] of [['past', 1], ['today', 1], ['next_7_days', 2]] as const) {
      const filters = [{ field: 'stage', operator: 'in', value: ['lead', 'qualified', 'proposal', 'negotiation'] }, { field: 'close_date', operator: 'date_relative', value: period }];
      const body = { collection_key: 'deals', filters, today: '2026-09-09' };
      const listed = await app.request('/api/modules/contacts/records/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(listed.status, 200);
      assert.equal((await listed.json()).records.length, expected, period);
      const counted = await summary(app, body);
      assert.equal(counted.status, 200);
      assert.equal((await counted.json()).groups.reduce((n: number, group: { record_count: string }) => n + Number(group.record_count), 0), expected, `${period} summary agrees`);
    }
    const relative = [{ field: 'close_date', operator: 'date_relative', value: 'today' }];
    assert.equal((await summary(app, { filters: relative })).status, 400, 'anchor is required');
    assert.equal((await summary(app, { filters: relative, today: '2026-02-30' })).status, 400, 'real calendar day required');
    assert.equal((await summary(app, { filters: [{ field: 'value', operator: 'date_relative', value: 'today' }], today: '2026-09-09' })).status, 400, 'numeric fields rejected');
    assert.equal((await summary(app, { filters: [{ field: 'close_date', operator: 'date_relative', value: 'whenever' }], today: '2026-09-09' })).status, 400);
    assert.equal((await summary(app, { filters: [{ field: 'close_date', operator: 'date_relative', value: ['today'] }], today: '2026-09-09' })).status, 400);
    const relativeSaved = await saveSummary({ ...savedSummaryConfig, filters: relative }, 'Relative closing date');
    assert.equal(relativeSaved.status, 201);
    assert.deepEqual((await relativeSaved.json()).view.config.filters, relative, 'saved views retain relative intent');
    assert.equal((await summary(app, { filters: [{ field: 'currency', operator: 'is_empty', value: 'yes' }] })).status, 400);
    assert.equal((await summary(app, { filters: [{ field: 'company_id', operator: 'is_empty', value: true }] })).status, 400);
    await client.query("UPDATE module_records SET is_deleted=true, deleted_at=now(), deleted_by_actor_type='human', deleted_by_actor_id=$2 WHERE org_id=$1 AND collection_key='deals' AND data->>'name'='Summary fixture 0'", [orgId, userId]);
    const afterArchive = (await (await summary()).json()).groups.find((group: { unit: string }) => group.unit === 'usd');
    assert.equal(afterArchive.record_count, '26');
    assert.equal(Number(afterArchive.total), 2.6);
    const post = (collection: string, name: string, relations: Record<string, string[]> = {}, key = randomUUID()) => app.request('/api/modules/contacts/records', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collection_key: collection, data: { name }, relations, expected_manifest_digest: installation.manifest_digest, idempotency_key: key }),
    });
    const companyResponse = await post('companies', 'Acme');
    assert.equal(companyResponse.status, 201);
    const company = (await companyResponse.json()).record;
    const projectId = randomUUID();
    await client.query('INSERT INTO projects (id,org_id,name,prefix) VALUES ($1,$2,$3,$4)', [projectId, orgId, 'Customer success', 'CS']);
    const taskIds: string[] = [];
    for (let index = 0; index < 103; index++) {
      const id = randomUUID(); taskIds.push(id);
      const restricted = index === 102;
      await client.query('INSERT INTO tasks (id,org_id,project_id,number,title,status,due_date,created_by,assignee_id,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, orgId, projectId, index + 1, `Follow-up ${index}`, index === 101 ? 'todo' : restricted ? 'todo' : 'done', index === 101 ? '2026-09-09' : '2026-01-01', restricted ? otherUser : userId, restricted ? otherUser : userId, restricted ? { visibility: 'restricted' } : null]);
      await client.query('INSERT INTO cross_references (id,org_id,source_type,source_id,target_type,target_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), orgId, 'module_record', `module_record:${company.id}`, 'task', id, userId]);
    }
    const taskUrl = `/api/modules/contacts/records/${company.id}/tasks`;
    const tasksResponse = await app.request(taskUrl);
    assert.equal(tasksResponse.status, 200);
    const taskLinks = (await tasksResponse.json()).links;
    assert.equal(taskLinks.length, 100);
    assert.equal(taskLinks[0].task_id, taskIds[101], 'open task is prioritized before the bounded limit');
    assert.equal(taskLinks[0].assignee_id, userId);
    assert.equal(taskLinks[0].assignee_name, userId);
    assert.match(taskLinks[0].due_date, /^2026-09-09/);
    assert.ok(!taskLinks.some((link: { task_id: string }) => link.task_id === taskIds[102]), 'restricted task is hidden');
    assert.equal((await appFor(otherOrg, otherUser).request(taskUrl)).status, 404);
    const linkTask = (taskId: string) => app.request(`/api/tasks/${taskId}/module-records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resource_id: `module_record:${company.id}` }) });
    assert.equal((await linkTask(taskIds[101]!)).status, 200, 'link retry does not create another edge');
    assert.equal((await app.request(`/api/tasks/${taskIds[101]}/module-records/${company.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await linkTask(taskIds[101]!)).status, 201, 'an existing task can be linked from record context');
    assert.equal((await linkTask(taskIds[102]!)).status, 404, 'restricted task cannot be linked by an unrelated actor');
    const queueUrl = '/api/modules/contacts/task-queue?today=2026-09-09';
    const company2 = (await (await post('companies', 'Second company')).json()).record;
    const extraCompanyIds: string[] = [];
    for (const name of ['Third company', 'Fourth company']) {
      const extraCompany = (await (await post('companies', name)).json()).record;
      extraCompanyIds.push(extraCompany.id);
      const response = await app.request(`/api/tasks/${taskIds[101]}/module-records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resource_id: `module_record:${extraCompany.id}` }) });
      assert.equal(response.status, 201);
    }
    await client.query('INSERT INTO cross_references (id,org_id,source_type,source_id,target_type,target_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), orgId, 'module_record', `module_record:${company2.id}`, 'task', taskIds[101], userId]);
    for (let index = 0; index < 4; index++) {
      await client.query("UPDATE tasks SET status='todo', due_date=$2, assignee_id=$3 WHERE id=$1", [taskIds[index], ['2026-09-08', '2026-09-09', '2026-09-10', null][index], index === 1 ? null : userId]);
    }
    const readQueue = async (query = '') => {
      const response = await app.request(`${queueUrl}${query}`);
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      return response.json();
    };
    const noTaskCompany = (await (await post('companies', 'No task company')).json()).record;
    const nextTasks = (recordIds: string[], target = app) => target.request('/api/modules/contacts/records/next-tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ record_ids: recordIds }),
    });
    const batchResponse = await nextTasks([company.id, company2.id, noTaskCompany.id, legacyCompany.id, randomUUID()]);
    assert.equal(batchResponse.status, 200);
    const batch = await batchResponse.json();
    assert.deepEqual(new Set(batch.record_ids), new Set([company.id, company2.id, noTaskCompany.id]));
    assert.equal(batch.links.length, 2, 'one open task per linked record, no invented empty tasks');
    for (const recordId of [company.id, company2.id]) {
      const detail = (await (await app.request(`/api/modules/contacts/records/${recordId}/tasks`)).json()).links;
      const { record_id, ...next } = batch.links.find((link: { record_id: string }) => link.record_id === recordId);
      assert.equal(record_id, recordId);
      assert.deepEqual(next, detail.find((task: { status: string }) => !['done', 'cancelled', 'won', 'lost'].includes(task.status)), 'batch uses detail visibility and ordering');
    }
    assert.equal(batch.links.find((link: { record_id: string }) => link.record_id === company.id).task_id, taskIds[0]);
    assert.equal((await nextTasks([company.id], appFor(orgId, userId, 'guest'))).status, 403);
    const foreignBatch = await nextTasks([company.id], legacyApp);
    assert.equal(foreignBatch.status, 200);
    assert.deepEqual(await foreignBatch.json(), { record_ids: [], links: [] });
    for (const ids of [[], [company.id, company.id], Array.from({ length: 101 }, () => randomUUID())]) {
      assert.equal((await nextTasks(ids)).status, 400, 'batch input is bounded and unique');
    }
    await client.query("UPDATE module_records SET is_deleted=true, deleted_at=now(), deleted_by_actor_type='human', deleted_by_actor_id=$2 WHERE id=$1", [noTaskCompany.id, userId]);
    assert.deepEqual(await (await nextTasks([noTaskCompany.id])).json(), { record_ids: [], links: [] });
    const openQueue = await readQueue();
    assert.equal(openQueue.tasks.length, 5, 'multiple record references do not duplicate tasks');
    assert.equal(openQueue.tasks[0].task_id, taskIds[0]);
    assert.equal(openQueue.tasks.at(-1).task_id, taskIds[3]);
    assert.equal(openQueue.tasks.find((task: { task_id: string }) => task.task_id === taskIds[101]).records.length, 3);
    assert.equal(openQueue.tasks.find((task: { task_id: string }) => task.task_id === taskIds[101]).record_count, 4);
    assert.deepEqual((await readQueue('&bucket=overdue')).tasks.map((task: { task_id: string }) => task.task_id), [taskIds[0]]);
    assert.deepEqual(new Set((await readQueue('&bucket=today')).tasks.map((task: { task_id: string }) => task.task_id)), new Set([taskIds[1], taskIds[101]]));
    assert.deepEqual((await readQueue('&bucket=upcoming')).tasks.map((task: { task_id: string }) => task.task_id), [taskIds[2]]);
    assert.deepEqual((await readQueue('&bucket=undated')).tasks.map((task: { task_id: string }) => task.task_id), [taskIds[3]]);
    assert.equal((await readQueue('&assignee=mine')).tasks.length, 4);
    assert.deepEqual((await readQueue('&assignee=unassigned')).tasks.map((task: { task_id: string }) => task.task_id), [taskIds[1]]);
    const queueIds: string[] = [];
    let queueOffset: number | null = 0;
    while (queueOffset !== null) {
      const queuePage = await readQueue(`&limit=2&offset=${queueOffset}`);
      queueIds.push(...queuePage.tasks.map((task: { task_id: string }) => task.task_id));
      queueOffset = queuePage.next_offset;
    }
    assert.equal(queueIds.length, 5); assert.equal(new Set(queueIds).size, 5);
    const closedQueue = await readQueue('&bucket=closed');
    assert.equal(closedQueue.tasks.length, 25); assert.equal(closedQueue.next_offset, 25);
    assert.ok(closedQueue.tasks.every((task: { status: string }) => task.status === 'done'));
    assert.equal((await appFor(orgId, userId, 'guest').request(queueUrl)).status, 403);
    assert.equal((await appFor(otherOrg, otherUser).request(queueUrl)).status, 200);
    assert.deepEqual((await (await appFor(otherOrg, otherUser).request(queueUrl)).json()).tasks, []);
    for (const invalid of ['&limit=101', '&offset=-1', '&bucket=unknown', '&assignee=someone']) assert.equal((await app.request(`${queueUrl}${invalid}`)).status, 400);
    assert.equal((await app.request(queueUrl.replace('2026-09-09', '2026-02-30'))).status, 400);
    await client.query("UPDATE module_records SET is_deleted=true, deleted_at=now(), deleted_by_actor_type='human', deleted_by_actor_id=$2 WHERE id=ANY($1::text[])", [[company2.id, ...extraCompanyIds], userId]);
    assert.equal((await readQueue()).tasks.find((task: { task_id: string }) => task.task_id === taskIds[101]).records.length, 1);
    await client.query('UPDATE tasks SET is_deleted=true WHERE id=$1', [taskIds[101]]);
    assert.ok(!(await (await app.request(taskUrl)).json()).links.some((link: { task_id: string }) => link.task_id === taskIds[101]));
    assert.deepEqual(await (await nextTasks([company2.id, ...extraCompanyIds])).json(), { record_ids: [], links: [] }, 'archived sources cannot expose linked tasks');
    await client.query("UPDATE tasks SET status='done' WHERE id=ANY($1::text[])", [taskIds.slice(0, 4)]);
    assert.deepEqual(await (await nextTasks([company.id])).json(), { record_ids: [company.id], links: [] }, 'closed, deleted and hidden tasks never become next actions');
    await client.query("UPDATE tasks SET status='todo' WHERE id=ANY($1::text[])", [taskIds.slice(0, 4)]);
    await client.query('UPDATE projects SET is_deleted=true WHERE id=$1', [projectId]);
    assert.deepEqual(await (await nextTasks([company.id])).json(), { record_ids: [company.id], links: [] }, 'archived projects cannot expose tasks');
    await client.query('UPDATE projects SET is_deleted=false WHERE id=$1', [projectId]);

    const ids: string[] = [];
    for (const name of ['Ada', 'Bea', 'Cora']) {
      const key = randomUUID();
      const response = await post('contacts', name, { company_id: [company.id] }, key);
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
      ids.push((await response.json()).record.id);
      if (name === 'Ada') {
        assert.equal((await post('contacts', name, { company_id: [company.id] }, key)).status, 200);
      }
    }
    const searchContacts = async (search: string) => {
      const response = await app.request('/api/modules/contacts/records/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collection_key: 'contacts', search }) });
      assert.equal(response.status, 200);
      return (await response.json()).records;
    };
    const createDraft = (recipients: string[]) => app.request('/api/modules/contacts/records', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collection_key: 'outreach', data: { name: 'Pilot invitation', subject: 'Review our pilot', body: 'A draft for selected contacts.' }, relations: { contacts: recipients }, expected_manifest_digest: installation.manifest_digest, idempotency_key: randomUUID() }),
    });
    const draft = await createDraft(ids.slice(0, 2));
    assert.equal(draft.status, 201);
    assert.equal((await draft.json()).record.data.status, 'draft');
    assert.equal((await createDraft([legacyCompany.id])).status, 400, 'foreign outreach recipients are rejected');
    const contactDrafts = await app.request(`/api/modules/contacts/records/${ids[0]}/incoming-relations?collection_key=outreach&field_key=contacts`);
    assert.equal(contactDrafts.status, 200);
    assert.equal((await contactDrafts.json()).records[0].data.name, 'Pilot invitation');
    assert.equal((await searchContacts('Acme')).length, 3, 'contacts are found by the current linked company title');
    const renamed = await app.request(`/api/modules/contacts/records/${company.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: { name: 'Renamed 100% Company' }, expected_revision: company.revision, expected_manifest_digest: installation.manifest_digest, idempotency_key: randomUUID() }) });
    assert.equal(renamed.status, 200);
    assert.equal((await searchContacts('Renamed 100% Company')).length, 3);
    assert.equal((await searchContacts('Acme')).length, 0, 'old company title is not copied into contacts');
    assert.equal((await searchContacts('Renamed 100_ Company')).length, 0, 'wildcards remain literal');
    const foreignSearch = await legacyApp.request('/api/modules/contacts/records/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collection_key: 'contacts', search: 'Renamed 100% Company' }) });
    assert.equal(foreignSearch.status, 200);
    assert.deepEqual((await foreignSearch.json()).records, [], 'relation search cannot cross tenants');
    const relatedDeal = await post('deals', 'Related opportunity', { company_id: [company.id] });
    assert.equal(relatedDeal.status, 201);
    const relatedSummary = await summary(app, { search: 'Renamed 100% Company' });
    assert.equal(relatedSummary.status, 200);
    assert.deepEqual((await relatedSummary.json()).groups.map((group: { record_count: string }) => group.record_count), ['1'], 'summary uses the same live relation search');
    const incoming = `/api/modules/contacts/records/${company.id}/incoming-relations?collection_key=contacts&field_key=company_id&limit=2`;
    const first = await app.request(incoming);
    assert.equal(first.status, 200);
    const page = await first.json();
    assert.deepEqual(page.records.map((r: { data: { name: string } }) => r.data.name), ['Ada', 'Bea']);
    assert.ok(page.next_cursor);
    const second = await app.request(`${incoming}&cursor=${encodeURIComponent(page.next_cursor)}`);
    const secondPage = await second.json();
    assert.deepEqual(secondPage.records.map((r: { id: string }) => r.id), [ids[2]]);
    assert.equal(secondPage.next_cursor, null);
    const activityIds: string[] = [];
    for (const [subject, occurredAt] of [
      ['Alphabetically first, older', '2026-09-09T10:00:00+05:30'],
      ['Z newest', '2026-09-09T08:00:00Z'],
      ['Undated', null],
      ['Same instant', '2026-09-09T13:30:00+05:30'],
    ]) {
      const response = await app.request('/api/modules/contacts/records', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collection_key: 'activities', data: { subject, ...(occurredAt ? { occurred_at: occurredAt } : {}) }, relations: { company_id: [company.id] }, expected_manifest_digest: installation.manifest_digest, idempotency_key: randomUUID() }),
      });
      assert.equal(response.status, 201);
      activityIds.push((await response.json()).record.id);
    }
    const historyUrl = `/api/modules/contacts/records/${company.id}/incoming-relations?collection_key=activities&field_key=company_id&date_field=occurred_at&limit=2`;
    const history = await (await app.request(historyUrl)).json();
    assert.deepEqual(history.records.map((r: { id: string }) => r.id), [activityIds[1], activityIds[3]].sort());
    const older = await (await app.request(`${historyUrl}&cursor=${encodeURIComponent(history.next_cursor)}`)).json();
    assert.deepEqual(older.records.map((r: { id: string }) => r.id), [activityIds[0], activityIds[2]]);
    assert.equal(older.next_cursor, null);
    for (const invalid of ['subject', 'company_id', 'missing']) {
      assert.equal((await app.request(historyUrl.replace('date_field=occurred_at', `date_field=${invalid}`))).status, 400);
    }
    assert.equal((await appFor(otherOrg, otherUser).request(historyUrl)).status, 404);
    assert.equal((await appFor(orgId, userId, 'guest').request(historyUrl)).status, 403);
    const latestUrl = `/api/modules/contacts/records/${ids[1]}/latest-related`;
    const readLatest = async () => {
      const response = await app.request(latestUrl);
      assert.equal(response.status, 200);
      return (await response.json()).summaries[0].latest;
    };
    assert.equal(await readLatest(), null, 'old unclassified activities do not imply completed contact');
    const logInteraction = async (subject: string, kind: string, outcome?: string, occurred_at?: string) => {
      const response = await app.request('/api/modules/contacts/records', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collection_key: 'activities', data: { subject, kind, ...(outcome ? { outcome } : {}), ...(occurred_at ? { occurred_at } : {}) }, relations: { contact_id: [ids[1]] }, expected_manifest_digest: installation.manifest_digest, idempotency_key: randomUUID() }) });
      assert.equal(response.status, 201);
      return (await response.json()).record;
    };
    const completedCall = await logInteraction('Completed call', 'call', 'completed', '2000-01-03T12:00:00Z');
    const olderMeeting = await logInteraction('Older meeting created later', 'meeting', 'completed', '2000-01-01T12:00:00Z');
    await logInteraction('Internal note', 'note', 'completed', '2000-01-05T12:00:00Z');
    await logInteraction('Planned call', 'call', 'planned', '2000-01-06T12:00:00Z');
    await logInteraction('Cancelled call', 'call', 'cancelled', '2000-01-07T12:00:00Z');
    await logInteraction('Unclassified email', 'email', undefined, '2000-01-08T12:00:00Z');
    await logInteraction('Future meeting', 'meeting', 'completed', '2999-01-01T12:00:00Z');
    await logInteraction('Undated email', 'email', 'completed');
    assert.equal((await readLatest()).record.id, completedCall.id);
    assert.equal((await readLatest()).date, '2000-01-03T12:00:00Z');
    const mcpActor = humanModuleActor({ orgId, userId, role: 'owner', source: 'mcp', scopes: ['read:modules'] });
    const incomingInput = { record_id: ids[0], collection_key: 'outreach', field_key: 'contacts', limit: 1 };
    const incomingOperation = await executeModuleOperationForActor('module_record_incoming', mcpActor, incomingInput) as any;
    assert.equal(incomingOperation.items[0].data.name, 'Pilot invitation');
    assert.equal(incomingOperation.next_cursor, null);
    const latestOperation = await executeModuleOperationForActor('module_record_latest_related', mcpActor, { record_id: ids[1] }) as any;
    assert.equal(latestOperation.summaries[0].latest.record.id, completedCall.id);
    for (const operation of ['module_record_incoming', 'module_record_latest_related'] as const) {
      const input = operation === 'module_record_incoming' ? incomingInput : { record_id: ids[1] };
      await assert.rejects(executeModuleOperationForActor(operation, humanModuleActor({ orgId: otherOrg, userId: otherUser, role: 'owner', source: 'mcp', scopes: ['read:modules'] }), input));
      await assert.rejects(executeModuleOperationForActor(operation, humanModuleActor({ orgId, userId, role: 'owner', source: 'mcp', scopes: [] }), input));
      await assert.rejects(executeToolCall(operation, input, orgId, userId), /Agent access is not enabled/);
    }
    await client.query("UPDATE module_installations SET agent_access='read' WHERE id=$1 AND org_id=$2", [installation.id, orgId]);
    const deftyIncoming = await executeToolCall('module_record_incoming', incomingInput, orgId, userId);
    assert.equal((deftyIncoming.result as any).items[0].id, incomingOperation.items[0].id);
    assert.match(deftyIncoming.citations[0].url!, /^\/modules\/contacts\/outreach\//);
    const deftyLatest = await executeToolCall('module_record_latest_related', { record_id: ids[1] }, orgId, userId);
    assert.equal((deftyLatest.result as any).summaries[0].latest.record.id, completedCall.id);
    await client.query("UPDATE module_installations SET agent_access='none' WHERE id=$1 AND org_id=$2", [installation.id, orgId]);
    const companyLatest = await app.request(`/api/modules/contacts/records/${company.id}/latest-related`);
    assert.equal((await companyLatest.json()).summaries[0].latest, null, 'contact activities are not silently rolled up to company');
    const editInteraction = async (id: string, body: Record<string, unknown>) => {
      const current = (await (await app.request(`/api/modules/contacts/records/${id}`)).json()).record;
      return app.request(`/api/modules/contacts/records/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, expected_revision: current.revision, expected_manifest_digest: installation.manifest_digest, idempotency_key: randomUUID() }) });
    };
    assert.equal((await editInteraction(olderMeeting.id, { patch: { occurred_at: '2000-01-04T12:00:00Z' } })).status, 200);
    assert.equal((await readLatest()).record.id, olderMeeting.id, 'editing occurrence recomputes latest');
    assert.equal((await editInteraction(olderMeeting.id, { relations: { contact_id: [] } })).status, 200);
    assert.equal((await readLatest()).record.id, completedCall.id, 'unlink recomputes latest');
    assert.equal((await editInteraction(completedCall.id, { patch: { outcome: 'cancelled' } })).status, 200);
    assert.equal(await readLatest(), null);
    assert.equal((await editInteraction(completedCall.id, { patch: { outcome: 'completed' } })).status, 200);
    await client.query("UPDATE module_records SET is_deleted=true, deleted_at=now(), deleted_by_actor_type='human', deleted_by_actor_id=$2 WHERE id=$1", [completedCall.id, userId]);
    assert.equal(await readLatest(), null, 'archived interaction no longer counts');
    assert.equal((await appFor(otherOrg, otherUser).request(latestUrl)).status, 404);
    assert.equal((await appFor(orgId, userId, 'guest').request(latestUrl)).status, 403);
    const patch = (body: Record<string, unknown>) => app.request(`/api/modules/contacts/records/${ids[2]}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, expected_manifest_digest: installation.manifest_digest, idempotency_key: randomUUID() }),
    });
    assert.equal((await patch({ patch: { role: 'Buyer' }, expected_revision: 1 })).status, 200);
    assert.equal((await patch({ relations: { company_id: [] }, expected_revision: 1 })).status, 409);
    assert.equal((await (await app.request(incoming)).json()).records.length, 2);
    const relationRead = await (await app.request(`/api/modules/contacts/records/${ids[2]}/relations`)).json();
    assert.equal(relationRead.relations.find((group: { field_key: string }) => group.field_key === 'company_id').records[0].id, company.id);
    assert.equal((await patch({ relations: { company_id: [] }, expected_revision: 2 })).status, 200);
    const cleared = await (await app.request(incoming)).json();
    assert.equal(cleared.next_cursor, null);
    assert.equal((await patch({ relations: { company_id: [company.id] }, expected_revision: 3 })).status, 200);
    // Invalid target rolls back the record insert as well as the edge.
    const invalid = await post('contacts', 'Must roll back', { company_id: ['missing-target'] });
    assert.equal(invalid.status, 400);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM module_records WHERE org_id=$1 AND data->>'name'='Must roll back'", [orgId])).rows[0].count, 0);
    const foreignCompanyResponse = await appFor(otherOrg, otherUser).request('/api/modules/contacts/records', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collection_key: 'companies', data: { name: 'Private company' }, expected_manifest_digest: otherInstallation.manifest_digest, idempotency_key: randomUUID() }),
    });
    assert.equal(foreignCompanyResponse.status, 201);
    const foreignCompany = (await foreignCompanyResponse.json()).record;
    assert.equal((await post('contacts', 'Foreign relation rejected', { company_id: [foreignCompany.id] })).status, 400);
    assert.equal((await post('contacts', 'Wrong collection rejected', { company_id: [ids[0]!] })).status, 400);
    assert.equal((await app.request(incoming.replace('field_key=company_id', 'field_key=name'))).status, 400);
    assert.equal((await app.request(`${incoming}&cursor=bad-cursor`)).status, 400);
    assert.equal((await app.request(incoming.replace('limit=2', 'limit=101'))).status, 400);
    assert.equal((await appFor(otherOrg, otherUser).request(incoming)).status, 404);
    assert.equal((await appFor(orgId, userId, 'guest').request(incoming)).status, 403);
    // Route slug/installation mismatch is not allowed even in the same org.
    const alternate = await installModuleFromManifest(humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' }), { ...manifest, id: `test.crm-${suffix}`, slug: `crm-${suffix}` }, { source: 'sideloaded' });
    assert.equal((await app.request(incoming.replace('/contacts/', `/${alternate.slug}/`))).status, 404);
    // A source archive and a removed edge both disappear from reverse reads.
    await client.query("UPDATE module_records SET is_deleted=true, deleted_at=now(), deleted_by_actor_type='human', deleted_by_actor_id=$2 WHERE id=$1", [ids[0], userId]);
    await client.query("UPDATE module_record_relations SET is_deleted=true, deleted_at=now(), deleted_by_actor_type='human', deleted_by_actor_id=$2 WHERE source_record_id=$1", [ids[1], userId]);
    const remaining = await (await app.request(incoming)).json();
    assert.equal((await searchContacts('Renamed 100% Company')).length, 1, 'archived sources and removed edges stop matching');
    assert.deepEqual(remaining.records.map((r: { id: string }) => r.id), [ids[2]]);
    await client.query("UPDATE module_records SET is_deleted=true, deleted_at=now(), deleted_by_actor_type='human', deleted_by_actor_id=$2 WHERE id=$1", [company.id, userId]);
    assert.equal((await app.request(incoming)).status, 404);
    assert.equal((await searchContacts('Renamed 100% Company')).length, 0, 'archived company cannot produce matches');
    await client.query('UPDATE module_records SET is_deleted=false, deleted_at=NULL, deleted_by_actor_type=NULL, deleted_by_actor_id=NULL WHERE id=$1', [company.id]);
    await client.query('UPDATE module_installations SET is_enabled=false, disabled_at=now() WHERE id=$1', [installation.id]);
    assert.equal((await app.request(incoming)).status, 409);
    assert.equal((await app.request(queueUrl)).status, 409);
    assert.equal((await summary()).status, 409);
    assert.equal((await app.request(latestUrl)).status, 409);
    assert.notEqual(otherInstallation.id, installation.id);
  } finally {
    try {
      for (const table of ['cross_references', 'tasks', 'projects', 'module_saved_views', 'module_record_relations', 'module_mutation_receipts', 'module_records', 'module_versions', 'module_installations', 'audit_log', 'org_members']) {
        await client.query(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [[orgId, otherOrg]]);
      }
      await client.query('DELETE FROM orgs WHERE id = ANY($1::text[])', [[orgId, otherOrg]]);
      await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[userId, otherUser]]);
    } finally {
      await client.end();
    }
  }
});
