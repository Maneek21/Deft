// Lane W2-a2 — E06: approval surfaces show every field the action will
// change, including clears, and full date and time; a pending action is not
// approved from a one-line summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { stripHtml } from './strip-html';
import {
  formatApprovalDateTime,
  getAgentActionPresentation,
  getTaskChangeList,
} from './agent-action-presentation';

const cardText = readFileSync(new URL('../components/agent-action-card.tsx', import.meta.url), 'utf8');
const card = ts.createSourceFile('card.tsx', cardText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const cardFunctions = ['getStringParam', 'getSubtaskDraftText', 'getDraftDetailText']
  .map((name) => card.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(card))
  .join('\n');
const draftDetails = vm.runInNewContext(
  ts.transpileModule(`${cardFunctions};getDraftDetailText`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
  { getTaskReviewAssignment: () => [], stripHtml },
) as (action: string, params: Record<string, unknown>) => string;

test('E06: a task update lists every patched field, including a cleared due date', () => {
  const params = { task_id: 'ENG-7', patch: { status: 'in_review', due_date: null, assignee_id: null } };
  const changes = getTaskChangeList(params, 'task_update');
  assert.ok(changes.includes('move to in review'));
  assert.ok(changes.includes('clear due date'));
  assert.ok(changes.includes('clear assignee'));
  const title = getAgentActionPresentation({ action: 'task_update', params }).title;
  assert.match(title, /move to in review/);
  assert.match(title, /clear due date/);
  assert.match(title, /clear assignee/);
});

test('E06: a single simple change keeps the short phrasing', () => {
  assert.equal(
    getAgentActionPresentation({ action: 'update_task_status', params: { task_identifier: 'ENG-1', new_status: 'done' } }).title,
    'Move ENG-1 to done',
  );
});

test('E06: legacy set_due_date to null reads as a clear', () => {
  const title = getAgentActionPresentation({ action: 'set_due_date', params: { task_identifier: 'ENG-2', due_date: null } }).title;
  assert.match(title, /clear due date/);
  assert.match(draftDetails('set_due_date', { task_identifier: 'ENG-2', due_date: null }), /Due: cleared/);
});

test('E06: reminder times keep the time of day and zone', () => {
  const text = formatApprovalDateTime('2026-11-12T15:30:00Z');
  assert.match(text, /2026/);
  assert.match(text, /\d{1,2}:\d{2}/);
  const chips = getAgentActionPresentation({ action: 'create_reminder', params: { content: 'Ping', remind_at: '2026-11-12T15:30:00Z' } }).chips;
  assert.ok(chips.some((chip) => /\d{1,2}:\d{2}/.test(chip.label)), JSON.stringify(chips));
  assert.match(draftDetails('create_reminder', { content: 'Ping', remind_at: '2026-11-12T15:30:00Z' }), /When: .*\d{1,2}:\d{2}/);
});

test('E06: date-only due dates stay calendar dates with the year', () => {
  assert.match(formatApprovalDateTime('2026-07-16'), /2026/);
});

test('E06: task update details show every patched field with clears', () => {
  const details = draftDetails('task_update', { task_id: 'ENG-7', patch: { status: 'in_review', due_date: null, comment: 'Ready' } });
  assert.match(details, /status: in_review/);
  assert.match(details, /due date: cleared/);
  assert.match(details, /Ready/);
});

test('E06: the dashboard agent widget does not approve from a one-line summary', () => {
  const widget = readFileSync(new URL('../app/(app)/dashboard/widgets/agent.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(widget, /approveAgentAction/);
  assert.doesNotMatch(widget, /rejectAgentAction/);
  assert.match(widget, /href="\/inbox"/);
});
