/**
 * Workspace exporter: one workspace only, no stored secrets, the member scope
 * shows no more than the product does, one snapshot, bounded reads.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/workspace-export-db.test.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
import { B_MARKER, SECRET_MARKER, dropExportWorld, seedExportWorld, type ExportWorld } from './fixtures/workspace-export-fixture.js';
import { DATASETS, EXPORT_TABLES, exportWorkspace, type ExportOptions } from '../src/lib/workspace-export/export.js';
import { Snapshot } from '../src/lib/workspace-export/snapshot.js';
import { canReadSpace } from '../src/lib/space-membership.js';
import { memberRoutes } from '../src/routes/members.js';

/** The operating system's own tar (Windows ships bsdtar as tar.exe; a Git Bash tar on PATH reads C: as a host). */
const systemTar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

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
  scratch = await mkdtemp(join(tmpdir(), 'deft-export-test-'));
  await mkdir(join(scratch, 'uploads'));
  world = await seedExportWorld(client, join(scratch, 'uploads'));
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
  // The test database holds many workspaces. Most tests exercise the copying path, so they declare a one-workspace
  // database and bypass the scan through its test seam; tests of the real decision pass hooks: { sharedDatabase: undefined }.
  const result = await exportWorkspace({ databaseUrl: databaseUrl!, workspace: orgSlug, outDir, uploadsDir: world.uploadsDir,
    singleWorkspaceDatabase: true, ...options, hooks: { sharedDatabase: () => false, ...options.hooks } });
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
    ...Object.values(world.b.notes), ...Object.values(world.b.wiki), ...Object.values(world.b.events), ...Object.values(world.b.folders),
    ...Object.values(world.b.files), world.b.contacts.installation, world.b.contacts.version, ...Object.values(world.b.contacts.records)].filter((id) => !sharedIds.has(id));
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
    // Events: never more than the Calendar shows; less only for cancelled events and events another part of Deft wrote.
    const calendar = await (await as(userId, calendarPath)).json() as any;
    const calendarIds = new Set(calendar.events.map((row: any) => row.id));
    const exportedEvents = rows(exported, 'data/events.jsonl').map((row) => row.id);
    for (const id of exportedEvents) assert.ok(calendarIds.has(id), `event ${id} exported but not on the Calendar for ${userId}`);
    const leftOut = new Set([world.a.events.memberCanceled, world.a.events.otherWriter, world.a.events.githubKeysElsewhere]);
    assert.deepEqual(exportedEvents.sort(), calendar.events.map((row: any) => row.id).filter((id: string) => !leftOut.has(id)).sort(), `events for ${userId}`);
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
  assert.ok(events.has(world.a.events.otherWriter!), 'the whole workspace keeps events other parts of Deft wrote');
  assert.ok(events.has(world.a.events.githubKeysElsewhere!));
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

test('attachments: member scope equals getVisibleAttachment for every file', { skip }, async () => {
  const { getVisibleAttachment } = await import('../src/lib/attachment-access.js');
  for (const userId of [world.a.owner, world.a.member, world.a.guest, world.a.other, world.shared]) {
    const exported = await runExport({ scope: { kind: 'member', member: userId } });
    const allowed: string[] = [];
    for (const fileId of Object.values(world.a.files)) if (await getVisibleAttachment(fileId, world.a.orgId, userId)) allowed.push(fileId);
    assert.deepEqual(rows(exported, 'data/files.jsonl').map((row) => row.id).sort(), allowed.sort(), `files for ${userId}`);
  }
});

