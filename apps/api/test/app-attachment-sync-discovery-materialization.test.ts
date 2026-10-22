import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as zod from 'zod';
import { SyncRequestV2Schema, SyncPageV2Schema } from '@deft/app-kit/core';

const materialize = mock.fn(zod.z.toJSONSchema);
mock.module('zod', { namedExports: { z: { ...zod.z, toJSONSchema: materialize } } });
const { createAttachmentSyncDiscoverySnapshot, createLegacyPrePdfAttachmentSyncDiscoverySnapshot } = await import('../src/lib/app-attachment-sync-discovery.js');

test('static declaration schemas materialize once while each discovery snapshot stays fresh and isolated', async () => {
  const descriptor = JSON.parse(readFileSync(new URL('./fixtures/runtime-security-manifest.json', import.meta.url), 'utf8')).sync_descriptors[0];
  const input = { org_id: randomUUID(), registration_id: randomUUID(), descriptor, captured_at: new Date('2026-10-01T00:00:00Z') };
  const expected = [SyncRequestV2Schema, SyncPageV2Schema].map(schema => JSON.parse(JSON.stringify(zod.z.toJSONSchema(schema, {
    target: 'draft-2020-12', unrepresentable: 'any',
  }))));
    const first = await createAttachmentSyncDiscoverySnapshot(input);
    const second = await createAttachmentSyncDiscoverySnapshot({ ...input, registration_id: randomUUID(), captured_at: new Date('2026-10-02T00:00:00Z') });
    assert.equal(materialize.mock.callCount(), 2, 'immutable schema identities must not be regenerated for each authority read');
    assert.deepEqual(JSON.parse(JSON.stringify(first.operations[0]!.input_schema)), expected[0]);
    assert.deepEqual(JSON.parse(JSON.stringify(first.operations[0]!.output_schema)), expected[1]);
    assert.notEqual(first.snapshot_digest, second.snapshot_digest);
    assert.notStrictEqual(first.operations[0]!.input_schema, second.operations[0]!.input_schema);
    assert.equal(Object.isFrozen(first.operations[0]!.input_schema), true);
    assert.throws(() => { (first.operations[0]!.input_schema as any).properties = {}; }, TypeError);
    const legacy = await createLegacyPrePdfAttachmentSyncDiscoverySnapshot(input);
    assert.notEqual(legacy.snapshot_digest, first.snapshot_digest);
    assert.deepEqual(JSON.parse(JSON.stringify((await createAttachmentSyncDiscoverySnapshot(input)).operations[0]!.input_schema)), expected[0]);
    await assert.rejects(createAttachmentSyncDiscoverySnapshot({ ...input, descriptor: { ...descriptor, key: '../foreign' } }));
    assert.equal(materialize.mock.callCount(), 2);
});
