import assert from 'node:assert/strict';
import test from 'node:test';
import {
  meetingPrepDraftSchema,
  parseGroundedDraft,
  renderMeetingPrepDraft,
  renderStandupDraft,
  standupDraftSchema,
} from '../src/lib/automation-synthesis.js';
import { createEventSchema } from '../src/routes/events.js';

test('grounded standup accepts only known evidence references', () => {
  const draft = parseGroundedDraft(
    JSON.stringify({
      done: [{ text: 'MKT-12 shipped by Lina.', source_ids: ['task:12'] }],
      in_progress: [],
      blocked: [],
    }),
    standupDraftSchema,
    new Set(['task:12']),
  );
  assert.equal(draft.done[0]?.text, 'MKT-12 shipped by Lina.');
});

test('grounded standup rejects invented sources', () => {
  assert.throws(() => parseGroundedDraft(
    JSON.stringify({
      done: [{ text: 'Alice completed the launch.', source_ids: ['task:invented'] }],
      in_progress: [],
      blocked: [],
    }),
    standupDraftSchema,
    new Set(['task:real']),
  ), /unknown source/);
});

test('grounded parser tolerates fenced JSON but rejects prose', () => {
  const draft = parseGroundedDraft(
    '```json\n{"done":[],"in_progress":[],"blocked":[]}\n```',
    standupDraftSchema,
    new Set(),
  );
  assert.deepEqual(draft.done, []);
  assert.throws(() => parseGroundedDraft('Here is your summary', standupDraftSchema, new Set()));
});

test('renderers produce stable empty and structured states', () => {
  assert.equal(
    renderStandupDraft({ done: [], in_progress: [], blocked: [] }),
    '- No significant work activity was recorded in the last 24 hours.',
  );
  const meeting = renderMeetingPrepDraft('Launch review', {
    agenda: [{ text: 'Review MKT-2.', source_ids: ['task:2'] }],
    decisions: [],
    updates: [],
  });
  assert.match(meeting, /Meeting prep: Launch review/);
  assert.match(meeting, /Review MKT-2/);
  assert.doesNotMatch(meeting, /Decide/);
});

test('meeting prep schema rejects oversized or malformed output', () => {
  assert.throws(() => meetingPrepDraftSchema.parse({
    agenda: Array.from({ length: 5 }, () => ({ text: 'Too many', source_ids: [] })),
    decisions: [],
    updates: [],
  }));
});

test('agent synthesis can safely cap extra grounded items before validation', () => {
  const item = (index: number) => ({ text: `Agenda ${index}`, source_ids: ['event:1'] });
  const parsed = parseGroundedDraft(
    JSON.stringify({ agenda: [1, 2, 3, 4, 5].map(item), decisions: [], updates: [] }),
    meetingPrepDraftSchema,
    new Set(['event:1']),
    { sectionLimits: { agenda: 4, decisions: 4, updates: 4 } },
  );
  assert.equal(parsed.agenda.length, 4);
});

test('native event contract preserves normalized attendees', () => {
  const parsed = createEventSchema.parse({
    title: 'Buyer review',
    start: '2026-07-18T09:00:00.000Z',
    end: '2026-07-18T09:30:00.000Z',
    metadata: {
      attendees: [{ email: 'lina@example.com', name: 'Lina' }],
    },
  });
  assert.equal(parsed.metadata?.attendees?.[0]?.email, 'lina@example.com');
  assert.equal(parsed.metadata?.attendees?.[0]?.name, 'Lina');
});

const sourceIds = new Set(['task:1', 'message:2']);
const backslash = String.fromCharCode(92);
const newline = String.fromCharCode(10);
const standupDraft = (items: Array<{ text: string; source_ids?: string[] }>) => JSON.stringify({ done: [], in_progress: items, blocked: [] });

