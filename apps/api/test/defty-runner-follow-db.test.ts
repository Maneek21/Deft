import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { orgMembers, orgs, spaceMembers, spaces, users } from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import { runAgentQuery } from '../src/lib/agent-runner.js';
import { requiresWorkspaceEvidence } from '../src/lib/agent-source-grounding.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const canRun = Boolean(safeTestDatabaseUrl());
const orgId = randomUUID(), userId = randomUUID(), spaceId = randomUUID();

describe('followed runner response', { skip: !canRun }, () => {
  before(async () => {
    await db.insert(orgs).values({ id: orgId, name: 'Followed runner', slug: `follow-${orgId}` });
    await db.insert(users).values({ id: userId, name: 'Priya Shah' });
    await db.insert(orgMembers).values({ org_id: orgId, user_id: userId });
    await db.insert(spaces).values({ id: spaceId, org_id: orgId, name: 'engineering', type: 'public' });
    await db.insert(spaceMembers).values({ space_id: spaceId, user_id: userId });
  });
  after(async () => {
    await db.delete(spaceMembers).where(eq(spaceMembers.space_id, spaceId));
    await db.delete(spaces).where(eq(spaces.id, spaceId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, orgId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
    await closeDb();
  });
  test('exact NO_REPLY survives workspace grounding without retrying or running actions', async (t) => {
    const providerKeys = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_URL'] as const;
    const savedEnv = Object.fromEntries(providerKeys.map(key => [key, env[key]]));
    const savedProcess = Object.fromEntries(providerKeys.map(key => [key, process.env[key]]));
    t.after(() => {
      Object.assign(env, savedEnv);
      for (const key of providerKeys) {
        if (savedProcess[key] === undefined) delete process.env[key];
        else process.env[key] = savedProcess[key];
      }
    });
    const configured = { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'test', OPENROUTER_API_KEY: '', OLLAMA_URL: '' };
    Object.assign(env, configured); Object.assign(process.env, configured);
    let reasonCalls = 0;
    t.mock.method(globalThis, 'fetch', async (url: unknown) => {
      if (String(url).includes('/embeddings')) return Response.json({ data: [{ embedding: Array(1536).fill(0) }] });
      assert.match(String(url), /\/responses$/);
      reasonCalls++;
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'NO_REPLY' }] }],
        usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const content = 'Search the current workspace tasks for the rollout.';
    assert.equal(requiresWorkspaceEvidence(content), true);
    const response = await runAgentQuery({ content, orgId, userId,
      orgName: 'Followed runner', followed: true, conversationId: spaceId,
      spaceContext: { type: 'public', name: 'engineering' }, maxIterations: 2 });
    assert.equal(response.text, 'NO_REPLY');
    assert.equal(reasonCalls, 1);
    assert.deepEqual(response.pendingActions, []);
    assert.deepEqual(response.executedActions, []);
  });
});
