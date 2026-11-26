import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import {
  resolveNativeDocumentDisplay,
  resolveNativeMessageDisplay,
  resolveNativeWikiDisplay,
} from '../src/lib/native-content-projections.js';
import type { NativeResourceSubject } from '../src/lib/native-resource-types.js';

const databaseUrl = process.env.DATABASE_URL ?? '';
const canRun = databaseUrl === process.env.DEFT_TEST_DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_phase5_test_[a-z0-9_]+$/.test(databaseUrl);

after(closeDb);

test('native display projections keep exact owner, share, space, and tombstone boundaries',
  { skip: !canRun }, async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const org = randomUUID(), foreignOrg = randomUUID();
    const owner = randomUUID(), peer = randomUUID(), outsider = randomUUID();
    const space = randomUUID(), foreignSpace = randomUUID();
    const message = randomUUID(), wrongParentMessage = randomUUID(), deadMessage = randomUUID();
    const privatePage = randomUUID(), spacePage = randomUUID(), orgPage = randomUUID();
    const wrongParentPage = randomUUID(), deadPage = randomUUID();
    // Notes are documents (F15): each note below moved to its document, in the owner's drive, and is shown as that.
    const privateNote = randomUUID(), sharedNote = randomUUID(), spaceNote = randomUUID(), deadNote = randomUUID();
    const drive = randomUUID();
    const documentOf: Record<string, string> = {};
    const noteDisplay = (subject: NativeResourceSubject, noteId: string) =>
      resolveNativeDocumentDisplay(subject.org_id, subject.user_id, noteId);
    const ownerSubject: NativeResourceSubject = { org_id: org, user_id: owner, role: 'member' };
    const peerSubject: NativeResourceSubject = { org_id: org, user_id: peer, role: 'member' };
    const outsiderSubject: NativeResourceSubject = { org_id: foreignOrg, user_id: outsider, role: 'member' };
    try {
      for (const id of [org, foreignOrg]) {
        await client.query('INSERT INTO orgs (id,name,slug) VALUES ($1,$2,$3)',
          [id, 'Native display fixture', `display-${id}`]);
      }
      for (const id of [owner, peer, outsider]) {
        await client.query('INSERT INTO users (id,name,email) VALUES ($1,$2,$3)',
          [id, 'Display fixture', `${id}@example.test`]);
      }
      for (const [orgId, userId] of [[org, owner], [org, peer], [foreignOrg, outsider]]) {
        await client.query("INSERT INTO org_members (id,org_id,user_id,role) VALUES ($1,$2,$3,'member')",
          [randomUUID(), orgId, userId]);
      }
      await client.query("INSERT INTO spaces (id,org_id,name,type) VALUES ($1,$3,'Private','private'),($2,$4,'Other org','private')",
        [space, foreignSpace, org, foreignOrg]);
      await client.query('INSERT INTO space_members (id,space_id,user_id) VALUES ($1,$2,$3),($4,$5,$3)',
        [randomUUID(), space, owner, randomUUID(), foreignSpace]);
      for (const [id, spaceId, deleted] of [
        [message, space, false], [wrongParentMessage, foreignSpace, false], [deadMessage, space, true],
      ] as const) {
        await client.query('INSERT INTO messages (id,org_id,space_id,user_id,content,is_deleted) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, org, spaceId, owner, 'secret message body', deleted]);
      }
      const pageRows = [
        [privatePage, 'user', null, owner, false, 'Private page'],
        [spacePage, 'space', space, null, false, 'Space page'],
        [orgPage, 'org', null, null, false, 'Org page'],
        [wrongParentPage, 'space', foreignSpace, null, false, 'Wrong parent'],
        [deadPage, 'org', null, null, true, 'Deleted page'],
      ] as const;
      for (const [id, scope, spaceId, userId, deleted, title] of pageRows) {
        await client.query(`INSERT INTO wiki_pages
          (id,org_id,scope,space_id,user_id,type,title,slug,content,is_deleted)
          VALUES ($1,$2,$3,$4,$5,'fact',$6,$7,'secret wiki body',$8)`,
        [id, org, scope, spaceId, userId, title, `display-${id}`, deleted]);
      }
      await client.query(`INSERT INTO drives (id,org_id,name,kind,owner_user_id,created_by) VALUES ($1,$2,'My drive','personal',$3,$3)`,
        [drive, org, owner]);
      await client.query(`INSERT INTO drive_members (id,org_id,drive_id,principal_type,principal_id,role) VALUES ($1,$2,$3,'user',$4,'full')`,
        [randomUUID(), org, drive, owner]);
      const noteRows = [
        [privateNote, false, 'Private note'],
        [sharedNote, false, 'Shared note'],
        [spaceNote, false, 'Space note'],
        [deadNote, true, 'Deleted note'],
      ] as const;
      for (const [id, deleted, title] of noteRows) {
        documentOf[id] = randomUUID();
        await client.query(`INSERT INTO documents (id,org_id,drive_id,title,content_json,content_text,created_by,is_deleted)
          VALUES ($1,$2,$3,$4,'{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb,'secret note body',$5,$6)`,
        [documentOf[id], org, drive, title, owner, deleted]);
        await client.query(`INSERT INTO note_document_map (id,org_id,source_type,source_id,target_type,target_id)
          VALUES ($1,$2,'note',$3,'document',$4)`, [randomUUID(), org, id, documentOf[id]]);
      }
      await client.query(`INSERT INTO document_shares (id,org_id,document_id,principal_type,principal_id,role) VALUES ($1,$2,$3,'space',$4,'view')`,
        [randomUUID(), org, documentOf[spaceNote], space]);

      assert.equal((await resolveNativeMessageDisplay(ownerSubject, message))?.label, 'Message');
      assert.equal(await resolveNativeMessageDisplay(peerSubject, message), null);
      assert.equal(await resolveNativeMessageDisplay(outsiderSubject, message), null);
      assert.equal(await resolveNativeMessageDisplay(ownerSubject, wrongParentMessage), null);
      assert.equal(await resolveNativeMessageDisplay(ownerSubject, deadMessage), null);
      assert.equal((await resolveNativeWikiDisplay(ownerSubject, privatePage))?.label, 'Private page');
      assert.equal(await resolveNativeWikiDisplay(peerSubject, privatePage), null);
      assert.equal((await resolveNativeWikiDisplay(peerSubject, orgPage))?.label, 'Org page');
      assert.equal((await resolveNativeWikiDisplay(ownerSubject, spacePage))?.label, 'Space page');
      assert.equal(await resolveNativeWikiDisplay(peerSubject, spacePage), null);
      assert.equal(await resolveNativeWikiDisplay(ownerSubject, wrongParentPage), null);
      assert.equal(await resolveNativeWikiDisplay(ownerSubject, deadPage), null);
      assert.equal(await resolveNativeWikiDisplay(outsiderSubject, orgPage), null);
      assert.equal((await noteDisplay(ownerSubject, privateNote))?.label, 'Private note');
      assert.equal((await noteDisplay(ownerSubject, documentOf[privateNote]!))?.label, 'Private note', 'by its document id too');
      assert.equal(await noteDisplay(peerSubject, privateNote), null);
      assert.equal(await noteDisplay(peerSubject, sharedNote), null);
      assert.equal((await noteDisplay(ownerSubject, spaceNote))?.label, 'Space note');
      assert.equal(await noteDisplay(peerSubject, spaceNote), null);
      assert.equal(await noteDisplay(ownerSubject, deadNote), null);
      assert.equal(await noteDisplay(outsiderSubject, privateNote), null);

      await client.query(`INSERT INTO document_shares (id,org_id,document_id,principal_type,principal_id,role) VALUES ($1,$2,$3,'user',$4,'view')`,
        [randomUUID(), org, documentOf[sharedNote], peer]);
      assert.equal((await noteDisplay(peerSubject, sharedNote))?.label, 'Shared note');
      await client.query('DELETE FROM document_shares WHERE document_id=$1', [documentOf[sharedNote]]);
      assert.equal(await noteDisplay(peerSubject, sharedNote), null);
      await client.query('INSERT INTO space_members (id,space_id,user_id) VALUES ($1,$2,$3)',
        [randomUUID(), space, peer]);
      assert.equal((await resolveNativeMessageDisplay(peerSubject, message))?.label, 'Message');
      assert.equal((await resolveNativeWikiDisplay(peerSubject, spacePage))?.label, 'Space page');
      assert.equal((await noteDisplay(peerSubject, spaceNote))?.label, 'Space note');
      await client.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [space, peer]);
      assert.equal(await resolveNativeMessageDisplay(peerSubject, message), null);
      assert.equal(await resolveNativeWikiDisplay(peerSubject, spacePage), null);
      assert.equal(await noteDisplay(peerSubject, spaceNote), null);
      assert.ok(!JSON.stringify(await resolveNativeWikiDisplay(ownerSubject, privatePage)).includes('secret'));
      assert.ok(!JSON.stringify(await noteDisplay(ownerSubject, privateNote)).includes('secret'));
    } finally {
      for (const table of ['note_document_map', 'document_shares', 'documents', 'drive_members', 'drives']) {
        await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [org]);
      }
      await client.query('DELETE FROM wiki_pages WHERE id = ANY($1)', [[privatePage, spacePage, orgPage, wrongParentPage, deadPage]]);
      await client.query('DELETE FROM messages WHERE id = ANY($1)', [[message, wrongParentMessage, deadMessage]]);
      await client.query('DELETE FROM space_members WHERE space_id = ANY($1)', [[space, foreignSpace]]);
      await client.query('DELETE FROM spaces WHERE id = ANY($1)', [[space, foreignSpace]]);
      await client.query('DELETE FROM org_members WHERE org_id = ANY($1)', [[org, foreignOrg]]);
      await client.query('DELETE FROM orgs WHERE id = ANY($1)', [[org, foreignOrg]]);
      await client.query('DELETE FROM users WHERE id = ANY($1)', [[owner, peer, outsider]]);
      await client.end();
    }
  });
