/**
 * Migration 0063 verification — users.kind enum.
 *
 * Phase 1 of agent-chat unification.
 * (docs/superpowers/specs/2026-05-07-agent-chat-unification.md §8)
 *
 * Run: pnpm --filter @deft/api test -- user-kind-migration
 *
 * Asserts:
 *   1. The 'kind' column exists with type 'user_kind' (custom enum).
 *   2. All is_agent=true rows have been backfilled to kind='agent'.
 *   3. deft-agent@system.local (Defty shadow user), if present, has kind='agent'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { users } from '@deft/db/schema';
import { eq, sql } from 'drizzle-orm';

test('kind column exists and has type user_kind', async () => {
  const result = await db.execute(sql`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'kind'
  `);
  assert.equal(result.rows.length, 1, 'Expected exactly one kind column');
  const row = result.rows[0] as { udt_name: string };
  assert.equal(row.udt_name, 'user_kind', 'Expected udt_name to be user_kind');
});

test('all is_agent=true rows have kind=agent', async () => {
  const mismatched = await db.execute(sql`
    SELECT id FROM users WHERE is_agent = true AND kind != 'agent'
  `);
  assert.equal(
    mismatched.rows.length,
    0,
    `Expected 0 mismatched rows, found ${mismatched.rows.length}`
  );
});

test('deft-agent@system.local (if present) has kind=agent', async () => {
  const result = await db
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.email, 'deft-agent@system.local'))
    .limit(1);
  if (result.length > 0) {
    assert.equal(
      result[0]!.kind,
      'agent',
      'Expected deft-agent@system.local to have kind=agent'
    );
  }
  // If Defty user doesn't exist yet (no @deft mention has happened on this DB),
  // skip the assertion. Task 4 creates one.
});
