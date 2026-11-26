import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as documentsSchema from '@deft/db/documents';
import { UPGRADE_NOTIFICATION_TYPES, asStoredNotificationType } from '../src/lib/notification-types.js';

// Drives and documents are created by upgrade 0.3.0-preview.155 (db:push-full
// and db:upgrade both apply it), not by schema.ts.

const DRIVE_TABLES = [
  'doc_favorites',
  'doc_folders',
  'document_attachments',
  'document_shares',
  'document_versions',
  'documents',
  'drive_members',
  'drives',
  'note_document_map',
];
const EMPTY_DOC = '{"type":"doc","content":[]}';

const newId = () => crypto.randomUUID();
const tag = newId().replace(/-/g, '').slice(0, 12);
const orgA = newId();
const orgB = newId();
const alice = newId();
const bob = newId();
const carol = newId();
const spaceA = newId();
const spaceB = newId();
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

async function rejectsWith(code: string, text: string, values: unknown[] = []) {
  await assert.rejects(client.query(text, values), (error: Error & { code?: string }) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

type DriveFields = { kind?: string; default_role?: string | null; owner_user_id?: string | null; system_key?: string | null };
const driveInsert = `INSERT INTO drives (id, org_id, name, kind, default_role, owner_user_id, system_key)
  VALUES ($1, $2, 'Drive', $3, $4, $5, $6)`;
const driveValues = (id: string, orgId: string, fields: DriveFields) => [id, orgId, fields.kind ?? 'open',
  fields.default_role === undefined ? 'edit' : fields.default_role, fields.owner_user_id ?? null, fields.system_key ?? null];

async function drive(orgId: string, fields: DriveFields = {}) {
  const id = newId();
  await client.query(driveInsert, driveValues(id, orgId, fields));
  return id;
}

async function folder(orgId: string, driveId: string) {
  const id = newId();
  await client.query('INSERT INTO doc_folders (id, org_id, drive_id, name) VALUES ($1, $2, $3, $4)', [id, orgId, driveId, 'Plans']);
  return id;
}

const documentInsert = `INSERT INTO documents (id, org_id, drive_id, folder_id, parent_document_id, title, content_text, content_json)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

async function document(orgId: string, driveId: string, fields: { folder?: string; parent?: string; title?: string; text?: string } = {}) {
  const id = newId();
  await client.query(documentInsert, [id, orgId, driveId, fields.folder ?? null, fields.parent ?? null,
    fields.title ?? '', fields.text ?? '', EMPTY_DOC]);
  return id;
}

before(async () => {
  await client.connect();
  await client.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'Docs A', $2), ($3, 'Docs B', $4)`,
    [orgA, `docs-a-${tag}`, orgB, `docs-b-${tag}`]);
  await client.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, 'Alice'), ($3, $4, 'Bob'), ($5, $6, 'Carol')`,
    [alice, `docs-alice-${tag}@test.local`, bob, `docs-bob-${tag}@test.local`, carol, `docs-carol-${tag}@test.local`]);
  await client.query('INSERT INTO org_members (id, org_id, user_id) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)',
    [newId(), orgA, alice, newId(), orgB, bob, newId(), orgA, carol]);
  await client.query(`INSERT INTO spaces (id, org_id, name) VALUES ($1, $2, 'general'), ($3, $4, 'general')`,
    [spaceA, orgA, spaceB, orgB]);
});

after(async () => {
  const orgIds = [orgA, orgB];
  for (const table of ['document_shares', 'drive_members', 'document_versions', 'document_attachments',
    'doc_favorites', 'note_document_map', 'documents', 'doc_folders', 'drives', 'spaces', 'org_members']) {
    await client.query(`DELETE FROM ${table} WHERE org_id = ANY($1)`, [orgIds]);
  }
  await client.query('DELETE FROM users WHERE id = ANY($1)', [[alice, bob, carol]]);
  await client.query('DELETE FROM orgs WHERE id = ANY($1)', [orgIds]);
  await client.end();
});

test('the upgrade creates every drives table', async () => {
  const { rows } = await client.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name = ANY($1) ORDER BY 1`, [DRIVE_TABLES]);
  assert.deepEqual(rows.map((row) => row.table_name), DRIVE_TABLES);
});

