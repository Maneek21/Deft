import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { strToU8, zipSync } from 'fflate';
import { executeAction } from '../src/lib/agent-actions.js';
import { parseCsv } from '../src/lib/module-csv-import.js';
import { workspacePlanImport } from '../src/lib/mcp-tools/workspace-plan-import.js';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';
import {
  compileMessageWorkspacePlanImport,
  parseWorkspacePlanTable,
  parseWorkspacePlanXlsx,
  WORKSPACE_PLAN_IMPORT_ACTION,
} from '../src/lib/workspace-plan-import.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let orgId = '';
let humanUserId = '';
let agentUserId = '';
let employeeId = '';
let spaceId = '';
let messageId = '';
let fileId = '';
let existingProjectId = '';

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function toolPayload(result: ToolResult): any {
  return JSON.parse(result.content[0]?.text ?? 'null');
}

function employeeContext(): ToolContext {
  return {
    org_id: orgId,
    employee_id: employeeId,
    employee_slug: `plan-import-agent-${suffix}`,
    trust_level: 'autonomous',
  };
}

function xlsxBytes(options: { formula?: boolean } = {}): Uint8Array {
  const cell = (reference: string, value: string) =>
    `<c r="${reference}" t="inlineStr"><is><t>${value}</t></is></c>`;
  const taskCell = options.formula
    ? '<c r="C2"><f>CONCAT("Ship", " launch")</f><v>Ship launch</v></c>'
    : cell('C2', 'Ship launch');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1">${cell('A1', 'Project')}${cell('B1', 'Project Prefix')}${cell('C1', 'Task')}${cell('D1', 'Priority')}</row>
      <row r="2">${cell('A2', 'Mobile Launch')}${cell('B2', 'MOB')}${taskCell}${cell('D2', 'high')}</row>
    </sheetData></worksheet>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      </Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets><sheet name="Plan" sheetId="1" r:id="rId1"/></sheets>
      </workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      </Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  };
  return zipSync(files, { level: 6 });
}

before(async () => {
  const csv = [
    'Project,Project Prefix,Project Description,Task,Task Description,Priority,Assignee,Due Date',
    'Existing Plan,EX,Existing work,Audit launch plan,Check scope,high,Plan Human,2026-09-01',
    'New Launch,LNCH,Launch workspace,Prepare launch,Create the checklist,p2,Plan Human,2026-09-02',
    'New Launch,LNCH,Launch workspace,Ship launch,Release after review,urgent,,2026-09-05',
  ].join('\n');
  await withClient(async (client) => {
    const org = await client.query<{ id: string }>(
      `INSERT INTO orgs (id, name, slug) VALUES (gen_random_uuid()::text, 'Workspace plan import', $1) RETURNING id`,
      [`workspace-plan-import-${suffix}`],
    );
    orgId = org.rows[0]!.id;
    const users = await client.query<{ id: string; name: string }>(
      `INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES
        (gen_random_uuid()::text, $1, 'Plan Human', 'human', false, true),
        (gen_random_uuid()::text, $2, 'Plan Agent', 'agent', true, true)
       RETURNING id, name`,
      [`plan-human-${suffix}@test.local`, `plan-agent-${suffix}@test.local`],
    );
    humanUserId = users.rows.find((row) => row.name === 'Plan Human')!.id;
    agentUserId = users.rows.find((row) => row.name === 'Plan Agent')!.id;
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES
        (gen_random_uuid()::text, $1, $2, 'owner', true),
        (gen_random_uuid()::text, $1, $3, 'member', true)`,
      [orgId, humanUserId, agentUserId],
    );
    const space = await client.query<{ id: string }>(
      `INSERT INTO spaces (id, org_id, name, type, created_by) VALUES (gen_random_uuid()::text, $1, $2, 'public', $3) RETURNING id`,
      [orgId, `workspace-plan-${suffix}`, humanUserId],
    );
    spaceId = space.rows[0]!.id;
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id) VALUES
        (gen_random_uuid()::text, $1, $2), (gen_random_uuid()::text, $1, $3)`,
      [spaceId, humanUserId, agentUserId],
    );
    const project = await client.query<{ id: string }>(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES (gen_random_uuid()::text, $1, 'Existing Plan', 'EX', $2, 0) RETURNING id`,
      [orgId, humanUserId],
    );
    existingProjectId = project.rows[0]!.id;
    const employee = await client.query<{ id: string }>(
      `INSERT INTO agent_employees (
         id, org_id, user_id, name, slug, role, system_prompt, project_ids,
         trust_level, max_daily_actions, created_by, is_active, is_byoa
       ) VALUES (
         gen_random_uuid()::text, $1, $2, 'Plan Agent', $3, 'project_manager',
         'test', ARRAY[]::text[], 'autonomous', 50, $4, true, true
       ) RETURNING id`,
      [orgId, agentUserId, `plan-import-agent-${suffix}`, humanUserId],
    );
    employeeId = employee.rows[0]!.id;
    const message = await client.query<{ id: string }>(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'Import this spreadsheet into projects and tasks') RETURNING id`,
      [orgId, spaceId, humanUserId],
    );
    messageId = message.rows[0]!.id;
    const file = await client.query<{ id: string }>(
      `INSERT INTO files (
         id, org_id, uploaded_by, filename, mime_type, detected_mime_type,
         size_bytes, storage_key, attachment_kind, processing_status,
         content_sha256, processed_at
       ) VALUES (
         gen_random_uuid()::text, $1, $2, 'workspace-plan.csv', 'text/csv', 'text/csv',
         $3, $4, 'spreadsheet', 'ready', $5, now()
       ) RETURNING id`,
      [orgId, humanUserId, Buffer.byteLength(csv), `${randomUUID()}-workspace-plan.csv`, `sha256:${'c'.repeat(64)}`],
    );
    fileId = file.rows[0]!.id;
    await client.query(
      `INSERT INTO message_attachments (org_id, message_id, file_id, position) VALUES ($1, $2, $3, 0)`,
      [orgId, messageId, fileId],
    );
    await client.query(
      `INSERT INTO attachment_derivatives (org_id, file_id, kind, mime_type, content, size_bytes)
       VALUES ($1, $2, 'text', 'text/plain', $3, $4)`,
      [orgId, fileId, csv, Buffer.byteLength(csv)],
    );
  });
});

