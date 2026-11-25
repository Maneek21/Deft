/**
 * Launch check 14.2 (row 15 and the canary): every clip route refuses anyone
 * who is not a member of the clip's space, and a role never waives that:
 * an owner or admin outside the space is refused like anyone else, and so is
 * a guest (also on a public space, which a guest may never read before
 * joining). Members of the space are allowed.
 *
 * The routes come from the clip router itself, so a route added later
 * without a case here fails the first test instead of going untested.
 *
 * Run: pnpm --filter @deft/api test test/clip-routes-space-membership-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { clipRoutes } from '../src/routes/clips.js';
import { closeDb, db } from '../src/lib/db.js';

const CLIP_DIR = join(process.cwd(), '..', '..', 'uploads', 'clips');
const AUDIO = 'CANARY-CLIP-AUDIO-BYTES';
const TRANSCRIPT = 'CANARY-CLIP-TRANSCRIPT';
const orgId = randomUUID();
const people = {
  /** In the clip's space; made the clip. */
  creator: randomUUID(),
  /** In the clip's space. */
  insider: randomUUID(),
  owner: randomUUID(),
  admin: randomUUID(),
  /** A member of the workspace who is in a different private space. */
  member: randomUUID(),
  /** A guest of the workspace who is in that other private space. */
  guest: randomUUID(),
};
const roles: Record<string, 'owner' | 'admin' | 'member' | 'guest'> = {
  [people.creator]: 'member', [people.insider]: 'member', [people.owner]: 'owner',
  [people.admin]: 'admin', [people.member]: 'member', [people.guest]: 'guest',
};
const spaces = { secret: randomUUID(), other: randomUUID(), open: randomUUID() };
const clipIds = { secret: randomUUID(), open: randomUUID(), toDelete: randomUUID() };
const fileKeys = new Set<string>();

/** Not in the private space the clip is filed in. */
const OUTSIDERS: Array<[string, string]> = [
  ['the workspace owner, not in the space', people.owner],
  ['an admin, not in the space', people.admin],
  ['a member of another private space', people.member],
  ['a guest', people.guest],
];
/** In the clip's space. */
const MEMBERS: Array<[string, string]> = [['the clip\'s creator', people.creator], ['another member of the space', people.insider]];

async function call(actor: string, method: string, path: string, body?: FormData) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: actor, org_id: orgId, email: `${actor}@example.test`, role: roles[actor], sid: `clip-${actor}` } as never);
    await next();
  });
  app.route('/api/clips', clipRoutes);
  const response = await app.request(path, { method, ...(body ? { body } : {}) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString('utf8');
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, text, json, headers: response.headers };
}

function upload(spaceId: string) {
  const form = new FormData();
  form.append('file', new File([Buffer.from('uploaded clip')], 'clip.webm', { type: 'audio/webm' }));
  form.append('context_type', 'space');
  form.append('context_id', spaceId);
  form.append('space_id', spaceId);
  form.append('duration', '3');
  return form;
}

const clipCount = async () => Number((await db.execute(sql`SELECT count(*)::int AS n FROM clips WHERE org_id = ${orgId}`)).rows[0]!.n);
const isDeleted = async (id: string) => (await db.execute(sql`SELECT is_deleted FROM clips WHERE id = ${id}`)).rows[0]!.is_deleted as boolean;

/** No refusal names the clip's file, its size or what was said in it. */
function assertNoLeak(label: string, text: string) {
  for (const secret of [AUDIO, TRANSCRIPT, ...fileKeys, 'file_size', 'transcript']) {
    assert.ok(!text.includes(secret), `${label}: the refusal leaks ${secret}: ${text}`);
  }
}

type Refusal = { status: number; code: string };
type RouteCase = {
  /** Asked for a clip (or its space) in a space the caller is not in. */
  refused(actor: string, clip: string, space: string): Promise<{ status: number; text: string; json: any }>;
  refusal: Refusal;
  /** The same request by someone in the space succeeds. */
  canary(actor: string): Promise<void>;
  /** After every refusal: nothing changed. */
  unchanged?(): Promise<void>;
};

