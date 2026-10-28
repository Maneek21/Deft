import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { executeWikiUpdate } from '../src/lib/mcp-tools/wiki-create.js';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const suffix = randomUUID();
const ORG_ID = randomUUID();
const OWNER_ID = `wiki-version-owner-${suffix}`;
const EMPLOYEE_USER_ID = `wiki-version-shadow-${suffix}`;
const EMPLOYEE_ID = `wiki-version-employee-${suffix}`;
const PAGE_ID = `wiki-version-page-${suffix}`;

const ctx: ToolContext = {
  org_id: ORG_ID,
  employee_id: EMPLOYEE_ID,
  employee_slug: `wiki-version-${suffix}`,
  trust_level: 'standard',
};

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function readPage() {
  return withClient(async (client) => {
    const result = await client.query<{ content: string; version: number }>(
      `SELECT content, version FROM wiki_pages WHERE id = $1`,
      [PAGE_ID],
    );
    return result.rows[0]!;
  });
}

before(async () => {
  await withClient(async (client) => {
    await client.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Wiki Version Test', $2)`, [ORG_ID, `wiki-version-${suffix}`]);
    await client.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $3, 'Version Owner', false), ($2, $4, 'Version Employee', true)`,
      [OWNER_ID, EMPLOYEE_USER_ID, `wiki-version-owner-${suffix}@test.local`, `wiki-version-agent-${suffix}@test.local`],
    );
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'owner', true), (gen_random_uuid()::text, $1, $3, 'member', true)`,
      [ORG_ID, OWNER_ID, EMPLOYEE_USER_ID],
    );
    await client.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'Version Employee', $4, 'project_manager', 'Wiki version test employee', 'standard', true, true, $5)`,
      [EMPLOYEE_ID, ORG_ID, EMPLOYEE_USER_ID, ctx.employee_slug, OWNER_ID],
    );
    await client.query(
      `INSERT INTO wiki_pages (id, org_id, scope, type, title, slug, content, version)
       VALUES ($1, $2, 'org', 'decision', 'Demo schedule', $3, 'Demo is Thursday.', 1)`,
      [PAGE_ID, ORG_ID, `demo-schedule-${suffix}`],
    );
  });
});

after(async () => {
  await withClient(async (client) => {
    await client.query(`DELETE FROM wiki_ops_log WHERE page_id = $1`, [PAGE_ID]);
    await client.query(`DELETE FROM wiki_page_versions WHERE page_id = $1`, [PAGE_ID]);
    await client.query(`DELETE FROM wiki_pages WHERE id = $1`, [PAGE_ID]);
    await client.query(`DELETE FROM agent_actions WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM agent_employees WHERE id = $1`, [EMPLOYEE_ID]);
    await client.query(`DELETE FROM org_members WHERE org_id = $1`, [ORG_ID]);
    await client.query(`DELETE FROM users WHERE id IN ($1, $2)`, [OWNER_ID, EMPLOYEE_USER_ID]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [ORG_ID]);
  });
});

test('wiki_update with a current expected_version applies the patch', async () => {
  const result = await executeWikiUpdate(
    {
      caller_employee_slug: ctx.employee_slug,
      page_id: PAGE_ID,
      expected_version: 1,
      patch: { content: 'Demo is Thursday.\n\n## Update\n\nRehearsal is Wednesday.' },
    },
    ctx,
    { skipReceipt: true },
  );
  assert.equal(result.isError, false, result.content[0]?.text);
  const page = await readPage();
  assert.equal(page.version, 2);
  assert.match(page.content, /Rehearsal is Wednesday/);
});

test('wiki_update drafted against an older version is rejected and keeps the newer content', async () => {
  const before = await readPage();
  assert.equal(before.version, 2);
  const result = await executeWikiUpdate(
    {
      caller_employee_slug: ctx.employee_slug,
      page_id: PAGE_ID,
      expected_version: 1,
      patch: { content: 'Demo is Thursday.\n\n## Update\n\nStale capture that must not overwrite.' },
    },
    ctx,
    { skipReceipt: true },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /changed since this update was drafted/);
  const page = await readPage();
  assert.equal(page.version, 2);
  assert.equal(page.content, before.content);
});
