/**
 * Two workspaces for drives and documents tests, in the test database.
 *
 * The workspace `orgId` has an owner, an admin, two members, a guest and an
 * agent user (an active employee's user, with the member role), the chats
 * `team` (public: member, member2, guest, agentUser) and `other` (private:
 * member2), and its open Workspace drive (default role edit). `outsider` is a
 * member of `otherOrgId` only.
 *
 * Rows are inserted directly, satisfying the upgrade's triggers: a person a
 * grant names, and a personal drive's owner, have an org_members row in the
 * row's workspace; a chat a grant names is one of its spaces. The insert
 * helpers take the workspace from the drive or document they are given.
 *
 * `request` runs route modules passed to setupDrivesFixture in a Hono app
 * whose stub sets the user (`c.set('user')`, as in
 * guest-space-visibility-db.test.ts) with the person's workspace and current
 * role. Unlike the auth middleware, it does not refuse an inactive member,
 * so the routes' own checks are what a test sees.
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import pg from 'pg';
import { EMPTY_DOCUMENT, jsonToText } from '@deft/doc-schema';
import type { DocRole } from '../../src/lib/document-access.js';
import type { AuthUser } from '../../src/middleware/auth.js';
import { safeTestDatabaseUrl } from './safe-test-database.js';

type JSONContent = Parameters<typeof jsonToText>[0];
type Principal = { user?: string; space?: string };

export type DrivesFixture = {
  client: pg.Client;
  orgId: string;
  otherOrgId: string;
  people: { owner: string; admin: string; member: string; member2: string; guest: string; agentUser: string; outsider: string };
  spaces: { team: string /* member, member2, guest, agentUser */; other: string /* member2 */ };
  workspaceDriveId: string;
  request(userId: string, method: string, path: string, body?: unknown): Promise<Response>;
  insertDrive(i: { kind: 'open' | 'private' | 'personal'; defaultRole?: DocRole; ownerUserId?: string; frozen?: boolean; name?: string }): Promise<string>;
  addDriveMember(driveId: string, p: Principal, role: DocRole): Promise<void>;
  insertFolder(i: { driveId: string; parentFolderId?: string }): Promise<string>;
  insertDocument(i: { driveId: string; folderId?: string; parentDocumentId?: string; title?: string; json?: JSONContent; deleted?: boolean }): Promise<string>;
  share(documentId: string, p: Principal, role: 'edit' | 'comment' | 'view'): Promise<void>;
  removeSpaceMember(spaceId: string, userId: string): Promise<void>;
  teardown(): Promise<void>;
};

export type DrivesFixtureOptions = {
  /** Route modules to mount for `request`, e.g. `{ path: '/api/drives', app: driveRoutes }`. */
  routes?: Array<{ path: string; app: Hono<any, any, any> }>;
  /** Seed the workspace with this many documents (planning tests: 10, 50, 200). See seedDocuments. */
  documents?: number;
};

/** The header that carries the stub's user. Test-only: production authenticates with a bearer session. */
const TEST_USER_HEADER = 'x-drives-test-user';

/** A Hono app with `routes` mounted behind a stub that sets the user from TEST_USER_HEADER. */
export function buildDrivesTestApp(routes: Array<{ path: string; app: Hono<any, any, any> }>): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const user = c.req.header(TEST_USER_HEADER);
    if (!user) return c.json({ error: 'Unauthorized', code: 'NO_TOKEN' }, 401);
    c.set('user', JSON.parse(user) as AuthUser);
    await next();
  });
  for (const route of routes) app.route(route.path, route.app);
  return app;
}

function principalOf(p: Principal): ['user' | 'space', string] {
  if ((p.user === undefined) === (p.space === undefined)) throw new Error('name exactly one of user or space');
  return p.user !== undefined ? ['user', p.user] : ['space', p.space!];
}

