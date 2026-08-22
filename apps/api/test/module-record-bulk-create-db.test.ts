import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after } from 'node:test';
import pg from 'pg';
import { executeAction } from '../src/lib/agent-actions.js';
import { compileMessageModuleCsvImport } from '../src/lib/module-csv-import.js';
import { closeDb } from '../src/lib/db.js';
import {
  humanModuleActor,
  installBundledModule,
  updateModuleInstallation,
} from '../src/lib/module-service.js';

const TEST_DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

function isSafeTestDatabase(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return /(?:test|ci|acceptance)/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

const canRun = isSafeTestDatabase(TEST_DATABASE_URL);
const ciRequiresDatabase = /^(?:1|true)$/i.test(process.env.CI ?? '');

after(async () => {
  await closeDb();
});

test(
  'bulk module create is resumable, deduplicated, and scrubs terminal row values',
  { skip: !canRun && !ciRequiresDatabase },
  async () => {
    assert.ok(
      canRun && TEST_DATABASE_URL,
      'CI must provide a disposable test database whose name contains test, ci, or acceptance',
    );
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const orgId = `module-bulk-org-${suffix}`;
    const ownerId = `module-bulk-owner-${suffix}`;
    const actionId = `module-bulk-action-${suffix}`;
    const spaceId = `module-bulk-space-${suffix}`;
    const messageId = `module-bulk-message-${suffix}`;
    const fileId = `module-bulk-file-${suffix}`;
    const storageKey = `module-bulk-${suffix}.csv`;
    const privateNameA = `Private Ada ${suffix}`;
    const privateNameB = `Private Grace ${suffix}`;
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    const uploadDir = join(process.cwd(), 'uploads');
    await mkdir(uploadDir, { recursive: true });
    try {
      await client.query(
        'INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)',
        [orgId, `Module Bulk ${suffix}`, `module-bulk-${suffix}`],
      );
      await client.query(
        `INSERT INTO users (id, email, name, email_verified)
         VALUES ($1, $2, 'Module Bulk Owner', true)`,
        [ownerId, `module-bulk-${suffix}@example.test`],
      );
      await client.query(
        `INSERT INTO org_members (id, org_id, user_id, role, is_active)
         VALUES ($1, $2, $3, 'owner', true)`,
        [`module-bulk-member-${suffix}`, orgId, ownerId],
      );

      const owner = humanModuleActor({ orgId, userId: ownerId, role: 'owner' });
      const installed = await installBundledModule(owner, 'contacts');
      await updateModuleInstallation(owner, 'contacts', { agent_access: 'write' });

      const csv = [
        'Name,Email,Company',
        `${privateNameA},ada-${suffix}@example.test,Analytical Engines`,
        `${privateNameB},grace-${suffix}@example.test,Compilers Inc`,
      ].join('\n');
      await writeFile(join(uploadDir, storageKey), csv, 'utf8');
      await client.query(
        `INSERT INTO spaces (id, org_id, name, type, created_by)
         VALUES ($1, $2, 'module-bulk', 'public', $3)`,
        [spaceId, orgId, ownerId],
      );
      await client.query(
        `INSERT INTO messages (id, org_id, space_id, user_id, content)
         VALUES ($1, $2, $3, $4, 'Import this CSV into contacts')`,
        [messageId, orgId, spaceId, ownerId],
      );
      await client.query(
        `INSERT INTO files
          (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key, message_id)
         VALUES ($1, $2, $3, 'contacts.csv', 'text/csv', $4, $5, $6)`,
        [fileId, orgId, ownerId, Buffer.byteLength(csv), storageKey, messageId],
      );
      const draft = await compileMessageModuleCsvImport({
        orgId,
        userId: ownerId,
        messageId,
        promptContent: 'Import this CSV into contacts',
      });
      assert.ok(draft);
      assert.equal(draft.actions.length, 1);
      assert.equal(draft.actions[0]!.action, 'module_record_bulk_create');
      assert.equal(draft.actions[0]!.approval_tier, 'full');
      assert.match(draft.summary ?? '', /prepared an import of 2 Contacts records.*for approval/i);
      const input = draft.actions[0]!.params;
      assert.equal(input.expected_manifest_digest, installed.manifest_digest);
      await client.query(
        `INSERT INTO agent_actions
          (id, org_id, user_id, action, params, approval_tier, approval_status, approved_at)
         VALUES ($1, $2, $3, 'module_record_bulk_create', $4::jsonb, 'full', 'approved', now())`,
        [actionId, orgId, ownerId, JSON.stringify(input)],
      );

      const first = await executeAction(actionId, 'module_record_bulk_create', input, orgId, ownerId);
      assert.equal(first.success, true, first.error);
      assert.equal(first.result.requested, 2);
      assert.equal(first.result.created, 2);
      assert.equal(first.result.replayed, 0);

      // Simulate a lost response/restarted executor by replaying the original
      // approved payload. Per-row receipts must prevent duplicate records.
      const replay = await executeAction(actionId, 'module_record_bulk_create', input, orgId, ownerId);
      assert.equal(replay.success, true, replay.error);
      assert.equal(replay.result.created, 0);
      assert.equal(replay.result.replayed, 2);

      const records = await client.query(
        `SELECT count(*)::int AS count
         FROM module_records
         WHERE org_id = $1 AND collection_key = 'contacts' AND is_deleted = false`,
        [orgId],
      );
      assert.equal(records.rows[0].count, 2);
      const receipts = await client.query(
        `SELECT count(*)::int AS count,
                count(agent_action_id)::int AS parent_links
         FROM module_mutation_receipts
         WHERE org_id = $1`,
        [orgId],
      );
      assert.equal(receipts.rows[0].count, 2);
      assert.equal(receipts.rows[0].parent_links, 0);

      const terminal = await client.query(
        'SELECT params, result FROM agent_actions WHERE id = $1 AND org_id = $2',
        [actionId, orgId],
      );
      assert.equal(terminal.rows[0].params.row_count, 2);
      assert.equal(Array.isArray(terminal.rows[0].params.rows), false);
      const terminalJson = JSON.stringify(terminal.rows[0]);
      assert.doesNotMatch(terminalJson, new RegExp(privateNameA));
      assert.doesNotMatch(terminalJson, new RegExp(privateNameB));
      assert.doesNotMatch(terminalJson, new RegExp(`ada-${suffix}@example\\.test`));
    } finally {
      await rm(join(uploadDir, storageKey), { force: true });
      await client.end();
    }
  },
);
