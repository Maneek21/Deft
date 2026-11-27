/**
 * Block 2.3 — canvas agent tools tests, since canvases became documents (F15).
 *
 * Run: pnpm --filter @deft/api test test/canvas-tools.test.ts
 *
 * The notes move (F14) made each chat canvas with content a document shared
 * with its chat ("can edit") and mapped it in note_document_map; empty ones
 * were dropped. read_canvas reads that document, as the asker can open it;
 * write_canvas writes it through the one writer (writeDocument, rule C2) as
 * Defty for the person who asked, and a chat with no canvas gets none.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeDb } from '../src/lib/db.js';
import { executeActionDirect } from '../src/lib/agent-actions.js';
import { ensureDeftyMembership } from '../src/lib/ensure-defty-membership.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

// Writes load, change and store the document without a live server.
process.env.DEFT_DOCUMENTS_LIVE ??= 'off';

const skip = !safeTestDatabaseUrl();
let fx: DrivesFixture;
let user: string;
let canvasSpace: string;
let canvasSpaceName: string;
let emptySpaceName: string;
let documentId: string;
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

before(async () => {
  if (skip) return;
  fx = await setupDrivesFixture('canvas-tools');
  user = fx.people.member;
  await ensureDeftyMembership(fx.orgId);
  canvasSpace = fx.spaces.team;
  canvasSpaceName = (await fx.client.query('SELECT name FROM spaces WHERE id = $1', [canvasSpace])).rows[0].name;
  emptySpaceName = `canvas-empty-${randomUUID().slice(0, 8)}`;
  const emptySpace = randomUUID();
  await fx.client.query(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, 'public', $4)`, [emptySpace, fx.orgId, emptySpaceName, user]);
  await fx.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), emptySpace, user]);
  // The team chat's canvas, as the move leaves it.
  const canvasId = randomUUID();
  await fx.client.query(`INSERT INTO canvases (id, org_id, space_id, title, content) VALUES ($1, $2, $3, 'Canvas', $4::jsonb)`,
    [canvasId, fx.orgId, canvasSpace, JSON.stringify(doc('legacy canvas words'))]);
  const myDrive = await fx.insertDrive({ kind: 'personal', ownerUserId: fx.people.member2, name: 'My drive' });
  documentId = await fx.insertDocument({ driveId: myDrive, title: 'Team canvas', json: doc('moved canvas words') });
  await fx.share(documentId, { space: canvasSpace }, 'edit');
  await fx.client.query(`INSERT INTO note_document_map (id, org_id, source_type, source_id, target_type, target_id)
    VALUES ($1, $2, 'canvas', $3, 'document', $4)`, [randomUUID(), fx.orgId, canvasId, documentId]);
});

after(async () => {
  if (skip) return;
  if (fx) {
    for (const table of ['action_receipts', 'agent_action_approvers']) {
      await fx.client.query(`DELETE FROM ${table} WHERE action_id IN (SELECT id FROM agent_actions WHERE org_id = $1)`, [fx.orgId]).catch(() => {});
    }
    await fx.client.query('DELETE FROM agent_actions WHERE org_id = $1', [fx.orgId]);
    await fx.client.query('DELETE FROM canvases WHERE org_id = $1', [fx.orgId]);
    await fx.teardown();
  }
  await closeDb();
});

const run = (action: string, params: Record<string, unknown>, tier: 'auto' | 'quick' = 'quick') =>
  executeActionDirect(action, params, fx.orgId, user, null, tier);
const canvasCount = async () => (await fx.client.query('SELECT count(*)::int AS n FROM canvases WHERE org_id = $1', [fx.orgId])).rows[0].n;

test('read_canvas returns exists=false for a space with no canvas', { skip }, async () => {
  const r = await run('read_canvas', { space_name: emptySpaceName }, 'auto');
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.result.exists, false);
});

test('write_canvas on a space with no canvas creates nothing', { skip }, async () => {
  const before = await canvasCount();
  const r = await run('write_canvas', { space_name: emptySpaceName, content: 'Hello canvas world' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /no canvas/);
  assert.equal(await canvasCount(), before);
});

test('write_canvas replaces the canvas document through the writer, and leaves the old canvas row alone', { skip }, async () => {
  const r = await run('write_canvas', { space_name: canvasSpaceName, content: 'Hello canvas world', title: 'Updated title' });
  assert.equal(r.success, true, JSON.stringify(r));
  assert.equal(r.result.document_id, documentId);
  const { rows: [row] } = await fx.client.query('SELECT title, content_text, revision FROM documents WHERE id = $1', [documentId]);
  assert.equal(row.title, 'Updated title');
  assert.equal(row.content_text.trim(), 'Hello canvas world');
  assert.ok(Number(row.revision) > 0, 'a writer store');
  const { rows: [canvas] } = await fx.client.query('SELECT title, content FROM canvases WHERE space_id = $1', [canvasSpace]);
  assert.equal(canvas.title, 'Canvas');
  assert.deepEqual(canvas.content, doc('legacy canvas words'));
});

test('read_canvas returns the document after a write', { skip }, async () => {
  const r = await run('read_canvas', { space_name: canvasSpaceName }, 'auto');
  assert.equal(r.result.exists, true);
  assert.equal(r.result.canvas.document_id, documentId);
  assert.equal(r.result.canvas.title, 'Updated title');
  assert.equal(r.result.canvas.content.trim(), 'Hello canvas world');
});

test('write_canvas is refused on a drive that takes only suggestions from agents', { skip }, async () => {
  await fx.client.query('UPDATE drives SET agent_suggest_only = true WHERE id = (SELECT drive_id FROM documents WHERE id = $1)', [documentId]);
  try {
    const r = await run('write_canvas', { space_name: canvasSpaceName, content: 'not allowed' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /suggestions only/);
  } finally {
    await fx.client.query('UPDATE drives SET agent_suggest_only = false WHERE id = (SELECT drive_id FROM documents WHERE id = $1)', [documentId]);
  }
});

test('write_canvas rejects missing content', { skip }, async () => {
  const r = await run('write_canvas', { space_name: canvasSpaceName });
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('content is required'));
});

test('read_canvas rejects missing space_name', { skip }, async () => {
  const r = await run('read_canvas', {}, 'auto');
  assert.equal(r.success, false);
});

test('write_canvas rejects unknown space', { skip }, async () => {
  const r = await run('write_canvas', { space_name: `definitely-missing-${Date.now()}`, content: 'x' });
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('not found'));
});
