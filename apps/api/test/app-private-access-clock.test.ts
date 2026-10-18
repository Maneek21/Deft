import assert from 'node:assert/strict';
import test from 'node:test';
import { privateAccessClockBounds } from '../src/lib/app-private-access-clock.js';

test('Private authority uses the upper clock and maximum issuance uses the lower clock', () => {
  let elapsed = 200, app = 1030000;
  const ahead = privateAccessClockBounds(() => new Date(app), app, 1000000, 100, 200, () => elapsed);
  assert.equal(ahead.issuance().getTime(), 1000000);
  assert.equal(ahead.current().getTime(), 1030100);
  elapsed = 1200; app = 900000;
  assert.equal(ahead.current().getTime(), 1031100, 'wall-clock rollback cannot prolong current authority');
  const behind = privateAccessClockBounds(() => new Date(970000), 970000, 1000000, 100, 200, () => 400);
  assert.equal(behind.current().getTime(), 1000300);
  assert.equal(behind.issuance().getTime(), 970000);
  behind.bindDeadline(new Date(1000200));
  assert.equal(behind.expired(), true, 'settled-response delivery must retain the earlier authority deadline');
  assert.equal(ahead.expired(), false, 'another request clock never inherits this deadline');
});
