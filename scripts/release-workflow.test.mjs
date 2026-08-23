import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

function position(label) {
  const index = workflow.indexOf(label);
  assert.notEqual(index, -1, `release workflow is missing: ${label}`);
  return index;
}

test('release publication signs and verifies the exact image digest before creating a release', () => {
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /attestations:\s*write/);
  assert.match(workflow, /IMAGE_REF:\s*\$\{\{ env\.REGISTRY \}\}\/\$\{\{ env\.IMAGE_NAME \}\}@\$\{\{ steps\.digest\.outputs\.digest \}\}/);
  assert.match(workflow, /cosign sign --yes "\$IMAGE_REF"/);
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(workflow, /gh attestation verify "oci:\/\/\$IMAGE_REF" --repo "\$GITHUB_REPOSITORY"/);

  const attest = position('- name: Attest image provenance');
  const sign = position('- name: Sign release image digest');
  const verify = position('- name: Verify signature and provenance');
  const publish = position('- name: Create GitHub release');
  assert.ok(attest < sign && sign < verify && verify < publish);
});

test('manual recovery reuses and verifies the original tag-signed digest', () => {
  assert.match(workflow, /reuse_existing_image:/);
  assert.match(workflow, /Resolve existing signed image digest/);
  assert.match(workflow, /if: steps\.existing\.outputs\.digest == ''/);
  assert.match(workflow, /refs\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(workflow, /"digest": "\$\{\{ steps\.digest\.outputs\.digest \}\}"/);
  assert.match(workflow, /"signature_identity": "\$\{\{ steps\.verification\.outputs\.signature_identity \}\}"/);
});

test('release manifest records signature and provenance metadata', () => {
  assert.match(workflow, /"signature": "sigstore-keyless"/);
  assert.match(workflow, /"signature_identity": "\$\{\{ steps\.verification\.outputs\.signature_identity \}\}"/);
  assert.match(workflow, /"provenance": "github-build-attestation"/);
});

test('release couples the image, package version, and Hermes integration bundle', () => {
  assert.match(workflow, /package\.json version \$package_version does not match release \$version/);
  assert.match(workflow, /DEFT_RELEASE_VERSION=\$\{\{ steps\.release\.outputs\.version \}\}/);
  assert.match(workflow, /node scripts\/build-hermes-integration-bundle\.mjs/);
  assert.match(workflow, /deft-hermes-integration-\$\{\{ steps\.release\.outputs\.version \}\}\.tar\.gz/);
  assert.match(workflow, /"agent_channel_protocol": "deft\.agent_channel\.v2"/);
});
