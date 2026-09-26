import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as kit from '@deft/app-kit';
import { appVersions, appGrantSnapshots, orgs, users, orgMembers } from '@deft/db/schema';
import { db } from '../../src/lib/db.js';
import { stageAppPackage } from '../../src/lib/app-service.js';
import { prepareRuntimeAppReview, activateRuntimeApp } from '../../src/lib/app-runtime-review.js';
import { prepareRuntimeBindingReview, activateRuntimeBinding } from '../../src/lib/app-runtime-management.js';
import { stagePublicEndpoint, activatePublicEndpoint } from '../../src/lib/app-public-management.js';
import { humanModuleActor, getModuleInstallation, createModuleRecord } from '../../src/lib/module-service.js';

export async function publicAvailabilityFixture(options: { availability?: boolean; deadlineField?: string } = {}) {
  const suffix = randomUUID().replaceAll('-', '');
  const orgId = randomUUID(), ownerId = randomUUID();
  await db.insert(orgs).values({ id: orgId, name: 'Availability fixture', slug: `availability-${suffix}` });
  await db.insert(users).values({ id: ownerId, name: 'Owner', email: `availability-${suffix}@example.test` });
  await db.insert(orgMembers).values({ id: randomUUID(), org_id: orgId, user_id: ownerId, role: 'owner', is_active: true });
  const owner = humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
  const moduleId = `community.example.slots.a${suffix}`;
  const artifact = await kit.prepareModuleArtifact({ path: 'modules/slots/deft.module.json', manifest: {
    schema_version: '1', id: moduleId, slug: `slots-${suffix}`, version: '1.0.0', name: 'Slots',
    collections: [{ key: 'slots', name: 'Slots', singular_name: 'Slot', fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'starts_at', label: 'Start', type: 'datetime', required: true },
      { key: 'claim_by', label: 'Claim by', type: 'datetime', required: true },
      { key: 'timezone', label: 'Timezone', type: 'text', required: true },
      { key: 'private_note', label: 'Private note', type: 'text', required: true },
    ], views: [{ key: 'all', name: 'All', type: 'table', fields: ['title', 'starts_at'] }],
    search: { title_field: 'title', subtitle_fields: [], fields: ['title'] } }],
    navigation: { default_collection: 'slots', default_view: 'all' },
  } });
  const object = { type: 'object' as const, properties: { resource_id: { type: 'string' as const, maxLength: 120 } },
    required: ['resource_id'], additionalProperties: false as const };
  const policy = { schema_version: 'deft.app_public_availability.v1' as const,
    fields: ['title', 'starts_at', 'timezone'], claim_deadline_field: options.deadlineField ?? 'claim_by', page_size: 10 };
  const pkg = await kit.buildDeftAppPackage({ manifest: {
    schema_version: '4', id: `community.example.booking.a${suffix}`, version: '1.0.0', name: 'Slots fixture',
    license: 'AGPL-3.0-only', compatibility: { app_protocol: '4' },
    modules: [{ module_id: moduleId, version: '1.0.0', manifest_path: artifact.path, manifest_digest: artifact.digest }],
    navigation: [], runtime_requirements: [{ key: 'operator', protocol_version: 'deft.app_runtime_channel.v1' }],
    private_capabilities: [{ key: 'follow_up', version: '1', input_schema: object, output_schema: object }],
    runtime_actions: [{ key: 'follow_up', label: 'Reviewed follow up', capability_key: 'follow_up', runtime_requirement_key: 'operator' }],
    experiences: [], public_actions: [{ key: 'reserve', action_key: 'follow_up', module_id: moduleId,
      collection_key: 'slots', input_mapping: { resource_id: 'claim.resource_id' },
      ...(options.availability === false ? {} : { availability: policy }) }],
  }, artifacts: [artifact] });
  const staged = await stageAppPackage(owner, pkg.json);
  const [version] = await db.select().from(appVersions).where(and(eq(appVersions.org_id, orgId), eq(appVersions.id, staged.version_id)));
  assert.ok(version?.requested_grant_snapshot_id);
  const [requested] = await db.select().from(appGrantSnapshots).where(eq(appGrantSnapshots.id, version.requested_grant_snapshot_id));
  assert.ok(requested);
  const reviewInput = { app_version_id: version.id, expected_package_digest: version.package_digest,
    expected_requested_snapshot_digest: requested.snapshot_digest, expected_lifecycle_epoch: staged.lifecycle_epoch,
    expected_grant_epoch: staged.grant_epoch };
  const review = await prepareRuntimeAppReview(owner, staged.id, reviewInput);
  const active = await activateRuntimeApp(owner, staged.id, { ...reviewInput,
    expected_review_digest: review.review_digest, accept_host_policy: true });
  const [grant] = await db.select().from(appGrantSnapshots).where(eq(appGrantSnapshots.id, active.grant_snapshot_id)); assert.ok(grant);
  const bindingInput = { installation_id: staged.id, action_key: 'follow_up', operator_user_id: ownerId,
    expected_app_version_id: version.id, expected_package_digest: version.package_digest,
    expected_grant_snapshot_digest: grant.snapshot_digest, expected_lifecycle_epoch: active.installation.lifecycle_epoch,
    expected_grant_epoch: active.installation.grant_epoch };
  const bindingReview = await prepareRuntimeBindingReview(owner, bindingInput);
  const binding = await activateRuntimeBinding(owner, { ...bindingInput,
    expected_review_digest: bindingReview.review_digest, accept_host_policy: true });
  const endpointInput = { installation_id: staged.id, public_action_key: 'reserve', runtime_binding_id: binding.binding_id,
    approver_user_id: ownerId, public_label: 'Reserve a slot', max_body_bytes: 1024, expected_app_version_id: version.id,
    expected_grant_snapshot_id: grant.id, expected_lifecycle_epoch: active.installation.lifecycle_epoch,
    expected_grant_epoch: active.installation.grant_epoch };
  const endpoint = await stagePublicEndpoint(owner, endpointInput);
  await activatePublicEndpoint(owner, endpoint.endpoint_id, { expected_review_digest: endpoint.review_digest,
    expected_endpoint_epoch: endpoint.endpoint_epoch, accept_host_policy: true });
  const module = await getModuleInstallation(owner, { moduleId });
  async function record(title: string, deadline = new Date(Date.now() + 60_000).toISOString(),
    startsAt = new Date(Date.now() + 3_600_000).toISOString()) {
    const result = await createModuleRecord(owner, { module_id: moduleId, collection_key: 'slots',
      data: { title, starts_at: startsAt, claim_by: deadline, timezone: 'America/New_York', private_note: 'NEVER PUBLIC' },
      relations: {}, expected_manifest_digest: module.manifest_digest, idempotency_key: randomUUID() });
    assert.ok(result.record); return result.record;
  }
  const body = (recordId: string, revision: number, key = randomUUID()) => Buffer.from(JSON.stringify({
    resource_ref: { schema_version: 'deft.resource_ref.v1', provider: { kind: 'module', provider_instance_id: module.id },
      resource_type: 'slots', resource_id: recordId }, expected_revision: revision, idempotency_key: key }));
  return { owner, orgId, module, record, body, endpoint, endpointInput, pkg };
}