test('attachments: a document image follows its document in a member export, never its uploader alone (F10)', { skip }, async () => {
  const { getVisibleAttachment } = await import('../src/lib/attachment-access.js');
  const { a } = world;
  const driveId = randomUUID();
  const documentId = randomUUID();
  const inText = randomUUID();
  const inHistory = randomUUID();
  const images = [inText, inHistory].sort();
  try {
    // A private drive the member edits; the guest views the document through a share; `other` uploaded both
    // images and can't open it; the owner isn't a member of the drive.
    await client.query(`INSERT INTO drives (id, org_id, name, kind, created_by) VALUES ($1, $2, 'Export images', 'private', $3)`,
      [driveId, a.orgId, a.owner]);
    await client.query(`INSERT INTO drive_members (id, org_id, drive_id, principal_type, principal_id, role, added_by)
      VALUES ($1, $2, $3, 'user', $4, 'edit', $5)`, [randomUUID(), a.orgId, driveId, a.member, a.owner]);
    await client.query(`INSERT INTO documents (id, org_id, drive_id, title, content_json, created_by)
      VALUES ($1, $2, $3, 'Export images', '{"type":"doc","content":[]}'::jsonb, $4)`, [documentId, a.orgId, driveId, a.member]);
    await client.query(`INSERT INTO document_shares (id, org_id, document_id, principal_type, principal_id, role, shared_by)
      VALUES ($1, $2, $3, 'user', $4, 'view', $5)`, [randomUUID(), a.orgId, documentId, a.guest, a.member]);
    for (const [fileId, inCurrent] of [[inText, true], [inHistory, false]] as const) {
      const bytes = Buffer.from(`image ${fileId}`);
      await writeFile(join(world.uploadsDir, `${fileId}.bin`), bytes);
      await client.query(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key, content_sha256)
        VALUES ($1, $2, $3, 'image.png', 'image/png', $4, $5, $6)`,
      [fileId, a.orgId, a.other, bytes.length, `${fileId}.bin`, `sha256:${createHash('sha256').update(bytes).digest('hex')}`]);
      await client.query(`INSERT INTO document_attachments (id, org_id, document_id, file_id, in_current, added_by)
        VALUES ($1, $2, $3, $4, $5, $6)`, [randomUUID(), a.orgId, documentId, fileId, inCurrent, a.other]);
    }
    const exported = async (member: string) => rows(await runExport({ scope: { kind: 'member', member } }), 'data/files.jsonl')
      .map((row) => row.id as string).filter((id) => images.includes(id)).sort();
    const served = async (member: string) => {
      const ids: string[] = [];
      for (const id of images) if (await getVisibleAttachment(id, a.orgId, member)) ids.push(id);
      return ids;
    };
    const expected: Array<[string, string, string[]]> = [
      ['the editor: in the text and only in history', a.member, images],
      ['a viewer: only the image in the text', a.guest, [inText]],
      ['the uploader, who can’t open the document', a.other, []],
      ['the owner, not in the private drive', a.owner, []],
    ];
    for (const [name, member, ids] of expected) {
      assert.deepEqual(await exported(member), ids, name);
      assert.deepEqual(await served(member), ids, `${name}: as GET /api/files serves them`);
    }
    const whole = rows(await runExport({ scope: { kind: 'workspace' } }), 'data/files.jsonl').filter((row) => images.includes(row.id));
    assert.deepEqual(whole.map((row) => row.id).sort(), images, 'the whole workspace has both');
    assert.ok(whole.every((row) => row.attached_to === null), 'on no message or task');

    // Access taken away: the drive membership and the share.
    await client.query('DELETE FROM drive_members WHERE drive_id = $1', [driveId]);
    await client.query('DELETE FROM document_shares WHERE document_id = $1', [documentId]);
    for (const member of [a.member, a.guest]) assert.deepEqual(await exported(member), [], `revoked: ${member}`);
  } finally {
    await client.query('DELETE FROM document_attachments WHERE document_id = $1', [documentId]);
    await client.query('DELETE FROM files WHERE id = ANY($1::text[])', [images]);
    await client.query('DELETE FROM document_shares WHERE document_id = $1', [documentId]);
    await client.query('DELETE FROM documents WHERE id = $1', [documentId]);
    await client.query('DELETE FROM drive_members WHERE drive_id = $1', [driveId]);
    await client.query('DELETE FROM drives WHERE id = $1', [driveId]);
    for (const id of images) await rm(join(world.uploadsDir, `${id}.bin`), { force: true });
  }
});

test('attachments: included bytes are exact and checksummed; every other file says why it is missing', { skip }, async () => {
  const exported = await runExport({ scope: { kind: 'workspace' } });
  const files = new Map(rows(exported, 'data/files.jsonl').map((row) => [row.id, row]));
  const sums = exported.files.get('SHA256SUMS')!.toString('utf8');
  const omitted = new Map(rows(exported, 'omissions.jsonl').filter((row) => row.kind === 'file').map((row) => [row.id, row.reason]));
  for (const key of ['onGeneral', 'onPrivateOthers', 'onOpenTask', 'legacyWatchedTask', 'legacyTaskBeforeMessage', 'unattachedOther']) {
    const row = files.get(world.a.files[key]!)!;
    assert.equal(row.included, true, key);
    assert.equal(exported.files.get(row.archive_path)!.toString('utf8'), `bytes of ${key}`);
    assert.ok(sums.includes(`  ${row.archive_path}\n`), key);
  }
  assert.deepEqual(files.get(world.a.files.legacyTaskBeforeMessage!)!.attached_to, { task_id: world.a.tasks.restricted });
  assert.ok(!files.has(world.a.files.onDeletedMessage!), 'a file on a deleted message is not exported');
  assert.ok(!files.has(world.a.files.onDeletedTask!), 'a file on a deleted task is not exported');
  assert.deepEqual(files.get(world.a.files.typedOverLegacy!)!.attached_to, { message_id: world.a.messages.privateOthers });
  assert.equal(files.get(world.a.files.stagedByMember!)!.included, true);
  for (const key of ['ambiguous', 'messageAndTask', 'blocked', 'missing', 'sizeMismatch', 'hashMismatch', 'namesBStorage',
    'paddedAlias', 'caseAlias', 'hardLink']) {
    const row = files.get(world.a.files[key]!)!;
    assert.equal(row.included, false, key);
    assert.equal(row.archive_path, null, key);
    assert.ok(omitted.get(world.a.files[key]!), `omission for ${key}`);
    assert.ok(![...exported.files.keys()].some((path) => path.startsWith(`attachments/${world.a.files[key]}/`)), `no bytes for ${key}`);
  }
  assert.equal(exported.manifest.complete, false);
});

test('attachments: a file deleted after the snapshot is reported, never referenced as present', { skip }, async () => {
  const victim = world.a.files.onGeneral2!;
  const storage = (await client.query<{ storage_key: string }>('SELECT storage_key FROM files WHERE id = $1', [victim])).rows[0]!.storage_key;
  const saved = await readFile(join(world.uploadsDir, storage));
  try {
    const exported = await runExport({ scope: { kind: 'workspace' }, hooks: { beforeFileRead: async (fileId) => {
      if (fileId === victim) await rm(join(world.uploadsDir, storage));
    } } });
    const row = rows(exported, 'data/files.jsonl').find((candidate) => candidate.id === victim)!;
    assert.equal(row.included, false);
    assert.equal(row.archive_path, null);
    assert.match(rows(exported, 'omissions.jsonl').find((omission) => omission.id === victim)!.reason, /missing/);
  } finally {
    await writeFile(join(world.uploadsDir, storage), saved);
  }
});

test('attachments: a file replaced, rewritten or removed during the read is reported, never included', { skip }, async () => {
  // Files without a recorded checksum, so only the identity checks can notice the change.
  const make = async (label: string) => {
    const fileId = randomUUID();
    const storage = `${fileId}-race.bin`;
    const bytes = Buffer.alloc(200 * 1024, 1);
    await writeFile(join(world.uploadsDir, storage), bytes);
    await client.query(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key)
      VALUES ($1, $2, $3, $4, 'application/octet-stream', $5, $6)`, [fileId, world.a.orgId, world.a.member, `${label}.bin`, bytes.length, storage]);
    return { fileId, path: join(world.uploadsDir, storage), size: bytes.length };
  };
  const replaced = await make('replaced');
  const rewritten = await make('rewritten');
  const removed = await make('removed');
  const vanished = await make('vanished');
  try {
    const exported = await runExport({ scope: { kind: 'workspace' }, hooks: {
      beforeOpen: async (fileId) => {
        // Removed after the checks, before the open: reported missing, not an aborted export.
        if (fileId === vanished.fileId) await rm(vanished.path);
        if (fileId !== replaced.fileId) return;
        await rm(replaced.path);
        await writeFile(replaced.path, Buffer.alloc(replaced.size, 2));
      },
      duringRead: async (fileId) => {
        if (fileId === rewritten.fileId) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await writeFile(rewritten.path, Buffer.alloc(rewritten.size, 3));
        }
        if (fileId === removed.fileId) await rm(removed.path);
      },
    } });
    const list = new Map(rows(exported, 'data/files.jsonl').map((row) => [row.id, row]));
    const reasons = new Map(rows(exported, 'omissions.jsonl').map((row) => [row.id, row.reason]));
    for (const { fileId } of [replaced, rewritten, removed, vanished]) {
      assert.equal(list.get(fileId)?.included, false, fileId);
      assert.match(reasons.get(fileId) ?? '', /changed|missing/);
      assert.ok(![...exported.files.keys()].some((path) => path.startsWith(`attachments/${fileId}/`)));
    }
  } finally {
    for (const { fileId, path } of [replaced, rewritten, removed, vanished]) {
      await client.query('DELETE FROM files WHERE id = $1', [fileId]);
      await rm(path, { force: true });
    }
  }
});

