import assert from 'node:assert/strict';
import test from 'node:test';
import { DeftExperienceResourceDocumentNodeSchema, DeftExperienceRichtextFieldProfileSchema,
  DeftExperienceFileFieldProfileSchema, DeftExperienceFileReferenceSchema,
  DeftExperienceResourceRefreshRequestSchema, DeftExperienceResourceFreshnessSchema,
  negotiateDeftExperienceCapabilities } from '../src/experience-capabilities.js';
import { createDeftResourceDocumentNode } from '../src/experience-sdk.js';

const record = '11111111-1111-4111-8111-111111111111';
const reference = { id: 'body', resource_key: 'messages', record_id: record };
test('resource documents carry existing opaque IDs and require negotiated profiles', () => {
  const node = createDeftResourceDocumentNode(reference, ['resource_document.v1']);
  assert.deepEqual(DeftExperienceResourceDocumentNodeSchema.parse(node), { kind: 'resource_document',
    profile_version: 'deft.resource_document.v1', ...reference });
  assert.throws(() => createDeftResourceDocumentNode(reference, []), /CAPABILITY_UNAVAILABLE/);
  for (const record_id of ['provider-id', 'https://mail.test/message', 'bearer-token']) {
    assert.throws(() => createDeftResourceDocumentNode({ ...reference, record_id }, ['resource_document.v1']));
    assert.equal(DeftExperienceResourceDocumentNodeSchema.safeParse({ ...node, record_id }).success, false);
  }
  for (const extra of [{ url: 'https://mail.test' }, { token: 'secret' }, { content: '<p>body</p>' }, { images: [] }]) {
    assert.equal(DeftExperienceResourceDocumentNodeSchema.safeParse({ ...node, ...extra }).success, false);
    assert.throws(() => createDeftResourceDocumentNode({ ...reference, ...extra }, ['resource_document.v1']));
  }
  assert.equal(DeftExperienceResourceDocumentNodeSchema.safeParse({ ...node, print_control_id: 'print' }).success, false);
});

test('negotiation distinguishes declared requirements from host implementation', () => {
  const host = { schema_version: 'deft.experience_capabilities.v1', view_version: 'deft.experience_view.v2', capabilities: ['resource_document.v1'] };
  const request = { schema_version: host.schema_version, view_version: host.view_version,
    required: ['resource_document.v1'], optional: ['resource_refresh.v1', 'richtext_field.v1'] };
  assert.deepEqual(negotiateDeftExperienceCapabilities(request, host), host);
  assert.throws(() => negotiateDeftExperienceCapabilities({ ...request, required: ['resource_refresh.v1'], optional: [] }, host), /CAPABILITY_UNAVAILABLE/);
  assert.throws(() => negotiateDeftExperienceCapabilities({ ...request, view_version: 'deft.experience_view.v99' }, host));
  assert.throws(() => negotiateDeftExperienceCapabilities({ ...request, optional: ['resource_document.v1'] }, host));
});

test('richtext and file declarations enforce reviewed bounds and reject authority flags', () => {
  const text = { profile_version: 'deft.richtext_field.v1', format: 'safe_compose_html',
    max_characters: 256 * 1024, max_bytes: 480 * 1024, links: 'host_validated', inline_images: 'host_files' };
  assert.equal(DeftExperienceRichtextFieldProfileSchema.safeParse(text).success, true);
  for (const extra of [{ max_characters: text.max_characters + 1 }, { max_bytes: text.max_bytes + 1 }, { nativeLinks: true }, { max_characters: 0 }]) {
    assert.equal(DeftExperienceRichtextFieldProfileSchema.safeParse({ ...text, ...extra }).success, false);
  }
  const files = { profile_version: 'deft.file_field.v1', max_files: 32, max_file_bytes: 25 * 1024 * 1024,
    max_total_bytes: 25 * 1024 * 1024, purpose: 'attachment' };
  assert.equal(DeftExperienceFileFieldProfileSchema.safeParse(files).success, true);
  for (const extra of [{ max_files: 33 }, { max_total_bytes: files.max_total_bytes + 1 }, { max_total_bytes: 100 }, { upload_url: 'https://test' }]) {
    assert.equal(DeftExperienceFileFieldProfileSchema.safeParse({ ...files, ...extra }).success, false);
  }
  assert.equal(DeftExperienceFileReferenceSchema.safeParse({ file_id: record }).success, true);
  assert.equal(DeftExperienceFileReferenceSchema.safeParse({ file_id: record, url: 'https://test' }).success, false);
});

test('refresh and freshness are closed contracts and cannot report unknown observations as current', () => {
  assert.equal(DeftExperienceResourceRefreshRequestSchema.safeParse({ schema_version: 'deft.experience_resource_refresh.v1', operation: 'refresh', record_id: record }).success, true);
  assert.equal(DeftExperienceResourceRefreshRequestSchema.safeParse({ schema_version: 'deft.experience_resource_refresh.v1', operation: 'read_one' }).success, false);
  const freshness = { schema_version: 'deft.experience_resource_freshness.v1', status: 'unknown', observed_at: null, revision: null };
  assert.equal(DeftExperienceResourceFreshnessSchema.safeParse(freshness).success, true);
  assert.equal(DeftExperienceResourceFreshnessSchema.safeParse({ ...freshness, status: 'current' }).success, false);
  assert.equal(DeftExperienceResourceFreshnessSchema.safeParse({ ...freshness, status: 'current', observed_at: '2026-10-09T00:00:00Z' }).success, true);
});
