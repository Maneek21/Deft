import type { ExperiencePin } from './app-experience-bridge';

export function experienceLifetimeIsCurrent(sessionExpiry: string, exposureExpiry?: string, now = Date.now()): boolean {
  const session = Date.parse(sessionExpiry);
  const exposure = exposureExpiry === undefined ? Infinity : Date.parse(exposureExpiry);
  return Number.isFinite(now) && Number.isFinite(session) && session > now
    && (exposureExpiry === undefined || Number.isFinite(exposure)) && exposure > now;
}

export type InstalledExperienceSession = Readonly<{
  pin: ExperiencePin;
  experience: Readonly<{ key: string; label: string; artifact_digest: string;
    bridge_version: 'deft.experience_bridge.v1'; renderer_version: 'deft.trusted_renderer.v1' }>;
  bundle: Readonly<{ schema_version: 'deft.experience_bundle.v1'; worker_source: string;
    entry_view: string; resource_keys: readonly string[]; action_keys: readonly string[] }>;
  expires_at: string;
}>;

export type ExperienceExposureStatus = Readonly<{ exposure_id: string; exposure_epoch: number;
  review_digest: string; expires_at: string; active: true }>;
export type ExperienceExposureReview = Readonly<{ review_token: string; review_digest: string; snapshot: {
  schema_version: 'deft.experience_resource_exposure.v1'; destination: 'verified_installed_experience_worker';
  app_name: string; app_version: string; owner_label: string; experience_label: string; artifact_digest: string;
  expires_at: string; review_expires_at: string; resources: Array<{ resource_key: string; label: string; resource_type: string;
    allowed_operations: string[]; allowed_fields: string[] }>;
} }>;
export function normalizeExperienceExposureStatus(value: unknown): ExperienceExposureStatus {
  const row = object(value);
  if (row.active !== true || !/^sha256:[a-f0-9]{64}$/.test(String(row.review_digest))
    || !Number.isFinite(new Date(String(row.expires_at)).getTime())) throw new Error('Private access is unavailable.');
  return { exposure_id: str(row.exposure_id), exposure_epoch: epoch(row.exposure_epoch), review_digest: str(row.review_digest),
    expires_at: str(row.expires_at), active: true };
}
export function normalizeExperienceExposureReview(value: unknown): ExperienceExposureReview {
  const row = object(value); const snapshot = object(row.snapshot);
  if (snapshot.schema_version !== 'deft.experience_resource_exposure.v1' || snapshot.destination !== 'verified_installed_experience_worker'
    || typeof row.review_token !== 'string' || row.review_token.length > 24576 || !/^sha256:[a-f0-9]{64}$/.test(String(row.review_digest))
    || !Array.isArray(snapshot.resources) || snapshot.resources.length < 1 || snapshot.resources.length > 16
    || !Number.isFinite(new Date(String(snapshot.expires_at)).getTime())
    || !Number.isFinite(new Date(String(snapshot.review_expires_at)).getTime())) throw new Error('Private access review is unavailable.');
  return { review_token: row.review_token, review_digest: str(row.review_digest), snapshot: {
    schema_version: 'deft.experience_resource_exposure.v1', destination: 'verified_installed_experience_worker',
    app_name: str(snapshot.app_name), app_version: str(snapshot.app_version), owner_label: str(snapshot.owner_label),
    experience_label: str(snapshot.experience_label), artifact_digest: str(snapshot.artifact_digest), expires_at: str(snapshot.expires_at),
    review_expires_at: str(snapshot.review_expires_at), resources: snapshot.resources.map(value => {
      const resource = object(value);
      if (!Array.isArray(resource.allowed_fields) || resource.allowed_fields.length > 32
        || !resource.allowed_fields.every(field => typeof field === 'string' && field.length <= 48)
        || JSON.stringify(resource.allowed_operations) !== '["list_summary","read_one"]') throw new Error('Private access review is unavailable.');
      return { resource_key: str(resource.resource_key), label: str(resource.label), resource_type: str(resource.resource_type),
        allowed_operations: ['list_summary', 'read_one'], allowed_fields: resource.allowed_fields as string[] };
    }),
  } };
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Experience session.');
  return value as Record<string, unknown>;
};
const str = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) throw new Error('Invalid Experience session.');
  return value;
};
const epoch = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid Experience session.');
  return value as number;
};
const keys = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 16
    || !value.every((item) => typeof item === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(item))) {
    throw new Error('Invalid Experience session.');
  }
  return value;
};

export function normalizeInstalledExperienceSession(value: unknown): InstalledExperienceSession {
  const result = object(value);
  const pin = object(result.pin);
  const experience = object(result.experience);
  const bundle = object(result.bundle);
  if (experience.bridge_version !== 'deft.experience_bridge.v1'
    || experience.renderer_version !== 'deft.trusted_renderer.v1'
    || bundle.schema_version !== 'deft.experience_bundle.v1'
    || typeof bundle.worker_source !== 'string'
    || new TextEncoder().encode(bundle.worker_source).byteLength < 1
    || new TextEncoder().encode(bundle.worker_source).byteLength > 64 * 1024) {
    throw new Error('Unsupported Experience bundle.');
  }
  const normalizedPin = {
    org_id: str(pin.org_id), user_id: str(pin.user_id),
    app_installation_id: str(pin.app_installation_id),
    app_version_id: str(pin.app_version_id), grant_snapshot_id: str(pin.grant_snapshot_id),
    lifecycle_epoch: epoch(pin.lifecycle_epoch), grant_epoch: epoch(pin.grant_epoch),
    session_id: str(pin.session_id), session_epoch: epoch(pin.session_epoch),
  };
  if (!/^[0-9a-f-]{36}$/i.test(normalizedPin.session_id)) throw new Error('Invalid Experience session.');
  return {
    pin: normalizedPin,
    experience: { key: str(experience.key), label: str(experience.label),
      artifact_digest: str(experience.artifact_digest),
      bridge_version: 'deft.experience_bridge.v1', renderer_version: 'deft.trusted_renderer.v1' },
    bundle: { schema_version: 'deft.experience_bundle.v1',
      worker_source: bundle.worker_source, entry_view: str(bundle.entry_view),
      resource_keys: keys(bundle.resource_keys), action_keys: keys(bundle.action_keys) },
    expires_at: str(result.expires_at),
  };
}
