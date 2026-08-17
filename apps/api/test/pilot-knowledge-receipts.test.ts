import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPilotKnowledgeReceiptPlan,
  isReusablePilotProofMessage,
  PILOT_SIMULATED_HISTORY_METADATA,
  pilotCitationIdentity,
  pilotProofMessageMetadata,
  type PilotKnowledgePageRef,
  type PilotMessageRef,
} from '../src/scripts/pilot-knowledge-receipts.js';

const proofPhrase = 'ruby-sunrise-2026';
const proofContent = `Use ${proofPhrase} as the proof marker.`;

function message(overrides: Partial<PilotMessageRef> = {}): PilotMessageRef {
  return {
    id: 'message-proof',
    org_id: 'org-pilot',
    space_id: 'space-marketing',
    user_id: 'user-diego',
    content: proofContent,
    is_deleted: false,
    metadata: {
      seed: 'pilot-polish',
      knowledge_marker: proofPhrase,
    },
    created_at: new Date('2026-08-17T04:00:00.000Z'),
    ...overrides,
  };
}

const expectedProof = {
  orgId: 'org-pilot',
  spaceId: 'space-marketing',
  userId: 'user-diego',
  content: proofContent,
  proofPhrase,
};

test('pilot proof reuse requires active, correctly attributed seed evidence', () => {
  assert.equal(isReusablePilotProofMessage(message(), expectedProof), true);

  const rejected: PilotMessageRef[] = [
    message({ is_deleted: true }),
    message({ org_id: 'org-other' }),
    message({ space_id: 'space-other' }),
    message({ user_id: 'user-other' }),
    message({ content: 'same idea, different evidence' }),
    message({ metadata: { seed: 'pilot-polish', knowledge_marker: 'wrong-marker' } }),
    message({ metadata: { seed: 'user-authored', knowledge_marker: proofPhrase } }),
    message({ metadata: null }),
  ];

  for (const candidate of rejected) {
    assert.equal(isReusablePilotProofMessage(candidate, expectedProof), false);
  }
});

test('pilot proof metadata labels the record as simulated demo history', () => {
  assert.deepEqual(pilotProofMessageMetadata(proofPhrase), {
    seed: 'pilot-polish',
    knowledge_marker: proofPhrase,
    ...PILOT_SIMULATED_HISTORY_METADATA,
  });
});

function receiptSources(): Parameters<typeof buildPilotKnowledgeReceiptPlan>[0]['sources'] {
  const base = message();
  return {
    pilotProof: base,
    marketingDecision: message({ id: 'message-marketing-decision', created_at: new Date('2026-08-17T01:00:00.000Z') }),
    blockerMessage: message({ id: 'message-blocker', user_id: 'user-lina', created_at: new Date('2026-08-17T01:30:00.000Z') }),
    opsUpdate: message({ id: 'message-ops', space_id: 'space-ops', user_id: 'user-tomas', created_at: new Date('2026-08-17T02:00:00.000Z') }),
    buyerUpdate: message({ id: 'message-buyer', space_id: 'space-buyers', user_id: 'user-maya', created_at: new Date('2026-08-17T02:30:00.000Z') }),
    fieldUpdate: message({ id: 'message-field', space_id: 'space-field', user_id: 'user-marigold', created_at: new Date('2026-08-17T03:00:00.000Z') }),
  };
}

const pages: PilotKnowledgePageRef[] = [
  { id: 'page-proof', slug: 'company-memory-proof-protocol', title: 'Company Memory Proof Protocol', type: 'resource' },
  { id: 'page-launch', slug: 'sun-gold-trial-launch-decision', title: 'Sun Gold Trial Launch Decision', type: 'decision' },
  { id: 'page-route', slug: 'tuesday-route-promise-gate', title: 'Tuesday Route Promise Gate', type: 'decision' },
  { id: 'page-amara', slug: 'chef-amara-account-brief', title: 'Chef Amara Account Brief', type: 'resource' },
  { id: 'page-cold-room', slug: 'cold-room-handoff-sop', title: 'Cold-room Handoff SOP', type: 'resource' },
];

test('receipt plan is deterministic, uniquely keyed, and explicit about simulated history', () => {
  const input = {
    orgId: 'org-pilot',
    convertedBy: 'user-diego',
    sources: receiptSources(),
    pages,
  };
  const first = buildPilotKnowledgeReceiptPlan(input);
  const retry = buildPilotKnowledgeReceiptPlan(input);

  assert.deepEqual(retry, first);
  assert.deepEqual(first.missingSlugs, []);
  assert.equal(first.intentRows.length, 6);
  assert.equal(first.citationRows.length, 6);
  assert.equal(new Set(first.intentRows.map((row) => row.dedupe_key)).size, 6);
  assert.equal(new Set(first.citationRows.map(pilotCitationIdentity)).size, 6);

  for (const row of first.intentRows) {
    assert.equal(row.metadata.simulated_history, true);
    assert.equal(row.metadata.simulation_source, 'seed-pilot-workspace');
    assert.equal(row.created_at, row.converted_at);
    assert.equal(row.updated_at, row.converted_at);
  }
});

test('receipt plan reports missing target pages once per slug', () => {
  const plan = buildPilotKnowledgeReceiptPlan({
    orgId: 'org-pilot',
    convertedBy: 'user-diego',
    sources: receiptSources(),
    pages: pages.filter((page) => page.slug !== 'tuesday-route-promise-gate'),
  });

  assert.deepEqual(plan.missingSlugs, ['tuesday-route-promise-gate']);
  assert.equal(plan.intentRows.length, 4);
  assert.equal(plan.citationRows.length, 4);
});