/** One case per route of the clip router, keyed `METHOD path` as the router lists it. */
const CASES: Record<string, RouteCase> = {
  'GET /:id': {
    refused: (actor, clip) => call(actor, 'GET', `/api/clips/${clip}`),
    refusal: { status: 404, code: 'NOT_FOUND' },
    async canary(actor) {
      const res = await call(actor, 'GET', `/api/clips/${clipIds.secret}`);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.id, clipIds.secret);
    },
  },
  'GET /:id/audio': {
    refused: (actor, clip) => call(actor, 'GET', `/api/clips/${clip}/audio`),
    refusal: { status: 404, code: 'NOT_FOUND' },
    async canary(actor) {
      const res = await call(actor, 'GET', `/api/clips/${clipIds.secret}/audio`);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.text, AUDIO);
    },
  },
  'GET /space/:spaceId': {
    refused: (actor, _clip, space) => call(actor, 'GET', `/api/clips/space/${space}`),
    refusal: { status: 403, code: 'FORBIDDEN' },
    async canary(actor) {
      const res = await call(actor, 'GET', `/api/clips/space/${spaces.secret}`);
      assert.equal(res.status, 200, res.text);
      assert.ok(res.json.some((clip: { id: string }) => clip.id === clipIds.secret), res.text);
    },
  },
  'POST /': {
    refused: (actor, _clip, space) => call(actor, 'POST', '/api/clips', upload(space)),
    refusal: { status: 403, code: 'FORBIDDEN' },
    async canary(actor) {
      const before = await clipCount();
      const res = await call(actor, 'POST', '/api/clips', upload(spaces.secret));
      assert.equal(res.status, 201, res.text);
      const [row] = (await db.execute(sql`SELECT file_key FROM clips WHERE id = ${res.json.id}`)).rows as Array<{ file_key: string }>;
      fileKeys.add(row!.file_key);
      assert.equal(await clipCount(), before + 1);
    },
    async unchanged() {
      assert.equal(await clipCount(), 3, 'no clip was uploaded by anyone outside the space');
    },
  },
  'DELETE /:id': {
    refused: (actor, clip) => call(actor, 'DELETE', `/api/clips/${clip}`),
    refusal: { status: 404, code: 'NOT_FOUND' },
    async canary(actor) {
      // Membership lets the request through to the authorship check: only the creator may delete.
      if (actor !== people.creator) {
        const res = await call(actor, 'DELETE', `/api/clips/${clipIds.toDelete}`);
        assert.equal(res.status, 403, res.text);
        assert.equal(res.json.code, 'UNAUTHORIZED');
        assert.equal(await isDeleted(clipIds.toDelete), false);
        return;
      }
      const res = await call(actor, 'DELETE', `/api/clips/${clipIds.toDelete}`);
      assert.equal(res.status, 200, res.text);
      assert.equal(await isDeleted(clipIds.toDelete), true);
    },
    async unchanged() {
      for (const id of Object.values(clipIds)) assert.equal(await isDeleted(id), false, `clip ${id} was not deleted by anyone outside its space`);
    },
  },
};

/** The routes as the clip router lists them, middleware excluded. */
function routerRoutes(): string[] {
  return [...new Set(clipRoutes.routes.filter((route) => route.method !== 'ALL').map((route) => `${route.method} ${route.path}`))].sort();
}

