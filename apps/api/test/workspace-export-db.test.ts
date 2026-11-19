/**
 * Workspace exporter: one workspace only, no stored secrets, the member scope
 * shows no more than the product does, one snapshot, bounded reads.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/workspace-export-db.test.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { sql } from 'drizzle-orm';

import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
import { B_MARKER, SECRET_MARKER, dropExportWorld, seedExportWorld, type ExportWorld } from './fixtures/workspace-export-fixture.js';
import { DATASETS, exportWorkspace, type ExportOptions } from '../src/lib/workspace-export/export.js';
import { Snapshot } from '../src/lib/workspace-export/snapshot.js';
import { canReadSpace } from '../src/lib/space-membership.js';
import { memberRoutes } from '../src/routes/members.js';

const databaseUrl = safeTestDatabaseUrl();
const skip = !databaseUrl;
let client: pg.Client;
let world: ExportWorld;
let scratch: string;
let counter = 0;

before(async () => {
  if (skip) return;
  client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  world = await seedExportWorld(client);
  scratch = await mkdtemp(join(tmpdir(), 'deft-export-test-'));
});

after(async () => {
  if (skip) return;
  if (world) await dropExportWorld(client, world);
  await client.end();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

type Exported = { root: string; files: Map<string, Buffer>; manifest: Record<string, any> };

async function listFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? listFiles(root, join(dir, entry.name)) : Promise.resolve([relative(root, join(dir, entry.name)).split(sep).join('/')])));
  return nested.flat();
}

async function runExport(options: Partial<ExportOptions> & Pick<ExportOptions, 'scope'>, orgSlug = world.a.slug): Promise<Exported> {
  const outDir = join(scratch, `export-${++counter}`);
  const result = await exportWorkspace({ databaseUrl: databaseUrl!, workspace: orgSlug, outDir, ...options });
  const files = new Map<string, Buffer>();
  for (const path of await listFiles(result.root)) files.set(path, await readFile(join(result.root, path)));
  return { root: result.root, files, manifest: JSON.parse(files.get('manifest.json')!.toString('utf8')) };
}

function rows(exported: Exported, path: string): Record<string, any>[] {
  const bytes = exported.files.get(path);
  assert.ok(bytes, `missing ${path}`);
  return bytes.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function spacesOf(orgId: string): Promise<string[]> {
  return (await client.query<{ id: string }>('SELECT id FROM spaces WHERE org_id = $1', [orgId])).rows.map((row) => row.id);
}

const allScopes = () => [
  { kind: 'workspace' as const },
  ...[world.a.owner, world.a.member, world.a.guest, world.a.other, world.shared].map((member) => ({ kind: 'member' as const, member })),
];

test('the archive is verifiable: SHA256SUMS lists every other file with its hash', { skip }, async () => {
  const exported = await runExport({ scope: { kind: 'workspace' } });
  const sums = exported.files.get('SHA256SUMS')!.toString('utf8').split('\n').filter(Boolean);
  const listed = new Map(sums.map((line) => { const [hash, ...path] = line.split('  '); return [path.join('  '), hash]; }));
  assert.deepEqual([...listed.keys()].sort(), [...exported.files.keys()].filter((path) => path !== 'SHA256SUMS').sort());
  for (const [path, hash] of listed) {
    assert.equal(createHash('sha256').update(exported.files.get(path)!).digest('hex'), hash, path);
  }
  assert.equal(exported.manifest.format, 'deft.workspace_export.v1');
  assert.deepEqual(exported.manifest.scope, { kind: 'workspace' });
  assert.equal(exported.manifest.workspace.id, world.a.orgId);
  assert.ok(exported.manifest.not_included.some((line: string) => line.startsWith('Mail')));
  for (const summary of exported.manifest.datasets) {
    const count = summary.path.endsWith('.jsonl') ? rows(exported, summary.path).length : 1;
    assert.equal(summary.records, count, summary.path);
  }
});

test('nothing from another workspace reaches the archive, in any scope', { skip }, async () => {
  const sharedIds = new Set([world.shared]);
  const bIds = [world.b.orgId, world.b.owner, world.b.member, world.b.other, world.b.guest, world.b.former,
    world.b.agentUser, world.b.agentEmployee, ...Object.values(world.b.spaces), ...Object.values(world.b.messages),
    ...Object.values(world.b.tasks), ...Object.values(world.b.projects), ...Object.values(world.b.labels),
    ...Object.values(world.b.notes), ...Object.values(world.b.wiki), ...Object.values(world.b.events), ...Object.values(world.b.folders)].filter((id) => !sharedIds.has(id));
  for (const scope of allScopes()) {
    const exported = await runExport({ scope });
    for (const [path, bytes] of exported.files) {
      const content = bytes.toString('utf8');
      assert.ok(!content.includes(B_MARKER), `${path} (${JSON.stringify(scope)}) contains workspace B content`);
      for (const id of bIds) assert.ok(!content.includes(id), `${path} (${JSON.stringify(scope)}) contains B id ${id}`);
    }
  }
});

test('no stored credential or secret reaches the archive, in any scope or workspace', { skip }, async () => {
  for (const scope of allScopes()) {
    const exported = await runExport({ scope });
    for (const [path, bytes] of exported.files) {
      const content = bytes.toString('utf8');
      for (const secret of [SECRET_MARKER, ...world.forbidden]) assert.ok(!content.includes(secret), `${path} (${JSON.stringify(scope)}) contains a secret`);
    }
  }
  const exportedB = await runExport({ scope: { kind: 'workspace' } }, world.b.slug);
  for (const [path, bytes] of exportedB.files) assert.ok(!bytes.toString('utf8').includes(SECRET_MARKER), path);
});

test('no exported field is named like a credential (coarse second net)', { skip }, async () => {
  const exported = await runExport({ scope: { kind: 'workspace' } });
  const reviewed = new Set<string>([]);
  for (const [path, bytes] of exported.files) {
    if (!path.endsWith('.jsonl')) continue;
    for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
      for (const key of Object.keys(JSON.parse(line))) {
        assert.ok(reviewed.has(key) || !/password|token|secret|hash|key|cipher|nonce|code|prompt|encrypt|session|config/i.test(key), `${path}: ${key}`);
      }
    }
  }
});

test('member scope: exactly the spaces canReadSpace allows, including archived ones', { skip }, async () => {
  for (const userId of [world.a.owner, world.a.member, world.a.guest, world.a.other, world.shared]) {
    const exported = await runExport({ scope: { kind: 'member', member: userId } });
    const exportedIds = rows(exported, 'data/spaces.jsonl').map((row) => row.id).sort();
    const allowed: string[] = [];
    for (const spaceId of await spacesOf(world.a.orgId)) {
      if (await canReadSpace(spaceId, userId, world.a.orgId)) allowed.push(spaceId);
    }
    assert.deepEqual(exportedIds, allowed.sort(), `spaces for ${userId}`);
    // Space membership rows only for exported spaces and visible people.
    const people = new Set(rows(exported, 'data/members.jsonl').map((row) => row.user_id));
    for (const row of rows(exported, 'data/space_members.jsonl')) {
      assert.ok(exportedIds.includes(row.space_id));
      assert.ok(people.has(row.user_id), `space member ${row.user_id} not in the member list`);
    }
    assert.equal(exported.manifest.scope.user_id, userId);
  }
});

test('member scope: spaces match a hand-written expectation, independent of the product code', { skip }, async () => {
  // Written from the product's rules, not computed by them: members see their
  // own spaces (archived too) and public unarchived ones; guests only their own.
  const s = world.a.spaces;
  const expected: Record<string, string[]> = {
    [world.a.owner]: [s.general, s.publicUnjoined, s.privateOthers, s.dmOwnerOther, s.groupDm, world.a.sealedSpace],
    [world.a.member]: [s.general, s.publicUnjoined, s.privateWithMember, s.dmMemberOther, s.archivedPrivateWithMember, s.groupDm],
    [world.a.guest]: [s.general, s.privateWithMember, s.groupDm],
    [world.a.other]: [s.general, s.publicUnjoined, s.privateOthers, s.privateWithMember, s.dmMemberOther, s.dmOwnerOther,
      s.archivedPublic, s.agentConversation],
    [world.shared]: [s.general, s.publicUnjoined, s.privateWithMember],
  };
  for (const [userId, spaceIds] of Object.entries(expected)) {
    const exported = await runExport({ scope: { kind: 'member', member: userId } });
    assert.deepEqual(rows(exported, 'data/spaces.jsonl').map((row) => row.id).sort(), [...spaceIds].sort(), `spaces for ${userId}`);
  }
});

test('member scope: the member list equals GET /api/members, field by field', { skip }, async () => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: c.req.header('x-test-user')!, org_id: world.a.orgId } as any);
    await next();
  });
  app.route('/api/members', memberRoutes);
  for (const userId of [world.a.member, world.a.guest]) {
    const response = await app.request('/api/members', { headers: { 'x-test-user': userId } });
    assert.equal(response.status, 200);
    const product = (await response.json() as any[]).map((row) => ({ user_id: row.id, name: row.name, email: row.email, kind: row.kind, role: row.role, is_active: true }));
    const exported = rows(await runExport({ scope: { kind: 'member', member: userId } }), 'data/members.jsonl');
    // Exactly these fields, and exactly the product's values for them.
    for (const row of exported) assert.deepEqual(Object.keys(row).sort(), ['email', 'is_active', 'kind', 'name', 'role', 'user_id']);
    const byId = (list: any[]) => [...list].sort((x, y) => x.user_id.localeCompare(y.user_id));
    assert.deepEqual(byId(exported), byId(product));
    // Independently: the former member and other workspaces' people are never listed.
    assert.ok(!exported.some((row) => row.user_id === world.a.former || row.user_id === world.b.owner));
  }
});

test('whole-workspace scope: every space and person, former members flagged, agents described without secrets', { skip }, async () => {
  const exported = await runExport({ scope: { kind: 'workspace' } });
  assert.deepEqual(rows(exported, 'data/spaces.jsonl').map((row) => row.id).sort(), (await spacesOf(world.a.orgId)).sort());
  const members = rows(exported, 'data/members.jsonl');
  assert.equal(members.find((row) => row.user_id === world.a.former)?.is_active, false);
  assert.ok(members.some((row) => row.user_id === world.shared));
  assert.deepEqual(Object.keys(rows(exported, 'data/agents.jsonl')[0]!).sort(),
    ['created_at', 'expertise_description', 'id', 'is_active', 'job_title', 'name', 'user_id']);
  // A creator from another workspace is not named.
  assert.equal(rows(exported, 'data/spaces.jsonl').find((row) => row.id === world.a.spaces.publicUnjoined)?.created_by, null);
});

test('scope arguments are refused unless they name exactly one active person of this workspace', { skip }, async () => {
  for (const member of [world.b.owner, world.a.former, world.a.agentUser, 'nobody@example.test', '']) {
    await assert.rejects(runExport({ scope: { kind: 'member', member } }), /member/i);
  }
  await assert.rejects(runExport({ scope: { kind: 'workspace' } }, 'no-such-workspace'), /No such workspace/);
});

test('rows are read in bounded batches and written before the next batch is fetched', { skip }, async () => {
  const fetches: number[] = [];
  let fetched = 0;
  let written = 0;
  let inDatasets = true;
  const lastDataset = DATASETS[DATASETS.length - 1]!.path;
  await runExport({
    scope: { kind: 'workspace' }, batchSize: 2,
    onFetch: (count) => {
      // Every row of the previous batches is already written: nothing accumulates.
      if (inDatasets) assert.equal(written, fetched, 'rows held back across a fetch');
      fetches.push(count);
      fetched += count;
    },
    onRecord: () => { written += 1; },
    afterDataset: async (path) => { if (path === lastDataset) inDatasets = false; },
  });
  assert.ok(fetches.length > 5);
  assert.ok(fetches.every((count) => count <= 2));
});

test('every dataset reads one snapshot, even when the workspace changes during the export', { skip }, async () => {
  const other = new pg.Client({ connectionString: databaseUrl });
  await other.connect();
  const added = randomUUID();
  const original = (await client.query<{ name: string }>('SELECT name FROM spaces WHERE id = $1', [world.a.spaces.general])).rows[0]!.name;
  try {
    const exported = await runExport({ scope: { kind: 'workspace' }, afterDataset: async (path) => {
      if (path !== 'data/members.jsonl') return;
      // Committed by another connection after the export began, before spaces are read.
      await other.query("INSERT INTO spaces (id, org_id, name, type) VALUES ($1, $2, 'added during export', 'public')", [added, world.a.orgId]);
      await other.query("UPDATE spaces SET name = 'renamed during export' WHERE id = $1", [world.a.spaces.general]);
    } });
    const spaces = rows(exported, 'data/spaces.jsonl');
    assert.ok(!spaces.some((row) => row.id === added));
    assert.equal(spaces.find((row) => row.id === world.a.spaces.general)?.name, original);
  } finally {
    await other.query('DELETE FROM spaces WHERE id = $1', [added]);
    await other.query('UPDATE spaces SET name = $2 WHERE id = $1', [world.a.spaces.general, original]);
    await other.end();
  }
});

test('cursors are closed when reading stops early or fails, and the first error is the one reported', { skip }, async () => {
  const snapshot = await Snapshot.open({ databaseUrl: databaseUrl!, batchSize: 1 });
  const openCursors = async () => Number((await snapshot.all<{ n: string }>(sql`SELECT count(*) AS n FROM pg_cursors`))[0]!.n);
  try {
    for await (const _row of snapshot.rows(sql`SELECT g FROM generate_series(1, 5) g`)) break;
    assert.equal(await openCursors(), 0);
    await assert.rejects((async () => {
      for await (const _row of snapshot.rows(sql`SELECT g FROM generate_series(1, 5) g`)) throw new Error('consumer failed');
    })(), /consumer failed/);
    assert.equal(await openCursors(), 0);
  } finally {
    await snapshot.close();
  }
  const broken = await Snapshot.open({ databaseUrl: databaseUrl!, batchSize: 1 });
  try {
    await assert.rejects((async () => {
      for await (const _row of broken.rows(sql`SELECT 1 / (g - 3) FROM generate_series(1, 5) g`)) { /* reads until the error */ }
    })(), /division by zero/);
  } finally {
    await broken.close();
  }
});