test('the Drizzle mirror matches every column the upgrade creates', async () => {
  const mirrors = [documentsSchema.drives, documentsSchema.driveMembers, documentsSchema.docFolders,
    documentsSchema.documents, documentsSchema.documentShares, documentsSchema.documentVersions,
    documentsSchema.documentAttachments, documentsSchema.docFavorites, documentsSchema.noteDocumentMap];
  const sqlType = (type: string) => (type === 'timestamp' ? 'timestamp without time zone' : type);
  const mirrored = mirrors.map(getTableConfig);
  assert.deepEqual(mirrored.map((table) => table.name).sort(), DRIVE_TABLES);
  for (const table of mirrored) {
    const { rows } = await client.query<{ column_name: string; type: string; is_nullable: string }>(`SELECT column_name,
        format_type(a.atttypid, a.atttypmod) AS type, c.is_nullable
      FROM information_schema.columns c
      JOIN pg_attribute a ON a.attrelid = ('public.' || c.table_name)::regclass AND a.attname = c.column_name
      WHERE c.table_schema = 'public' AND c.table_name = $1`, [table.name]);
    const live = rows.map((row) => `${row.column_name}:${row.type}:${row.is_nullable === 'NO' ? 'not null' : 'null'}`).sort();
    const mirror = table.columns.map((column) => `${column.name}:${sqlType(column.getSQLType())}:${column.notNull ? 'not null' : 'null'}`).sort();
    assert.deepEqual(mirror, live, table.name);
  }
  assert.deepEqual(documentsSchema.DOC_ROLES, ['full', 'edit', 'comment', 'view']);
});

test("a document's folder must be in the document's drive", async () => {
  const one = await drive(orgA);
  const two = await drive(orgA);
  const plans = await folder(orgA, two);
  const parentInTwo = await document(orgA, two);
  await rejectsWith('23503', documentInsert, [newId(), orgA, one, plans, null, '', '', EMPTY_DOC]);
  await rejectsWith('23503', documentInsert, [newId(), orgA, one, null, parentInTwo, '', '', EMPTY_DOC]);
  await rejectsWith('23503', 'INSERT INTO doc_folders (id, org_id, drive_id, parent_folder_id, name) VALUES ($1, $2, $3, $4, $5)',
    [newId(), orgA, one, plans, 'Nested']);
  // The same folder and parent are accepted inside their own drive.
  await document(orgA, two, { folder: plans });
  await document(orgA, two, { parent: parentInTwo });
});

test("a document can't have both a folder and a parent document", async () => {
  const d = await drive(orgA);
  const plans = await folder(orgA, d);
  const parent = await document(orgA, d);
  await rejectsWith('23514', documentInsert, [newId(), orgA, d, plans, parent, '', '', EMPTY_DOC]);
});

test('the search trigger fills search_vector from title and text', async () => {
  const d = await drive(orgA);
  const doc = await document(orgA, d, { title: 'Quarterly budget', text: 'Hiring plan' });
  const read = async () => (await client.query<{ title: boolean; text: boolean; later: boolean; vector: string }>(`SELECT
      search_vector @@ to_tsquery('simple', 'budget') AS title,
      search_vector @@ to_tsquery('simple', 'hiring') AS text,
      search_vector @@ to_tsquery('simple', 'roadmap') AS later,
      search_vector::text AS vector
    FROM documents WHERE id = $1`, [doc])).rows[0]!;
  const first = await read();
  assert.equal(first.title, true);
  assert.equal(first.text, true);
  assert.equal(first.vector, "'budget':2A 'hiring':3B 'plan':4B 'quarterly':1A", 'title weighs A, text B');
  await client.query("UPDATE documents SET content_text = 'Roadmap' WHERE id = $1", [doc]);
  const second = await read();
  assert.equal(second.text, false, 'the old text is gone');
  assert.equal(second.later, true, 'the new text is searchable');
});

