/**
 * Check 14.3: a download or media stream of a person's private content must
 * never be kept by a browser or a proxy. Every such response carries
 * `Cache-Control: private, no-store`, and a clip's audio is sent as a download.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/private-download-cache-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { wikiRoutes } from '../src/routes/wiki.js';
import { clipRoutes } from '../src/routes/clips.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const userId = randomUUID();
const spaceId = randomUUID();
const messageId = randomUUID();
const clipId = randomUUID();
const CLIP_DIR = join(process.cwd(), '..', '..', 'uploads', 'clips');
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('user', { id: userId, org_id: orgId, email: `${userId}@example.test`, sid: `cache-${userId}`, role: 'member' } as any);
  await next();
});
app.route('/api/wiki', wikiRoutes);
app.route('/api/clips', clipRoutes);

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  const q = (text: string, values: unknown[]) => client!.query(text, values);
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Cache', `cache-${orgId}`]);
  await q(`INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,'Mia','human',false)`, [userId, `${userId}@example.test`]);
  await q(`INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'member')`, [randomUUID(), orgId, userId]);
  await q(`INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,'cache','private',$3)`, [spaceId, orgId, userId]);
  await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), spaceId, userId]);
  await q(`INSERT INTO messages(id,org_id,space_id,user_id,content) VALUES($1,$2,$3,$4,'clip')`, [messageId, orgId, spaceId, userId]);
  await q(`INSERT INTO clips(id,org_id,space_id,message_id,context_type,context_id,created_by,file_key,status)
    VALUES($1,$2,$3,$4,'space',$3,$5,$6,'ready')`, [clipId, orgId, spaceId, messageId, userId, `${clipId}.webm`]);
  await q(`INSERT INTO wiki_pages(id,org_id,scope,user_id,type,title,slug,content)
    VALUES($1,$2,'org',$3,'fact','Private page',$4,'PRIVATE-WIKI-TEXT')`, [randomUUID(), orgId, userId, `cache-${orgId}`]);
  await mkdir(CLIP_DIR, { recursive: true });
  await writeFile(join(CLIP_DIR, `${clipId}.webm`), Buffer.from('not really audio'));
});

after(async () => {
  await rm(join(CLIP_DIR, `${clipId}.webm`), { force: true });
  if (client) {
    for (const table of ['clips', 'wiki_pages', 'messages']) await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
    await client.query('DELETE FROM space_members WHERE space_id=$1', [spaceId]);
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=$1', [userId]);
    await client.end();
  }
  await closeDb();
});

test('14.3: the wiki export is never cacheable, in every format', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const format of ['md', 'csv', 'json']) {
    const response = await app.request(`/api/wiki/export?format=${format}`);
    assert.equal(response.status, 200, format);
    assert.match(await response.text(), /PRIVATE-WIKI-TEXT/, format);
    assert.equal(response.headers.get('cache-control'), 'private, no-store', format);
  }
});

test('14.3: clip audio is a download and never cacheable', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const response = await app.request(`/api/clips/${clipId}/audio`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});