const linkConstructs = [
  '[task](/tasks?task=invented "details")',
  '[task](</tasks?task=invented>)',
  '[spec](https://example.com/spec)',
  `See [task][1]${newline}[1]: /tasks?task=invented`,
  `See [task][r]${newline}${newline}> [r]: &#47;tasks?task=invented`,
  `- [r]: /tasks`,
  '[task](&#47;tasks?task=invented)',
  '&lsqb;task&rsqb;&lpar;/tasks&rpar;',
  '&#91;task&#93;&#40;/tasks&#41;',
  '<https://workspace.example/tasks?task=invented>',
  '&lt;https://workspace.example/tasks&gt;',
  '<www.example.com>',
  'Open https://workspace.example/tasks?task=invented',
  '<a href="/tasks">task</a>',
  '<img src="https://example.com/x.png">',
  '[task](https://workspace.example/a(b)/../tasks?task=invented)',
  `[task](${backslash}/tasks?task=invented)`,
];
for (const link of linkConstructs) {
  test(`grounded parser rejects the link construct ${JSON.stringify(link)}`, () => {
    assert.throws(() => parseGroundedDraft(standupDraft([{ text: link, source_ids: ['task:1'] }]), standupDraftSchema, sourceIds), /link/i);
  });
}

test('grounded parser rejects a link that appears only after JSON decoding', () => {
  const raw = `{"in_progress":[{"text":"Review [task](${backslash}u002ftasks?task=invented)","source_ids":["task:1"]}]}`;
  assert.ok(!raw.includes('](/tasks'), 'the serialized reply carries no plain link');
  assert.throws(() => parseGroundedDraft(raw, standupDraftSchema, sourceIds), /link/i);
});

for (const claim of [
  'Project lead approval is required before shipping MKT-1.',
  'Approval from Dr. Smith is required.',
  `Approval:${newline}Required before launch.`,
  'The release must be signed off by Lina.',
  'Lina will sign off on the release.',
  'Appr&#111;val is required before launch.',
  'Ana approved the launch plan.',
  'No approval is required for MKT-1.',
]) {
  test(`grounded parser rejects an item that mentions approval: ${JSON.stringify(claim)}`, () => {
    assert.throws(() => parseGroundedDraft(standupDraft([{ text: claim, source_ids: ['task:1'] }]), standupDraftSchema, sourceIds), /approval/i);
  });
}

test('grounded parser keeps plain cited progress, including brackets and entities that form no link', () => {
  const draft = parseGroundedDraft(standupDraft([
    { text: 'MKT-1 is in progress with Lina.', source_ids: ['task:1'] },
    { text: '[Draft] launch notes &amp; checklist are 80% done (2 of 3).', source_ids: ['message:2'] },
  ]), standupDraftSchema, sourceIds);
  assert.equal(draft.in_progress.length, 2);
});

test('grounded parser drops uncited items before the section caps', () => {
  const uncited = Array.from({ length: 5 }, (_, index) => ({ text: `Uncited ${index}`, source_ids: [] }));
  const draft = parseGroundedDraft(
    standupDraft([...uncited, { text: 'No ids key' }, { text: 'MKT-1 is in progress.', source_ids: ['task:1'] }]),
    standupDraftSchema,
    sourceIds,
    { sectionLimits: { done: 5, in_progress: 5, blocked: 5 } },
  );
  assert.deepEqual(draft.in_progress.map((item) => item.text), ['MKT-1 is in progress.']);
});

test('grounded parser rejects a draft whose items all cite no evidence, and an empty draft when items are required', () => {
  assert.throws(() => parseGroundedDraft(standupDraft([{ text: 'Uncited claim', source_ids: [] }]), standupDraftSchema, sourceIds), /cites/i);
  assert.throws(() => parseGroundedDraft('{}', standupDraftSchema, sourceIds, { minItems: 1 }), /cites/i);
  assert.deepEqual(parseGroundedDraft('{}', meetingPrepDraftSchema, sourceIds).agenda, []);
});