before(async () => {
  await db.execute(sql`INSERT INTO orgs(id,name,slug) VALUES(${orgId}, 'Clip routes', ${`clip-routes-${orgId}`})`);
  for (const [name, id] of Object.entries(people)) {
    await db.execute(sql`INSERT INTO users(id,email,name,kind,is_agent) VALUES(${id}, ${`${id}@example.test`}, ${name}, 'human', false)`);
    await db.execute(sql`INSERT INTO org_members(id,org_id,user_id,role) VALUES(${randomUUID()}, ${orgId}, ${id}, ${roles[id]})`);
  }
  for (const [id, type, members] of [
    [spaces.secret, 'private', [people.creator, people.insider]],
    [spaces.other, 'private', [people.member, people.guest]],
    [spaces.open, 'public', [people.creator, people.insider]],
  ] as const) {
    await db.execute(sql`INSERT INTO spaces(id,org_id,name,type,created_by) VALUES(${id}, ${orgId}, ${`clips-${id}`}, ${type}, ${people.creator})`);
    for (const member of members) {
      await db.execute(sql`INSERT INTO space_members(id,space_id,user_id) VALUES(${randomUUID()}, ${id}, ${member})`);
    }
  }
  await mkdir(CLIP_DIR, { recursive: true });
  for (const [clip, space] of [[clipIds.secret, spaces.secret], [clipIds.toDelete, spaces.secret], [clipIds.open, spaces.open]] as const) {
    const messageId = randomUUID();
    const fileKey = `clip-routes-${clip}.webm`;
    fileKeys.add(fileKey);
    await db.execute(sql`INSERT INTO messages(id,org_id,space_id,user_id,content)
      VALUES(${messageId}, ${orgId}, ${space}, ${people.creator}, ${`[[clip:${clip}]]`})`);
    await db.execute(sql`INSERT INTO clips(id,org_id,space_id,message_id,context_type,context_id,created_by,file_key,file_size,mime_type,status,transcript)
      VALUES(${clip}, ${orgId}, ${space}, ${messageId}, 'space', ${space}, ${people.creator}, ${fileKey}, ${AUDIO.length}, 'audio/webm', 'ready', ${TRANSCRIPT})`);
    await writeFile(join(CLIP_DIR, fileKey), AUDIO);
  }
});

after(async () => {
  const ids = Object.values(people);
  await db.execute(sql`DELETE FROM job_queue WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM clips WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM messages WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = ${orgId})`);
  await db.execute(sql`DELETE FROM spaces WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM org_members WHERE org_id = ${orgId}`);
  await db.execute(sql`DELETE FROM orgs WHERE id = ${orgId}`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  for (const key of fileKeys) await rm(join(CLIP_DIR, key), { force: true });
  await closeDb();
});

test('every clip route the router serves has a case here', () => {
  const routes = routerRoutes();
  assert.ok(routes.length >= 5, `the clip router lists its routes: ${routes.join(', ')}`);
  assert.deepEqual(routes, Object.keys(CASES).sort(), 'a clip route without a case in this file (or a case for a route that is gone)');
});

for (const route of Object.keys(CASES).sort()) {
  const routeCase = CASES[route]!;

  test(`${route}: refused to everyone outside the clip's private space, whatever their role`, async () => {
    for (const [who, actor] of OUTSIDERS) {
      const res = await routeCase.refused(actor, clipIds.secret, spaces.secret);
      const label = `${route} by ${who}`;
      assert.equal(res.status, routeCase.refusal.status, `${label}: ${res.text}`);
      assert.equal(res.json?.code, routeCase.refusal.code, `${label}: ${res.text}`);
      assertNoLeak(label, res.text);
    }
    await routeCase.unchanged?.();
  });

  test(`${route}: a guest is refused a public space's clip`, async () => {
    const res = await routeCase.refused(people.guest, clipIds.open, spaces.open);
    assert.equal(res.status, routeCase.refusal.status, res.text);
    assert.equal(res.json?.code, routeCase.refusal.code, res.text);
    assertNoLeak(`${route} by a guest on a public space`, res.text);
    await routeCase.unchanged?.();
  });

  test(`${route}: members of the space are allowed (canary)`, async () => {
    // The creator last, so the delete canary runs after the other member's attempt.
    for (const [who, actor] of [...MEMBERS].reverse()) {
      await routeCase.canary(actor).catch((error: unknown) => {
        throw new Error(`${route} by ${who}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  });
}