test('the exporter never loads the app database client or app configuration', async () => {
  const root = join(import.meta.dirname, '..', 'src', 'lib');
  const seen = new Set<string>();
  const visit = async (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
      await visit(join(file, '..', match[1]!.replace(/\.js$/, '.ts')));
    }
  };
  for (const entry of await readdir(join(root, 'workspace-export'))) await visit(join(root, 'workspace-export', entry));
  for (const forbidden of ['db.ts', 'env.ts']) assert.ok(![...seen].some((file) => file === join(root, forbidden)), `imports lib/${forbidden}`);
});

test('messages: member scope equals loadMessagesForReader; plumbing, hidden and deleted rows never exported', { skip }, async () => {
  const { loadMessagesForReader } = await import('../src/lib/space-membership.js');
  const allA = (await client.query<{ id: string; metadata: any }>('SELECT id, metadata FROM messages WHERE org_id = $1', [world.a.orgId])).rows;
  const plumbing = new Set(allA.filter((row) => row.metadata?.kind === 'tool_result' || row.metadata?.hidden === true).map((row) => row.id));
  for (const userId of [world.a.owner, world.a.member, world.a.guest, world.a.other, world.shared]) {
    const exported = await runExport({ scope: { kind: 'member', member: userId } });
    const readable = await loadMessagesForReader(allA.map((row) => row.id), userId, world.a.orgId);
    const expected = [...readable.keys()].filter((id) => !plumbing.has(id)).sort();
    assert.deepEqual(rows(exported, 'data/messages.jsonl').map((row) => row.id).sort(), expected, `messages for ${userId}`);
    const messageIds = new Set(expected);
    for (const row of rows(exported, 'data/reactions.jsonl')) assert.ok(messageIds.has(row.message_id));
    const spaceIds = new Set(rows(exported, 'data/spaces.jsonl').map((row) => row.id));
    for (const row of rows(exported, 'data/canvases.jsonl')) assert.ok(spaceIds.has(row.space_id));
  }
  const whole = await runExport({ scope: { kind: 'workspace' } });
  const messages = new Map(rows(whole, 'data/messages.jsonl').map((row) => [row.id, row]));
  for (const key of ['deleted', 'toolResult', 'hidden']) assert.ok(!messages.has(world.a.messages[key]!), key);
  assert.equal(messages.get(world.a.messages.replyToDeleted!)?.parent_missing, true);
  assert.equal(messages.get(world.a.messages.replyToDeleted!)?.parent_id, world.a.messages.deleted);
  assert.equal(messages.get(world.a.messages.byFormer!)?.user_id, world.a.former);
  assert.equal(messages.get(world.a.messages.byFormer!)?.parent_id, null);
  assert.equal(messages.get(world.a.messages['general-reply']!)?.parent_missing, false);
  const sealed = messages.get(world.a.messages.privateAssistant!);
  assert.equal(sealed?.content, null);
  assert.equal(sealed?.content_omitted, true);
  const omissions = rows(whole, 'omissions.jsonl');
  assert.ok(omissions.some((row) => row.kind === 'message' && row.id === world.a.messages.privateAssistant));
  assert.equal(whole.manifest.complete, false);
  assert.ok(!rows(whole, 'data/reactions.jsonl').some((row) => row.user_id === world.b.owner));
});

