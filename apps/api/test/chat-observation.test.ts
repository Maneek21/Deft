import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { explicitObservationIgnoreReason } from '../src/lib/chat-observation.js';
import { extractExplicitDecision } from '../src/workers/handlers/observe-chat-message.js';

describe('chat observation guardrails', () => {
  test('suppresses explicit no-action messages', () => {
    assert.equal(
      explicitObservationIgnoreReason('No action needed, no task, no memory. Just noting the room is noisy.'),
      'explicit_no_action',
    );
    assert.equal(
      explicitObservationIgnoreReason("Don't save this link; I'm just testing the channel."),
      'explicit_no_action',
    );
    assert.equal(
      explicitObservationIgnoreReason('FYI only: the truck arrived early.'),
      'explicit_no_action',
    );
  });

  test('suppresses low-signal acknowledgements', () => {
    assert.equal(explicitObservationIgnoreReason('ok'), 'low_signal_ack');
    assert.equal(explicitObservationIgnoreReason('Sounds good!'), 'low_signal_ack');
    assert.equal(explicitObservationIgnoreReason('thanks'), 'low_signal_ack');
  });

  test('allows real work, decisions, and resources through', () => {
    assert.equal(explicitObservationIgnoreReason('Please create a task for Lina to check greenhouse humidity.'), null);
    assert.equal(explicitObservationIgnoreReason('Decision: use crate batch TT-42 for the buyer sample.'), null);
    assert.equal(explicitObservationIgnoreReason('Resource: save https://example.com/packing-checklist for launch prep.'), null);
  });

  test('keeps explicit decision context ahead of shorter classifier wording', () => {
    assert.equal(
      extractExplicitDecision(
        'DENSE-EXAMPLE-MARIGOLD-03-DECISION: Decision: for the launch drill around crop quality and greenhouse status, we will use the Tuesday route promise gate before telling buyers launch is green. Save this as team knowledge.',
      ),
      'for the launch drill around crop quality and greenhouse status, we will use the Tuesday route promise gate before telling buyers launch is green',
    );
  });
});
