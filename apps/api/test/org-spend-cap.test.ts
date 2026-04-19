/**
 * Block 0.9 — org_spend_caps helper unit tests.
 *
 * Uses the seed dev org. Creates + cleans up its own spend-cap row so reruns
 * are idempotent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/lib/db.js';
import { orgSpendCaps } from '@deft/db/schema';
import { eq } from 'drizzle-orm';
import {
  checkOrgSpendCap,
  recordOrgSpend,
  recordOrgSpendFromUsage,
} from '../src/lib/org-spend-cap.js';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

async function resetRow() {
  await db.delete(orgSpendCaps).where(eq(orgSpendCaps.org_id, ORG_ID));
}

test('checkOrgSpendCap auto-creates row + returns allowed for fresh org', async () => {
  await resetRow();
  try {
    const v = await checkOrgSpendCap(ORG_ID);
    assert.equal(v.allowed, true);
    const [row] = await db
      .select()
      .from(orgSpendCaps)
      .where(eq(orgSpendCaps.org_id, ORG_ID));
    assert.ok(row, 'row should be auto-created');
    assert.equal(row!.monthly_cents, 10000);
    assert.equal(row!.current_monthly_cents, 0);
  } finally {
    await resetRow();
  }
});

test('recordOrgSpend increments both counters', async () => {
  await resetRow();
  try {
    await checkOrgSpendCap(ORG_ID);
    await recordOrgSpend(ORG_ID, 250);
    await recordOrgSpend(ORG_ID, 100);
    const [row] = await db
      .select()
      .from(orgSpendCaps)
      .where(eq(orgSpendCaps.org_id, ORG_ID));
    assert.equal(row!.current_daily_cents, 350);
    assert.equal(row!.current_monthly_cents, 350);
  } finally {
    await resetRow();
  }
});

test('checkOrgSpendCap circuit-breaks once monthly cap reached', async () => {
  await resetRow();
  try {
    // Pre-create with a tiny cap
    await db.insert(orgSpendCaps).values({
      org_id: ORG_ID,
      monthly_cents: 100,
      current_monthly_cents: 0,
      current_daily_cents: 0,
    });
    await recordOrgSpend(ORG_ID, 100);
    const v = await checkOrgSpendCap(ORG_ID);
    assert.equal(v.allowed, false);
    if (!v.allowed) {
      assert.match(v.reason, /Monthly spend cap/i);
    }
  } finally {
    await resetRow();
  }
});

test('recordOrgSpendFromUsage computes cost from model pricing', async () => {
  await resetRow();
  try {
    await checkOrgSpendCap(ORG_ID);
    // haiku: 80 input + 400 output per million tokens
    // 1M in / 1M out = 480 cents
    await recordOrgSpendFromUsage(
      ORG_ID,
      'anthropic/claude-haiku-4-5-20251001',
      1_000_000,
      1_000_000,
    );
    const [row] = await db
      .select()
      .from(orgSpendCaps)
      .where(eq(orgSpendCaps.org_id, ORG_ID));
    assert.equal(row!.current_monthly_cents, 480);
  } finally {
    await resetRow();
  }
});

test('unknown model computes zero cost (no crash)', async () => {
  await resetRow();
  try {
    await checkOrgSpendCap(ORG_ID);
    await recordOrgSpendFromUsage(ORG_ID, 'unknown/model', 1000, 1000);
    const [row] = await db
      .select()
      .from(orgSpendCaps)
      .where(eq(orgSpendCaps.org_id, ORG_ID));
    assert.equal(row!.current_monthly_cents, 0);
  } finally {
    await resetRow();
  }
});

test('checkOrgSpendCap no-ops on empty orgId', async () => {
  const v = await checkOrgSpendCap('');
  assert.equal(v.allowed, true);
});
