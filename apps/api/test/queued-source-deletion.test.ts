import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { messages } from '@deft/db/schema';
import { db } from '../src/lib/db.js';

afterEach(() => mock.restoreAll());

function deletedSourceDatabase() {
  mock.method(db, 'select', () => {
    const query = {
      from(table: unknown) {
        assert.equal(table, messages, 'a queued extractor must check its source before reading other context');
        return query;
      },
      where() { return query; },
      limit: async () => [],
    };
    return query as any;
  });
  mock.method(db, 'insert', () => { throw new Error('Deleted source must not create content'); });
}

const job = { id: 'deleted-source', name: 'extract', attempts: 0, data: {
  orgId: 'org', userId: 'author', spaceId: 'room', messageId: 'deleted-message', content: 'CANARY-DELETED',
  facts: ['CANARY-DELETED'], classification: { intent: 'actionable' },
} };

test('a legacy memory-extract job cannot resurrect a deleted source', async () => {
  const { handleMemoryExtract } = await import('../src/workers/handlers/memory-extract.js');
  deletedSourceDatabase();
  await assert.doesNotReject(() => handleMemoryExtract(job));
});

test('opt-in background task extraction checks a deleted source before dispatching captured text', async () => {
  const original = process.env.DEFT_ENABLE_BACKGROUND_TASK_CAPTURE;
  process.env.DEFT_ENABLE_BACKGROUND_TASK_CAPTURE = '1';
  try {
    const { handleTaskExtract } = await import('../src/workers/handlers/task-extract.js');
    deletedSourceDatabase();
    await assert.doesNotReject(() => handleTaskExtract(job));
  } finally {
    if (original === undefined) delete process.env.DEFT_ENABLE_BACKGROUND_TASK_CAPTURE;
    else process.env.DEFT_ENABLE_BACKGROUND_TASK_CAPTURE = original;
  }
});
