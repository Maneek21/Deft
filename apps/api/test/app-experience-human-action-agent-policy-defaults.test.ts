import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { seedExperienceAgentPolicyDefaults } from '../src/lib/app-experience-human-action-agent-policy.js';
import type { HumanActionAuthorityPort } from '../src/lib/app-experience-human-action-service.js';

const caller = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID(), access_expires_at: Date.now() + 60_000 };
const sessionId = randomUUID();

/** A minimal transaction fake sufficient for the policy read/write path. */
function authorityWith(state: Record<string, { mode: 'deny' | 'require_approval'; revision: number } | undefined>) {
  const writes: string[] = [];
  const authority: HumanActionAuthorityPort = {
    async withHumanAction(_c, _s, actionKey, use) {
      const existing = state[actionKey];
      const tx = {
        select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => existing ? [existing] : [] }) }) }) }),
        insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => { writes.push(actionKey); return [{ mode: 'require_approval', revision: 1 }]; } }) }) }),
        update: () => ({ set: () => ({ where: () => ({ returning: async () => { writes.push(actionKey); return [{ mode: 'require_approval', revision: (existing?.revision ?? 0) + 1 }]; } }) }) }),
      };
      return use(tx, { runtime_binding_id: `rb-${actionKey}` }, async () => {});
    },
  };
  return { authority, writes };
}

test('seeding defaults grants require_approval to nominated actions and leaves others implicit deny', async () => {
  const { authority, writes } = authorityWith({});
  const seeded = await seedExperienceAgentPolicyDefaults(authority, caller, sessionId, ['mirror_drafts', 'send_message']);
  assert.deepEqual(writes, ['mirror_drafts', 'send_message']);
  assert.deepEqual(seeded.map(row => row.action_key).sort(), ['mirror_drafts', 'send_message']);
  assert.ok(seeded.every(row => row.mode === 'require_approval' && row.revision === 1));
});

test('a prior human choice is never overwritten by seeding', async () => {
  const { authority, writes } = authorityWith({ mirror_drafts: { mode: 'deny', revision: 3 } });
  const seeded = await seedExperienceAgentPolicyDefaults(authority, caller, sessionId, ['mirror_drafts']);
  assert.deepEqual(writes, []);
  assert.deepEqual(seeded, []);
});

test('an empty action list seeds nothing', async () => {
  const { authority, writes } = authorityWith({});
  assert.deepEqual(await seedExperienceAgentPolicyDefaults(authority, caller, sessionId, []), []);
  assert.deepEqual(writes, []);
});
