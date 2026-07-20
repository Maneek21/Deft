import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundedRequestPriority,
  isBoundedRequestCandidate,
} from '../src/workers/handlers/observe-chat-message.js';

type Candidate = Parameters<typeof isBoundedRequestCandidate>[1];

const request = (overrides: Partial<Candidate> = {}): Candidate => ({
  is_request: true,
  agent_mentioned: false,
  confidence: 0.94,
  requested_action: 'Review the launch copy',
  requested_people: ['Mina'],
  ...overrides,
});

const fixtures: Array<{ content: string; classification: Candidate; expected: boolean }> = [
  { content: 'Mina, please review the launch copy before we send it.', classification: request(), expected: true },
  { content: 'Mina and Ben, can you settle the packaging numbers today?', classification: request({ requested_people: ['Mina', 'Ben'] }), expected: true },
  { content: 'Could Mina confirm whether the route is available?', classification: request({ requested_action: 'Confirm route availability' }), expected: true },
  { content: 'I need Mina to sign off on the buyer note.', classification: request({ requested_action: 'Sign off on the buyer note' }), expected: true },
  { content: 'Mina, the cold-room handoff is blocked until you confirm capacity.', classification: request({ requested_action: 'Confirm cold-room capacity' }), expected: true },
  { content: 'Mina, please send the revised quote. Ben, verify the margin.', classification: request({ requested_people: ['Mina', 'Ben'], requested_action: 'Send the quote and verify margin' }), expected: true },
  { content: 'Can Mina take the first pass and report back?', classification: request({ requested_action: 'Take the first pass and report back' }), expected: true },
  { content: 'Mina, please decide between the two launch dates.', classification: request({ requested_action: 'Choose a launch date' }), expected: true },
  { content: 'We need Mina to acknowledge the safety exception.', classification: request({ requested_action: 'Acknowledge the safety exception' }), expected: true },
  { content: 'Mina, could you answer the buyer before 3pm?', classification: request({ requested_action: 'Answer the buyer' }), expected: true },
  { content: 'Pizza at noon. Mina wants thin crust.', classification: request(), expected: false },
  { content: 'Mina joked that pineapple should be banned from lunch.', classification: request(), expected: false },
  { content: 'Mina owns the launch copy.', classification: request({ is_request: false }), expected: false },
  { content: 'Someone should probably review this.', classification: request({ requested_people: [] }), expected: false },
  { content: 'Mina might review this later.', classification: request({ confidence: 0.7 }), expected: false },
  { content: '@Defty ask Mina to review this.', classification: request({ agent_mentioned: true }), expected: false },
  { content: '<span data-mention-uuid="mina-id">@Mina</span> review this.', classification: request(), expected: false },
  { content: '@here can someone review this?', classification: request({ requested_people: ['Mina'] }), expected: false },
  { content: 'Mina, Ben, Jo, and Lee should review this.', classification: request({ requested_people: ['Mina', 'Ben', 'Jo', 'Lee'] }), expected: false },
  { content: 'Mina discussed the buyer note with Ben.', classification: request({ requested_action: null }), expected: false },
];

test('bounded request gate keeps only concrete human asks', () => {
  const results = fixtures.map((fixture) => isBoundedRequestCandidate(fixture.content, fixture.classification));
  assert.deepEqual(results, fixtures.map((fixture) => fixture.expected));
  const surfaced = fixtures.filter((_, index) => results[index]);
  assert.equal(surfaced.length, 10);
  assert.ok(surfaced.every((fixture) => fixture.expected));
});

test('bounded request urgency follows blockers and four-hour deadlines only', () => {
  const now = new Date('2026-07-20T10:00:00.000Z');
  assert.equal(boundedRequestPriority('Mina, please review this.', '2026-07-20T13:59:00.000Z', now), 'high');
  assert.equal(boundedRequestPriority('Mina, please review this.', '2026-07-20T16:00:00.000Z', now), 'normal');
  assert.equal(boundedRequestPriority('We are blocked until Mina confirms capacity.', null, now), 'high');
  assert.equal(boundedRequestPriority('This is URGENT, Mina.', null, now), 'normal');
});
