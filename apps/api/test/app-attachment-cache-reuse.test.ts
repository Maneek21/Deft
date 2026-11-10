import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AppError } from '../src/lib/app-errors.js';
import { AppConnectionRegistry } from '../src/lib/app-connection-registry.js';
import type { AppConnectionAdapter, AppConnectionProjection } from '../src/lib/app-connection-contract.js';
import { AppExperienceResourceContentService } from '../src/lib/app-experience-resource-content.js';

const caller = { org_id: randomUUID(), user_id: randomUUID(), sid: randomUUID() }, sessionId = randomUUID();
const pins = { org_id: caller.org_id, owner_user_id: caller.user_id, installation_id: randomUUID(), app_version_id: randomUUID(),
  grant_snapshot_id: randomUUID(), target_key: 'personal', resource_key: 'inbox', resource_binding_id: randomUUID(), action_key: null, action_binding_id: null };
const recordId = randomUUID();

/** Path B: the Host built-in attachment panel drives source inspection through
 * the reviewed content service. The retained source digest never changes, so
 * repeated file reads must not repeat authority transactions (PR3 coalescing). */
function fixture() {
  const file = { file_ref: 'f'.repeat(64), filename: 'brief.pdf', media_type: 'application/pdf', size_bytes: 3, disposition: 'attachment' as const, preview: 'unsupported' as const };
  const state = { time: 1000, sourceReads: 0, setupReads: 0, adapterReads: 0,
    source: { installation_id: pins.installation_id, target_key: pins.target_key, resource_binding_id: pins.resource_binding_id,
      exposure_id: randomUUID(), exposure_epoch: 1,
      record: { record_id: recordId, revision: 'current-1', label: 'Private message', data: { id: 'host-retained-logical-id' } } },
    projection: { ...pins, purpose: 'read_source', web_session_id: caller.sid, experience_session_id: sessionId,
      runtime_registration_id: randomUUID(), descriptor_digest: 'sha256:' + '1'.repeat(64), allowed_operations: ['list_summary', 'read_one'],
      content_policy: { source: { media_type: 'message/rfc822', filename: 'message.eml', max_bytes: 8388608 } },
      lifecycle_epoch: 1, grant_epoch: 1, runtime_epoch: 1, checked_at: 1000, expires_at: 61_000 } as { -readonly [K in keyof AppConnectionProjection]: AppConnectionProjection[K] },
    bytes: new TextEncoder().encode('abc'),
  };
  const authority = {
    async sourceRecord(actualCaller: typeof caller, actualSession: string, key: string, id: string) {
      state.sourceReads++;
      if (actualCaller.org_id !== caller.org_id || actualCaller.user_id !== caller.user_id || actualCaller.sid !== caller.sid
        || actualSession !== sessionId || key !== pins.resource_key || id !== recordId) throw new AppError('Source unavailable', 'APP_ACTION_UNAVAILABLE', 409);
      return structuredClone(state.source);
    },
    async connectionSetup(actualCaller: typeof caller, actualSession: string, actualPins: typeof pins, _signal: AbortSignal | undefined, purpose: string) {
      state.setupReads++;
      assert.deepEqual(actualCaller, caller); assert.equal(actualSession, sessionId); assert.deepEqual(actualPins, pins);
      return { ...state.projection, purpose: purpose as AppConnectionProjection['purpose'] };
    },
  };
  const adapter: AppConnectionAdapter = { handle: async () => { assert.fail('Read cannot invoke connection/send handler'); },
    async readSourceFiles(input) { state.adapterReads++; if (input.file_ref) return { files: [file], file_ref: input.file_ref, bytes: state.bytes }; return { files: [file] }; } };
  const registry = new AppConnectionRegistry([{ pins, adapter }]);
  const service = new AppExperienceResourceContentService(authority, async () => registry, () => state.time);
  const read = (operation: 'list_files' | 'read_file') => service.read(caller, sessionId, 'inbox',
    operation === 'list_files' ? { operation, record_id: recordId } : { operation, record_id: recordId, file_ref: file.file_ref });
  return { state, read };
}

test('Path B list_files plus repeated read_file invoke the provider once each with bounded authority work', async () => {
  const f = fixture();
  const list = await f.read('list_files');
  assert.equal(list.kind, 'files');
  assert.equal(f.state.adapterReads, 1, 'list_files performs one provider read');
  assert.equal(f.state.setupReads, 2, 'list_files performs at most two setup reads');
  assert.equal(f.state.sourceReads, 2, 'list_files performs at most two source reads');

  for (let i = 0; i < 3; i++) {
    const out = await f.read('read_file');
    assert.equal(out.kind, 'file');
    if (out.kind === 'file') assert.equal(Buffer.from(out.bytes).toString(), 'abc');
  }
  assert.equal(f.state.adapterReads, 4, 'one provider read per file read');
  assert.equal(f.state.setupReads, 8, 'authority setup work stays bounded at two per read');
  assert.equal(f.state.sourceReads, 8, 'authority source work stays bounded at two per read');
});
