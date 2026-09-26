import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFT_EXPERIENCE_BRIDGE_VERSION, DEFT_EXPERIENCE_RENDERER_VERSION,
  prepareDeftExperienceArtifact, verifyDeftExperienceArtifact,
} from '../src/experience.js';

const bundle = {
  schema_version: 'deft.experience_bundle.v1',
  worker_source: 'self.onmessage = () => postMessage({kind:"view"});',
  entry_view: 'workspace',
  resource_keys: ['records'],
  action_keys: ['create_label'],
} as const;
const path = 'experiences/workspace.json';

test('search requires explicit closed bundle v2 pinned by canonical artifact bytes', async () => {
  const old = await prepareDeftExperienceArtifact(path, bundle);
  assert.equal(old.content, JSON.stringify(bundle));
  await assert.rejects(() => prepareDeftExperienceArtifact(path, { ...bundle, search_resource_keys: ['records'] }));
  await assert.rejects(() => prepareDeftExperienceArtifact(path, { ...bundle, schema_version: 'deft.experience_bundle.v2', search_resource_keys: [] }));
  await assert.rejects(() => prepareDeftExperienceArtifact(path, { ...bundle, schema_version: 'deft.experience_bundle.v2', search_resource_keys: ['foreign'] }));
  const v2 = { ...bundle, schema_version: 'deft.experience_bundle.v2', search_resource_keys: ['records'] };
  const artifact = await prepareDeftExperienceArtifact(path, v2);
  assert.notEqual(artifact.digest, old.digest);
  const reference = { artifact_path: path, artifact_digest: artifact.digest,
    bridge_version: DEFT_EXPERIENCE_BRIDGE_VERSION, renderer_version: DEFT_EXPERIENCE_RENDERER_VERSION };
  assert.deepEqual(await verifyDeftExperienceArtifact(reference, artifact), v2);
  await assert.rejects(() => verifyDeftExperienceArtifact({ ...reference, artifact_digest: old.digest }, artifact));
  await assert.rejects(() => prepareDeftExperienceArtifact(path, { ...v2, schema_version: 'deft.experience_bundle.v3' }));
});

test('canonical Experience artifact verifies its exact path, MIME, length and digest', async () => {
  const artifact = await prepareDeftExperienceArtifact(path, bundle);
  const ref = { artifact_path: path, artifact_digest: artifact.digest,
    bridge_version: DEFT_EXPERIENCE_BRIDGE_VERSION,
    renderer_version: DEFT_EXPERIENCE_RENDERER_VERSION };
  assert.deepEqual(await verifyDeftExperienceArtifact(ref, artifact), bundle);
  await assert.rejects(() => verifyDeftExperienceArtifact(ref, {
    ...artifact, content: artifact.content.replace('workspace', 'wrong_view'),
  }), /mismatch/);
  await assert.rejects(() => verifyDeftExperienceArtifact(ref, {
    ...artifact, media_type: 'text/html',
  }));
  await assert.rejects(() => verifyDeftExperienceArtifact({
    ...ref, artifact_path: 'experiences/other.json',
  }, artifact), /reference mismatch/);
  await assert.rejects(() => verifyDeftExperienceArtifact({
    ...ref, artifact_digest: 'sha256:' + '0'.repeat(64),
  }, artifact), /reference mismatch/);
});

test('Experience bundle rejects unknown fields, traversal, unsorted keys and oversized source', async () => {
  await assert.rejects(() => prepareDeftExperienceArtifact('experiences/../escape.json', bundle));
  await assert.rejects(() => prepareDeftExperienceArtifact(path, { ...bundle, install_script: 'npm run postinstall' }));
  await assert.rejects(() => prepareDeftExperienceArtifact(path, {
    ...bundle, action_keys: ['z_action', 'a_action'],
  }));
  await assert.rejects(() => prepareDeftExperienceArtifact(path, {
    ...bundle, worker_source: 'x'.repeat(65 * 1024),
  }));
});
