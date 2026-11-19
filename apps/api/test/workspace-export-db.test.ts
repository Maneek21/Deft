/**
 * Workspace exporter: one workspace only, no stored secrets, the member scope
 * shows no more than the product does, one snapshot, bounded reads.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/workspace-export-db.test.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';

import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
import { B_MARKER, SECRET_MARKER, dropExportWorld, seedExportWorld, type ExportWorld } from './fixtures/workspace-export-fixture.js';
import { exportWorkspace, type ExportOptions } from '../src/lib/workspace-export/export.js';
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
    world.b.agentUser, world.b.agentEmployee, ...Object.values(world.b.spaces)].filter((id) => !sharedIds.has(id));
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
      assert.ok(!bytes.toString('utf8').includes(SECRET_MARKER), `${path} (${JSON.stringify(scope)}) contains a secret`);
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
    for (const spaceId of Object.values(world.a.spaces)) {
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
  // The private space of two other people is never in the member's export.
  const member = await runExport({ scope: { kind: 'member', member: world.a.member } });
  assert.ok(!rows(member, 'data/spaces.jsonl').some((row) => row.id === world.a.spaces.privateOthers));
  assert.ok(rows(member, 'data/spaces.jsonl').some((row) => row.id === world.a.spaces.archivedPrivateWithMember));
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
    const product = (await response.json() as any[]).map((row) => ({ user_id: row.id, name: row.name, email: row.email, kind: row.kind, role: row.role }));
    const exported = rows(await runExport({ scope: { kind: 'member', member: userId } }), 'data/members.jsonl')
      .map(({ user_id, name, email, kind, role }) => ({ user_id, name, email, kind, role }));
    const byId = (list: any[]) => [...list].sort((x, y) => x.user_id.localeCompare(y.user_id));
    assert.deepEqual(byId(exported), byId(product));
  }
});

test('whole-workspace scope: every space and person, former members flagged, agents described without secrets', { skip }, async () => {
  const exported = await runExport({ scope: { kind: 'workspace' } });
  assert.deepEqual(rows(exported, 'data/spaces.jsonl').map((row) => row.id).sort(), Object.values(world.a.spaces).sort());
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

test('rows are read in bounded batches', { skip }, async () => {
  const fetches: number[] = [];
  await runExport({ scope: { kind: 'workspace' }, batchSize: 2, onFetch: (count) => fetches.push(count) });
  assert.ok(fetches.length > 5);
  assert.ok(fetches.every((count) => count <= 2));
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
