import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AppRuntimeStartRequestSchema, AppRuntimePayloadReadRequestSchema,
  runtimePayloadHandshakeAllowed, APP_ACTION_PAYLOAD_VERSION } from '../src/lib/app-runtime-contract.js';

const identity = { schema_version: 'deft.app_runtime_channel.v1', session_id: randomUUID(), session_token: 'a'.repeat(43),
  run_id: randomUUID(), attempt_id: randomUUID(), claim_token: 'claimed', sequence: 1 };
const ref = { snapshot_id: randomUUID(), digest: 'a'.repeat(64) };

test('payload Start handshake rejects downgrade and malformed retained pointers while preserving scalar Starts', () => {
  assert(AppRuntimeStartRequestSchema.safeParse(identity).success);
  assert(AppRuntimeStartRequestSchema.safeParse({ ...identity, action_payload_version: APP_ACTION_PAYLOAD_VERSION }).success);
  assert(!AppRuntimeStartRequestSchema.safeParse({ ...identity, action_payload_version: 'deft.app_action_payload.v0' }).success);
  assert(runtimePayloadHandshakeAllowed(undefined, undefined));
  assert(runtimePayloadHandshakeAllowed({ snapshot_id: null, snapshot_digest: null }, undefined));
  const pointer = { snapshot_id: ref.snapshot_id, snapshot_digest: ref.digest };
  assert(!runtimePayloadHandshakeAllowed(pointer, undefined));
  assert(runtimePayloadHandshakeAllowed(pointer, APP_ACTION_PAYLOAD_VERSION));
  assert(!runtimePayloadHandshakeAllowed({ ...pointer, snapshot_digest: null }, APP_ACTION_PAYLOAD_VERSION));
  assert(!runtimePayloadHandshakeAllowed({ ...pointer, snapshot_id: null }, APP_ACTION_PAYLOAD_VERSION));
});

test('payload read admits only exact claimed credentials, opaque snapshot refs and bounded typed parts', () => {
  for (const part of [{ kind: 'metadata' }, { kind: 'bytes' }, { kind: 'file', file_id: randomUUID() }])
    assert(AppRuntimePayloadReadRequestSchema.safeParse({ ...identity, snapshot_ref: ref, part }).success);
  for (const mutation of [{ sequence: 0 }, { snapshot_ref: { ...ref, provider_url: 'https://provider.invalid' } },
    { part: { kind: 'file', file_id: 'guessed' } }, { part: { kind: 'bytes', path: '/private' } },
    { owner_user_id: randomUUID() }, { snapshot_ref: { ...ref, digest: `sha256:${ref.digest}` } }])
    assert(!AppRuntimePayloadReadRequestSchema.safeParse({ ...identity, snapshot_ref: ref, part: { kind: 'bytes' }, ...mutation }).success);
});