test('attachments: a symbolic link in the uploads folder is never followed', { skip }, async () => {
  const fileId = randomUUID();
  const storage = `${fileId}-symlink.bin`;
  const outside = join(scratch, `outside-${fileId}.txt`);
  await writeFile(outside, `outside ${SECRET_MARKER}`);
  try {
    await symlink(outside, join(world.uploadsDir, storage));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return; // Windows without the privilege to create symlinks.
    throw error;
  }
  try {
    await client.query(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key)
      VALUES ($1, $2, $3, 'link.txt', 'text/plain', $4, $5)`, [fileId, world.a.orgId, world.a.member, `outside ${SECRET_MARKER}`.length, storage]);
    const exported = await runExport({ scope: { kind: 'workspace' } });
    assert.equal(rows(exported, 'data/files.jsonl').find((row) => row.id === fileId)?.included, false);
  } finally {
    await client.query('DELETE FROM files WHERE id = $1', [fileId]);
    await rm(join(world.uploadsDir, storage), { force: true });
  }
});

test('attachments: a large file is streamed, not held in memory', { skip }, async () => {
  const size = 64 * 1024 * 1024;
  const fileId = randomUUID();
  const storage = `${fileId}.bin`;
  const chunk = Buffer.alloc(1024 * 1024, 7);
  const hash = createHash('sha256');
  const handle = await open(join(world.uploadsDir, storage), 'w');
  for (let written = 0; written < size; written += chunk.length) { await handle.write(chunk); hash.update(chunk); }
  await handle.close();
  await client.query(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key, content_sha256)
    VALUES ($1, $2, $3, 'big.bin', 'application/octet-stream', $4, $5, $6)`, [fileId, world.a.orgId, world.a.member, size, storage, `sha256:${hash.digest('hex')}`]);
  // Measure live memory, not garbage waiting for collection: collect before each sample.
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  gc();
  const baseline = process.memoryUsage();
  let peak = 0;
  const sampler = setInterval(() => {
    gc();
    const now = process.memoryUsage();
    peak = Math.max(peak, now.heapUsed + now.arrayBuffers - baseline.heapUsed - baseline.arrayBuffers);
  }, 100);
  try {
    // Not runExport: it reads every output file back into memory.
    const result = await exportWorkspace({ databaseUrl: databaseUrl!, workspace: world.a.slug, scope: { kind: 'workspace' },
      outDir: join(scratch, `export-${++counter}`), uploadsDir: world.uploadsDir, singleWorkspaceDatabase: true, hooks: { sharedDatabase: () => false } });
    clearInterval(sampler);
    const list = (await readFile(join(result.root, 'data', 'files.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(list.find((row) => row.id === fileId)?.included, true);
    await rm(result.root, { recursive: true, force: true });
  } finally {
    clearInterval(sampler);
    await client.query('DELETE FROM files WHERE id = $1', [fileId]);
    await rm(join(world.uploadsDir, storage), { force: true });
  }
  assert.ok(peak < size / 2, `peak memory growth ${Math.round(peak / 1048576)} MiB for a ${size / 1048576} MiB file`);
});

test('Contacts: records with declared fields only, relations between live records, and the product read rule', { skip }, async () => {
  const whole = await runExport({ scope: { kind: 'workspace' } });
  const schema = JSON.parse(whole.files.get('data/modules/contacts/schema.json')!.toString('utf8'));
  assert.deepEqual(schema.collections.map((collection: any) => collection.key).sort(), ['activities', 'companies', 'contacts', 'deals', 'outreach']);
  assert.ok(schema.collections.every((collection: any) => collection.fields.every((field: any) => !('default' in field))));
  const contacts = rows(whole, 'data/modules/contacts/collections/contacts.jsonl');
  assert.deepEqual(contacts.map((row) => row.id), [world.a.contacts.records.contact]);
  assert.deepEqual(Object.keys(contacts[0]!.fields).sort(), ['email', 'name', 'notes', 'owner', 'phone', 'status']);
  const companies = rows(whole, 'data/modules/contacts/collections/companies.jsonl');
  assert.equal(companies[0]!.fields.owner, null, 'an owner from another workspace is not named');
  assert.deepEqual(rows(whole, 'data/modules/contacts/relations.jsonl').map(({ field, source_record_id, target_record_id }) =>
    ({ field, source_record_id, target_record_id })),
  [{ field: 'company_id', source_record_id: world.a.contacts.records.contact, target_record_id: world.a.contacts.records.company }]);

  // The member scope follows assertInstallationAccess: members read Contacts; guests never; nobody reads a disabled module.
  const member = await runExport({ scope: { kind: 'member', member: world.a.member } });
  assert.equal(rows(member, 'data/modules.jsonl').length, 1);
  assert.equal(rows(member, 'data/modules/contacts/collections/contacts.jsonl').length, 1);
  const guest = await runExport({ scope: { kind: 'member', member: world.a.guest } });
  assert.equal(rows(guest, 'data/modules.jsonl').length, 0);
  assert.ok(![...guest.files.keys()].some((path) => path.startsWith('data/modules/')));
  await client.query('UPDATE module_installations SET is_enabled = false, disabled_at = now() WHERE id = $1', [world.a.contacts.installation]);
  try {
    const disabled = await runExport({ scope: { kind: 'member', member: world.a.owner } });
    assert.equal(rows(disabled, 'data/modules.jsonl').length, 0);
    const wholeDisabled = await runExport({ scope: { kind: 'workspace' } });
    assert.equal(rows(wholeDisabled, 'data/modules.jsonl')[0]!.is_enabled, false);
  } finally {
    await client.query('UPDATE module_installations SET is_enabled = true, disabled_at = NULL WHERE id = $1', [world.a.contacts.installation]);
  }
});

test('readable: README states scope, counts, omissions and what is not included; mail has a reserved place', { skip }, async () => {
  for (const scope of [{ kind: 'workspace' as const }, { kind: 'member' as const, member: world.a.member }]) {
    const exported = await runExport({ scope });
    const readme = exported.files.get('README.txt')!.toString('utf8');
    assert.match(readme, scope.kind === 'workspace' ? /including private spaces and direct messages/ : /Only what a member can see/);
    const countLines = readme.split('\n').filter((line) => line.endsWith(')') && line.startsWith('  '));
    for (const dataset of exported.manifest.datasets) {
      assert.ok(countLines.some((line) => line.trim().startsWith(`${dataset.records}  `) && line.endsWith(`(${dataset.path})`)), dataset.path);
    }
    assert.match(readme, /Mail and mail attachments: not included/);
    assert.match(readme, /Could not be included:/);
    assert.match(exported.files.get('mail/README.txt')!.toString('utf8'), /Mail is not included by this export command/);
    const html = exported.files.get('README.html')!.toString('utf8');
    assert.match(html, /<a href="conversations\/index.html">/);
    assert.ok(!html.includes('<script'));
  }
});

test('readable: one escaped transcript per exported space, holding exactly the exported messages', { skip }, async () => {
  // A space with a hostile name, an attachment with a hostile file name, and an empty space.
  const hostile = randomUUID();
  const empty = randomUUID();
  const hostileMessage = randomUUID();
  const hostileFile = randomUUID();
  const hostileStorage = `${hostileFile}-hostile.bin`;
  await client.query(`INSERT INTO spaces (id, org_id, name, type) VALUES ($1, $3, '<img src=x onerror=alert(1)>"&', 'public'),
    ($2, $3, 'empty space', 'public')`, [hostile, empty, world.a.orgId]);
  await client.query(`INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, 'hello')`,
    [hostileMessage, world.a.orgId, hostile, world.a.member]);
  await writeFile(join(world.uploadsDir, hostileStorage), 'hostile bytes');
  await client.query(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key)
    VALUES ($1, $2, $3, '"><script>alert(1)</script>.txt', 'text/plain', 13, $4)`, [hostileFile, world.a.orgId, world.a.member, hostileStorage]);
  await client.query('INSERT INTO message_attachments (org_id, message_id, file_id, position) VALUES ($1, $2, $3, 0)',
    [world.a.orgId, hostileMessage, hostileFile]);
  try {
    for (const scope of [{ kind: 'workspace' as const }, { kind: 'member' as const, member: world.a.member }, { kind: 'member' as const, member: world.a.guest }]) {
      const exported = await runExport({ scope });
      const messages = rows(exported, 'data/messages.jsonl');
      const spaceIds = rows(exported, 'data/spaces.jsonl').map((row) => row.id).sort();
      const fileRows = rows(exported, 'data/files.jsonl');
      const transcriptSpaces: string[] = [];
      const transcriptIds: string[] = [];
      const index = exported.files.get('conversations/index.html')!.toString('utf8');
      assert.equal(index.match(/<\/body>/g)?.length, 1, 'index has one end of body');
      assert.ok(index.trimEnd().endsWith('</ul></body></html>'), 'the index list closes before the document');
      for (const [path, bytes] of exported.files) {
        const match = /^conversations\/([^/]+)\.html$/.exec(path);
        if (!match || match[1] === 'index') continue;
        transcriptSpaces.push(match[1]!);
        const html = bytes.toString('utf8');
        assert.ok(!/<script|<img/i.test(html), `${path} contains active markup`);
        assert.equal(html.match(/<\/body>/g)?.length, 1, `${path} has one end of body`);
        assert.ok(html.includes(`href="${match[1]}.html"`) || index.includes(`href="${match[1]}.html"`), `${path} is in the index`);
        // Each message's attachment links are exactly its included files.
        for (const block of html.split('<div class="message').slice(1)) {
          const messageId = /id="m-([^"]+)"/.exec(block)![1]!;
          const linked = [...block.matchAll(/href="\.\.\/(attachments\/[^"]+)"/g)].map((found) => decodeURIComponent(found[1]!)).sort();
          const expected = fileRows.filter((file) => file.attached_to?.message_id === messageId && file.included)
            .map((file) => file.archive_path).sort();
          assert.deepEqual(linked, expected, `attachment links of ${messageId}`);
          for (const target of linked) assert.ok(exported.files.has(target), `${path} links to a missing file ${target}`);
          transcriptIds.push(messageId);
        }
      }
      assert.deepEqual(transcriptSpaces.sort(), spaceIds, 'one transcript for every exported space');
      assert.deepEqual(transcriptIds.sort(), messages.map((row) => row.id).sort());
      assert.equal((index.match(/<li>/g) ?? []).length, spaceIds.length);
    }
    const whole = await runExport({ scope: { kind: 'workspace' } });
    const general = whole.files.get(`conversations/${world.a.spaces.general}.html`)!.toString('utf8');
    assert.ok(general.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; &amp; done'));
    assert.match(general, /missing\.txt <span class="muted">\(not included; see omissions\)/);
    assert.match(whole.files.get(`conversations/${empty}.html`)!.toString('utf8'), /No messages\./);
    const hostilePage = whole.files.get(`conversations/${hostile}.html`)!.toString('utf8');
    assert.ok(hostilePage.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;'));
    assert.ok(hostilePage.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;.txt'));
  } finally {
    await client.query('DELETE FROM message_attachments WHERE file_id = $1', [hostileFile]);
    await client.query('DELETE FROM files WHERE id = $1', [hostileFile]);
    await client.query('DELETE FROM messages WHERE id = $1', [hostileMessage]);
    await client.query('DELETE FROM spaces WHERE id = ANY($1)', [[hostile, empty]]);
    await rm(join(world.uploadsDir, hostileStorage), { force: true });
  }
});

test('modules: a custom module whose collection is named like an export file still exports, records and relations apart', { skip }, async () => {
  const { installModuleFromManifest } = await import('../src/lib/module-service.js');
  const slug = `ex1custom${randomUUID().slice(0, 6)}`;
  await installModuleFromManifest({ kind: 'human', org_id: world.a.orgId, actor_id: world.a.owner, role: 'owner', source: 'ui', scopes: [] }, {
    schema_version: '1', id: `com.example.${slug}`, slug, name: 'Custom', version: '1.0.0', icon: 'contact', description: 'Export collision test.',
    navigation: { default_collection: 'relations', default_view: 'table' },
    collections: [{
      key: 'relations', name: 'Relations', singular_name: 'Relation',
      fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
      search: { fields: ['name'], title_field: 'name' },
      views: [{ key: 'table', name: 'Table', type: 'table', fields: ['name'] }],
    }, {
      key: 'con', name: 'Device name', singular_name: 'Device',
      fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
      search: { fields: ['name'], title_field: 'name' },
      views: [{ key: 'table', name: 'Table', type: 'table', fields: ['name'] }],
    }],
  }, { source: 'sideloaded' });
  const installed = (await client.query<{ installation: string; version: string }>(`SELECT i.id AS installation, v.id AS version
    FROM module_installations i JOIN module_versions v ON v.installation_id = i.id AND v.is_active WHERE i.org_id = $1 AND i.slug = $2`,
  [world.a.orgId, slug])).rows[0]!;
  await client.query(`INSERT INTO module_records (id, org_id, installation_id, collection_key, validated_version_id, data, search_title,
      created_by_actor_type, created_by_actor_id, updated_by_actor_type, updated_by_actor_id)
    VALUES ($1, $2, $3, 'relations', $4, '{"name":"kept"}', 'kept', 'human', $5, 'human', $5)`,
  [randomUUID(), world.a.orgId, installed.installation, installed.version, world.a.owner]);
  await client.query(`INSERT INTO module_records (id, org_id, installation_id, collection_key, validated_version_id, data, search_title,
      created_by_actor_type, created_by_actor_id, updated_by_actor_type, updated_by_actor_id)
    VALUES ($1, $2, $3, 'con', $4, '{"name":"device"}', 'device', 'human', $5, 'human', $5)`,
  [randomUUID(), world.a.orgId, installed.installation, installed.version, world.a.owner]);
  const exported = await runExport({ scope: { kind: 'workspace' } });
  // A collection named like a Windows device is stored under a safe name, not an aborted export.
  assert.deepEqual(rows(exported, `data/modules/${slug}/collections/_con.jsonl`).map((row) => row.fields), [{ name: 'device' }]);
  assert.deepEqual(rows(exported, `data/modules/${slug}/collections/relations.jsonl`).map((row) => row.fields), [{ name: 'kept' }]);
  assert.deepEqual(rows(exported, `data/modules/${slug}/relations.jsonl`), []);
});

test('modules: a manifest that fails its integrity check is never used to choose fields', async () => {
  const { verifiedManifest } = await import('../src/lib/workspace-export/modules.js');
  const { digestSupportedModuleManifest } = await import('@deft/shared/modules');
  const manifest = JSON.parse(await readFile(join(import.meta.dirname, '..', '..', '..', 'modules', 'bundled', 'contacts', 'deft.module.json'), 'utf8'));
  const digest = await digestSupportedModuleManifest(manifest);
  assert.ok(await verifiedManifest({ manifest, manifest_digest: digest }));
  // A field added to the stored manifest after it was recorded: the digest no longer matches.
  const tampered = structuredClone(manifest);
  tampered.collections[0].fields.push({ key: 'undeclared_secret', label: 'Secret', type: 'text', required: false });
  assert.equal(await verifiedManifest({ manifest: tampered, manifest_digest: digest }), null);
  assert.equal(await verifiedManifest({ manifest: { not: 'a manifest' }, manifest_digest: digest }), null);
});

test('the command writes one tar that extracts, verifies against SHA256SUMS, and holds no secret or other workspace', { skip }, async () => {
  const { runCommand } = await import('../src/scripts/export-workspace.js');
  const { spawnSync } = await import('node:child_process');
  for (const scope of [{ kind: 'workspace' as const }, { kind: 'member' as const, member: world.a.member }]) {
    const tarPath = join(scratch, `command-${++counter}.tar`);
    const keyFile = join(scratch, `key-${counter}`);
    await writeFile(keyFile, 'not a real key');
    await runCommand({ databaseUrl: databaseUrl!, workspace: world.a.slug, uploads: world.uploadsDir, out: tarPath, folder: false,
      scope, workspaceKeyFile: scope.kind === 'workspace' ? keyFile : null });
    const raw = (await readFile(tarPath)).toString('latin1');
    for (const needle of [SECRET_MARKER, B_MARKER, ...world.forbidden]) assert.ok(!raw.includes(needle), `tar contains ${needle}`);
    const out = join(scratch, `extract-${counter}`);
    await mkdir(out);
    assert.equal(spawnSync(systemTar, ['-xf', tarPath, '-C', out]).status, 0);
    const root = join(out, `command-${counter}`);
    const sums = (await readFile(join(root, 'SHA256SUMS'), 'utf8')).split('\n').filter(Boolean);
    assert.ok(sums.length > 20);
    for (const line of sums) {
      const [hash, ...rest] = line.split('  ');
      const bytes = await readFile(join(root, ...rest.join('  ').split('/')));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, rest.join('  '));
    }
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.workspace_key, scope.kind === 'workspace' ? 'supplied_not_used' : 'not_supplied');
    assert.equal(manifest.scope.kind, scope.kind);
  }
});
test('attachments: without the operator declaring a one-workspace database, no bytes are copied', { skip }, async () => {
  // Called directly, with the option left out entirely: the default must not copy.
  const result = await exportWorkspace({ databaseUrl: databaseUrl!, workspace: world.a.slug, scope: { kind: 'workspace' },
    outDir: join(scratch, `export-${++counter}`), uploadsDir: world.uploadsDir });
  assert.deepEqual(result.manifest.attachments, { single_workspace_declared: false, files_copied: 0 });
  const files = (await readFile(join(result.root, 'data', 'files.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(files.length > 10);
  assert.ok(files.every((row) => row.included === false && row.archive_path === null && row.sha256 === null));
  const reasons = new Map((await readFile(join(result.root, 'omissions.jsonl'), 'utf8')).split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).map((row) => [row.id, row.reason]));
  for (const row of files) assert.ok(reasons.get(row.id), `omission for ${row.id}`);
  assert.ok(files.some((row) => /exactly one workspace \(--single-workspace-database\)/.test(reasons.get(row.id) ?? '')));
  await assert.rejects(readdir(join(result.root, 'attachments')), /ENOENT/);
});

test('attachments: declaring a one-workspace database that shows another workspace stops the export before any byte', { skip }, async () => {
  const outDir = join(scratch, `export-${++counter}`);
  await assert.rejects(exportWorkspace({ databaseUrl: databaseUrl!, workspace: world.a.slug, scope: { kind: 'workspace' }, outDir,
    uploadsDir: world.uploadsDir, singleWorkspaceDatabase: true }), /shows another workspace/);
  await assert.rejects(readdir(join(outDir, 'attachments')), /ENOENT/);
  await assert.rejects(readFile(join(outDir, 'SHA256SUMS')), /ENOENT/);
});

test('attachments: a declared one-workspace database copies, keeping the checks that need no other workspace', { skip }, async () => {
  const exported = await runExport({ scope: { kind: 'workspace' } });
  assert.equal(exported.manifest.attachments.single_workspace_declared, true);
  const files = new Map(rows(exported, 'data/files.jsonl').map((row) => [row.id, row]));
  assert.equal(exported.manifest.attachments.files_copied, [...files.values()].filter((row) => row.included).length);
  const actual = (row: any) => createHash('sha256').update(exported.files.get(row.archive_path)!).digest('hex');
  const onGeneral = files.get(world.a.files.onGeneral!)!;
  assert.equal(onGeneral.sha256, actual(onGeneral));
  assert.equal(onGeneral.recorded_sha256, onGeneral.sha256);
  // A file Deft recorded no checksum for: the archive still carries the digest of the bytes it copied.
  const unrecorded = files.get(world.a.files.noRecordedHash!)!;
  assert.equal(unrecorded.included, true);
  assert.equal(unrecorded.recorded_sha256, null);
  assert.equal(unrecorded.sha256, actual(unrecorded));
  for (const key of ['missing', 'sizeMismatch', 'hashMismatch', 'hardLink', 'blocked', 'paddedAlias', 'caseAlias', 'namesBStorage']) {
    assert.equal(files.get(world.a.files[key]!)!.included, false, key);
  }
});

test('attachments: the shared-database decision counts any trace of another workspace', { skip }, async () => {
  // A throwaway database holding only the tables the decision reads.
  const name = `deft_test_ex1_classify_${randomUUID().slice(0, 8)}`;
  try {
    await client.query(`CREATE DATABASE ${name}`);
  } catch (error) {
    if ((error as { code?: string }).code === '42501') return; // no CREATEDB privilege in this environment
    throw error;
  }
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  const scratchDb = new pg.Client({ connectionString: url.toString() });
  await scratchDb.connect();
  try {
    await scratchDb.query(`CREATE TABLE orgs (id text PRIMARY KEY); CREATE TABLE files (id text, org_id text);
      CREATE TABLE notes (id text, org_id text); CREATE TABLE skills (id text, org_id text)`);
    const { databaseIsShared } = await import('../src/lib/workspace-export/attachments.js');
    const decide = async () => {
      const snapshot = await Snapshot.open({ databaseUrl: url.toString() });
      try { return await databaseIsShared(snapshot, 'ours'); } finally { await snapshot.close(); }
    };
    assert.equal(await decide(), true, 'this workspace is missing');
    await scratchDb.query(`INSERT INTO orgs VALUES ('ours'); INSERT INTO files VALUES ('f1', 'ours'); INSERT INTO notes VALUES ('n1', 'ours');
      INSERT INTO skills VALUES ('bundled', NULL)`);
    assert.equal(await decide(), false, 'only this workspace (and shared rows with no workspace)');
    await scratchDb.query(`INSERT INTO notes VALUES ('n2', 'gone')`);
    assert.equal(await decide(), true, 'a note left by a deleted workspace');
    await scratchDb.query(`DELETE FROM notes WHERE org_id = 'gone'; INSERT INTO files VALUES ('f2', 'gone')`);
    assert.equal(await decide(), true, 'a file row left by a deleted workspace');
    await scratchDb.query(`DELETE FROM files WHERE org_id = 'gone'; INSERT INTO orgs VALUES ('other')`);
    assert.equal(await decide(), true, 'another workspace with no members or content');

    // The search path of the role or connection cannot change what is read:
    // a decoy schema first in the path, holding a one-row orgs table and no
    // workspace columns, is ignored; the pinned schema is scanned and read.
    await scratchDb.query(`DELETE FROM orgs WHERE id = 'other'; INSERT INTO notes VALUES ('n3', 'gone');
      CREATE SCHEMA personal; CREATE TABLE personal.orgs (id text); INSERT INTO personal.orgs VALUES ('ours')`);
    const decoyUrl = new URL(url.toString());
    decoyUrl.searchParams.set('options', '-c search_path=personal,public');
    const pinned = await Snapshot.open({ databaseUrl: decoyUrl.toString() });
    try {
      assert.equal((await pinned.all<{ search_path: string }>(sql`SHOW search_path`))[0]!.search_path, 'pg_catalog, public');
      assert.equal(await databaseIsShared(pinned, 'ours'), true, 'the note left in public is found despite the decoy');
      await assert.rejects(pinned.requireTables(['orgs', 'missing_table']), /not found there: missing_table/);
    } finally {
      await pinned.close();
    }
    // Deft's tables are not in the schema asked for: refused, naming what is missing.
    const wrongSchema = await Snapshot.open({ databaseUrl: url.toString(), schema: 'personal' });
    try {
      await assert.rejects(wrongSchema.requireTables(['orgs', 'files', 'notes']), /schema "personal" \(not found there: files, notes\)/);
    } finally {
      await wrongSchema.close();
    }
    // A workspace column whose name differs only in case would escape the scan: refused.
    await scratchDb.query(`DELETE FROM notes WHERE org_id = 'gone'; CREATE TABLE odd ("Org_Id" text)`);
    await assert.rejects(decide(), /not named exactly org_id in: odd/);
    // A view standing in for one of Deft's tables is refused, so a view cannot hide rows from the scan.
    await scratchDb.query('DROP TABLE odd; CREATE VIEW files_view AS SELECT * FROM files');
    const viewCheck = await Snapshot.open({ databaseUrl: url.toString() });
    try {
      await assert.rejects(viewCheck.requireTables(['orgs', 'files_view']), /not found there: files_view/);
    } finally {
      await viewCheck.close();
    }
  } finally {
    await scratchDb.end();
    await client.query(`DROP DATABASE IF EXISTS ${name}`);
  }
});


test('attachments: even when the scan would call the database single, nothing is copied without the declaration', { skip }, async () => {
  const reads: string[] = [];
  const exported = await runExport({ scope: { kind: 'workspace' }, singleWorkspaceDatabase: false,
    hooks: { sharedDatabase: () => false, beforeFileRead: async (fileId) => { reads.push(fileId); } } });
  assert.deepEqual(reads, [], 'no stored file is even looked at');
  assert.deepEqual(exported.manifest.attachments, { single_workspace_declared: false, files_copied: 0 });
  assert.ok(rows(exported, 'data/files.jsonl').every((row) => row.included === false));
  assert.ok(![...exported.files.keys()].some((path) => path.startsWith('attachments/')));
});

test('the export refuses a schema whose tables are views over the real ones, before writing anything', { skip }, async () => {
  const schema = `ex1_views_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
  await client.query(`CREATE SCHEMA ${schema}`);
  try {
    for (const table of EXPORT_TABLES) await client.query(`CREATE VIEW ${schema}.${table} AS SELECT * FROM public.${table}`);
    const outDir = join(scratch, `export-${++counter}`);
    await assert.rejects(exportWorkspace({ databaseUrl: databaseUrl!, workspace: world.a.slug, scope: { kind: 'workspace' }, outDir,
      uploadsDir: world.uploadsDir, singleWorkspaceDatabase: true, databaseSchema: schema }), /not all plain tables in the schema/);
    await assert.rejects(readdir(outDir), /ENOENT/);
  } finally {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
  }
});

test('readable: the README says plainly when attachment files were not copied, and why', { skip }, async () => {
  const notCopied = await runExport({ scope: { kind: 'workspace' }, singleWorkspaceDatabase: false });
  const text = notCopied.files.get('README.txt')!.toString('utf8');
  assert.match(text, /Attachment files were not copied: .*exactly one workspace \(--single-workspace-database\)/);
  assert.match(text, /Database schema read: public/);
  assert.match(notCopied.files.get('README.html')!.toString('utf8'), /<strong>Attachment files were not copied/);
  const copied = await runExport({ scope: { kind: 'workspace' } });
  assert.doesNotMatch(copied.files.get('README.txt')!.toString('utf8'), /were not copied/);
});

test('modules: each module table must be a plain table in the schema; a view in its place is refused', { skip }, async () => {
  const moduleTables = ['module_installations', 'module_versions', 'module_records', 'module_record_relations'];
  for (const viewed of moduleTables) {
    const schema = `ex1_mod_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    try {
      for (const table of EXPORT_TABLES) {
        await client.query(table === viewed
          ? `CREATE VIEW ${schema}.${table} AS SELECT * FROM public.${table}`
          : `CREATE TABLE ${schema}.${table} (LIKE public.${table})`);
      }
      await assert.rejects(exportWorkspace({ databaseUrl: databaseUrl!, workspace: world.a.slug, scope: { kind: 'workspace' },
        outDir: join(scratch, `export-${++counter}`), uploadsDir: world.uploadsDir, databaseSchema: schema }),
      (error: Error) => error.message.includes(`(not found there: ${viewed})`));
    } finally {
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  }
});

test('modules: a module whose slug Windows reserves is stored under a safe folder name', { skip }, async () => {
  const { installModuleFromManifest } = await import('../src/lib/module-service.js');
  await installModuleFromManifest({ kind: 'human', org_id: world.a.orgId, actor_id: world.a.owner, role: 'owner', source: 'ui', scopes: [] }, {
    schema_version: '1', id: `com.example.device${randomUUID().slice(0, 6)}`, slug: 'con', name: 'Device', version: '1.0.0', icon: 'contact',
    description: 'Reserved slug test.', navigation: { default_collection: 'items', default_view: 'table' },
    collections: [{ key: 'items', name: 'Items', singular_name: 'Item', fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
      search: { fields: ['name'], title_field: 'name' }, views: [{ key: 'table', name: 'Table', type: 'table', fields: ['name'] }] }],
  }, { source: 'sideloaded' });
  const installed = (await client.query<{ installation: string; version: string }>(`SELECT i.id AS installation, v.id AS version
    FROM module_installations i JOIN module_versions v ON v.installation_id = i.id AND v.is_active WHERE i.org_id = $1 AND i.slug = 'con'`,
  [world.a.orgId])).rows[0]!;
  await client.query(`INSERT INTO module_records (id, org_id, installation_id, collection_key, validated_version_id, data, search_title,
      created_by_actor_type, created_by_actor_id, updated_by_actor_type, updated_by_actor_id)
    VALUES ($1, $2, $3, 'items', $4, '{"name":"kept"}', 'kept', 'human', $5, 'human', $5)`,
  [randomUUID(), world.a.orgId, installed.installation, installed.version, world.a.owner]);
  const exported = await runExport({ scope: { kind: 'workspace' } });
  assert.deepEqual(rows(exported, 'data/modules/_con/collections/items.jsonl').map((row) => row.fields), [{ name: 'kept' }]);
  assert.ok(exported.files.has('data/modules/_con/schema.json'));
});

/** Adds a file of this workspace, attached to nothing, with real bytes under storage. */
async function addFile(filename: string, storage: string, bytes: Buffer | null): Promise<string> {
  const fileId = randomUUID();
  if (bytes) await writeFile(join(world.uploadsDir, storage), bytes);
  await client.query(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key)
    VALUES ($1, $2, $3, $4, 'application/octet-stream', $5, $6)`, [fileId, world.a.orgId, world.a.member, filename, bytes?.length ?? 1, storage]);
  return fileId;
}

test('attachments: a long multi-byte name is written, cut at a whole character, and the original kept', { skip }, async () => {
  const filename = `${'報告書の最終版'.repeat(43)}.pdf`;
  const storage = `${randomUUID()}-long.bin`;
  const fileId = await addFile(filename, storage, Buffer.from('long name bytes'));
  try {
    const exported = await runExport({ scope: { kind: 'workspace' } });
    const row = rows(exported, 'data/files.jsonl').find((candidate) => candidate.id === fileId)!;
    assert.equal(row.included, true);
    assert.equal(row.filename, filename);
    const name = row.archive_path.split('/').at(-1);
    assert.ok(Buffer.byteLength(name, 'utf8') <= 181 && name.endsWith('.pdf') && filename.startsWith(name.slice(0, -4)), name);
    assert.deepEqual(exported.files.get(row.archive_path), Buffer.from('long name bytes'));
  } finally {
    await client.query('DELETE FROM files WHERE id = $1', [fileId]);
    await rm(join(world.uploadsDir, storage), { force: true });
  }
});

test('attachments: a name the file system refuses is omitted and the export completes; a full disk still stops it', { skip }, async () => {
  const refused = await addFile('refused.txt', `${randomUUID()}-a.bin`, Buffer.from('a'));
  const secondChoice = await addFile('second choice.txt', `${randomUUID()}-b.bin`, Buffer.from('b'));
  const nameError = () => Object.assign(new Error('name too long'), { code: 'ENAMETOOLONG' });
  const badCharacters = () => Object.assign(new Error('invalid argument'), { code: 'EINVAL' });
  try {
    const exported = await runExport({ scope: { kind: 'workspace' }, hooks: { beforeWrite: async (fileId, path) => {
      if (fileId === refused) throw badCharacters();
      if (fileId === secondChoice && !path.endsWith('/file.txt')) throw nameError();
    } } });
    const list = new Map(rows(exported, 'data/files.jsonl').map((row) => [row.id, row]));
    assert.equal(list.get(refused)?.included, false);
    assert.match(rows(exported, 'omissions.jsonl').find((row) => row.id === refused)!.reason, /refused the characters/);
    assert.equal(list.get(secondChoice)?.archive_path, `attachments/${secondChoice}/file.txt`);
    assert.deepEqual(exported.files.get(`attachments/${secondChoice}/file.txt`), Buffer.from('b'));
    assert.equal(exported.manifest.complete, false);
    assert.ok([...list.values()].some((row) => row.included && row.id !== secondChoice), 'the other files are still copied');
    await assert.rejects(runExport({ scope: { kind: 'workspace' }, hooks: { beforeWrite: async (fileId) => {
      if (fileId === refused) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    } } }), /no space left/);
    // Even the short plain name too long: the output path is at fault, not the file, so the export stops.
    await assert.rejects(runExport({ scope: { kind: 'workspace' }, hooks: { beforeWrite: async (fileId) => {
      if (fileId === refused) throw nameError();
    } } }), /output path is too long/);
  } finally {
    await client.query('DELETE FROM files WHERE id = ANY($1)', [[refused, secondChoice]]);
  }
});

test('attachments: a stored file whose name the uploads file system refuses is reported, not a failed export', { skip }, async () => {
  // Longer than any file system allows: Linux refuses it (ENAMETOOLONG), Windows reports it missing.
  const fileId = await addFile('unreadable.txt', 'k'.repeat(300), null);
  try {
    const exported = await runExport({ scope: { kind: 'workspace' } });
    assert.equal(rows(exported, 'data/files.jsonl').find((row) => row.id === fileId)?.included, false);
    assert.match(rows(exported, 'omissions.jsonl').find((row) => row.id === fileId)!.reason, /cannot be read|missing/);
  } finally {
    await client.query('DELETE FROM files WHERE id = $1', [fileId]);
  }
});
