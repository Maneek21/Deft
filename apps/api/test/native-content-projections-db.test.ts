import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import {
  resolveNativeMessageDisplay,
  resolveNativeNoteDisplay,
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
    const privateNote = randomUUID(), sharedNote = randomUUID(), spaceNote = randomUUID();
    const wrongParentNote = randomUUID(), deadNote = randomUUID();
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
      const noteRows = [
        [privateNote, 'private', null, false, 'Private note'],
        [sharedNote, 'private', null, false, 'Shared note'],
        [spaceNote, 'space', space, false, 'Space note'],
        [wrongParentNote, 'space', foreignSpace, false, 'Wrong parent note'],
        [deadNote, 'org', null, true, 'Deleted note'],
      ] as const;
      for (const [id, visibility, spaceId, deleted, title] of noteRows) {
        await client.query(`INSERT INTO notes
          (id,org_id,user_id,title,content,visibility,visibility_space_id,is_deleted)
          VALUES ($1,$2,$3,$4,'secret note body',$5,$6,$7)`,
        [id, org, owner, title, visibility, spaceId, deleted]);
      }

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
      assert.equal((await resolveNativeNoteDisplay(ownerSubject, privateNote))?.label, 'Private note');
      assert.equal(await resolveNativeNoteDisplay(peerSubject, privateNote), null);
      assert.equal(await resolveNativeNoteDisplay(peerSubject, sharedNote), null);
      assert.equal((await resolveNativeNoteDisplay(ownerSubject, spaceNote))?.label, 'Space note');
      assert.equal(await resolveNativeNoteDisplay(peerSubject, spaceNote), null);
      assert.equal(await resolveNativeNoteDisplay(ownerSubject, wrongParentNote), null);
      assert.equal(await resolveNativeNoteDisplay(ownerSubject, deadNote), null);
      assert.equal(await resolveNativeNoteDisplay(outsiderSubject, privateNote), null);

      await client.query('INSERT INTO note_shares (id,note_id,shared_with_user_id) VALUES ($1,$2,$3)',
        [randomUUID(), sharedNote, peer]);
      assert.equal((await resolveNativeNoteDisplay(peerSubject, sharedNote))?.label, 'Shared note');
      await client.query('DELETE FROM note_shares WHERE note_id=$1', [sharedNote]);
      assert.equal(await resolveNativeNoteDisplay(peerSubject, sharedNote), null);
      await client.query('INSERT INTO space_members (id,space_id,user_id) VALUES ($1,$2,$3)',
        [randomUUID(), space, peer]);
      assert.equal((await resolveNativeMessageDisplay(peerSubject, message))?.label, 'Message');
      assert.equal((await resolveNativeWikiDisplay(peerSubject, spacePage))?.label, 'Space page');
      assert.equal((await resolveNativeNoteDisplay(peerSubject, spaceNote))?.label, 'Space note');
      await client.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [space, peer]);
      assert.equal(await resolveNativeMessageDisplay(peerSubject, message), null);
      assert.equal(await resolveNativeWikiDisplay(peerSubject, spacePage), null);
      assert.equal(await resolveNativeNoteDisplay(peerSubject, spaceNote), null);
      assert.ok(!JSON.stringify(await resolveNativeWikiDisplay(ownerSubject, privatePage)).includes('secret'));
      assert.ok(!JSON.stringify(await resolveNativeNoteDisplay(ownerSubject, privateNote)).includes('secret'));
    } finally {
      await client.query('DELETE FROM note_shares WHERE note_id = ANY($1)', [[privateNote, sharedNote, spaceNote, wrongParentNote, deadNote]]);
      await client.query('DELETE FROM notes WHERE id = ANY($1)', [[privateNote, sharedNote, spaceNote, wrongParentNote, deadNote]]);
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
