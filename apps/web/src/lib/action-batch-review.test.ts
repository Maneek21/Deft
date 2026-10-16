import test from 'node:test';
import assert from 'node:assert/strict';
import { batchFieldText, readBatchReview, readBatchStatus, visibleBatchItems } from './action-batch-review';

const status = { batch: { id: 'batch-id', title: 'Saved actions', state: 'pending_approval', runtime_binding_id: 'binding-id', item_count: 1, review_url: '/apps/action-batches/batch-id' },
  items: [{ key: 'one', label: 'First action', run_id: 'run-id', state: 'pending_approval' }] };
const review = { ...status, ticket: 'opaque-ticket', digest: 'saved-digest', expires_at: new Date(Date.now() + 60_000).toISOString(), app_label: 'Provider', action_label: 'Declared action',
  items: [{ ...status.items[0], input: { recipient: ['one@example.test'], content: '<script>untrusted</script>', extra: { nested: true } } }] };

test('review preserves every execution input and binds the requested batch', () => {
  assert.deepEqual(readBatchReview(review, 'batch-id').items[0].input, review.items[0].input);
  assert.throws(() => readBatchReview(review, 'another-batch'));
  assert.equal(batchFieldText(review.items[0].input.content), '<script>untrusted</script>');
  assert.equal(batchFieldText(review.items[0].input.extra), '{\n  "nested": true\n}');
});

test('review fails closed for missing input, expired ticket, mismatched count and excessive items', () => {
  for (const invalid of [status, { ...review, expires_at: new Date(0).toISOString() },
    { ...review, items: status.items }, { ...review, batch: { ...status.batch, item_count: 2 } },
    { ...review, items: Array.from({ length: 11 }, (_, index) => ({ ...review.items[0], key: String(index) })), batch: { ...status.batch, item_count: 11 } }]) {
    assert.throws(() => readBatchReview(invalid, 'batch-id'));
  }
});

test('status strips execution inputs and rejects unknown or duplicated item states', () => {
  assert.equal(readBatchStatus(review, 'batch-id').items[0].input, undefined);
  assert.throws(() => readBatchStatus({ ...status, items: [{ ...status.items[0], state: 'invented' }] }, 'batch-id'));
  assert.throws(() => readBatchStatus({ ...status, batch: { ...status.batch, item_count: 2 }, items: [status.items[0], status.items[0]] }, 'batch-id'));
});

test('private inputs are only visible with a current review and disappear on expiry or cleared authority', () => {
  const parsed = readBatchReview(review, 'batch-id');
  assert.deepEqual(visibleBatchItems(parsed, parsed, Date.now())[0].input, review.items[0].input);
  assert.equal(visibleBatchItems(parsed, parsed, Date.parse(parsed.expires_at))[0].input, undefined);
  assert.equal(visibleBatchItems(null, parsed, Date.now())[0].input, undefined);
  assert.deepEqual(visibleBatchItems(null, null, Date.now()), []);
});
