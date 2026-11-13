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

const evidenceText = new Map([
  ['task:1', 'MKT-1 Ship the login fix is in progress.'],
  ['message:2', 'Ana in #launch: Project lead approval is required before the launch post goes out.'],
]);

test('grounded parser rejects an approval requirement the cited evidence does not state', () => {
  assert.throws(() => parseGroundedDraft(
    JSON.stringify({ done: [], in_progress: [{ text: 'Project lead approval is required before shipping MKT-1.', source_ids: ['task:1'] }], blocked: [] }),
    standupDraftSchema,
    evidenceText,
  ), /approval/i);
});

test('grounded parser keeps an approval requirement that a cited source states', () => {
  const draft = parseGroundedDraft(
    JSON.stringify({ agenda: [{ text: 'Project lead approval is required before the launch post.', source_ids: ['message:2'] }], decisions: [], updates: [] }),
    meetingPrepDraftSchema,
    evidenceText,
  );
  assert.equal(draft.agenda.length, 1);
});

test('grounded parser rejects a native link that appears only after JSON decoding', () => {
  const raw = '{"done":[],"in_progress":[{"text":"Review [task](\\u002ftasks?task=invented)","source_ids":["task:1"]}],"blocked":[]}';
  assert.ok(!raw.includes('](/tasks'), 'the serialized reply carries no plain link');
  assert.throws(() => parseGroundedDraft(raw, standupDraftSchema, evidenceText), /link/i);
});

test('grounded parser drops items that cite no evidence and keeps cited ones', () => {
  const draft = parseGroundedDraft(
    JSON.stringify({ done: [{ text: 'Uncited claim', source_ids: [] }, { text: 'No ids key' }], in_progress: [{ text: 'MKT-1 is in progress.', source_ids: ['task:1'] }], blocked: [] }),
    standupDraftSchema,
    evidenceText,
  );
  assert.deepEqual(draft.done, []);
  assert.equal(draft.in_progress.length, 1);
});

test('grounded parser rejects a draft whose items all cite no evidence', () => {
  assert.throws(() => parseGroundedDraft(
    JSON.stringify({ done: [{ text: 'Uncited claim', source_ids: [] }], in_progress: [], blocked: [] }),
    standupDraftSchema,
    evidenceText,
  ), /cite/i);
});

for (const link of ['[task](/tasks?task=invented "details")', '[task](</tasks?task=invented>)', 'See [task][1]\n[1]: /tasks?task=invented']) {
  test(`grounded parser rejects a native link written as ${JSON.stringify(link)}`, () => {
    assert.throws(() => parseGroundedDraft(
      JSON.stringify({ done: [], in_progress: [{ text: link, source_ids: ['task:1'] }], blocked: [] }),
      standupDraftSchema,
      evidenceText,
    ), /link/i);
  });
}

test('grounded parser keeps an external link and plain text', () => {
  const draft = parseGroundedDraft(
    JSON.stringify({ done: [], in_progress: [{ text: 'MKT-1 spec: [doc](https://example.com/spec)', source_ids: ['task:1'] }], blocked: [] }),
    standupDraftSchema,
    evidenceText,
  );
  assert.equal(draft.in_progress.length, 1);
});

test('grounded parser accepts a paraphrased approval only for the role the evidence names', () => {
  const evidence = new Map([['message:3', 'Ana: The project lead must give approval before release.']]);
  const item = (text: string) => JSON.stringify({ agenda: [{ text, source_ids: ['message:3'] }], decisions: [], updates: [] });
  assert.equal(parseGroundedDraft(item('Project lead approval is required before release.'), meetingPrepDraftSchema, evidence).agenda.length, 1);
  assert.throws(() => parseGroundedDraft(item('Account manager approval is required before release.'), meetingPrepDraftSchema, evidence), /approval/i);
  assert.throws(() => parseGroundedDraft(item('Project lead approval is required before release.'), meetingPrepDraftSchema, new Set(['message:3'])), /approval/i);
});

test('grounded parser with minItems rejects an empty draft; without it an empty draft stays valid', () => {
  assert.throws(() => parseGroundedDraft('{}', standupDraftSchema, evidenceText, { minItems: 1 }), /cites/i);
  assert.deepEqual(parseGroundedDraft('{}', meetingPrepDraftSchema, evidenceText).agenda, []);
});
