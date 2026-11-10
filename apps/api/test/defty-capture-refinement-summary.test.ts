import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { getTableName } from 'drizzle-orm';

const existingContent = '# Launch runbook\n\n## Owners\n\nPriya owns QA.\n\n## Freeze\n\nCode freeze is Thursday.\n\n## Rollback\n\nRollback needs two approvers.';
const page = {
  id: 'wiki-one', title: 'Launch runbook', slug: 'launch-runbook',
  content: existingContent, summary: 'Priya owns QA; freeze Thursday; rollback needs two approvers.', version: 4,
};
const reads: unknown[][] = [];
const insertedActions: any[] = [];
const approvals: string[] = [];
const query = {
  from() { return this; }, innerJoin() { return this; }, where() { return this; },
  async limit() { assert.ok(reads.length, 'unexpected read'); return reads.shift()!; },
};
const db = {
  select: () => query,
  async transaction(run: (tx: any) => Promise<unknown>) {
    return run({
      select: () => ({ ...query, limit: async () => [] }),
      insert(table: unknown) {
        return {
          values(value: unknown) {
            if (getTableName(table as any) === 'agent_actions') insertedActions.push(value);
            return this;
          },
          onConflictDoNothing() { return this; },
          async returning() { return [{ id: 'action-one' }]; },
        };
      },
    });
  },
};
mock.module(new URL('../src/lib/db.ts', import.meta.url).href, { namedExports: { db } });
mock.module(new URL('../src/lib/ensure-defty-membership.ts', import.meta.url).href, { namedExports: {
  ensureDeftyEmployee: async () => ({ slug: 'defty', employeeId: 'employee-one', userId: 'defty-user' }),
} });
mock.module(new URL('../src/lib/agent-approval-resolver.ts', import.meta.url).href, { namedExports: {
  approveAction: async (id: string) => { approvals.push(id); return { status: 'approved' }; },
} });
mock.module(new URL('../src/lib/resolve-assignee.ts', import.meta.url).href, { namedExports: {
  resolveAssigneeWithMatches: async () => ({ assigneeId: null, matches: [] }),
} });
const { queueDeftyKnowledgeCapture } = await import('../src/lib/defty-capture.js');

test('B05: a capture refinement does not auto-approve a whole-page replace', async () => {
  // Source message, similar-page probe (not similar), related-page match.
  reads.push([{ id: 'message-one', spaceType: 'public' }], [page], [page]);
  const update = 'Launch runbook adds a Friday dry run owned by Arjun.';
  // Same flags the passive chat-knowledge batch passes.
  const result = await queueDeftyKnowledgeCapture({
    orgId: 'org-one', sourceUserId: 'user-one', spaceId: 'space-one', messageId: 'message-one',
    content: update, title: page.title, wikiType: 'decision', captureKind: 'decision_candidate',
    extraction: 'llm', preferUpdate: true, autoApprove: true,
  });
  assert.equal(result.queued, true);
  assert.equal(insertedActions.length, 1);
  assert.equal(insertedActions[0].action, 'wiki_update');
  const params = insertedActions[0].params;
  assert.equal(params.expected_version, 4, 'the write is bound to the version it was built from');
  assert.ok(params.patch.content.startsWith(existingContent), 'every existing section survives');
  assert.ok(params.patch.content.endsWith(update));
  assert.ok(!('summary' in params.patch), 'an auto-approved append must not replace the page summary');
  assert.deepEqual(approvals, ['action-one']);
});
