export const APP_PACKAGE_MAX_BYTES = 1024 * 1024;

export type AppModuleReference = {
  module_id: string;
  version: string;
  manifest_path: string;
  manifest_digest: string;
};

export type AppManifest = {
  schema_version: '0';
  id: string;
  version: string;
  name: string;
  description?: string;
  license: string;
  compatibility: { app_protocol: '0' };
  provenance?: { source_repository: string; source_commit: string };
  modules: AppModuleReference[];
  navigation: Array<{ key: string; label: string; module_id: string; collection_key: string; view_key?: string }>;
};

export type AppInstallation = {
  id: string;
  app_id: string;
  name: string;
  version: string;
  state: 'staged' | 'active' | 'disabled' | 'failed';
  lifecycle_epoch: number;
  active_version_id: string | null;
  package_digest: string;
  manifest_digest: string;
  manifest: AppManifest;
  created_at: string;
  updated_at: string;
};

export type AppInspection = {
  manifest: AppManifest;
  manifest_digest: string;
  package_digest: string;
  canonical_package_json: string;
  permissions: [];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid App response.');
  return value as Record<string, unknown>;
}

export function normalizeAppInstallation(value: unknown): AppInstallation {
  const row = object(value);
  if (typeof row.id !== 'string' || typeof row.app_id !== 'string' || typeof row.name !== 'string') {
    throw new Error('Invalid App installation response.');
  }
  return row as unknown as AppInstallation;
}

export function normalizeAppsResponse(value: unknown): AppInstallation[] {
  const rows = object(value).apps;
  if (!Array.isArray(rows)) return [];
  return rows.map(normalizeAppInstallation);
}

export async function appApiError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  return typeof body.error === 'string' ? body.error : fallback;
}
