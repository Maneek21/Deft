import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { getTableName } from 'drizzle-orm';
import ts from 'typescript';

for (const explicitUpdate of [false, true]) {
test(`${explicitUpdate ? 'update-prefixed capture' : 'capture matching an existing page'} appends a dated update section and keeps existing content`, async () => {
  const existingContent = `# Demo schedule\n\n${'Keep the original discussion and formatting.\n'.repeat(180)}`;
  const update = 'Demo schedule moves to Friday at 3pm, with the rehearsal on Thursday.';
  const page = {
    id: 'wiki-one', title: 'Demo schedule', slug: 'demo-schedule',
    content: existingContent, summary: 'Original demo schedule.', version: 1,
  };
  const results = [[{ id: 'message-one', spaceType: 'public' }], [page], ...(explicitUpdate ? [] : [[page]])];
  const insertedIntents: any[] = [];
  const query = {
    from() { return this; },
    innerJoin() { return this; },
    where() { return this; },
    async limit() {
      assert.ok(results.length, 'unexpected read');
      return results.shift()!;
    },
  };
  const db = {
    select: () => query,
    async transaction(run: (tx: any) => Promise<unknown>) {
      return run({ select: () => ({ ...query, limit: async () => [] }),
        insert(table: unknown) {
          return {
            values(value: unknown) {
              if (getTableName(table as any) === 'work_intents') insertedIntents.push(value);
              return this;
            },
            onConflictDoNothing() { return this; },
            async returning() { return [{ id: 'proposal-one' }]; },
          };
        },
      });
    },
  };
  const url = new URL('../src/lib/defty-capture.ts', import.meta.url);
  const require = createRequire(url);
  const dependencies: Record<string, unknown> = {
    './db.js': { db },
    './ensure-defty-membership.js': {
      ensureDeftyEmployee: async () => ({ slug: 'defty', employeeId: 'employee-one', userId: 'defty-user' }),
    },
    './agent-approval-resolver.js': { approveAction: async () => assert.fail('capture must remain a proposal') },
    './resolve-assignee.js': {},
  };
  const module = { exports: {} as Record<string, any> };
  const compiled = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, {
    module, exports: module.exports, console,
    require: (name: string) => name in dependencies ? dependencies[name] : require(name),
  });
  const result = await module.exports.queueDeftyKnowledgeCapture({
    orgId: 'org-one', sourceUserId: 'user-one', spaceId: 'space-one', messageId: 'message-one',
    content: update, title: page.title, wikiType: 'decision', captureKind: 'decision_candidate',
    rawContent: explicitUpdate ? `Update knowledge: ${update}` : undefined,
    extraction: 'classifier', preferUpdate: true, autoApprove: false,
  });
  assert.equal(result.queued, true);
  assert.equal(insertedIntents.length, 1);
  assert.equal(insertedIntents[0].proposed_action, 'wiki_update');
  assert.equal(insertedIntents[0].proposed_params.expected_version, 1);
  const patch = insertedIntents[0].proposed_params.patch;
  assert.ok(patch.content.startsWith(existingContent), 'existing page must survive exactly, including long content');
  assert.match(patch.content.slice(existingContent.length), /^\n\n## Update \d{4}-\d{2}-\d{2}\n\n/);
  assert.ok(patch.content.endsWith(update));
  assert.equal(patch.summary, update);
});
}