test('one personal drive per person and one Workspace drive per org', async () => {
  const personal = { kind: 'personal', default_role: null, owner_user_id: alice };
  await drive(orgA, personal);
  await rejectsWith('23505', driveInsert, driveValues(newId(), orgA, personal));
  await drive(orgA, { system_key: 'workspace' });
  await rejectsWith('23505', driveInsert, driveValues(newId(), orgA, { system_key: 'workspace' }));
  // Another workspace has its own Workspace drive.
  await drive(orgB, { system_key: 'workspace' });
});

test('a frozen personal drive is not the live one: its owner can have a new personal drive beside it', async () => {
  const personal = { kind: 'personal', default_role: null, owner_user_id: bob };
  const first = await drive(orgB, personal);
  await rejectsWith('23505', driveInsert, driveValues(newId(), orgB, personal));
  await client.query('UPDATE drives SET frozen_at = now() WHERE id = $1', [first]);
  const second = await drive(orgB, personal);
  assert.notEqual(second, first);
  await rejectsWith('23505', driveInsert, driveValues(newId(), orgB, personal));
});

test('an open drive has a default role, and only a personal drive has an owner', async () => {
  await rejectsWith('23514', driveInsert, driveValues(newId(), orgA, { default_role: null }));
  await rejectsWith('23514', driveInsert, driveValues(newId(), orgA, { kind: 'private', default_role: 'view' }));
  await rejectsWith('23514', driveInsert, driveValues(newId(), orgA, { kind: 'private', default_role: null, owner_user_id: alice }));
  await rejectsWith('23514', driveInsert, driveValues(newId(), orgA, { kind: 'personal', default_role: null }));
});

test('notification_type has document_shared; entity_tag_type has document', async () => {
  const { rows } = await client.query<{ notification: boolean; tag: boolean }>(`SELECT
    'document_shared' = ANY (enum_range(NULL::notification_type)::text[]) AS notification,
    'document' = ANY (enum_range(NULL::entity_tag_type)::text[]) AS tag`);
  assert.deepEqual(rows[0], { notification: true, tag: true });
  // Every label the API widens its notification type with is a real label.
  const labels = (await client.query<{ label: string }>('SELECT unnest(enum_range(NULL::notification_type))::text AS label')).rows
    .map((row) => row.label);
  for (const type of UPGRADE_NOTIFICATION_TYPES) assert.ok(labels.includes(type), type);
  assert.equal(asStoredNotificationType('document_shared'), 'document_shared');
});

test('team_resource_type has document', async () => {
  const { rows } = await client.query<{ present: boolean }>(
    `SELECT 'document' = ANY (enum_range(NULL::team_resource_type)::text[]) AS present`);
  assert.equal(rows[0]?.present, true);
});

test("a drive member naming another org's user is refused by the principal trigger", async () => {
  const d = await drive(orgA);
  const member = 'INSERT INTO drive_members (id, org_id, drive_id, principal_type, principal_id, role) VALUES ($1, $2, $3, $4, $5, $6)';
  await rejectsWith('23503', member, [newId(), orgA, d, 'user', bob, 'edit']);
  await rejectsWith('23503', member, [newId(), orgA, d, 'space', spaceB, 'view']);
  await rejectsWith('23503', member, [newId(), orgA, d, 'user', newId(), 'view']);
  await client.query(member, [newId(), orgA, d, 'user', alice, 'full']);
  await client.query(member, [newId(), orgA, d, 'space', spaceA, 'view']);
  await rejectsWith('23503', 'UPDATE drive_members SET principal_id = $1 WHERE drive_id = $2 AND principal_id = $3', [bob, d, alice]);

  const doc = await document(orgA, d);
  const share = 'INSERT INTO document_shares (id, org_id, document_id, principal_type, principal_id, role) VALUES ($1, $2, $3, $4, $5, $6)';
  await rejectsWith('23503', share, [newId(), orgA, doc, 'user', bob, 'view']);
  await rejectsWith('23503', share, [newId(), orgA, doc, 'space', spaceB, 'view']);
  await client.query(share, [newId(), orgA, doc, 'user', alice, 'edit']);
  await client.query(share, [newId(), orgA, doc, 'space', spaceA, 'comment']);
});