test('tasks: member scope equals the product task check; links and comments follow both ends', { skip }, async () => {
  const { canAccessAttachmentTask } = await import('../src/lib/attachment-access.js');
  for (const userId of [world.a.owner, world.a.member, world.a.guest, world.a.other, world.shared]) {
    const exported = await runExport({ scope: { kind: 'member', member: userId } });
    const allowed: string[] = [];
    for (const taskId of Object.values(world.a.tasks)) if (await canAccessAttachmentTask(taskId, world.a.orgId, userId)) allowed.push(taskId);
    const taskIds = rows(exported, 'data/tasks.jsonl').map((row) => row.id).sort();
    assert.deepEqual(taskIds, allowed.sort(), `tasks for ${userId}`);
    const visible = new Set(taskIds);
    for (const path of ['data/task_comments.jsonl', 'data/task_assignees.jsonl', 'data/task_watchers.jsonl', 'data/task_labels.jsonl', 'data/task_reactions.jsonl']) {
      for (const row of rows(exported, path)) assert.ok(visible.has(row.task_id), `${path} ${row.task_id}`);
    }
    for (const row of rows(exported, 'data/task_relationships.jsonl')) assert.ok(visible.has(row.source_task_id) && visible.has(row.target_task_id));
    for (const row of rows(exported, 'data/tasks.jsonl')) assert.ok(row.parent_task_id === null || visible.has(row.parent_task_id));
  }
  const whole = await runExport({ scope: { kind: 'workspace' } });
  const tasks = new Map(rows(whole, 'data/tasks.jsonl').map((row) => [row.id, row]));
  assert.ok(!tasks.has(world.a.tasks.deleted!));
  assert.ok(tasks.has(world.a.tasks.inDeletedProject!));
  assert.equal(rows(whole, 'data/projects.jsonl').find((row) => row.id === world.a.projects.deleted)?.is_deleted, true);
  assert.equal(tasks.get(world.a.tasks.subtask!)?.parent_task_id, world.a.tasks.open);
  assert.equal(tasks.get(world.a.tasks.restricted!)?.visibility, 'restricted');
  assert.deepEqual(rows(whole, 'data/task_labels.jsonl'), [{ task_id: world.a.tasks.open, label_id: world.a.labels.bug }]);
  // Positive sets, so an empty dataset cannot pass.
  const pairs = (path: string, a: string, b: string) => rows(whole, path).map((row) => `${row[a]}:${row[b]}`).sort();
  assert.deepEqual(pairs('data/task_assignees.jsonl', 'task_id', 'user_id'),
    [`${world.a.tasks.restrictedAssigned}:${world.a.guest}`, `${world.a.tasks.open}:${world.a.other}`].sort());
  assert.deepEqual(pairs('data/task_watchers.jsonl', 'task_id', 'user_id'), [`${world.a.tasks.restrictedWatched}:${world.a.member}`]);
  assert.deepEqual(pairs('data/task_reactions.jsonl', 'task_id', 'user_id'), [`${world.a.tasks.open}:${world.a.member}`]);
  assert.deepEqual(pairs('data/task_relationships.jsonl', 'source_task_id', 'target_task_id'), [`${world.a.tasks.open}:${world.a.tasks.restricted}`]);
  assert.deepEqual(pairs('data/reactions.jsonl', 'message_id', 'user_id'), [`${world.a.messages.general}:${world.a.member}`]);
  assert.deepEqual(rows(whole, 'data/canvases.jsonl').map((row) => row.space_id), [world.a.spaces.privateOthers]);
  const comments = rows(whole, 'data/task_comments.jsonl');
  assert.equal(comments.length, 2, 'comments on open and restricted; not the deleted comment or the deleted task');
});

function productApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: c.req.header('x-test-user')!, org_id: world.a.orgId } as any);
    await next();
  });
  return app;
}

test('notes, folders, wiki and events: member scope equals what the product routes return', { skip }, async () => {
  const { dailyNoteRoutes } = await import('../src/routes/daily-notes.js');
  const { wikiRoutes } = await import('../src/routes/wiki.js');
  const { calendarRoutes } = await import('../src/routes/calendar.js');
  const app = productApp().route('/api/daily-notes', dailyNoteRoutes).route('/api/wiki', wikiRoutes).route('/api/calendar', calendarRoutes);
  const as = async (userId: string, path: string) => { const r = await app.request(path, { headers: { "x-test-user": userId } }); if (r.status >= 500) throw new Error(`${path} -> ${r.status}: ${await r.text()}`); return r; };
  const day = 86_400_000;
  const calendarPath = `/api/calendar?from=${new Date(Date.now() - day).toISOString()}&to=${new Date(Date.now() + 10 * day).toISOString()}`;
  for (const userId of [world.a.owner, world.a.member, world.a.guest, world.a.other]) {
    const exported = await runExport({ scope: { kind: 'member', member: userId } });
    // Notes: exactly those GET /api/daily-notes/:id opens, with the same title and body.
    const noteRows = new Map(rows(exported, 'data/notes.jsonl').map((row) => [row.id, row]));
    for (const noteId of Object.values(world.a.notes)) {
      const response = await as(userId, `/api/daily-notes/${noteId}`);
      assert.equal(noteRows.has(noteId), response.status === 200, `note ${noteId} for ${userId}`);
      if (response.status === 200) {
        const product = await response.json() as any;
        assert.equal(noteRows.get(noteId)!.content, product.content);
        assert.equal(noteRows.get(noteId)!.title, product.title);
      }
    }
    // Folders: the member's own, as GET /folders lists them.
    const folders = await (await as(userId, '/api/daily-notes/folders')).json() as any;
    assert.deepEqual(rows(exported, 'data/note_folders.jsonl').map((row) => row.id).sort(), folders.folders.map((row: any) => row.id).sort());
    // Wiki: exactly GET /api/wiki/export's pages.
    const wiki = await (await as(userId, '/api/wiki/export')).json() as any;
    assert.deepEqual(rows(exported, 'data/wiki_pages.jsonl').map((row) => row.id).sort(), wiki.pages.map((row: any) => row.id).sort(), `wiki for ${userId}`);
    const pages = new Set(wiki.pages.map((row: any) => row.id));
    for (const row of rows(exported, 'data/wiki_links.jsonl')) assert.ok(pages.has(row.source_page_id) && pages.has(row.target_page_id));
    // Events: the Calendar's events, less cancelled ones (never more than the Calendar).
    const calendar = await (await as(userId, calendarPath)).json() as any;
    assert.deepEqual(rows(exported, 'data/events.jsonl').map((row) => row.id).sort(),
      calendar.events.filter((row: any) => row.metadata?.status !== 'canceled').map((row: any) => row.id).sort(), `events for ${userId}`);
    // Note shares: exactly what GET /api/daily-notes/:id/shares lists for the member's own notes.
    const ownNotes = (await client.query<{ id: string }>('SELECT id FROM notes WHERE org_id = $1 AND user_id = $2 AND NOT is_deleted',
      [world.a.orgId, userId])).rows;
    const productShares: string[] = [];
    for (const { id } of ownNotes) {
      const shares = await (await as(userId, `/api/daily-notes/${id}/shares`)).json() as any;
      productShares.push(...shares.shares.map((share: any) => `${id}:${share.user_id}`));
    }
    assert.deepEqual(rows(exported, 'data/note_shares.jsonl').map((row) => `${row.note_id}:${row.shared_with_user_id}`).sort(),
      productShares.sort(), `note shares for ${userId}`);
    // Spaces named by notes and pages are spaces in the export.
    const spaces = new Set(rows(exported, 'data/spaces.jsonl').map((row) => row.id));
    for (const row of [...noteRows.values(), ...rows(exported, 'data/wiki_pages.jsonl')]) {
      const spaceId = row.visibility_space_id ?? row.space_id;
      assert.ok(spaceId == null || spaces.has(spaceId));
    }
  }
  const whole = await runExport({ scope: { kind: 'workspace' } });
  const events = new Map(rows(whole, 'data/events.jsonl').map((row) => [row.id, row]));
  assert.equal(events.get(world.a.events.noOwner!)?.user_id, null);
  assert.ok(events.has(world.a.events.memberCanceled!), 'the whole workspace keeps cancelled events');
  assert.equal(events.get(world.a.events.nested!)?.location, null, 'an object in place of text is not written');
  // Positive sets, so an empty dataset cannot pass.
  assert.deepEqual(rows(whole, 'data/note_shares.jsonl').map((row) => `${row.note_id}:${row.shared_with_user_id}`),
    [`${world.a.notes.sharedWithMember}:${world.a.member}`], 'only shares to active members of this workspace');
  assert.deepEqual(rows(whole, 'data/wiki_links.jsonl').map((row) => row.target_page_id).sort(),
    [world.a.wiki.personalOther, world.a.wiki.spacePrivateWithMember].sort());
  const folders = rows(whole, 'data/note_folders.jsonl');
  assert.equal(folders.length, 3);
  assert.equal(folders.filter((row) => row.user_id === null).length, 1, 'a folder owner from another workspace is not named');
  const member = events.get(world.a.events.member!)!;
  assert.deepEqual(member.attendees, [{ email: 'guest@example.test', name: 'attendee' }]);
  assert.equal(member.recurrence.rrule, 'FREQ=WEEKLY;COUNT=4');
  assert.equal(member.recurrence.start.time_zone, 'Europe/London');
  assert.ok(!rows(whole, 'data/wiki_pages.jsonl').some((row) => row.id === world.a.wiki.deleted));
  assert.ok(!rows(whole, 'data/notes.jsonl').some((row) => row.id === world.a.notes.deleted));
});
