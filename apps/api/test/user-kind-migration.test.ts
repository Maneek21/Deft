/**
 * Migration 0063 verification — users.kind enum.
 *
 * Phase 1 of agent-chat unification.
 * (docs/superpowers/specs/2026-05-07-agent-chat-unification.md §8)
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/user-kind-migration.test.ts
 *
 * Asserts:
 *   1. The 'kind' column exists with type 'user_kind' (custom enum).
 *   2. All is_agent=true rows have kind=agent (backfill consistency).
 *   3. The well-known Defty user (if present) has kind=agent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { users } from '@deft/db/schema';
import { eq, sql } from 'drizzle-orm';

test('users.kind migration — kind column exists and has type user_kind', async () => {
  const result = await db.execute(sql`
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'kind'
  `);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0] as { udt_name: string };
  assert.equal(row.udt_name, 'user_kind');
});

test('users.kind migration — all is_agent=true rows have kind=agent', async () => {
  const mismatched = await db.execute(sql`
    SELECT id FROM users WHERE is_agent = true AND kind != 'agent'
  `);
  assert.equal(mismatched.rows.length, 0);
});

test('users.kind migration — Defty user (if present) has kind=agent', async () => {
  const result = await db
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.email, 'deft-agent@system.local'))
    .limit(1);
  if (result.length > 0) {
    assert.equal(result[0]!.kind, 'agent');
  }
  // If Defty user doesn't exist yet, skip — Task 4 creates one.
});
