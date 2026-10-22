import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { loadClassificationContext } from '../src/workers/handlers/observe-chat-message.js';
import { closeDb } from '../src/lib/db.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = Boolean(target && target === process.env.DATABASE_URL && /test/i.test(new URL(target).pathname));

test('classifier context isolates readable channel/thread history, tenant and private spaces', { skip: !safe }, async () => {
  const client = new pg.Client({ connectionString: target, connectionTimeoutMillis: 2_000 });
  const suffix = randomUUID();
  const orgId = `classifier-org-${suffix}`;
  const foreignOrgId = `classifier-foreign-${suffix}`;
  const requesterId = `classifier-reader-${suffix}`;
  const room = `classifier-room-${suffix}`;
  const joined = `classifier-joined-${suffix}`;
  const hidden = `classifier-hidden-${suffix}`;
  const foreignRoom = `classifier-foreign-room-${suffix}`;
  const parent = `classifier-parent-${suffix}`;
  const unrelatedParent = `classifier-unrelated-${suffix}`;
  const instant = (minute: number) => new Date(Date.UTC(2026, 9, 22, 10, minute));
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query('INSERT INTO orgs (id, name, slug) VALUES ($1, $1, $1), ($2, $2, $2)', [orgId, foreignOrgId]);
    await client.query('INSERT INTO users (id, email, name, kind, is_agent, email_verified) VALUES ($1, $2, $3, $4, false, true)', [requesterId, `${suffix}@classifier.test`, 'Priya Shah', 'human']);
    await client.query('INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, $4, true)', [`member-${suffix}`, orgId, requesterId, 'member']);
    await client.query('INSERT INTO spaces (id, org_id, name, type) VALUES ($1, $5, $1, $6), ($2, $5, $2, $7), ($3, $5, $3, $7), ($4, $8, $4, $6)', [room, joined, hidden, foreignRoom, orgId, 'public', 'private', foreignOrgId]);
    await client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [`joined-${suffix}`, joined, requesterId]);
    async function message(id: string, content: string, minute: number, options: { space?: string; org?: string; parent?: string; deleted?: boolean } = {}) {
      await client.query('INSERT INTO messages (id, org_id, space_id, user_id, content, parent_id, is_deleted, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)', [id, options.org ?? orgId, options.space ?? room, requesterId, content, options.parent ?? null, options.deleted ?? false, instant(minute).toISOString()]);
    }
    await message(parent, 'Schema review discussion', 0);
    for (let i = 1; i <= 8; i += 1) await message(`history-${i}-${suffix}`, `Channel message ${i}`, i);
    await message(unrelatedParent, 'Another discussion', 9);
    await message(`unrelated-reply-${suffix}`, 'Unrelated thread reply', 10, { parent: unrelatedParent });
    await message(`deleted-${suffix}`, 'Deleted text', 11, { deleted: true });
    await message(`reply-one-${suffix}`, '<p>Schema review owner is Rahul</p>', 12, { parent });
    await message(`reply-two-${suffix}`, 'Review due Wednesday EOD', 13, { parent });
    await message(`future-${suffix}`, 'Future message', 25);
    await message(`joined-message-${suffix}`, 'Joined private context', 14, { space: joined });
    await message(`hidden-message-${suffix}`, 'Secret private context', 14, { space: hidden });
    await message(`foreign-message-${suffix}`, 'Other tenant context', 14, { space: foreignRoom, org: foreignOrgId });
    const input = { orgId, spaceId: room, requesterId, parentId: null, createdAt: instant(20) };
    assert.deepEqual(await loadClassificationContext(input), [
      ...[4, 5, 6, 7, 8].map((i) => ({ author: 'Priya Shah', content: `Channel message ${i}` })),
      { author: 'Priya Shah', content: 'Another discussion' },
    ]);
    assert.deepEqual(await loadClassificationContext({ ...input, parentId: parent }), [
      { author: 'Priya Shah', content: 'Schema review discussion' },
      { author: 'Priya Shah', content: 'Schema review owner is Rahul' },
      { author: 'Priya Shah', content: 'Review due Wednesday EOD' },
    ]);
    assert.deepEqual(await loadClassificationContext({ ...input, spaceId: joined }), [{ author: 'Priya Shah', content: 'Joined private context' }]);
    assert.deepEqual(await loadClassificationContext({ ...input, spaceId: hidden }), []);
    assert.deepEqual(await loadClassificationContext({ ...input, spaceId: foreignRoom }), []);
    await client.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [orgId, requesterId]);
    assert.deepEqual(await loadClassificationContext(input), []);
  } finally {
    if (connected) {
      await client.query('DELETE FROM messages WHERE org_id = ANY($1::text[])', [[orgId, foreignOrgId]]);
      await client.query('DELETE FROM space_members WHERE user_id = $1', [requesterId]);
      await client.query('DELETE FROM spaces WHERE org_id = ANY($1::text[])', [[orgId, foreignOrgId]]);
      await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]);
      await client.query('DELETE FROM users WHERE id = $1', [requesterId]);
      await client.query('DELETE FROM orgs WHERE id = ANY($1::text[])', [[orgId, foreignOrgId]]);
    }
    await client.end();
    await closeDb();
  }
});
