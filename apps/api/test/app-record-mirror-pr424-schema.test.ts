import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// PR #424 review F01: the real (unmocked) reviewed-authority schema. Kept in
// its own file because the sibling test mocks app-record-mirror-authority.
const uuid = () => randomUUID();

test('PR424-F01: the reviewed authority schema accepts an exact record binding and rejects a malformed one', async () => {
  const { ReviewedRecordMirrorAuthoritySchema } = await import('../src/lib/app-record-mirror-authority.js');
  // zod v4 refine() keeps the strict object, so its shape is directly reachable.
  const recordField = (ReviewedRecordMirrorAuthoritySchema as unknown as { shape: Record<string, { safeParse(v: unknown): { success: boolean } } | undefined> }).shape.record_id;
  assert.ok(recordField, 'reviewed authority must declare an optional record_id binding');
  assert.equal(recordField!.safeParse(undefined).success, true, 'store-wide in-app reviews stay valid');
  assert.equal(recordField!.safeParse(uuid()).success, true);
  assert.equal(recordField!.safeParse('not-a-uuid').success, false);
});
