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