test("a personal drive owned by another org's user is refused by the member trigger", async () => {
  const personal = (owner: string) => ({ kind: 'personal', default_role: null, owner_user_id: owner });
  await rejectsWith('23503', driveInsert, driveValues(newId(), orgA, personal(bob)));
  const carols = await drive(orgA, personal(carol));
  await rejectsWith('23503', 'UPDATE drives SET owner_user_id = $1 WHERE id = $2', [bob, carols]);
  await rejectsWith('23503', 'UPDATE drives SET org_id = $1 WHERE id = $2', [orgB, carols]);
  // Freezing a departed owner's drive doesn't depend on their membership row;
  // naming the owner again does.
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [orgA, carol]);
    await client.query('UPDATE drives SET frozen_at = now(), name = $1 WHERE id = $2', ['Frozen', carols]);
    await rejectsWith('23503', 'UPDATE drives SET owner_user_id = owner_user_id WHERE id = $1', [carols]);
  } finally {
    await client.query('ROLLBACK');
  }
});

test("a favorite for another org's user is refused by the member trigger", async () => {
  const favorite = 'INSERT INTO doc_favorites (id, org_id, user_id, target_type, target_id) VALUES ($1, $2, $3, $4, $5)';
  const d = await drive(orgA);
  await rejectsWith('23503', favorite, [newId(), orgA, bob, 'drive', d]);
  const id = newId();
  await client.query(favorite, [id, orgA, alice, 'drive', d]);
  await rejectsWith('23503', 'UPDATE doc_favorites SET user_id = $1 WHERE id = $2', [bob, id]);
  await rejectsWith('23503', 'UPDATE doc_favorites SET org_id = $1 WHERE id = $2', [orgB, id]);
});

test("a document pointing at another org's drive is refused", async () => {
  const driveB = await drive(orgB);
  await rejectsWith('23503', documentInsert, [newId(), orgA, driveB, null, null, '', '', EMPTY_DOC]);
  await rejectsWith('23503', 'INSERT INTO doc_folders (id, org_id, drive_id, name) VALUES ($1, $2, $3, $4)', [newId(), orgA, driveB, 'X']);
  await rejectsWith('23503', 'INSERT INTO drive_members (id, org_id, drive_id, principal_type, principal_id, role) VALUES ($1, $2, $3, $4, $5, $6)',
    [newId(), orgA, driveB, 'user', alice, 'view']);
  // A share, version or attachment row carries its document's org.
  const docA = await document(orgA, await drive(orgA));
  await rejectsWith('23503', 'INSERT INTO document_shares (id, org_id, document_id, principal_type, principal_id, role) VALUES ($1, $2, $3, $4, $5, $6)',
    [newId(), orgB, docA, 'user', bob, 'view']);
  await rejectsWith('23503', `INSERT INTO document_versions (id, org_id, document_id, kind, content_json, size_bytes) VALUES ($1, $2, $3, 'auto', $4, 0)`,
    [newId(), orgB, docA, EMPTY_DOC]);
});

test('a retried agent edit stores one version', async () => {
  const doc = await document(orgA, await drive(orgA));
  const version = `INSERT INTO document_versions (id, org_id, document_id, kind, action_id, content_json, size_bytes)
    VALUES ($1, $2, $3, $4, $5, $6, 0)`;
  const action = newId();
  await client.query(version, [newId(), orgA, doc, 'agent', action, EMPTY_DOC]);
  await rejectsWith('23505', version, [newId(), orgA, doc, 'agent', action, EMPTY_DOC]);
  await client.query(version, [newId(), orgA, doc, 'auto', action, EMPTY_DOC]);
});

// Same definitions as the Versioned Upgrade job checks after db:upgrade (ci.yml).
const constraintsSql = `SELECT string_agg(conname || ': ' || pg_get_constraintdef(oid), ' | ' ORDER BY conname) AS v
  FROM pg_constraint WHERE conrelid = $1::regclass AND contype IN ('c', 'f')`;
