import { randomUUID } from 'node:crypto';
import type { SyncDescriptorV1 } from '@deft/app-kit/experimental/resource-sync';
import type { AppRunKeyProvider } from '../../src/lib/app-run-keyrings.js';
import type { DeftExperienceArtifact } from '@deft/app-kit';

const defaultDescriptor: SyncDescriptorV1 = {
  schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox',
  runtime_requirement_key: 'provider', resource_type: 'email_message',
  requested_visibility: 'user_private', label_field: 'subject',
  record_schema: { type: 'object', properties: {
    subject: { type: 'string', maxLength: 200 },
  }, required: ['subject'], additionalProperties: false },
};

/** Real synthetic authoring→App review→private consent fixture. The caller
 * configures feature flags before calling and owns its DB pool/keyring. */
export async function createReviewedResourceSyncFixture(input: Readonly<{
  keys: AppRunKeyProvider; clock: () => Date; descriptor?: SyncDescriptorV1;
  experience_artifact?: DeftExperienceArtifact;
  consent_duration_ms?: number;
}>) {
  const [{ db }, schema, kit, apps, reviews, modules, managementModule, drizzle] = await Promise.all([
    import('../../src/lib/db.js'), import('@deft/db/schema'), import('@deft/app-kit'),
    import('../../src/lib/app-service.js'), import('../../src/lib/app-runtime-review.js'),
    import('../../src/lib/module-service.js'), import('../../src/lib/app-resource-sync-management.js'),
    import('drizzle-orm'),
  ]);
  const suffix = randomUUID().replaceAll('-', '');
  const orgId = randomUUID();
  const ownerId = randomUUID();
  const operatorId = randomUUID();
  const descriptor = input.descriptor ?? defaultDescriptor;
  await db.insert(schema.orgs).values({ id: orgId, name: 'Private sync consent fixture',
    slug: `private-sync-${suffix}` });
  await db.insert(schema.users).values([
    { id: ownerId, name: 'Private sync owner', email: `sync-owner-${suffix}@example.test` },
    { id: operatorId, name: 'Runtime operator', email: `sync-operator-${suffix}@example.test` },
  ]);
  await db.insert(schema.orgMembers).values([
    { id: randomUUID(), org_id: orgId, user_id: ownerId, role: 'owner', is_active: true },
    { id: randomUUID(), org_id: orgId, user_id: operatorId, role: 'member', is_active: true },
  ]);
  const ownerActor = modules.humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
  const operatorActor = modules.humanModuleActor({ orgId, userId: operatorId, role: 'member', source: 'rest' });
  const manifest = { schema_version: '5' as const,
    id: `community.example.private-sync.a${suffix}`, version: '1.0.0',
    name: 'Private sync fixture', license: 'AGPL-3.0-only',
    compatibility: { app_protocol: '5' as const }, modules: [], navigation: [],
    runtime_requirements: [{ key: descriptor.runtime_requirement_key,
      protocol_version: 'deft.app_runtime_channel.v2' as const }],
    private_capabilities: [], runtime_actions: [], sync_descriptors: [descriptor],
    experiences: input.experience_artifact ? [{ key: 'main', label: 'Saved private records',
      artifact_path: input.experience_artifact.path, artifact_digest: input.experience_artifact.digest,
      bridge_version: 'deft.experience_bridge.v1' as const, renderer_version: 'deft.trusted_renderer.v1' as const }] : [], public_actions: [],
  };
  const pkg = await kit.buildDeftAppPackage({ manifest, artifacts: input.experience_artifact ? [input.experience_artifact] : [] });
  const staged = await apps.stageAppPackage(ownerActor, pkg.json);
  const [version] = await db.select().from(schema.appVersions).where(drizzle.and(
    drizzle.eq(schema.appVersions.org_id, orgId),
    drizzle.eq(schema.appVersions.id, staged.version_id)));
  if (!version?.requested_grant_snapshot_id) throw new Error('Fixture staging omitted requested grant');
  const [requested] = await db.select().from(schema.appGrantSnapshots).where(drizzle.and(
    drizzle.eq(schema.appGrantSnapshots.org_id, orgId),
    drizzle.eq(schema.appGrantSnapshots.id, version.requested_grant_snapshot_id)));
  if (!requested) throw new Error('Fixture requested grant unavailable');
  const appRequest = { app_version_id: version.id,
    expected_package_digest: version.package_digest,
    expected_requested_snapshot_digest: requested.snapshot_digest,
    expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch };
  const appReview = await reviews.prepareRuntimeAppReview(ownerActor, staged.id, appRequest);
  const activated = await reviews.activateRuntimeApp(ownerActor, staged.id, {
    ...appRequest, expected_review_digest: appReview.review_digest, accept_host_policy: true });
  const [grant] = await db.select().from(schema.appGrantSnapshots).where(drizzle.and(
    drizzle.eq(schema.appGrantSnapshots.org_id, orgId),
    drizzle.eq(schema.appGrantSnapshots.id, activated.grant_snapshot_id)));
  if (!grant) throw new Error('Fixture effective grant unavailable');
  const management = new managementModule.AppResourceSyncManagement(input.keys, input.clock);
  const consentRequest = { installation_id: staged.id, resource_key: descriptor.key,
    operator_user_id: operatorId, expected_app_version_id: version.id,
    expected_package_digest: version.package_digest,
    expected_grant_snapshot_digest: grant.snapshot_digest,
    expected_lifecycle_epoch: activated.installation.lifecycle_epoch,
    expected_grant_epoch: activated.installation.grant_epoch,
    consent_expires_at: new Date(input.clock().getTime() + (input.consent_duration_ms ?? 60 * 60 * 1_000)).toISOString(),
    limits: { max_records_per_page: 100, max_page_bytes: 524_288,
      max_retained_records: 100_000, max_retained_bytes: 1_073_741_824,
      min_interval_seconds: 60 },
  };
  const consentReview = await management.prepareConsent(ownerActor, consentRequest);
  const consent = await management.activateConsent(ownerActor, { ...consentRequest,
    expected_review_digest: consentReview.review_digest, accept_host_policy: true });
  return Object.freeze({ org_id: orgId, owner_user_id: ownerId,
    operator_user_id: operatorId, owner_actor: ownerActor, operator_actor: operatorActor,
    installation_id: staged.id, app_version_id: version.id,
    grant_snapshot_id: grant.id, registration_id: consent.registration_id,
    binding_id: consent.binding_id, checkpoint_id: consent.checkpoint_id,
    descriptor, management, consent_request: consentRequest, consent_review: consentReview });
}
