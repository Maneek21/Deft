import assert from 'node:assert/strict';
import test from 'node:test';

import { parseClipSummaryJson } from '../src/lib/clip-summary.js';

test('parseClipSummaryJson accepts and normalizes the exact clip schema', () => {
  assert.deepEqual(
    parseClipSummaryJson(JSON.stringify({
      tldr: '  A short summary.  ',
      decisions: ['  Ship it  '],
      actions: ['Write tests'],
      blockers: [],
    })),
    {
      tldr: 'A short summary.',
      decisions: ['Ship it'],
      actions: ['Write tests'],
      blockers: [],
    },
  );
});

test('parseClipSummaryJson rejects malformed or shape-confused model output', () => {
  assert.equal(parseClipSummaryJson('not json'), null);
  assert.equal(parseClipSummaryJson(JSON.stringify({
    tldr: 'Summary',
    decisions: [{ text: 'object instead of string' }],
    actions: [],
    blockers: [],
  })), null);
  assert.equal(parseClipSummaryJson(JSON.stringify({
    tldr: 'Summary',
    decisions: [],
    actions: [],
    blockers: [],
    instructions: 'unexpected field',
  })), null);
  assert.equal(parseClipSummaryJson(JSON.stringify({
    tldr: 'Summary',
    decisions: [],
    actions: Array.from({ length: 21 }, (_, index) => `Action ${index}`),
    blockers: [],
  })), null);
});