const indexesSql = `SELECT string_agg(pg_get_indexdef(i.indexrelid), ' | ' ORDER BY c.relname) AS v
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = $1::regclass AND NOT i.indisprimary`;

const DEFINITIONS: Record<string, { constraints: string; indexes: string }> = {
  documents: {
    constraints: [
      'documents_drive_fk: FOREIGN KEY (org_id, drive_id) REFERENCES drives(org_id, id)',
      'documents_folder_fk: FOREIGN KEY (org_id, drive_id, folder_id) REFERENCES doc_folders(org_id, drive_id, id) DEFERRABLE',
      'documents_folder_or_parent: CHECK ((NOT ((folder_id IS NOT NULL) AND (parent_document_id IS NOT NULL))))',
      'documents_org_id_fkey: FOREIGN KEY (org_id) REFERENCES orgs(id)',
      'documents_parent_fk: FOREIGN KEY (org_id, drive_id, parent_document_id) REFERENCES documents(org_id, drive_id, id) DEFERRABLE',
    ].join(' | '),
    indexes: [
      'CREATE UNIQUE INDEX documents_org_drive_id_key ON public.documents USING btree (org_id, drive_id, id)',
      'CREATE INDEX documents_org_drive_live_idx ON public.documents USING btree (org_id, drive_id) WHERE (NOT is_deleted)',
      'CREATE UNIQUE INDEX documents_org_id_id_key ON public.documents USING btree (org_id, id)',
      'CREATE INDEX documents_parent_idx ON public.documents USING btree (parent_document_id)',
      'CREATE INDEX documents_search_idx ON public.documents USING gin (search_vector)',
    ].join(' | '),
  },
  drive_members: {
    constraints: [
      'drive_members_drive_fk: FOREIGN KEY (org_id, drive_id) REFERENCES drives(org_id, id)',
      'drive_members_org_id_fkey: FOREIGN KEY (org_id) REFERENCES orgs(id)',
      "drive_members_principal_type_check: CHECK ((principal_type = ANY (ARRAY['user'::text, 'space'::text])))",
      "drive_members_role_check: CHECK ((role = ANY (ARRAY['full'::text, 'edit'::text, 'comment'::text, 'view'::text])))",
    ].join(' | '),
    indexes: [
      'CREATE UNIQUE INDEX drive_members_drive_principal_key ON public.drive_members USING btree (drive_id, principal_type, principal_id)',
      'CREATE INDEX drive_members_principal_idx ON public.drive_members USING btree (principal_type, principal_id)',
      "CREATE UNIQUE INDEX drive_members_space_link_uidx ON public.drive_members USING btree (org_id, principal_id) WHERE ((principal_type = 'space'::text) AND is_link)",
    ].join(' | '),
  },
  document_shares: {
    constraints: [
      'document_shares_document_fk: FOREIGN KEY (org_id, document_id) REFERENCES documents(org_id, id)',
      'document_shares_org_id_fkey: FOREIGN KEY (org_id) REFERENCES orgs(id)',
      "document_shares_principal_type_check: CHECK ((principal_type = ANY (ARRAY['user'::text, 'space'::text])))",
      "document_shares_role_check: CHECK ((role = ANY (ARRAY['edit'::text, 'comment'::text, 'view'::text])))",
    ].join(' | '),
    indexes: [
      'CREATE UNIQUE INDEX document_shares_document_principal_key ON public.document_shares USING btree (document_id, principal_type, principal_id)',
      'CREATE INDEX document_shares_principal_idx ON public.document_shares USING btree (principal_type, principal_id)',
    ].join(' | '),
  },
};

test('documents, drive_members and document_shares have the definitions the upgrade job checks', async () => {
  for (const [table, expected] of Object.entries(DEFINITIONS)) {
    const constraints = await client.query<{ v: string }>(constraintsSql, [`public.${table}`]);
    const indexes = await client.query<{ v: string }>(indexesSql, [`public.${table}`]);
    assert.equal(constraints.rows[0]?.v, expected.constraints, `${table} foreign keys and checks`);
    assert.equal(indexes.rows[0]?.v, expected.indexes, `${table} indexes`);
  }
});
