import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeftyStarterCta } from './starter-cards';

test('E12: the Defty starter card is dismissed only after the DM opened', async () => {
  let dismissed = 0;
  assert.equal(await runDeftyStarterCta(async () => true, () => { dismissed++; }), true);
  assert.equal(dismissed, 1);
});

test('E12: the Defty starter card stays when the DM did not open or the open failed', async () => {
  let dismissed = 0;
  assert.equal(await runDeftyStarterCta(async () => false, () => { dismissed++; }), false);
  assert.equal(await runDeftyStarterCta(async () => { throw new Error('offline'); }, () => { dismissed++; }), false);
  assert.equal(dismissed, 0);
});
