/**
 * Block 1.4 — skill_secrets store tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/skill-secrets.test.ts
 *
 * Hits the real dev DB. Cleans up after itself with DELETE on each test to
 * avoid interference with other runs. Encryption round-trips through
 * encrypt/decrypt in lib/encryption.ts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, skillSecrets, orgs, skills } from '@deft/db';
import { and, eq } from 'drizzle-orm';
import {
  getSecretForSkill,
  getSecretsForSkill,
  setSecretForSkill,
  deleteSecretForSkill,
  listSecretKeysForSkill,
} from '../src/lib/skill-secrets.js';

// Create a throwaway skill row for FK scoping. testOrgId falls back to an
// existing org in the dev DB (per reference_test_credentials memory).
let testOrgId: string;
let testSkillId: string;

before(async () => {
  // Pick any existing org — bootstrap test org if needed.
  const existing = await db.query.orgs.findFirst();
  if (!existing) {
    testOrgId = crypto.randomUUID();
    await db.insert(orgs).values({ id: testOrgId, name: 'test-secrets-org', slug: 'test-secrets-org' });
  } else {
    testOrgId = existing.id;
  }

  testSkillId = crypto.randomUUID();
  await db.insert(skills).values({
    id: testSkillId,
    org_id: testOrgId,
    name: 'skill-secrets-test',
    slug: `skill-secrets-test-${Date.now()}`,
    source: 'org',
  });
});

after(async () => {
  await db.delete(skillSecrets).where(eq(skillSecrets.skill_id, testSkillId));
  await db.delete(skills).where(eq(skills.id, testSkillId));
});

test('setSecretForSkill + getSecretForSkill round-trip through encryption', async () => {
  await setSecretForSkill({
    org_id: testOrgId,
    skill_id: testSkillId,
    key_name: 'SLACK_BOT_TOKEN',
    value: 'xoxb-super-secret-123',
  });

  const got = await getSecretForSkill(testOrgId, testSkillId, 'SLACK_BOT_TOKEN');
  assert.equal(got, 'xoxb-super-secret-123');

  // Verify ciphertext is not plaintext in the DB row
  const row = await db.query.skillSecrets.findFirst({
    where: and(
      eq(skillSecrets.org_id, testOrgId),
      eq(skillSecrets.skill_id, testSkillId),
      eq(skillSecrets.key_name, 'SLACK_BOT_TOKEN'),
    ),
  });
  assert.ok(row, 'row exists');
  assert.notEqual(row!.value_encrypted, 'xoxb-super-secret-123', 'stored value is encrypted');
  assert.match(row!.value_encrypted, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i, 'iv:tag:ciphertext format');
});

test('getSecretForSkill returns null for missing key', async () => {
  const got = await getSecretForSkill(testOrgId, testSkillId, 'NOT_SET');
  assert.equal(got, null);
});

test('setSecretForSkill upserts on repeat (overwrites ciphertext)', async () => {
  await setSecretForSkill({
    org_id: testOrgId,
    skill_id: testSkillId,
    key_name: 'GITHUB_TOKEN',
    value: 'ghp_original',
  });
  await setSecretForSkill({
    org_id: testOrgId,
    skill_id: testSkillId,
    key_name: 'GITHUB_TOKEN',
    value: 'ghp_rotated',
  });
  const got = await getSecretForSkill(testOrgId, testSkillId, 'GITHUB_TOKEN');
  assert.equal(got, 'ghp_rotated');

  // Only one row despite two writes
  const rows = await db.query.skillSecrets.findMany({
    where: and(
      eq(skillSecrets.org_id, testOrgId),
      eq(skillSecrets.skill_id, testSkillId),
      eq(skillSecrets.key_name, 'GITHUB_TOKEN'),
    ),
  });
  assert.equal(rows.length, 1, 'upsert keeps single row');
});

test('getSecretsForSkill returns only requested keys (least-privilege)', async () => {
  await setSecretForSkill({ org_id: testOrgId, skill_id: testSkillId, key_name: 'KEY_A', value: 'aaa' });
  await setSecretForSkill({ org_id: testOrgId, skill_id: testSkillId, key_name: 'KEY_B', value: 'bbb' });
  await setSecretForSkill({ org_id: testOrgId, skill_id: testSkillId, key_name: 'KEY_C', value: 'ccc' });

  const only = await getSecretsForSkill(testOrgId, testSkillId, ['KEY_A', 'KEY_C']);
  assert.deepEqual(only, { KEY_A: 'aaa', KEY_C: 'ccc' }, 'only declared keys returned');
  assert.equal(Object.keys(only).length, 2);
});

test('getSecretsForSkill returns empty for empty keyNames (no-op short-circuit)', async () => {
  const got = await getSecretsForSkill(testOrgId, testSkillId, []);
  assert.deepEqual(got, {});
});

test('listSecretKeysForSkill returns names without values', async () => {
  await setSecretForSkill({ org_id: testOrgId, skill_id: testSkillId, key_name: 'LIST_KEY_1', value: 'v1' });
  await setSecretForSkill({ org_id: testOrgId, skill_id: testSkillId, key_name: 'LIST_KEY_2', value: 'v2' });

  const keys = await listSecretKeysForSkill(testOrgId, testSkillId);
  assert.ok(keys.includes('LIST_KEY_1'));
  assert.ok(keys.includes('LIST_KEY_2'));
});

test('deleteSecretForSkill removes the row', async () => {
  await setSecretForSkill({
    org_id: testOrgId,
    skill_id: testSkillId,
    key_name: 'DELETE_ME',
    value: 'bye',
  });
  assert.equal(await getSecretForSkill(testOrgId, testSkillId, 'DELETE_ME'), 'bye');

  await deleteSecretForSkill(testOrgId, testSkillId, 'DELETE_ME');
  assert.equal(await getSecretForSkill(testOrgId, testSkillId, 'DELETE_ME'), null);
});
