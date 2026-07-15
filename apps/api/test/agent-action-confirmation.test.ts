import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatApprovalConfirmation,
  summarizeConfirmedAction,
} from '../src/lib/agent-action-confirmation.js';

test('confirmation copy names concrete task, wiki, note, and message outcomes', () => {
  assert.equal(summarizeConfirmedAction({
    action: 'create_task',
    params: { title: 'Run field trial' },
    result: { prefix: 'MKT', number: 42, title: 'Run field trial', subtasks: [{}, {}] },
  }), 'Created MKT-42: Run field trial with 2 subtasks.');
  assert.equal(summarizeConfirmedAction({
    action: 'task_create',
    params: { title: 'Prepare buyer brief' },
    result: { identifier: 'BUY-17', title: 'Prepare buyer brief' },
  }), 'Created BUY-17: Prepare buyer brief.');
  assert.equal(summarizeConfirmedAction({
    action: 'wiki_write',
    params: { title: 'Watering guide' },
    result: { action: 'created', slug: 'watering-guide' },
  }), 'Created wiki page "Watering guide".');
  assert.equal(summarizeConfirmedAction({
    action: 'create_note',
    params: { title: 'Buyer call notes' },
    result: { note_id: 'note-1', title: 'Buyer call notes' },
  }), 'Created note "Buyer call notes".');
  assert.equal(summarizeConfirmedAction({
    action: 'post_message',
    params: { space_name: 'sales' },
  }), 'Posted the message in #sales.');
});

test('compound confirmations remain concise but auditable', () => {
  assert.equal(formatApprovalConfirmation([
    { action: 'wiki_write', params: { title: 'Trial guide' }, result: { action: 'updated' } },
    { action: 'create_reminder', params: { remind_at: '2026-07-20T09:00:00Z' } },
  ]), [
    'Done - completed 2 approved actions.',
    '- Updated wiki page "Trial guide".',
    '- Set the reminder for 2026-07-20T09:00:00Z.',
  ].join('\n'));
});