export async function setupDrivesFixture(label: string, options: DrivesFixtureOptions = {}): Promise<DrivesFixture> {
  const url = safeTestDatabaseUrl();
  if (!url) throw new Error('setupDrivesFixture needs DEFT_TEST_DATABASE_URL set to a disposable test database');
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await client.connect();
  const q = (text: string, values: unknown[] = []) => client.query(text, values);

  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const tag = `${label}-${orgId.slice(0, 8)}`;
  const people = {
    owner: randomUUID(), admin: randomUUID(), member: randomUUID(), member2: randomUUID(),
    guest: randomUUID(), agentUser: randomUUID(), outsider: randomUUID(),
  };
  const agentEmployeeId = randomUUID();
  const spaces = { team: randomUUID(), other: randomUUID() };
  const workspaceDriveId = randomUUID();

  const teardown = async () => {
    try {
      const orgs = [orgId, otherOrgId];
      for (const table of ['attention_events', 'attention_items', 'doc_favorites', 'note_document_map', 'document_attachments',
        'document_versions', 'document_shares', 'documents', 'doc_folders', 'drive_members', 'drives']) {
        await q(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [orgs]);
      }
      await q('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id = ANY($1::text[]))', [orgs]);
      for (const table of ['spaces', 'agent_employees', 'org_members']) await q(`DELETE FROM ${table} WHERE org_id = ANY($1::text[])`, [orgs]);
      await q('DELETE FROM orgs WHERE id = ANY($1::text[])', [orgs]);
      await q('DELETE FROM users WHERE id = ANY($1::text[])', [Object.values(people)]);
    } finally {
      await client.end();
    }
  };

  try {
    await q('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3), ($4, $5, $6)',
      [orgId, `Drives ${tag}`, `drives-${tag}`, otherOrgId, `Drives other ${tag}`, `drives-other-${tag}`]);
    const roles: Array<[keyof typeof people, string, string]> = [
      ['owner', orgId, 'owner'], ['admin', orgId, 'admin'], ['member', orgId, 'member'], ['member2', orgId, 'member'],
      ['guest', orgId, 'guest'], ['agentUser', orgId, 'member'], ['outsider', otherOrgId, 'member'],
    ];
    for (const [name, org, role] of roles) {
      const agent = name === 'agentUser';
      await q('INSERT INTO users (id, email, name, kind, is_agent, agent_employee_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [people[name], `${name}-${tag}@drives.test`, name, agent ? 'agent' : 'human', agent, agent ? agentEmployeeId : null]);
      await q('INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)', [randomUUID(), org, people[name], role]);
    }
    await q(`INSERT INTO agent_employees (id, org_id, user_id, name, slug, role, system_prompt, trust_level, is_active, is_byoa, runtime_kind, created_by)
      VALUES ($1, $2, $3, 'Agent', $4, 'custom', 'Test.', 'conservative', true, true, 'custom_mcp', $5)`,
    [agentEmployeeId, orgId, people.agentUser, `agent-${tag}`, people.owner]);
    const chats: Array<[string, string, string, string[]]> = [
      [spaces.team, 'team', 'public', [people.member, people.member2, people.guest, people.agentUser]],
      [spaces.other, 'other', 'private', [people.member2]],
    ];
    for (const [id, name, type, members] of chats) {
      await q('INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, $4, $5)', [id, orgId, `${name}-${tag}`, type, people.owner]);
      for (const user of members) await q('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), id, user]);
    }
    await q(`INSERT INTO drives (id, org_id, name, kind, system_key, default_role, created_by)
      VALUES ($1, $2, 'Workspace', 'open', 'workspace', 'edit', $3)`, [workspaceDriveId, orgId, people.owner]);
  } catch (error) {
    await teardown().catch(() => undefined);
    throw error;
  }

  const app = buildDrivesTestApp(options.routes ?? []);

  const addDriveMember = async (driveId: string, p: Principal, role: DocRole) => {
    const [type, id] = principalOf(p);
    const result = await q(`INSERT INTO drive_members (id, org_id, drive_id, principal_type, principal_id, role, added_by)
      SELECT $1, d.org_id, d.id, $3, $4, $5, $6 FROM drives d WHERE d.id = $2
      ON CONFLICT (drive_id, principal_type, principal_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
    [randomUUID(), driveId, type, id, role, people.owner]);
    if (result.rowCount !== 1) throw new Error(`no drive ${driveId}`);
  };

  const fixture: DrivesFixture = {
    client, orgId, otherOrgId, people, spaces, workspaceDriveId,

    async request(userId, method, path, body) {
      const { rows: [membership] } = await q(`SELECT m.org_id, m.role, u.email FROM org_members m JOIN users u ON u.id = m.user_id
        WHERE m.user_id = $1 AND m.org_id = ANY($2::text[]) ORDER BY m.org_id = $3 DESC LIMIT 1`, [userId, [orgId, otherOrgId], orgId]);
      const user: AuthUser = {
        id: userId, email: membership?.email ?? `${userId}@drives.test`, org_id: membership?.org_id ?? orgId,
        sid: `drives-test-${userId}`, role: membership?.role,
      };
      const headers: Record<string, string> = { [TEST_USER_HEADER]: JSON.stringify(user) };
      if (body !== undefined) headers['content-type'] = 'application/json';
      return app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    },

    async insertDrive({ kind, defaultRole, ownerUserId, frozen, name }) {
      if (kind === 'personal' && !ownerUserId) throw new Error('a personal drive needs ownerUserId');
      const id = randomUUID();
      await q(`INSERT INTO drives (id, org_id, name, kind, owner_user_id, default_role, frozen_at, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::boolean THEN now() END, $8)`,
      [id, orgId, name ?? `${kind} drive`, kind, kind === 'personal' ? ownerUserId : null,
        kind === 'open' ? (defaultRole ?? 'edit') : (defaultRole ?? null), frozen === true, ownerUserId ?? people.owner]);
      // As ensurePersonalDrive (F4): the owner holds full access through a drive_members row.
      if (kind === 'personal') await addDriveMember(id, { user: ownerUserId! }, 'full');
      return id;
    },

    addDriveMember,

    async insertFolder({ driveId, parentFolderId }) {
      const id = randomUUID();
      const result = await q(`INSERT INTO doc_folders (id, org_id, drive_id, parent_folder_id, name, created_by)
        SELECT $1, d.org_id, d.id, $3, 'Folder', d.created_by FROM drives d WHERE d.id = $2`, [id, driveId, parentFolderId ?? null]);
      if (result.rowCount !== 1) throw new Error(`no drive ${driveId}`);
      return id;
    },

    async insertDocument({ driveId, folderId, parentDocumentId, title, json, deleted }) {
      const id = randomUUID();
      const content = JSON.stringify(json ?? EMPTY_DOCUMENT);
      const result = await q(`INSERT INTO documents (id, org_id, drive_id, folder_id, parent_document_id, title, content_json, content_text,
          size_bytes, created_by, is_deleted, deleted_at)
        SELECT $1, d.org_id, d.id, $3, $4, $5, $6::jsonb, $7, $8::int, d.created_by, $9::boolean, CASE WHEN $9::boolean THEN now() END
        FROM drives d WHERE d.id = $2`,
      [id, driveId, folderId ?? null, parentDocumentId ?? null, title ?? 'Untitled', content, json ? jsonToText(json) : '',
        Buffer.byteLength(content), deleted === true]);
      if (result.rowCount !== 1) throw new Error(`no drive ${driveId}`);
      return id;
    },

    async share(documentId, p, role) {
      const [type, principalId] = principalOf(p);
      const result = await q(`INSERT INTO document_shares (id, org_id, document_id, principal_type, principal_id, role, shared_by)
        SELECT $1, doc.org_id, doc.id, $3, $4, $5, $6 FROM documents doc WHERE doc.id = $2
        ON CONFLICT (document_id, principal_type, principal_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
      [randomUUID(), documentId, type, principalId, role, people.owner]);
      if (result.rowCount !== 1) throw new Error(`no document ${documentId}`);
    },

    async removeSpaceMember(spaceId, userId) {
      await q('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, userId]);
    },

    teardown,
  };

  if (options.documents) {
    try {
      await seedDocuments(fixture, options.documents);
    } catch (error) {
      await teardown().catch(() => undefined);
      throw error;
    }
  }
  return fixture;
}

/**
 * Fills the workspace with `count` documents of every kind of access, for
 * planning tests: they are spread over the Workspace drive, an open drive
 * (view), a private drive of the team chat (edit) with the member as its
 * manager, a private drive of member2 (comment) and the member's personal
 * drive; one in five sits in a folder and one in five is a sub-page; one in
 * three is shared with the guest (view) and one in four with the `other`
 * chat (comment).
 */
async function seedDocuments(fx: DrivesFixture, count: number): Promise<void> {
  const { people, spaces } = fx;
  const openView = await fx.insertDrive({ kind: 'open', defaultRole: 'view', name: 'Seed: open' });
  const teamDrive = await fx.insertDrive({ kind: 'private', name: 'Seed: team' });
  await fx.addDriveMember(teamDrive, { space: spaces.team }, 'edit');
  await fx.addDriveMember(teamDrive, { user: people.member }, 'full');
  const member2Drive = await fx.insertDrive({ kind: 'private', name: 'Seed: member2' });
  await fx.addDriveMember(member2Drive, { user: people.member2 }, 'comment');
  const personal = await fx.insertDrive({ kind: 'personal', ownerUserId: people.member, name: 'Seed: My drive' });
  const homes = [fx.workspaceDriveId, openView, teamDrive, member2Drive, personal];
  const folders = new Map<string, string>();
  for (const drive of homes) folders.set(drive, await fx.insertFolder({ driveId: drive }));
  const previous = new Map<string, string>();
  for (let at = 0; at < count; at += 1) {
    const driveId = homes[at % homes.length]!;
    const placement = Math.floor(at / homes.length) % 5;
    const json = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Seed document ${at} of ${count}` }] }] };
    const id = await fx.insertDocument({
      driveId, title: `Seed document ${at}`, json,
      folderId: placement === 1 ? folders.get(driveId) : undefined,
      parentDocumentId: placement === 2 ? previous.get(driveId) : undefined,
    });
    previous.set(driveId, id);
    if (at % 3 === 0) await fx.share(id, { user: people.guest }, 'view');
    if (at % 4 === 0) await fx.share(id, { space: spaces.other }, 'comment');
  }
}