after(async () => {
  if (!orgId) return;
  await withClient(async (client) => {
    await client.query(`DELETE FROM action_receipts WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM task_activity WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM tasks WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM agent_actions WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM attachment_derivatives WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM message_attachments WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM files WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM messages WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM agent_employees WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM space_members WHERE space_id = $1`, [spaceId]);
    await client.query(`DELETE FROM spaces WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM projects WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM org_members WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[humanUserId, agentUserId]]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
  });
});

test('workspace-plan table parser maps common headers and rejects formula-like cells', () => {
  const parsed = parseWorkspacePlanTable(parseCsv([
    'Project,Prefix,Task,Priority,Owner,Start Date,Due Date,Estimate',
    'Apollo,APL,Design launch,high,Ada,2026-09-01,2026-09-04,2d',
  ].join('\n')));
  assert.equal(parsed.rows[0]?.projectName, 'Apollo');
  assert.equal(parsed.rows[0]?.priority, 'p1');
  assert.equal(parsed.rows[0]?.estimation, '2d');
  assert.throws(() => parseWorkspacePlanTable(parseCsv([
    'Project,Task',
    'Apollo,"=HYPERLINK(""https://attacker.test"",""click"")"',
  ].join('\n'))), /formulas are not imported/);
});

test('XLSX plan parsing is bounded, selects Plan, and rejects formulas', async () => {
  const parsed = await parseWorkspacePlanXlsx(xlsxBytes());
  assert.equal(parsed.sheetName, 'Plan');
  assert.equal(parsed.rows[0]?.projectName, 'Mobile Launch');
  assert.equal(parsed.rows[0]?.taskTitle, 'Ship launch');
  assert.equal(parsed.rows[0]?.priority, 'p1');
  await assert.rejects(parseWorkspacePlanXlsx(xlsxBytes({ formula: true })), /formulas are not imported/);
});

test('Hermes queues one replay-safe full-review preview and project-scoped employees cannot expand scope', async () => {
  const first = await workspacePlanImport({
    caller_employee_slug: employeeContext().employee_slug,
    message_id: messageId,
    attachment_id: fileId,
  }, employeeContext());
  assert.equal(first.isError, false, first.content[0]?.text);
  const firstBody = toolPayload(first);
  assert.equal(firstBody.status, 'pending');
  assert.match(firstBody.message, /No project or task has been created yet/);
  assert.equal(firstBody.preview.projects.length, 2);
  assert.equal(firstBody.preview.projects.reduce((count: number, project: any) => count + project.task_count, 0), 3);

  const replay = await workspacePlanImport({
    caller_employee_slug: employeeContext().employee_slug,
    message_id: messageId,
    attachment_id: fileId,
  }, employeeContext());
  const replayBody = toolPayload(replay);
  assert.equal(replayBody.action_id, firstBody.action_id);
  assert.equal(replayBody.idempotent, true);

  const beforeCounts = await withClient(async (client) => (await client.query<{ projects: number; tasks: number }>(
    `SELECT
       (SELECT count(*)::int FROM projects WHERE org_id = $1) AS projects,
       (SELECT count(*)::int FROM tasks WHERE org_id = $1) AS tasks`,
    [orgId],
  )).rows[0]!);
  assert.deepEqual(beforeCounts, { projects: 1, tasks: 0 });

  await withClient((client) => client.query(
    `UPDATE agent_employees SET project_ids = ARRAY[$2]::text[] WHERE id = $1`,
    [employeeId, existingProjectId],
  ));
  const restricted = await compileMessageWorkspacePlanImport({
    orgId,
    actorUserId: agentUserId,
    messageId,
    attachmentId: fileId,
    promptContent: 'Import this project and task plan',
    employeeId,
    force: true,
  });
  assert.match(restricted?.clarification ?? '', /cannot create projects outside its boundary/);
  await withClient((client) => client.query(
    `UPDATE agent_employees SET project_ids = ARRAY[]::text[] WHERE id = $1`,
    [employeeId],
  ));
});

test('Defty preview writes nothing before approval and approved execution is atomic and replay-safe', async () => {
  const draft = await compileMessageWorkspacePlanImport({
    orgId,
    actorUserId: humanUserId,
    messageId,
    attachmentId: fileId,
    promptContent: 'Set up the projects and tasks from this spreadsheet',
  });
  assert.equal(draft?.clarification, undefined);
  assert.equal(draft?.actions.length, 1);
  assert.equal(draft?.actions[0]?.action, WORKSPACE_PLAN_IMPORT_ACTION);
  assert.equal(draft?.actions[0]?.approval_tier, 'full');
  const proposal = draft!.actions[0]!;
  const [actionId] = await withClient(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO agent_actions (
         id, org_id, user_id, source, action, params, approval_tier, approval_status
       ) VALUES (gen_random_uuid()::text, $1, $2, 'deterministic_workspace_plan_import', $3, $4::jsonb, 'full', 'pending')
       RETURNING id`,
      [orgId, humanUserId, WORKSPACE_PLAN_IMPORT_ACTION, JSON.stringify(proposal.params)],
    );
    return [inserted.rows[0]!.id];
  });
  const stillEmpty = await withClient(async (client) => (await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM tasks WHERE org_id = $1`,
    [orgId],
  )).rows[0]!.count);
  assert.equal(stillEmpty, 0);

  await withClient((client) => client.query(
    `UPDATE agent_actions SET approval_status = 'approved', approved_at = now() WHERE id = $1`,
    [actionId],
  ));
  const executed = await executeAction(
    actionId,
    WORKSPACE_PLAN_IMPORT_ACTION,
    proposal.params,
    orgId,
    humanUserId,
  );
  assert.equal(executed.success, true, executed.error);
  assert.equal(executed.result.replayed, false);
  assert.equal(executed.result.projects.length, 2);
  assert.equal(executed.result.tasks.length, 3);

  const committed = await withClient(async (client) => (await client.query<{
    projects: number;
    tasks: number;
    activities: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM projects WHERE org_id = $1) AS projects,
       (SELECT count(*)::int FROM tasks WHERE org_id = $1) AS tasks,
       (SELECT count(*)::int FROM task_activity WHERE org_id = $1 AND agent_action_id = $2) AS activities`,
    [orgId, actionId],
  )).rows[0]!);
  assert.deepEqual(committed, { projects: 2, tasks: 3, activities: 3 });

  const replay = await executeAction(
    actionId,
    WORKSPACE_PLAN_IMPORT_ACTION,
    proposal.params,
    orgId,
    humanUserId,
  );
  assert.equal(replay.success, true, replay.error);
  assert.equal(replay.result.replayed, true);
  const finalTasks = await withClient(async (client) => (await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM tasks WHERE org_id = $1`,
    [orgId],
  )).rows[0]!.count);
  assert.equal(finalTasks, 3);
});
