import type { ExperiencePin } from './app-experience-bridge';

export type InstalledExperienceSession = Readonly<{
  pin: ExperiencePin;
  experience: Readonly<{ key: string; label: string; artifact_digest: string;
    bridge_version: 'deft.experience_bridge.v1'; renderer_version: 'deft.trusted_renderer.v1' }>;
  bundle: Readonly<{ schema_version: 'deft.experience_bundle.v1'; worker_source: string;
    entry_view: string; resource_keys: readonly string[]; action_keys: readonly string[] }>;
  expires_at: string;
}>;

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
