import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeftAppPackage, buildDeftAppRequestedAuthorityReport, diffDeftAppRequestedAuthority,
  NATIVE_CALENDAR_CONTRACTS, parseDeftAppManifest, parseNativeCalendarInput, parseNativeAppManifest,
  prepareDeftExperienceArtifact, verifyDeftAppPackageJson,
  DEFT_EXPERIENCE_BRIDGE_VERSION, DEFT_EXPERIENCE_RENDERER_VERSION,
} from '../dist/index.js';

const create = NATIVE_CALENDAR_CONTRACTS['calendar.events.create.v1'];
const base = {
  schema_version: '6' as const, id: 'community.example.booking-native', version: '1.0.0',
  name: 'Booking', license: 'AGPL-3.0-only', compatibility: { app_protocol: '6' as const },
  modules: [], navigation: [], runtime_requirements: [], runtime_actions: [], sync_descriptors: [],
  private_capabilities: [{ key: 'calendar_create', version: '1' as const, ...create }],
  native_actions: [{ key: 'create_event', label: 'Create Calendar event', capability_key: 'calendar_create',
    operation: 'calendar.events.create.v1' as const }], experiences: [], public_actions: [],
};

test('native-only v6 packs a real Experience with declared native keys and requested-only authority', async () => {
  const artifact = await prepareDeftExperienceArtifact('experiences/booking.json', {
    schema_version: 'deft.experience_bundle.v1', worker_source: 'self.onmessage = () => {};', entry_view: 'booking',
    resource_keys: [], action_keys: ['create_event'],
  });
  const manifest = { ...base, experiences: [{ key: 'booking', label: 'Booking', artifact_path: artifact.path,
    artifact_digest: artifact.digest, bridge_version: DEFT_EXPERIENCE_BRIDGE_VERSION, renderer_version: DEFT_EXPERIENCE_RENDERER_VERSION }] };
  const built = await buildDeftAppPackage({ manifest, artifacts: [artifact] });
  assert.equal(built.package.package_format, 'deft.app.package.v6');
  assert.deepEqual(await verifyDeftAppPackageJson(built.json), built);
  assert.equal(parseNativeAppManifest(manifest).native_actions[0]?.operation, 'calendar.events.create.v1');
  const report = buildDeftAppRequestedAuthorityReport(manifest);
  assert.equal(report.schema, 'deft.app.requested_authority.v6');
  assert.equal(report.requested_authority.classification.executable, false);
  assert.equal(report.requested_authority.classification.provider_access, false);
  const widened = { ...manifest, native_actions: [{ ...manifest.native_actions[0]!, label: 'Changed review label' }] };
  assert.deepEqual((await diffDeftAppRequestedAuthority({ prior: manifest, proposed: widened })).changed_atoms, ['actions']);
});

test('v6 mixed planes remain disjoint and reject authority fields, uncertified pairs and old-version native claims', () => {
  const scalar = { type: 'object' as const, properties: { id: { type: 'string' as const, maxLength: 100 } },
    required: ['id'], additionalProperties: false as const };
  const mixed = { ...base, runtime_requirements: [{ key: 'writes', protocol_version: 'deft.app_runtime_channel.v1' as const }],
    private_capabilities: [...base.private_capabilities, { key: 'runtime_write', version: '1' as const, input_schema: scalar, output_schema: scalar }],
    runtime_actions: [{ key: 'remote_write', label: 'Remote write', capability_key: 'runtime_write', runtime_requirement_key: 'writes' }] };
  assert.equal(parseDeftAppManifest(mixed).schema_version, '6');
  assert.throws(() => parseDeftAppManifest({ ...mixed, runtime_actions: [{ ...mixed.runtime_actions[0], key: 'create_event' }] }));
  assert.throws(() => parseDeftAppManifest({ ...mixed, runtime_actions: [{ ...mixed.runtime_actions[0], capability_key: 'calendar_create' }] }));
  assert.throws(() => parseDeftAppManifest({ ...base, native_actions: [{ ...base.native_actions[0], calendar_owner_user_id: crypto.randomUUID() }] }));
  assert.throws(() => parseDeftAppManifest({ ...base, private_capabilities: [{ ...base.private_capabilities[0],
    output_schema: NATIVE_CALENDAR_CONTRACTS['calendar.events.cancel.v1'].output_schema }] }));
  assert.throws(() => parseDeftAppManifest({ ...base, private_capabilities: [{ ...base.private_capabilities[0],
    input_schema: { ...create.input_schema, additionalProperties: true } }] }));
  for (const older of ['3', '4', '5']) assert.throws(() => parseDeftAppManifest({ ...base,
    schema_version: older, compatibility: { app_protocol: older } }));
});

test('native Calendar certified input enforces exact keys, time range and complete Unicode envelope bound', () => {
  const value = { title: 'Literal <script>☃</script>', start: '2026-10-01T10:00:00Z', end: '2026-10-01T11:00:00Z' };
  assert.equal(parseNativeCalendarInput('calendar.events.create.v1', value).title, value.title);
  assert.throws(() => parseNativeCalendarInput('calendar.events.create.v1', { ...value, end: value.start }));
  assert.throws(() => parseNativeCalendarInput('calendar.events.create.v1', { ...value, owner_user_id: crypto.randomUUID() }));
  assert.throws(() => parseNativeCalendarInput('calendar.events.create.v1', { ...value, description: '☃'.repeat(4096) }));
  assert.throws(() => parseNativeCalendarInput('calendar.events.cancel.v1', { create_run_id: crypto.randomUUID(),
    event_ref: { schema_version: 'deft.resource_ref.v2', provider: { kind: 'module', provider_instance_id: 'foreign' },
      resource_type: 'calendar_event', resource_id: crypto.randomUUID() } }));
});
