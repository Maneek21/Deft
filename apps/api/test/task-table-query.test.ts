import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeTaskTableCursor,
  encodeTaskTableCursor,
  parseTaskTableQuery,
} from '../src/lib/task-table-query.js';

test('table query accepts bounded filters, group, and three stable sorts', () => {
  const parsed = parseTaskTableQuery({
    project_id: 'project-1',
    status: 'todo,in_progress',
    priority: 'p0,p2',
    group: 'assignee:asc',
    sort: 'priority:asc:last,due_date:asc:last,number:desc:last',
    page_size: '200',
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.deepEqual(parsed.data.statuses, ['todo', 'in_progress']);
  assert.equal(parsed.data.sorts.length, 3);
  assert.equal(parsed.data.group?.field, 'assignee');
  assert.equal(parsed.data.pageSize, 200);
});

test('table query rejects missing scope, malformed clauses, and oversized pages', () => {
  assert.equal(parseTaskTableQuery({}).success, false);
  assert.equal(parseTaskTableQuery({ mine: 'true', sort: 'mystery:asc:last' }).success, false);
  assert.equal(parseTaskTableQuery({ mine: 'true', sort: 'title:sideways:last' }).success, false);
  assert.equal(parseTaskTableQuery({ mine: 'true', group: 'mystery:asc' }).success, false);
  assert.equal(parseTaskTableQuery({ mine: 'true', priority: 'urgent' }).success, false);
  assert.equal(parseTaskTableQuery({ mine: 'true', page_size: '201' }).success, false);
});

test('table cursors round-trip typed null-aware ordering values and fail closed', () => {
  const values = ['todo', null, 42, 'task-id'];
  assert.deepEqual(
    decodeTaskTableCursor(encodeTaskTableCursor('project:test|number:desc', values)),
    { signature: 'project:test|number:desc', values },
  );
  assert.equal(decodeTaskTableCursor('not-a-cursor'), null);
});
