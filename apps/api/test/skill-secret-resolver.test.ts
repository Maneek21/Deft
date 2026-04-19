/**
 * Block 1.6 — pre-deploy secret resolver tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/skill-secret-resolver.test.ts
 *
 * Exercises the OAuth-first → skill_secrets fallback chain + gateway
 * push sequencing. Real DB for connected_accounts + skill_secrets rows;
 * mock gateway for config.set capture.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, and, inArray } from 'drizzle-orm';
import {
  db, orgs, users, orgMembers, connectedAccounts, skills, skillSecrets,
} from '@deft/db';
import {
  resolveSecretsForInstall,
  pushSkillSecretsToGateway,
} from '../src/lib/skill-secret-resolver.js';
import { setSecretForSkill } from '../src/lib/skill-secrets.js';
import { encrypt } from '../src/lib/encryption.js';

let testOrgId: string;
let testUserId: string;
let testSkillId: string;
const connectedIds: string[] = [];

before(async () => {
  const existingOrg = await db.query.orgs.findFirst();
  testOrgId = existingOrg?.id ?? crypto.randomUUID();
  if (!existingOrg) {
    await db.insert(orgs).values({ id: testOrgId, name: 'b16-org', slug: 'b16-org' });
  }
  const existingUser = await db.query.users.findFirst();
  testUserId = existingUser?.id ?? crypto.randomUUID();
  if (!existingUser) {
    await db.insert(users).values({ id: testUserId, email: `b16-${Date.now()}@t.local`, name: 'b16' });
  }
  const member = await db.query.orgMembers.findFirst({
    where: (m, { and, eq }) => and(eq(m.user_id, testUserId), eq(m.org_id, testOrgId)),
  });
  if (!member) {
    await db.insert(orgMembers).values({
      id: crypto.randomUUID(), org_id: testOrgId, user_id: testUserId, role: 'admin',
    });
  }

  testSkillId = crypto.randomUUID();
  await db.insert(skills).values({
    id: testSkillId,
    org_id: testOrgId,
    name: 'b16-skill',
    slug: `b16-skill-${Date.now()}`,
    source: 'marketplace',
    version: '1.0.0',
  });
});

afterEach(async () => {
  // Clean connected_accounts + skill_secrets between tests
  if (connectedIds.length > 0) {
    await db.delete(connectedAccounts).where(inArray(connectedAccounts.id, connectedIds));
    connectedIds.length = 0;
  }
  await db.delete(skillSecrets).where(eq(skillSecrets.skill_id, testSkillId));
});

after(async () => {
  await db.delete(skillSecrets).where(eq(skillSecrets.skill_id, testSkillId));
  await db.delete(skills).where(eq(skills.id, testSkillId));
});

async function seedConnectedAccount(provider: string, plaintextToken: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(connectedAccounts).values({
    id,
    org_id: testOrgId,
    user_id: testUserId,
    provider,
    access_token_encrypted: encrypt(plaintextToken),
  });
  connectedIds.push(id);
  return id;
}

test('OAuth-first: SLACK_BOT_TOKEN resolves from connected_accounts', async () => {
  await seedConnectedAccount('slack', 'xoxb-OAUTH-token');
  const r = await resolveSecretsForInstall(testOrgId, testSkillId, ['SLACK_BOT_TOKEN']);
  assert.equal(r.resolved.SLACK_BOT_TOKEN, 'xoxb-OAUTH-token');
  assert.equal(r.sources.SLACK_BOT_TOKEN, 'oauth');
  assert.equal(r.missing.length, 0);
});

test('skill_secrets fallback: custom key without provider prefix', async () => {
  await setSecretForSkill({
    org_id: testOrgId, skill_id: testSkillId, key_name: 'CUSTOM_API_KEY', value: 'raw-xyz',
  });
  const r = await resolveSecretsForInstall(testOrgId, testSkillId, ['CUSTOM_API_KEY']);
  assert.equal(r.resolved.CUSTOM_API_KEY, 'raw-xyz');
  assert.equal(r.sources.CUSTOM_API_KEY, 'skill_secret');
});

test('skill_secrets fallback: provider-prefixed key with no OAuth match', async () => {
  await setSecretForSkill({
    org_id: testOrgId, skill_id: testSkillId, key_name: 'LINEAR_API_TOKEN', value: 'lin_api_raw',
  });
  const r = await resolveSecretsForInstall(testOrgId, testSkillId, ['LINEAR_API_TOKEN']);
  assert.equal(r.resolved.LINEAR_API_TOKEN, 'lin_api_raw');
  assert.equal(r.sources.LINEAR_API_TOKEN, 'skill_secret');
});

test('missing list when no OAuth and no skill_secret', async () => {
  const r = await resolveSecretsForInstall(testOrgId, testSkillId, ['GITHUB_TOKEN', 'SOMETHING_ELSE']);
  assert.deepEqual(r.missing.sort(), ['GITHUB_TOKEN', 'SOMETHING_ELSE']);
  assert.equal(Object.keys(r.resolved).length, 0);
});

test('mixed: OAuth hit + skill_secret hit + missing in one call', async () => {
  await seedConnectedAccount('github', 'ghp-oauth');
  await setSecretForSkill({
    org_id: testOrgId, skill_id: testSkillId, key_name: 'CUSTOM_X', value: 'raw',
  });

  const r = await resolveSecretsForInstall(testOrgId, testSkillId, [
    'GITHUB_TOKEN', 'CUSTOM_X', 'SLACK_MISSING',
  ]);
  assert.equal(r.resolved.GITHUB_TOKEN, 'ghp-oauth');
  assert.equal(r.sources.GITHUB_TOKEN, 'oauth');
  assert.equal(r.resolved.CUSTOM_X, 'raw');
  assert.equal(r.sources.CUSTOM_X, 'skill_secret');
  assert.deepEqual(r.missing, ['SLACK_MISSING']);
});

test('empty requiredKeys short-circuits to empty result', async () => {
  const r = await resolveSecretsForInstall(testOrgId, testSkillId, []);
  assert.equal(r.missing.length, 0);
  assert.equal(Object.keys(r.resolved).length, 0);
});

// ─── pushSkillSecretsToGateway ──────────────────────────────────────────────
test('pushSkillSecretsToGateway calls config.set with scoped path', async () => {
  const calls: Array<{ path: string; value: unknown }> = [];
  const mockGateway = {
    config: {
      set: (path: string, value: unknown) => {
        calls.push({ path, value });
        return Promise.resolve({ set: true });
      },
    },
  };

  const r = await pushSkillSecretsToGateway(mockGateway, 'slack', {
    SLACK_BOT_TOKEN: 'xoxb-abc',
    SLACK_SIGNING_SECRET: 'sss-xyz',
  });

  assert.equal(r.pushed.length, 2);
  assert.equal(r.failed.length, 0);
  assert.ok(calls.find((c) => c.path === 'skills/slack/SLACK_BOT_TOKEN' && c.value === 'xoxb-abc'));
  assert.ok(calls.find((c) => c.path === 'skills/slack/SLACK_SIGNING_SECRET' && c.value === 'sss-xyz'));
});

test('pushSkillSecretsToGateway records failures without throwing', async () => {
  const mockGateway = {
    config: {
      set: (path: string) => {
        if (path.includes('FAIL')) return Promise.reject(new Error('nope'));
        return Promise.resolve({ set: true });
      },
    },
  };
  const r = await pushSkillSecretsToGateway(mockGateway, 'skill', {
    OK_KEY: 'ok',
    FAIL_KEY: 'bad',
  });
  assert.deepEqual(r.pushed, ['OK_KEY']);
  assert.deepEqual(r.failed, ['FAIL_KEY']);
});
